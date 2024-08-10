import "module-alias/register";

import { BigNumber, constants, utils } from "ethers";

import { getRandomAccount, getRandomAddress, convertPositionToNotional } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address, Bytes } from "@utils/types";
import { impersonateAccount } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { cacheBeforeEach, getAccounts, getWaffleExpect } from "@utils/test/index";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether } from "@utils/index";
import { network } from "hardhat";
import { forkingConfig } from "../../hardhat.config";

import {
  MorphoLeverageModule,
  IERC20,
  IERC20__factory,
  IMorpho,
  IMorpho__factory,
  Controller,
  Controller__factory,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  UniswapV3ExchangeAdapterV2,
  UniswapV3ExchangeAdapterV2__factory,
} from "@typechain/index";
import { MarketParamsStruct } from "@typechain/IMorpho";

const expect = getWaffleExpect();

// https://docs.aave.com/developers/deployed-contracts/v3-mainnet/ethereum-mainnet

const contractAddresses = {
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  debtIssuanceModule: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  integrationRegistry: "0xb9083dee5e8273E54B9DB4c31bA9d4aB7C6B28d3",
  uniswapV3ExchangeAdapterV2: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  uniswapV3Router: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  interestRateStrategy: "0x76884cAFeCf1f7d4146DA6C4053B18B76bf6ED14",
  morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
};

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  wsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
};

const whales = {
  usdc: "0xD6153F5af5679a75cC85D8974463545181f48772",
  wsteth: "0x3c22ec75ea5D745c78fc84762F7F1E6D82a2c5BF",
};

const wstethUsdcMarketParams: MarketParamsStruct = {
  loanToken: tokenAddresses.usdc,
  collateralToken: tokenAddresses.wsteth,
  oracle: "0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2",
  irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
  lltv: ether(0.86),
};

describe("MorphoLeverageModule integration", () => {
  let owner: Account;
  let mockModule: Account;
  let deployer: DeployHelper;
  let morphoLeverageModule: MorphoLeverageModule;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let integrationRegistry: IntegrationRegistry;
  let setTokenCreator: SetTokenCreator;
  let controller: Controller;
  let usdc: IERC20;
  let wsteth: IERC20;
  let uniswapV3ExchangeAdapterV2: UniswapV3ExchangeAdapterV2;
  let morpho: IMorpho;
  const marketId = "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc";

  let manager: Address;
  const maxManagerFee = ether(0.05);
  const managerIssueFee = ether(0);
  const managerRedeemFee = ether(0);
  let managerFeeRecipient: Address;
  let managerIssuanceHook: Address;

  const sharesToAssetsUp = (shares: BigNumber, totalAssets: BigNumber, totalShares: BigNumber) => {
    const VIRTUAL_SHARES = 1e6;
    const VIRTUAL_ASSETS = 1;
    const totalAssetsAdjusted = totalAssets.add(VIRTUAL_ASSETS);
    const totalSharesAdjusted = totalShares.add(VIRTUAL_SHARES);
    return shares.mul(totalAssetsAdjusted).add(totalSharesAdjusted).sub(1).div(totalSharesAdjusted);
  };

  const blockNumber = 20475000;
  before(async () => {
    const forking = {
      jsonRpcUrl: forkingConfig.url,
      blockNumber,
    };
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking,
        },
      ],
    });
  });
  after(async () => {
    // await network.provider.request({
    //   method: "hardhat_reset",
    //   params: [],
    // });
  });
  cacheBeforeEach(async () => {
    [owner, mockModule] = await getAccounts();

    usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
    wsteth = IERC20__factory.connect(tokenAddresses.wsteth, owner.wallet);
    uniswapV3ExchangeAdapterV2 = UniswapV3ExchangeAdapterV2__factory.connect(
      contractAddresses.uniswapV3ExchangeAdapterV2,
      owner.wallet,
    );

    morpho = IMorpho__factory.connect(contractAddresses.morpho, owner.wallet);

    manager = owner.address;
    managerFeeRecipient = owner.address;
    managerIssuanceHook = constants.AddressZero;

    controller = Controller__factory.connect(contractAddresses.controller, owner.wallet);

    const controllerOwner = await controller.owner();
    const controllerOwnerSigner = await impersonateAccount(controllerOwner);
    controller = controller.connect(controllerOwnerSigner);

    deployer = new DeployHelper(owner.wallet);
    const morphoLibrary = await deployer.libraries.deployMorpho();

    morphoLeverageModule = await deployer.modules.deployMorphoLeverageModule(
      controller.address,
      contractAddresses.morpho,
      "contracts/protocol/integration/lib/Morpho.sol:Morpho",
      morphoLibrary.address,
    );
    await controller.addModule(morphoLeverageModule.address);

    debtIssuanceModule = DebtIssuanceModuleV2__factory.connect(
      contractAddresses.debtIssuanceModule,
      owner.wallet,
    );
    setTokenCreator = SetTokenCreator__factory.connect(
      contractAddresses.setTokenCreator,
      owner.wallet,
    );
    integrationRegistry = IntegrationRegistry__factory.connect(
      contractAddresses.integrationRegistry,
      owner.wallet,
    );
    const integrationRegistryOwner = await integrationRegistry.owner();
    integrationRegistry = integrationRegistry.connect(
      await impersonateAccount(integrationRegistryOwner),
    );

    await integrationRegistry.addIntegration(
      morphoLeverageModule.address,
      "UNISWAPV3",
      uniswapV3ExchangeAdapterV2.address,
    );

    await integrationRegistry.addIntegration(
      morphoLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );
    await integrationRegistry.addIntegration(
      debtIssuanceModule.address,
      "MorphoLeverageModuleV3",
      morphoLeverageModule.address,
    );
  });

  async function createNonControllerEnabledSetToken(
    components: Address[],
    positions: BigNumber[],
    modules: Address[],
  ): Promise<SetToken> {
    return new SetToken__factory(owner.wallet).deploy(
      components,
      positions,
      modules,
      controller.address,
      manager,
      "TestSetToken",
      "TEST",
    );
  }
  async function createSetToken(
    components: Address[],
    positions: BigNumber[],
    modules: Address[],
  ): Promise<SetToken> {
    const setTokenAddress = await setTokenCreator.callStatic.create(
      components,
      positions,
      modules,
      manager,
      "TestSetToken",
      "TEST",
    );

    await setTokenCreator.create(components, positions, modules, manager, "TestSetToken", "TEST");
    return SetToken__factory.connect(setTokenAddress, owner.wallet);
  }

  const initializeDebtIssuanceModule = (setTokenAddress: Address) => {
    return debtIssuanceModule.initialize(
      setTokenAddress,
      maxManagerFee,
      managerIssueFee,
      managerRedeemFee,
      managerFeeRecipient,
      managerIssuanceHook,
    );
  };

  describe("#constructor", () => {
    it("should set the correct controller", async () => {
      const returnController = await morphoLeverageModule.controller();
      expect(returnController).to.eq(contractAddresses.controller);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let isAllowListed: boolean;
    let subjectSetToken: Address;
    let subjectMarketParams: MarketParamsStruct;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      manager = owner.address;
      setToken = await createSetToken(
        [tokenAddresses.wsteth, tokenAddresses.usdc],
        [ether(1), ether(100)],
        [morphoLeverageModule.address, debtIssuanceModule.address],
      );

      await initializeDebtIssuanceModule(setToken.address);

      if (isAllowListed) {
        // Add SetToken to allow list
        await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCaller = owner;
      subjectMarketParams = wstethUsdcMarketParams;
    };

    async function subject(): Promise<any> {
      return morphoLeverageModule
        .connect(subjectCaller.wallet)
        .initialize(subjectSetToken, subjectMarketParams);
    }

    describe("when isAllowListed is true", () => {
      before(async () => {
        isAllowListed = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(morphoLeverageModule.address);
        expect(isModuleEnabled).to.eq(true);
      });

      it("should register on the debt issuance module", async () => {
        await subject();
        const issuanceSettings = await debtIssuanceModule.issuanceSettings(setToken.address);
        expect(issuanceSettings.feeRecipient).to.not.eq(ADDRESS_ZERO);
      });

      describe("when debt issuance module is not added to integration registry", async () => {
        beforeEach(async () => {
          await integrationRegistry.removeIntegration(
            morphoLeverageModule.address,
            "DefaultIssuanceModule",
          );
        });

        afterEach(async () => {
          // Add debt issuance address to integration
          await integrationRegistry.addIntegration(
            morphoLeverageModule.address,
            "DefaultIssuanceModule",
            debtIssuanceModule.address,
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(debtIssuanceModule.address);
        });

        afterEach(async () => {
          await setToken.addModule(debtIssuanceModule.address);
          await initializeDebtIssuanceModule(setToken.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Issuance not initialized");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when SetToken is not in pending state", async () => {
        beforeEach(async () => {
          const newModule = await getRandomAddress();
          await controller.addModule(newModule);

          const morphoLeverageModuleNotPendingSetToken = await createSetToken(
            [tokenAddresses.wsteth],
            [ether(1)],
            [newModule],
          );

          subjectSetToken = morphoLeverageModuleNotPendingSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be pending initialization");
        });
      });

      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await createNonControllerEnabledSetToken(
            [tokenAddresses.wsteth],
            [ether(1)],
            [morphoLeverageModule.address],
          );
          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
        });
      });

      describe("when isAllowListed is false", async () => {
        before(async () => {
          isAllowListed = false;
        });

        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);

        describe("when SetToken is not allowlisted", async () => {
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Not allowed SetToken");
          });
        });

        describe("when any Set can initialize this module", async () => {
          beforeEach(async () => {
            await morphoLeverageModule.updateAnySetAllowed(true);
          });

          it("should enable the Module on the SetToken", async () => {
            await subject();
            const isModuleEnabled = await setToken.isInitializedModule(
              morphoLeverageModule.address,
            );
            expect(isModuleEnabled).to.eq(true);
          });
        });
      });
    });
  });

  context("when wsteth is collateral asset and usdc borrow assets", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectCaller: Account;

    cacheBeforeEach(async () => {
      setToken = await createSetToken(
        [wsteth.address],
        [ether(1)],
        [morphoLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      subjectSetToken = setToken.address;
      subjectCaller = owner;

      // Mint aTokens
      await network.provider.send("hardhat_setBalance", [whales.wsteth, ether(10).toHexString()]);
      await wsteth
        .connect(await impersonateAccount(whales.wsteth))
        .transfer(owner.address, ether(10000));
      await wsteth.approve(debtIssuanceModule.address, ether(10000));

      const issueQuantity = ether(1);
      await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Add SetToken to allow list
      await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
    });
    context("when morphoLeverageModule is intialized", async () => {
      cacheBeforeEach(async () => {
        await morphoLeverageModule.initialize(setToken.address, wstethUsdcMarketParams);
      });

      describe("#enterCollateralPosition", async () => {
        async function subject(): Promise<any> {
          return morphoLeverageModule
            .connect(subjectCaller.wallet)
            .enterCollateralPosition(subjectSetToken);
        }
        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const initialFirstPosition = initialPositions[0];

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          expect(initialPositions.length).to.eq(1);
          expect(initialFirstPosition.positionState).to.eq(0); // Default already
          expect(initialFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(currentPositions.length).to.eq(1);
          expect(newFirstPosition.component).to.eq(wsteth.address);
          expect(newFirstPosition.positionState).to.eq(1); // External
          expect(newFirstPosition.unit).to.eq(initialFirstPosition.unit);
          expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
        });
        it("positions should align with token balances", async () => {
          await subject();
          const currentPositions = await setToken.getPositions();
          const [supplyShares, borrowShares, collateral] = await morpho.position(
            marketId,
            setToken.address,
          );
          console.log("collateral", collateral.toString());
          const collateralNotional = await convertPositionToNotional(
            currentPositions[0].unit,
            setToken,
          );
          console.log("collateralNotional", collateralNotional.toString());
          const collateralTokenBalance = await wsteth.balanceOf(setToken.address);
          console.log("collateralTokenBalance", collateralTokenBalance.toString());
          expect(collateralNotional).to.eq(collateralTokenBalance.add(collateral));

          const [, , totalBorrowAssets, totalBorrowShares, ,] = await morpho.market(marketId);
          console.log("totalBorrowAssets", totalBorrowAssets.toString());
          const borrowAssets = sharesToAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
          console.log("borrowAssets", borrowAssets.toString());
          if (borrowAssets.gt(0)) {
            const borrowNotional = await convertPositionToNotional(
              currentPositions[1].unit,
              setToken,
            );
            console.log("borrowNotional", borrowNotional.toString());
            expect(borrowNotional.mul(-1)).to.eq(borrowAssets);
          }

          expect(supplyShares).to.eq(0);
        });
      });
      context("when collateral has been deposited into morpho", async () => {
        cacheBeforeEach(async () => {
          await morphoLeverageModule.enterCollateralPosition(setToken.address);
        });

        describe("#lever", async () => {
          let subjectBorrowQuantity: BigNumber;
          let subjectMinCollateralQuantity: BigNumber;
          let subjectTradeAdapterName: string;
          let subjectTradeData: Bytes;

          async function subject(): Promise<any> {
            return morphoLeverageModule
              .connect(subjectCaller.wallet)
              .lever(
                subjectSetToken,
                subjectBorrowQuantity,
                subjectMinCollateralQuantity,
                subjectTradeAdapterName,
                subjectTradeData,
                { gasLimit: 2000000 },
              );
          }

          beforeEach(async () => {
            subjectSetToken = setToken.address;
            subjectBorrowQuantity = utils.parseUnits("1000", 6);
            subjectMinCollateralQuantity = utils.parseEther("0.1");
            subjectTradeAdapterName = "UNISWAPV3";
            subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
              [usdc.address, wsteth.address], // Swap path
              [500], // Fees
              true,
            );
          });

          it("should update the positions on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];
            const newSecondPosition = (await setToken.getPositions())[1];

            expect(initialPositions.length).to.eq(1);
            expect(initialPositions[0].positionState).to.eq(1); // External already

            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(wsteth.address);
            expect(newFirstPosition.positionState).to.eq(1); // External
            expect(newFirstPosition.unit).to.gte(
              initialPositions[0].unit.add(subjectMinCollateralQuantity),
            );
            expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);

            expect(newSecondPosition.component).to.eq(usdc.address);
            expect(newSecondPosition.positionState).to.eq(1); // External

            const roundingMargin = 1;
            expect(newSecondPosition.unit).to.gte(
              subjectBorrowQuantity.mul(-1).sub(roundingMargin),
            );
            expect(newSecondPosition.unit).to.lte(
              subjectBorrowQuantity.mul(-1).add(roundingMargin),
            );
            expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
          });

          it("positions should align with token balances", async () => {
            await subject();
            const currentPositions = await setToken.getPositions();
            const [supplyShares, borrowShares, collateral] = await morpho.position(
              marketId,
              setToken.address,
            );
            console.log("collateral", collateral.toString());
            const collateralNotional = await convertPositionToNotional(
              currentPositions[0].unit,
              setToken,
            );
            console.log("collateralNotional", collateralNotional.toString());
            const collateralTokenBalance = await wsteth.balanceOf(setToken.address);
            console.log("collateralTokenBalance", collateralTokenBalance.toString());
            expect(collateralNotional).to.eq(collateralTokenBalance.add(collateral));

            const [, , totalBorrowAssets, totalBorrowShares, ,] = await morpho.market(marketId);
            console.log("totalBorrowAssets", totalBorrowAssets.toString());
            const borrowAssets = sharesToAssetsUp(
              borrowShares,
              totalBorrowAssets,
              totalBorrowShares,
            );
            console.log("borrowAssets", borrowAssets.toString());
            const borrowNotional = await convertPositionToNotional(
              currentPositions[1].unit,
              setToken,
            );
            console.log("borrowNotional", borrowNotional.toString());
            expect(borrowNotional.mul(-1)).to.eq(borrowAssets);

            expect(supplyShares).to.eq(0);
          });
        });
        context("when token is levered", async () => {
          cacheBeforeEach(async () => {
            const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
              [usdc.address, wsteth.address], // Swap path
              [500], // Fees
              true,
            );
            const borrowQuantity = utils.parseUnits("1000", 6);
            const tradeAdapterName = "UNISWAPV3";
            await morphoLeverageModule
              .connect(owner.wallet)
              .lever(subjectSetToken, borrowQuantity, 0, tradeAdapterName, leverTradeData);
          });

          describe("#delever", async () => {
            let subjectRedeemQuantity: BigNumber;
            let subjectMinRepayQuantity: BigNumber;
            let subjectTradeAdapterName: string;
            let subjectTradeData: Bytes;

            async function subject(): Promise<any> {
              return morphoLeverageModule
                .connect(subjectCaller.wallet)
                .delever(
                  subjectSetToken,
                  subjectRedeemQuantity,
                  subjectMinRepayQuantity,
                  subjectTradeAdapterName,
                  subjectTradeData,
                  { gasLimit: 2000000 },
                );
            }

            beforeEach(async () => {
              subjectSetToken = setToken.address;
              subjectRedeemQuantity = utils.parseEther("0.05");
              subjectMinRepayQuantity = utils.parseUnits("100", 6);
              subjectTradeAdapterName = "UNISWAPV3";
              subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
                [wsteth.address, usdc.address], // Swap path
                [500], // Fees
                true,
              );
            });

            it("should update the positions on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];
              const newSecondPosition = (await setToken.getPositions())[1];

              expect(initialPositions.length).to.eq(2);
              expect(initialPositions[0].positionState).to.eq(1); // External already

              expect(currentPositions.length).to.eq(2);
              expect(newFirstPosition.component).to.eq(wsteth.address);
              expect(newFirstPosition.positionState).to.eq(1); // External
              expect(newFirstPosition.unit).to.eq(
                initialPositions[0].unit.sub(subjectRedeemQuantity),
              );
              expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);

              expect(newSecondPosition.component).to.eq(usdc.address);
              expect(newSecondPosition.positionState).to.eq(1); // External
              expect(newSecondPosition.unit).to.gte(
                initialPositions[1].unit.add(subjectMinRepayQuantity),
              );
              expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
            });
            it("positions should align with token balances", async () => {
              await subject();
              const currentPositions = await setToken.getPositions();
              const [supplyShares, borrowShares, collateral] = await morpho.position(
                marketId,
                setToken.address,
              );
              console.log("collateral", collateral.toString());
              const collateralNotional = await convertPositionToNotional(
                currentPositions[0].unit,
                setToken,
              );
              console.log("collateralNotional", collateralNotional.toString());
              const collateralTokenBalance = await wsteth.balanceOf(setToken.address);
              console.log("collateralTokenBalance", collateralTokenBalance.toString());
              expect(collateralNotional).to.eq(collateralTokenBalance.add(collateral));

              const [, , totalBorrowAssets, totalBorrowShares, ,] = await morpho.market(marketId);
              console.log("totalBorrowAssets", totalBorrowAssets.toString());
              const borrowAssets = sharesToAssetsUp(
                borrowShares,
                totalBorrowAssets,
                totalBorrowShares,
              );
              console.log("borrowAssets", borrowAssets.toString());
              const borrowNotional = await convertPositionToNotional(
                currentPositions[1].unit,
                setToken,
              );
              console.log("borrowNotional", borrowNotional.toString());
              expect(borrowNotional.mul(-1)).to.eq(borrowAssets);

              expect(supplyShares).to.eq(0);
            });
          });

          describe("#deleverToZeroBorrowBalance", async () => {
            let subjectRedeemQuantity: BigNumber;
            let subjectTradeAdapterName: string;
            let subjectTradeData: Bytes;

            async function subject(): Promise<any> {
              return morphoLeverageModule
                .connect(subjectCaller.wallet)
                .deleverToZeroBorrowBalance(
                  subjectSetToken,
                  subjectRedeemQuantity,
                  subjectTradeAdapterName,
                  subjectTradeData,
                );
            }

            beforeEach(async () => {
              subjectSetToken = setToken.address;
              subjectRedeemQuantity = utils.parseEther("0.5");
              subjectTradeAdapterName = "UNISWAPV3";
              subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
                [wsteth.address, usdc.address], // Swap path
                [500], // Fees
                true,
              );
            });

            it("should update the positions on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];

              expect(initialPositions.length).to.eq(2);
              expect(initialPositions[0].positionState).to.eq(1); // External already

              expect(currentPositions.length).to.eq(1);
              expect(newFirstPosition.component).to.eq(wsteth.address);
              expect(newFirstPosition.positionState).to.eq(1); // External
              expect(newFirstPosition.unit).to.eq(
                initialPositions[0].unit.sub(subjectRedeemQuantity),
              );
              expect(newFirstPosition.module).to.eq(morphoLeverageModule.address);
            });

            it("positions should align with token balances", async () => {
              await subject();
              const [supplyShares, borrowShares, collateral] = await morpho.position(
                marketId,
                setToken.address,
              );
              console.log("collateral", collateral.toString());
              const currentPositions = await setToken.getPositions();
              const collateralNotional = await convertPositionToNotional(
                currentPositions[0].unit,
                setToken,
              );
              console.log("collateralNotional", collateralNotional.toString());
              const collateralTokenBalance = await wsteth.balanceOf(setToken.address);
              // TODO: Understand why token balance is exactly 0
              console.log("collateralTokenBalance", collateralTokenBalance.toString());
              expect(collateralNotional).to.eq(collateralTokenBalance.add(collateral));
              expect(borrowShares).to.eq(0);
              expect(supplyShares).to.eq(0);
              expect(collateral).to.gt(0);
            });
          });

          describe("#componentIssueHook", async () => {
            let subjectSetToken: Address;
            let subjectSetQuantity: BigNumber;
            let subjectComponent: Address;
            let subjectIsEquity: boolean;
            let subjectCaller: Account;

            cacheBeforeEach(async () => {
              await controller.addModule(mockModule.address);
              await setToken.addModule(mockModule.address);
              await setToken.connect(mockModule.wallet).initializeModule();
            });

            beforeEach(() => {
              subjectSetToken = setToken.address;
              subjectSetQuantity = ether(0.1);
              subjectComponent = usdc.address;
              subjectIsEquity = false;
              subjectCaller = mockModule;
            });

            async function subject(): Promise<any> {
              return morphoLeverageModule
                .connect(subjectCaller.wallet)
                .componentIssueHook(
                  subjectSetToken,
                  subjectSetQuantity,
                  subjectComponent,
                  subjectIsEquity,
                );
            }

            it("should increase borrowed quantity on the SetToken", async () => {
              const previousUsdcBalance = await usdc.balanceOf(setToken.address);

              await subject();

              const currentUsdcBalance = await usdc.balanceOf(setToken.address);

              expect(previousUsdcBalance).to.eq(ZERO);
              expect(currentUsdcBalance).to.gt(ZERO);
            });

            it("positions should align with token balances", async () => {
              await subject();
              // TODO: Check that the positions not getting synced in hook itself is correct
              await morphoLeverageModule.sync(setToken.address);
              const currentPositions = await setToken.getPositions();
              const [supplyShares, borrowShares, collateral] = await morpho.position(
                marketId,
                setToken.address,
              );
              console.log("collateral", collateral.toString());
              const collateralNotional = await convertPositionToNotional(
                currentPositions[0].unit,
                setToken,
              );
              console.log("collateralNotional", collateralNotional.toString());
              const collateralTokenBalance = await wsteth.balanceOf(setToken.address);
              console.log("collateralTokenBalance", collateralTokenBalance.toString());
              expect(collateralNotional).to.eq(collateralTokenBalance.add(collateral));

              const [, , totalBorrowAssets, totalBorrowShares, ,] = await morpho.market(marketId);
              console.log("totalBorrowAssets", totalBorrowAssets.toString());
              const borrowAssets = sharesToAssetsUp(
                borrowShares,
                totalBorrowAssets,
                totalBorrowShares,
              );
              console.log("borrowAssets", borrowAssets.toString());
              if (borrowAssets.gt(0)) {
                const borrowNotional = await convertPositionToNotional(
                  currentPositions[1].unit,
                  setToken,
                );
                console.log("borrowNotional", borrowNotional.toString());
                expect(borrowNotional.mul(-1)).to.eq(borrowAssets);
              }

              expect(supplyShares).to.eq(0);
            });

            describe("when isEquity is false and component has positive unit (should not happen)", async () => {
              beforeEach(async () => {
                subjectComponent = wsteth.address;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Debt component mismatch");
              });
            });

            describe("when isEquity is true", async () => {
              beforeEach(async () => {
                subjectIsEquity = true;
              });

              it("should NOT increase borrowed quantity on the SetToken", async () => {
                const previousUsdcBalance = await usdc.balanceOf(setToken.address);

                await subject();

                const currentUsdcBalance = await usdc.balanceOf(setToken.address);

                expect(previousUsdcBalance).to.eq(ZERO);
                expect(currentUsdcBalance).to.eq(ZERO);
              });
            });

            describe("when caller is not module", async () => {
              beforeEach(async () => {
                subjectCaller = owner;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Only the module can call");
              });
            });

            describe("if disabled module is caller", async () => {
              beforeEach(async () => {
                await controller.removeModule(mockModule.address);
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
              });
            });
          });
          describe("#componentRedeemHook", async () => {
            let subjectSetToken: Address;
            let subjectSetQuantity: BigNumber;
            let subjectComponent: Address;
            let subjectIsEquity: boolean;
            let subjectCaller: Account;

            cacheBeforeEach(async () => {
              await controller.addModule(mockModule.address);
              await setToken.addModule(mockModule.address);
              await setToken.connect(mockModule.wallet).initializeModule();
              await usdc.connect(await impersonateAccount(whales.usdc)).transfer(setToken.address, utils.parseUnits("1000", 6));
            });

            beforeEach(() => {
              subjectSetToken = setToken.address;
              subjectSetQuantity = ether(0.1);
              subjectComponent = usdc.address;
              subjectIsEquity = false;
              subjectCaller = mockModule;
            });

            async function subject(): Promise<any> {
              return morphoLeverageModule
                .connect(subjectCaller.wallet)
                .componentRedeemHook(
                  subjectSetToken,
                  subjectSetQuantity,
                  subjectComponent,
                  subjectIsEquity,
                );
            }
            it("should decrease borrowed quantity on the SetToken", async () => {
              const previousUsdcBalance = await usdc.balanceOf(setToken.address);

              await subject();

              const currentUsdcBalance = await usdc.balanceOf(setToken.address);

              expect(currentUsdcBalance).to.lt(previousUsdcBalance);
            });

            it("positions should align with token balances", async () => {
              await subject();
              // TODO: Check that the positions not getting synced in hook itself is correct
              await morphoLeverageModule.sync(setToken.address);
              const currentPositions = await setToken.getPositions();
              const [supplyShares, borrowShares, collateral] = await morpho.position(
                marketId,
                setToken.address,
              );
              console.log("collateral", collateral.toString());
              const collateralNotional = await convertPositionToNotional(
                currentPositions[0].unit,
                setToken,
              );
              console.log("collateralNotional", collateralNotional.toString());
              const collateralTokenBalance = await wsteth.balanceOf(setToken.address);
              console.log("collateralTokenBalance", collateralTokenBalance.toString());
              expect(collateralNotional).to.eq(collateralTokenBalance.add(collateral));

              const [, , totalBorrowAssets, totalBorrowShares, ,] = await morpho.market(marketId);
              console.log("totalBorrowAssets", totalBorrowAssets.toString());
              const borrowAssets = sharesToAssetsUp(
                borrowShares,
                totalBorrowAssets,
                totalBorrowShares,
              );
              console.log("borrowAssets", borrowAssets.toString());
              if (borrowAssets.gt(0)) {
                const borrowNotional = await convertPositionToNotional(
                  currentPositions[1].unit,
                  setToken,
                );
                console.log("borrowNotional", borrowNotional.toString());
                expect(borrowNotional.mul(-1)).to.eq(borrowAssets);
              }

              expect(supplyShares).to.eq(0);
            });

            describe("when isEquity is false and component has positive unit (should not happen)", async () => {
              beforeEach(async () => {
                subjectComponent = wsteth.address;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Debt component mismatch");
              });
            });

            describe("when isEquity is true", async () => {
              beforeEach(async () => {
                subjectIsEquity = true;
              });

              it("should NOT decrease borrowed quantity on the SetToken", async () => {
                const previousUsdcBalance = await usdc.balanceOf(setToken.address);

                await subject();

                const currentUsdcBalance = await usdc.balanceOf(setToken.address);

                expect(previousUsdcBalance).to.eq(currentUsdcBalance);
              });
            });

            describe("when caller is not module", async () => {
              beforeEach(async () => {
                subjectCaller = owner;
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Only the module can call");
              });
            });

            describe("if disabled module is caller", async () => {
              beforeEach(async () => {
                await controller.removeModule(mockModule.address);
              });

              it("should revert", async () => {
                await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
              });
            });
          });
        });
      });
    });
  });
});