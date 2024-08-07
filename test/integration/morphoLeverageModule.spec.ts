import "module-alias/register";

import { Signer, BigNumber, ContractTransaction, constants, utils } from "ethers";

import { getRandomAccount, getRandomAddress } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address, Bytes } from "@utils/types";
import { impersonateAccount, waitForEvent } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { cacheBeforeEach, getAccounts, getWaffleExpect } from "@utils/test/index";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, preciseMul } from "@utils/index";
import { network } from "hardhat";
import { forkingConfig } from "../../hardhat.config";

import {
  MorphoLeverageModule,
  ChainlinkAggregatorMock,
  DebtIssuanceMock,
  Iwsteth,
  Iwsteth__factory,
  IERC20,
  IERC20__factory,
  IPool,
  IPool__factory,
  IPoolAddressesProvider,
  IPoolAddressesProvider__factory,
  IPoolConfigurator,
  IPoolConfigurator__factory,
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
  StandardTokenMock,
  UniswapV3ExchangeAdapterV2,
  UniswapV3ExchangeAdapterV2__factory,
  UniswapV3Pool,
  UniswapV3Pool__factory,
} from "@typechain/index";
import {
    MarketParamsStruct 
} from  "@typechain/IMorpho";

const expect = getWaffleExpect();

// https://docs.aave.com/developers/deployed-contracts/v3-mainnet/ethereum-mainnet

const contractAddresses = {
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  debtIssuanceModule: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  integrationRegistry: "0xb9083dee5e8273E54B9DB4c31bA9d4aB7C6B28d3",
  uniswapV3ExchangeAdapterV2: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  uniswapV3Router: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  wstethUsdcPool: "0x60594a405d53811d3bc4766596efd80fd545a270",
  interestRateStrategy: "0x76884cAFeCf1f7d4146DA6C4053B18B76bf6ED14",
  morpho:  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
};

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  wsteth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
};

const whales = {
  usdc: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  wsteth: "0x5fEC2f34D80ED82370F733043B6A536d7e9D7f8d",
};

describe("MorphoLeverageModule integration", () => {
  let owner: Account;
  let notOwner: Account;
  let mockModule: Account;
  let deployer: DeployHelper;
  let morphoLeverageModule: MorphoLeverageModule;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let integrationRegistry: IntegrationRegistry;
  let setTokenCreator: SetTokenCreator;
  let controller: Controller;
  let wsteth: Iwsteth;
  let usdc: IERC20;
  let wbtc: IERC20;
  let usdc: IERC20;
  let wsteth: IERC20;
  let uniswapV3ExchangeAdapterV2: UniswapV3ExchangeAdapterV2;
  let wstethUsdcPool: UniswapV3Pool;

  let manager: Address;
  const maxManagerFee = ether(0.05);
  const managerIssueFee = ether(0);
  const managerRedeemFee = ether(0);
  let managerFeeRecipient: Address;
  let managerIssuanceHook: Address;

  const blockNumber = 17611000;
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
    await network.provider.request({
      method: "hardhat_reset",
      params: [],
    });
  });
  cacheBeforeEach(async () => {
    [owner, notOwner, mockModule] = await getAccounts();


    usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
    wsteth = IERC20__factory.connect(tokenAddresses.wsteth, owner.wallet);
    uniswapV3ExchangeAdapterV2 = UniswapV3ExchangeAdapterV2__factory.connect(
      contractAddresses.uniswapV3ExchangeAdapterV2,
      owner.wallet,
    );


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
      subjectMarketParams = {
            loanToken: usdc.address,
            collateralToken: wsteth.address,
            oracle: "0xbD60A6770b27E084E8617335ddE769241B0e71D8",
            irm: "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC",
            lltv: ethers.utils.parseEther("0.945"),
      }
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
            const isModuleEnabled = await setToken.isInitializedModule(morphoLeverageModule.address);
            expect(isModuleEnabled).to.eq(true);
          });
        });
      });
    });
  });

  // describe("#lever", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let destinationTokenQuantity: BigNumber;

  //   let subjectSetToken: Address;
  //   let subjectBorrowAsset: Address;
  //   let subjectCollateralAsset: Address;
  //   let subjectBorrowQuantity: BigNumber;
  //   let subjectMinCollateralQuantity: BigNumber;
  //   let subjectTradeAdapterName: string;
  //   let subjectTradeData: Bytes;
  //   let subjectCaller: Account;

  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .lever(
  //         subjectSetToken,
  //         subjectBorrowAsset,
  //         subjectCollateralAsset,
  //         subjectBorrowQuantity,
  //         subjectMinCollateralQuantity,
  //         subjectTradeAdapterName,
  //         subjectTradeData,
  //         { gasLimit: 2000000 },
  //       );
  //   }

  //   context(
  //     "when wsteth is borrow asset, and WSTETH is collateral asset (icEth configuration)",
  //     async () => {
  //       // This is a borrow amount that will fail in normal mode but should work in e-mode
  //       const maxBorrowAmount = utils.parseEther("1.6");
  //       before(async () => {
  //         isInitialized = true;
  //       });

  //       cacheBeforeEach(async () => {
  //         setToken = await createSetToken(
  //           [aWstEth.address, wsteth.address],
  //           [ether(2), ether(1)],
  //           [morphoLeverageModule.address, debtIssuanceModule.address],
  //         );
  //         await initializeDebtIssuanceModule(setToken.address);
  //         // Add SetToken to allow list
  //         await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //         // Initialize module if set to true
  //         if (isInitialized) {
  //           await morphoLeverageModule.initialize(
  //             setToken.address,
  //             [wsteth.address, wsteth.address],
  //             [wsteth.address, wsteth.address],
  //           );
  //         }

  //         // Mint aTokens
  //         await network.provider.send("hardhat_setBalance", [
  //           whales.wsteth,
  //           ether(10).toHexString(),
  //         ]);
  //         await wsteth
  //           .connect(await impersonateAccount(whales.wsteth))
  //           .transfer(owner.address, ether(10000));
  //         await wsteth.approve(aaveLendingPool.address, ether(10000));
  //         await aaveLendingPool
  //           .connect(owner.wallet)
  //           .deposit(wsteth.address, ether(10000), owner.address, ZERO);

  //         await wsteth.approve(aaveLendingPool.address, ether(1000));
  //         await aaveLendingPool
  //           .connect(owner.wallet)
  //           .deposit(wsteth.address, ether(1000), owner.address, ZERO);

  //         // Approve tokens to issuance module and call issue
  //         await aWstEth.approve(debtIssuanceModule.address, ether(10000));
  //         await wsteth.approve(debtIssuanceModule.address, ether(1000));

  //         // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //         const issueQuantity = ether(1);
  //         destinationTokenQuantity = ether(1);
  //         await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //       });

  //       beforeEach(async () => {
  //         subjectSetToken = setToken.address;
  //         subjectBorrowAsset = wsteth.address;
  //         subjectCollateralAsset = wsteth.address;
  //         subjectBorrowQuantity = utils.parseEther("0.2");
  //         subjectMinCollateralQuantity = utils.parseEther("0.1");
  //         subjectTradeAdapterName = "UNISWAPV3";
  //         subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [wsteth.address, wsteth.address], // Swap path
  //           [500], // Fees
  //           true,
  //         );
  //         subjectCaller = owner;
  //       });

  //       it("should update the collateral position on the SetToken correctly", async () => {
  //         const initialPositions = await setToken.getPositions();

  //         await subject();

  //         // cEther position is increased
  //         const currentPositions = await setToken.getPositions();
  //         const newFirstPosition = (await setToken.getPositions())[0];
  //         const newSecondPosition = (await setToken.getPositions())[1];

  //         // Get expected aTokens minted
  //         const newUnits = subjectMinCollateralQuantity;
  //         const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

  //         expect(initialPositions.length).to.eq(2);
  //         expect(currentPositions.length).to.eq(3);
  //         expect(newFirstPosition.component).to.eq(aWstEth.address);
  //         expect(newFirstPosition.positionState).to.eq(0); // Default
  //         expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
  //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

  //         expect(newSecondPosition.component).to.eq(wsteth.address);
  //         expect(newSecondPosition.positionState).to.eq(0); // Default
  //         expect(newSecondPosition.unit).to.eq(ether(1));
  //         expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //       });
  //       describe("When leverage ratio is higher than normal limit", () => {
  //         beforeEach(async () => {
  //           subjectBorrowQuantity = maxBorrowAmount;
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("36");
  //         });
  //       });

  //       describe("When E-mode category is set to eth category", () => {
  //         beforeEach(async () => {
  //           const wstethEModeCategory = await protocolDataProvider.getReserveEModeCategory(
  //             wsteth.address,
  //           );
  //           const wstethEModeCategory = await protocolDataProvider.getReserveEModeCategory(
  //             wsteth.address,
  //           );
  //           expect(wstethEModeCategory).to.eq(wstethEModeCategory);
  //           await morphoLeverageModule.setEModeCategory(setToken.address, wstethEModeCategory);
  //         });

  //         it("should update the collateral position on the SetToken correctly", async () => {
  //           const initialPositions = await setToken.getPositions();

  //           await subject();

  //           // cEther position is increased
  //           const currentPositions = await setToken.getPositions();
  //           const newFirstPosition = (await setToken.getPositions())[0];
  //           const newSecondPosition = (await setToken.getPositions())[1];

  //           // Get expected aTokens minted
  //           const newUnits = subjectMinCollateralQuantity;
  //           const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

  //           expect(initialPositions.length).to.eq(2);
  //           expect(currentPositions.length).to.eq(3);
  //           expect(newFirstPosition.component).to.eq(aWstEth.address);
  //           expect(newFirstPosition.positionState).to.eq(0); // Default
  //           expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
  //           expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

  //           expect(newSecondPosition.component).to.eq(wsteth.address);
  //           expect(newSecondPosition.positionState).to.eq(0); // Default
  //           expect(newSecondPosition.unit).to.eq(ether(1));
  //           expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //         });
  //         describe("When leverage ratio is higher than normal limit", () => {
  //           beforeEach(async () => {
  //             subjectBorrowQuantity = maxBorrowAmount;
  //           });
  //           it("should update the collateral position on the SetToken correctly", async () => {
  //             const initialPositions = await setToken.getPositions();

  //             await subject();

  //             // cEther position is increased
  //             const currentPositions = await setToken.getPositions();
  //             const newFirstPosition = (await setToken.getPositions())[0];
  //             const newSecondPosition = (await setToken.getPositions())[1];

  //             // Get expected aTokens minted
  //             const newUnits = subjectMinCollateralQuantity;
  //             const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

  //             expect(initialPositions.length).to.eq(2);
  //             expect(currentPositions.length).to.eq(3);
  //             expect(newFirstPosition.component).to.eq(aWstEth.address);
  //             expect(newFirstPosition.positionState).to.eq(0); // Default
  //             expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
  //             expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

  //             expect(newSecondPosition.component).to.eq(wsteth.address);
  //             expect(newSecondPosition.positionState).to.eq(0); // Default
  //             expect(newSecondPosition.unit).to.eq(ether(1));
  //             expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //           });
  //         });
  //       });
  //     },
  //   );
  //   context("when awsteth is collateral asset and borrow positions is 0", async () => {
  //     const initializeContracts = async () => {
  //       setToken = await createSetToken(
  //         [awsteth.address],
  //         [ether(2)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //       // Initialize module if set to true
  //       if (isInitialized) {
  //         await morphoLeverageModule.initialize(
  //           setToken.address,
  //           [wsteth.address, usdc.address],
  //           [usdc.address, wsteth.address],
  //         );
  //       }
  //       // Mint aTokens
  //       await wsteth.approve(aaveLendingPool.address, ether(1000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(wsteth.address, ether(1000), owner.address, ZERO);
  //       await usdc.approve(aaveLendingPool.address, ether(10000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(usdc.address, ether(10000), owner.address, ZERO);
  //       // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //       const issueQuantity = ether(1);
  //       destinationTokenQuantity = utils.parseEther("0.5");
  //       await awsteth.approve(debtIssuanceModule.address, ether(1000));
  //       await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //     };
  //     const initializeSubjectVariables = async () => {
  //       subjectSetToken = setToken.address;
  //       subjectBorrowAsset = usdc.address;
  //       subjectCollateralAsset = wsteth.address;
  //       subjectBorrowQuantity = ether(1000);
  //       subjectMinCollateralQuantity = destinationTokenQuantity;
  //       subjectTradeAdapterName = "UNISWAPV3";
  //       subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //         [usdc.address, wsteth.address], // Swap path
  //         [500], // Fees
  //         true,
  //       );
  //       subjectCaller = owner;
  //     };
  //     describe("when module is initialized", async () => {
  //       before(async () => {
  //         isInitialized = true;
  //       });
  //       cacheBeforeEach(initializeContracts);
  //       beforeEach(initializeSubjectVariables);
  //       it("should update the collateral position on the SetToken correctly", async () => {
  //         const initialPositions = await setToken.getPositions();
  //         await subject();
  //         // cwsteth position is increased
  //         const currentPositions = await setToken.getPositions();
  //         const newFirstPosition = (await setToken.getPositions())[0];
  //         const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);
  //         expect(initialPositions.length).to.eq(1);
  //         expect(currentPositions.length).to.eq(2); // added a new borrow position
  //         expect(newFirstPosition.component).to.eq(awsteth.address);
  //         expect(newFirstPosition.positionState).to.eq(0); // Default
  //         expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
  //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
  //       });
  //       it("should update the borrow position on the SetToken correctly", async () => {
  //         const initialPositions = await setToken.getPositions();
  //         await subject();
  //         // cEther position is increased
  //         const currentPositions = await setToken.getPositions();
  //         const newSecondPosition = (await setToken.getPositions())[1];
  //         const expectedSecondPositionUnit = (
  //           await variableDebtUSDC.balanceOf(setToken.address)
  //         ).mul(-1);
  //         expect(initialPositions.length).to.eq(1);
  //         expect(currentPositions.length).to.eq(2);
  //         expect(newSecondPosition.component).to.eq(usdc.address);
  //         expect(newSecondPosition.positionState).to.eq(1); // External
  //         expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
  //         expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
  //       });
  //       it("should transfer the correct components to the exchange", async () => {
  //         const oldSourceTokenBalance = await usdc.balanceOf(wstethUsdcPool.address);
  //         await subject();
  //         const totalSourceQuantity = subjectBorrowQuantity;
  //         const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
  //         const newSourceTokenBalance = await usdc.balanceOf(wstethUsdcPool.address);
  //         expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
  //       });
  //       it("should transfer the correct components from the exchange", async () => {
  //         const oldDestinationTokenBalance = await wsteth.balanceOf(wstethUsdcPool.address);
  //         await subject();
  //         const totalDestinationQuantity = destinationTokenQuantity;
  //         const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
  //           totalDestinationQuantity,
  //         );
  //         const newDestinationTokenBalance = await wsteth.balanceOf(wstethUsdcPool.address);
  //         expect(newDestinationTokenBalance).to.gt(
  //           expectedDestinationTokenBalance.mul(999).div(1000),
  //         );
  //         expect(newDestinationTokenBalance).to.lt(
  //           expectedDestinationTokenBalance.mul(1001).div(1000),
  //         );
  //       });
  //       describe("when there is a protocol fee charged", async () => {
  //         let feePercentage: BigNumber;
  //         cacheBeforeEach(async () => {
  //           feePercentage = ether(0.05);
  //           controller = controller.connect(await impersonateAccount(await controller.owner()));
  //           await controller.addFee(
  //             morphoLeverageModule.address,
  //             ZERO, // Fee type on trade function denoted as 0
  //             feePercentage, // Set fee to 5 bps
  //           );
  //         });
  //         it("should transfer the correct components to the exchange", async () => {
  //           // const oldSourceTokenBalance = await usdc.balanceOf(oneInchExchangeMockTowsteth.address);
  //           await subject();
  //           // const totalSourceQuantity = subjectBorrowQuantity;
  //           // const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
  //           // const newSourceTokenBalance = await usdc.balanceOf(oneInchExchangeMockTowsteth.address);
  //           // expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
  //         });
  //         it("should transfer the correct protocol fee to the protocol", async () => {
  //           const feeRecipient = await controller.feeRecipient();
  //           const oldFeeRecipientBalance = await wsteth.balanceOf(feeRecipient);
  //           await subject();
  //           const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(
  //             preciseMul(feePercentage, destinationTokenQuantity),
  //           );
  //           const newFeeRecipientBalance = await wsteth.balanceOf(feeRecipient);
  //           expect(newFeeRecipientBalance).to.gte(expectedFeeRecipientBalance);
  //         });
  //         it("should update the collateral position on the SetToken correctly", async () => {
  //           const initialPositions = await setToken.getPositions();
  //           await subject();
  //           // cEther position is increased
  //           const currentPositions = await setToken.getPositions();
  //           const newFirstPosition = (await setToken.getPositions())[0];
  //           // Get expected cTokens minted
  //           const unitProtocolFee = feePercentage.mul(subjectMinCollateralQuantity).div(ether(1));
  //           const newUnits = subjectMinCollateralQuantity.sub(unitProtocolFee);
  //           const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);
  //           expect(initialPositions.length).to.eq(1);
  //           expect(currentPositions.length).to.eq(2);
  //           expect(newFirstPosition.component).to.eq(awsteth.address);
  //           expect(newFirstPosition.positionState).to.eq(0); // Default
  //           expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
  //           expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
  //         });
  //         it("should update the borrow position on the SetToken correctly", async () => {
  //           const initialPositions = await setToken.getPositions();
  //           await subject();
  //           // cEther position is increased
  //           const currentPositions = await setToken.getPositions();
  //           const newSecondPosition = (await setToken.getPositions())[1];
  //           const expectedSecondPositionUnit = (
  //             await variableDebtUSDC.balanceOf(setToken.address)
  //           ).mul(-1);
  //           expect(initialPositions.length).to.eq(1);
  //           expect(currentPositions.length).to.eq(2);
  //           expect(newSecondPosition.component).to.eq(usdc.address);
  //           expect(newSecondPosition.positionState).to.eq(1); // External
  //           expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
  //           expect(newSecondPosition.module).to.eq(morphoLeverageModule.address);
  //         });
  //       });
  //       describe("when the exchange is not valid", async () => {
  //         beforeEach(async () => {
  //           subjectTradeAdapterName = "INVALID";
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("Must be valid adapter");
  //         });
  //       });
  //       describe("when collateral asset is not enabled", async () => {
  //         beforeEach(async () => {
  //           subjectCollateralAsset = wbtc.address;
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("CNE");
  //         });
  //       });
  //       describe("when borrow asset is not enabled", async () => {
  //         beforeEach(async () => {
  //           subjectBorrowAsset = await getRandomAddress();
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("BNE");
  //         });
  //       });
  //       describe("when borrow asset is same as collateral asset", async () => {
  //         beforeEach(async () => {
  //           subjectBorrowAsset = wsteth.address;
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("CBE");
  //         });
  //       });
  //       describe("when quantity of token to sell is 0", async () => {
  //         beforeEach(async () => {
  //           subjectBorrowQuantity = ZERO;
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("ZQ");
  //         });
  //       });
  //       describe("when the caller is not the SetToken manager", async () => {
  //         beforeEach(async () => {
  //           subjectCaller = await getRandomAccount();
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //         });
  //       });
  //       describe("when SetToken is not valid", async () => {
  //         beforeEach(async () => {
  //           const nonEnabledSetToken = await createNonControllerEnabledSetToken(
  //             [wsteth.address],
  //             [ether(1)],
  //             [morphoLeverageModule.address],
  //           );
  //           subjectSetToken = nonEnabledSetToken.address;
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //         });
  //       });
  //     });
  //     describe("when module is not initialized", async () => {
  //       beforeEach(async () => {
  //         isInitialized = false;
  //         await initializeContracts();
  //         initializeSubjectVariables();
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //       });
  //     });
  //   });

  //   context("when USDC is borrow asset, and is a default position", async () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(async () => {
  //       setToken = await createSetToken(
  //         [awsteth.address, usdc.address],
  //         [ether(2), ether(1)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //       // Initialize module if set to true
  //       if (isInitialized) {
  //         await morphoLeverageModule.initialize(
  //           setToken.address,
  //           [wsteth.address, usdc.address],
  //           [usdc.address, wsteth.address],
  //         );
  //       }
  //       // Mint aTokens
  //       await wsteth.approve(aaveLendingPool.address, ether(1000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(wsteth.address, ether(1000), owner.address, ZERO);
  //       await usdc.approve(aaveLendingPool.address, ether(10000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(usdc.address, ether(10000), owner.address, ZERO);
  //       // Approve tokens to issuance module and call issue
  //       await awsteth.approve(debtIssuanceModule.address, ether(1000));
  //       await usdc.approve(debtIssuanceModule.address, ether(10000));
  //       // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //       const issueQuantity = ether(1);
  //       destinationTokenQuantity = ether(1);
  //       await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //     });
  //     beforeEach(async () => {
  //       subjectSetToken = setToken.address;
  //       subjectBorrowAsset = usdc.address;
  //       subjectCollateralAsset = wsteth.address;
  //       subjectBorrowQuantity = ether(1000);
  //       subjectMinCollateralQuantity = destinationTokenQuantity.div(2);
  //       subjectTradeAdapterName = "UNISWAPV3";
  //       subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //         [usdc.address, wsteth.address], // Swap path
  //         [500], // Fees
  //         true,
  //       );
  //       subjectCaller = owner;
  //     });
  //     it("should update the collateral position on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();
  //       await subject();
  //       // cEther position is increased
  //       const currentPositions = await setToken.getPositions();
  //       const newFirstPosition = (await setToken.getPositions())[0];
  //       const newSecondPosition = (await setToken.getPositions())[1];
  //       // Get expected aTokens minted
  //       const newUnits = subjectMinCollateralQuantity;
  //       const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);
  //       expect(initialPositions.length).to.eq(2);
  //       expect(currentPositions.length).to.eq(3);
  //       expect(newFirstPosition.component).to.eq(awsteth.address);
  //       expect(newFirstPosition.positionState).to.eq(0); // Default
  //       expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
  //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
  //       expect(newSecondPosition.component).to.eq(usdc.address);
  //       expect(newSecondPosition.positionState).to.eq(0); // Default
  //       expect(newSecondPosition.unit).to.eq(ether(1));
  //       expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //     });
  //     it("should update the borrow position on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();
  //       await subject();
  //       // cEther position is increased
  //       const currentPositions = await setToken.getPositions();
  //       const newThridPosition = (await setToken.getPositions())[2];
  //       const expectedPositionUnit = (await variableDebtUSDC.balanceOf(setToken.address)).mul(-1);
  //       expect(initialPositions.length).to.eq(2);
  //       expect(currentPositions.length).to.eq(3);
  //       expect(newThridPosition.component).to.eq(usdc.address);
  //       expect(newThridPosition.positionState).to.eq(1); // External
  //       expect(newThridPosition.unit).to.eq(expectedPositionUnit);
  //       expect(newThridPosition.module).to.eq(morphoLeverageModule.address);
  //     });
  //   });
  // });

  // describe("#setEModeCategory", () => {
  //   let setToken: SetToken;
  //   let subjectCategoryId: number;
  //   let subjectSetToken: Address;
  //   let caller: Signer;
  //   const initializeContracts = async () => {
  //     setToken = await createSetToken(
  //       [aWstEth.address, wsteth.address],
  //       [ether(2), ether(1)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Initialize module if set to true
  //     await morphoLeverageModule.initialize(
  //       setToken.address,
  //       [wsteth.address, wsteth.address],
  //       [wsteth.address, wsteth.address],
  //     );

  //     // Mint aTokens
  //     await network.provider.send("hardhat_setBalance", [whales.wsteth, ether(10).toHexString()]);
  //     await wsteth
  //       .connect(await impersonateAccount(whales.wsteth))
  //       .transfer(owner.address, ether(10000));
  //     await wsteth.approve(aaveLendingPool.address, ether(10000));
  //     await aaveLendingPool
  //       .connect(owner.wallet)
  //       .deposit(wsteth.address, ether(10000), owner.address, ZERO);

  //     await wsteth.approve(aaveLendingPool.address, ether(1000));
  //     await aaveLendingPool
  //       .connect(owner.wallet)
  //       .deposit(wsteth.address, ether(1000), owner.address, ZERO);

  //     // Approve tokens to issuance module and call issue
  //     await aWstEth.approve(debtIssuanceModule.address, ether(10000));
  //     await wsteth.approve(debtIssuanceModule.address, ether(1000));

  //     // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //     const issueQuantity = ether(1);
  //     await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

  //     // This is a borrow amount that will fail in normal mode but should work in e-mode
  //     const borrowAmount = utils.parseEther("1.5");

  //     const leverageTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //       [wsteth.address, wsteth.address], // Swap path
  //       [500], // Fees
  //       true,
  //     );
  //     console.log("levering up");
  //     await morphoLeverageModule.lever(
  //       setToken.address,
  //       wsteth.address,
  //       wsteth.address,
  //       borrowAmount,
  //       utils.parseEther("0.1"),
  //       "UNISWAPV3",
  //       leverageTradeData,
  //     );
  //     console.log("levered up");
  //   };

  //   cacheBeforeEach(initializeContracts);

  //   beforeEach(() => {
  //     subjectSetToken = setToken.address;
  //     caller = owner.wallet;
  //   });

  //   const subject = () =>
  //     morphoLeverageModule.connect(caller).setEModeCategory(subjectSetToken, subjectCategoryId);

  //   describe("When changing the EMode Category from default to 1", async () => {
  //     beforeEach(() => {
  //       subjectCategoryId = 1;
  //     });
  //     it("sets the EMode category for the set Token user correctly", async () => {
  //       await subject();
  //       const categoryId = await aaveLendingPool.getUserEMode(subjectSetToken);
  //       expect(categoryId).to.eq(subjectCategoryId);
  //     });

  //     it("Increases liquidationThreshold and healthFactor", async () => {
  //       const userDataBefore = await aaveLendingPool.getUserAccountData(subjectSetToken);
  //       await subject();
  //       const userDataAfter = await aaveLendingPool.getUserAccountData(subjectSetToken);
  //       expect(userDataAfter.healthFactor).to.be.gt(userDataBefore.healthFactor);
  //       expect(userDataAfter.currentLiquidationThreshold).to.be.gt(
  //         userDataBefore.currentLiquidationThreshold,
  //       );
  //     });
  //   });

  //   describe("When category has been set to 1 (ETH)", async () => {
  //     beforeEach(async () => {
  //       await morphoLeverageModule.setEModeCategory(subjectSetToken, 1);
  //     });
  //     describe("When setting the category back to 0", async () => {
  //       beforeEach(() => {
  //         subjectCategoryId = 0;
  //       });
  //       it("sets the EMode category for the set Token user correctly", async () => {
  //         await subject();
  //         const categoryId = await aaveLendingPool.getUserEMode(subjectSetToken);
  //         expect(categoryId).to.eq(subjectCategoryId);
  //       });
  //     });
  //   });

  //   describe("When caller is not the owner", async () => {
  //     beforeEach(async () => {
  //       caller = notOwner.wallet;
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //     });
  //   });
  // });

  // describe("#delever", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;

  //   let subjectSetToken: Address;
  //   let subjectCollateralAsset: Address;
  //   let subjectRepayAsset: Address;
  //   let subjectRedeemQuantity: BigNumber;
  //   let subjectMinRepayQuantity: BigNumber;
  //   let subjectTradeAdapterName: string;
  //   let subjectTradeData: Bytes;
  //   let subjectCaller: Account;

  //   const initializeContracts = async () => {
  //     setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(10)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Initialize module if set to true
  //     if (isInitialized) {
  //       await morphoLeverageModule.initialize(
  //         setToken.address,
  //         [wsteth.address, usdc.address],
  //         [usdc.address, wsteth.address],
  //       );
  //     }

  //     const issueQuantity = ether(10);

  //     await wsteth.approve(aaveLendingPool.address, ether(100));
  //     await aaveLendingPool
  //       .connect(owner.wallet)
  //       .deposit(wsteth.address, ether(100), owner.address, ZERO);
  //     await awsteth.approve(debtIssuanceModule.address, ether(100));
  //     await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

  //     // Lever SetToken
  //     if (isInitialized) {
  //       const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //         [usdc.address, wsteth.address], // Swap path
  //         [500], // fees
  //         true,
  //       );

  //       await morphoLeverageModule.lever(
  //         setToken.address,
  //         usdc.address,
  //         wsteth.address,
  //         ether(2000),
  //         ether(1),
  //         "UNISWAPV3",
  //         leverTradeData,
  //       );
  //     }
  //   };

  //   const initializeSubjectVariables = async () => {
  //     subjectSetToken = setToken.address;
  //     subjectCollateralAsset = wsteth.address;
  //     subjectRepayAsset = usdc.address;
  //     subjectRedeemQuantity = ether(2);
  //     subjectTradeAdapterName = "UNISWAPV3";
  //     subjectMinRepayQuantity = ZERO;
  //     subjectCaller = owner;
  //     subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //       [wsteth.address, usdc.address], // Swap path
  //       [500], // Send quantity
  //       true,
  //     );
  //   };

  //   async function subject(): Promise<ContractTransaction> {
  //     return await morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .delever(
  //         subjectSetToken,
  //         subjectCollateralAsset,
  //         subjectRepayAsset,
  //         subjectRedeemQuantity,
  //         subjectMinRepayQuantity,
  //         subjectTradeAdapterName,
  //         subjectTradeData,
  //       );
  //   }

  //   describe("when module is initialized", async () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });

  //     cacheBeforeEach(initializeContracts);
  //     beforeEach(initializeSubjectVariables);

  //     it("should update the collateral position on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();

  //       await subject();

  //       const currentPositions = await setToken.getPositions();
  //       const newFirstPosition = (await setToken.getPositions())[0];

  //       // Get expected aTokens burnt
  //       const removedUnits = subjectRedeemQuantity;
  //       const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

  //       expect(initialPositions.length).to.eq(2);
  //       expect(currentPositions.length).to.eq(2);
  //       expect(newFirstPosition.component).to.eq(awsteth.address);
  //       expect(newFirstPosition.positionState).to.eq(0); // Default
  //       // When switching to uniswapV3 integration testing had to add some small tolerance here
  //       // TODO: understand why
  //       expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
  //       expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
  //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
  //     });

  //     it("should wipe the debt on Aave", async () => {
  //       await subject();

  //       const borrowDebt = await variableDebtUSDC.balanceOf(setToken.address);

  //       expect(borrowDebt).to.eq(ZERO);
  //     });

  //     it("should remove external positions on the borrow asset", async () => {
  //       await subject();

  //       const borrowAssetExternalModules = await setToken.getExternalPositionModules(usdc.address);
  //       const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
  //         usdc.address,
  //         morphoLeverageModule.address,
  //       );
  //       const isPositionModule = await setToken.isExternalPositionModule(
  //         usdc.address,
  //         morphoLeverageModule.address,
  //       );

  //       expect(borrowAssetExternalModules.length).to.eq(0);
  //       expect(borrowExternalUnit).to.eq(ZERO);
  //       expect(isPositionModule).to.eq(false);
  //     });

  //     it("should update the borrow asset equity on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();

  //       const tx = await subject();

  //       // Fetch total repay amount
  //       const res = await tx.wait();
  //       const levDecreasedEvent = res.events?.find(value => {
  //         return value.event == "LeverageDecreased";
  //       });
  //       expect(levDecreasedEvent).to.not.eq(undefined);

  //       const initialSecondPosition = initialPositions[1];

  //       const currentPositions = await setToken.getPositions();
  //       const newSecondPosition = (await setToken.getPositions())[1];

  //       expect(initialPositions.length).to.eq(2);
  //       expect(currentPositions.length).to.eq(2);
  //       expect(newSecondPosition.component).to.eq(usdc.address);
  //       expect(newSecondPosition.positionState).to.eq(0); // Default
  //       expect(newSecondPosition.unit).to.gt(initialSecondPosition.unit);
  //       expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //     });

  //     it("should transfer the correct components to the exchange", async () => {
  //       const oldSourceTokenBalance = await wsteth.balanceOf(wstethUsdcPool.address);

  //       await subject();
  //       const totalSourceQuantity = subjectRedeemQuantity;
  //       const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
  //       const newSourceTokenBalance = await wsteth.balanceOf(wstethUsdcPool.address);
  //       // Had to add some tolerance here when switching to morpho integration testing
  //       // TODO: understand why
  //       expect(newSourceTokenBalance).to.lt(expectedSourceTokenBalance.mul(102).div(100));
  //       expect(newSourceTokenBalance).to.gt(expectedSourceTokenBalance.mul(99).div(100));
  //     });

  //     it("should transfer the correct components from the exchange", async () => {
  //       // const [, repayAssetAmountOut] = await uniswapV3Router.getAmountsOut(subjectRedeemQuantity, [
  //       //   wsteth.address,
  //       //   usdc.address,
  //       // ]);
  //       const oldDestinationTokenBalance = await usdc.balanceOf(wstethUsdcPool.address);

  //       await subject();
  //       // const totalDestinationQuantity = repayAssetAmountOut;
  //       // const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
  //       //   totalDestinationQuantity,
  //       // );
  //       const newDestinationTokenBalance = await usdc.balanceOf(wstethUsdcPool.address);
  //       expect(newDestinationTokenBalance).to.lt(oldDestinationTokenBalance);
  //     });

  //     describe("when the exchange is not valid", async () => {
  //       beforeEach(async () => {
  //         subjectTradeAdapterName = "INVALID";
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be valid adapter");
  //       });
  //     });

  //     describe("when borrow / repay asset is not enabled", async () => {
  //       beforeEach(async () => {
  //         subjectRepayAsset = wbtc.address;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("BNE");
  //       });
  //     });

  //     describe("when the caller is not the SetToken manager", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = await getRandomAccount();
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //       });
  //     });

  //     describe("when SetToken is not valid", async () => {
  //       beforeEach(async () => {
  //         const nonEnabledSetToken = await createNonControllerEnabledSetToken(
  //           [wsteth.address],
  //           [ether(1)],
  //           [morphoLeverageModule.address],
  //         );

  //         subjectSetToken = nonEnabledSetToken.address;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //       });
  //     });
  //   });

  //   describe("when module is not initialized", async () => {
  //     beforeEach(async () => {
  //       isInitialized = false;
  //       await initializeContracts();
  //       initializeSubjectVariables();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //     });
  //   });
  // });

  // describe("#deleverToZeroBorrowBalance", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;

  //   let subjectSetToken: Address;
  //   let subjectCollateralAsset: Address;
  //   let subjectRepayAsset: Address;
  //   let subjectRedeemQuantity: BigNumber;
  //   let subjectTradeAdapterName: string;
  //   let subjectTradeData: Bytes;
  //   let subjectCaller: Account;

  //   const initializeContracts = async () => {
  //     setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(10)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Initialize module if set to true
  //     if (isInitialized) {
  //       await morphoLeverageModule.initialize(
  //         setToken.address,
  //         [wsteth.address, usdc.address],
  //         [usdc.address, wsteth.address],
  //       );
  //     }

  //     const issueQuantity = ether(10);

  //     await wsteth.approve(aaveLendingPool.address, ether(100));
  //     await aaveLendingPool
  //       .connect(owner.wallet)
  //       .deposit(wsteth.address, ether(100), owner.address, ZERO);
  //     await awsteth.approve(debtIssuanceModule.address, ether(100));
  //     await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

  //     // Lever SetToken
  //     if (isInitialized) {
  //       const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //         [usdc.address, wsteth.address], // Swap path
  //         [500], // fees
  //         true,
  //       );

  //       await morphoLeverageModule.lever(
  //         setToken.address,
  //         usdc.address,
  //         wsteth.address,
  //         ether(2000),
  //         ether(1),
  //         "UNISWAPV3",
  //         leverTradeData,
  //       );
  //     }
  //   };

  //   const initializeSubjectVariables = async () => {
  //     subjectSetToken = setToken.address;
  //     subjectCollateralAsset = wsteth.address;
  //     subjectRepayAsset = usdc.address;
  //     subjectRedeemQuantity = ether(2);
  //     subjectTradeAdapterName = "UNISWAPV3";
  //     subjectCaller = owner;
  //     subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //       [wsteth.address, usdc.address], // Swap path
  //       [500], // Send quantity
  //       true,
  //     );
  //   };

  //   async function subject(): Promise<ContractTransaction> {
  //     return await morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .deleverToZeroBorrowBalance(
  //         subjectSetToken,
  //         subjectCollateralAsset,
  //         subjectRepayAsset,
  //         subjectRedeemQuantity,
  //         subjectTradeAdapterName,
  //         subjectTradeData,
  //       );
  //   }

  //   describe("when module is initialized", async () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });

  //     cacheBeforeEach(initializeContracts);
  //     beforeEach(initializeSubjectVariables);

  //     it("should update the collateral position on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();

  //       await subject();

  //       const currentPositions = await setToken.getPositions();
  //       const newFirstPosition = (await setToken.getPositions())[0];

  //       // Get expected aTokens burnt
  //       const removedUnits = subjectRedeemQuantity;
  //       const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

  //       expect(initialPositions.length).to.eq(2);
  //       expect(currentPositions.length).to.eq(2);
  //       expect(newFirstPosition.component).to.eq(awsteth.address);
  //       expect(newFirstPosition.positionState).to.eq(0); // Default
  //       expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
  //       expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
  //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
  //     });

  //     it("should wipe the debt on Aave", async () => {
  //       await subject();

  //       const borrowDebt = await variableDebtUSDC.balanceOf(setToken.address);

  //       expect(borrowDebt).to.eq(ZERO);
  //     });

  //     it("should remove external positions on the borrow asset", async () => {
  //       await subject();

  //       const borrowAssetExternalModules = await setToken.getExternalPositionModules(usdc.address);
  //       const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
  //         usdc.address,
  //         morphoLeverageModule.address,
  //       );
  //       const isPositionModule = await setToken.isExternalPositionModule(
  //         usdc.address,
  //         morphoLeverageModule.address,
  //       );

  //       expect(borrowAssetExternalModules.length).to.eq(0);
  //       expect(borrowExternalUnit).to.eq(ZERO);
  //       expect(isPositionModule).to.eq(false);
  //     });

  //     it("should update the borrow asset equity on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();

  //       const swapPromise = waitForEvent(wstethUsdcPool, "Swap");
  //       const tx = await subject();

  //       // Fetch total repay amount
  //       const res = await tx.wait();
  //       await swapPromise;
  //       const levDecreasedEvent = res.events?.find(value => {
  //         return value.event == "LeverageDecreased";
  //       });
  //       expect(levDecreasedEvent).to.not.eq(undefined);

  //       const initialSecondPosition = initialPositions[1];

  //       const currentPositions = await setToken.getPositions();
  //       const newSecondPosition = (await setToken.getPositions())[1];

  //       expect(initialPositions.length).to.eq(2);
  //       expect(currentPositions.length).to.eq(2);
  //       expect(newSecondPosition.component).to.eq(usdc.address);
  //       expect(newSecondPosition.positionState).to.eq(0); // Default
  //       expect(newSecondPosition.unit).to.gt(initialSecondPosition.unit);
  //       expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //     });

  //     it("should transfer the correct components to the exchange", async () => {
  //       const oldSourceTokenBalance = await wsteth.balanceOf(wstethUsdcPool.address);

  //       await subject();
  //       const totalSourceQuantity = subjectRedeemQuantity;
  //       const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
  //       const newSourceTokenBalance = await wsteth.balanceOf(wstethUsdcPool.address);
  //       // Had to add some tolerance here when switching to morpho integration testing
  //       // TODO: understand why
  //       expect(newSourceTokenBalance).to.lt(expectedSourceTokenBalance.mul(102).div(100));
  //       expect(newSourceTokenBalance).to.gt(expectedSourceTokenBalance.mul(99).div(100));
  //     });

  //     it("should transfer the correct components from the exchange", async () => {
  //       // const [, repayAssetAmountOut] = await uniswapV3Router.getAmountsOut(subjectRedeemQuantity, [
  //       //   wsteth.address,
  //       //   usdc.address,
  //       // ]);
  //       const oldDestinationTokenBalance = await usdc.balanceOf(wstethUsdcPool.address);

  //       await subject();
  //       // const totalDestinationQuantity = repayAssetAmountOut;
  //       // const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
  //       //   totalDestinationQuantity,
  //       // );
  //       const newDestinationTokenBalance = await usdc.balanceOf(wstethUsdcPool.address);
  //       expect(newDestinationTokenBalance).to.lt(oldDestinationTokenBalance);
  //     });

  //     describe("when the exchange is not valid", async () => {
  //       beforeEach(async () => {
  //         subjectTradeAdapterName = "INVALID";
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be valid adapter");
  //       });
  //     });

  //     describe("when borrow / repay asset is not enabled", async () => {
  //       beforeEach(async () => {
  //         subjectRepayAsset = wbtc.address;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("BNE");
  //       });
  //     });

  //     describe("when borrow balance is 0", async () => {
  //       beforeEach(async () => {
  //         await morphoLeverageModule
  //           .connect(owner.wallet)
  //           .addBorrowAssets(setToken.address, [wbtc.address]);

  //         subjectRepayAsset = wbtc.address;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("BBZ");
  //       });
  //     });

  //     describe("when the caller is not the SetToken manager", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = await getRandomAccount();
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //       });
  //     });

  //     describe("when SetToken is not valid", async () => {
  //       beforeEach(async () => {
  //         const nonEnabledSetToken = await createNonControllerEnabledSetToken(
  //           [wsteth.address],
  //           [ether(1)],
  //           [morphoLeverageModule.address],
  //         );

  //         subjectSetToken = nonEnabledSetToken.address;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //       });
  //     });
  //   });

  //   describe("when module is not initialized", async () => {
  //     beforeEach(async () => {
  //       isInitialized = false;
  //       await initializeContracts();
  //       initializeSubjectVariables();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //     });
  //   });
  // });

  // describe("#sync", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;

  //   let subjectSetToken: Address;
  //   let subjectCaller: Account;

  //   const initializeSubjectVariables = async () => {
  //     subjectSetToken = setToken.address;
  //     subjectCaller = await getRandomAccount();
  //   };

  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule.connect(subjectCaller.wallet).sync(subjectSetToken);
  //   }

  //   context("when awsteth and aUSDC are collateral and wsteth and USDC are borrow assets", async () => {
  //     const initializeContracts = async () => {
  //       setToken = await createSetToken(
  //         [awsteth.address, aUSDC.address],
  //         [ether(2), ether(1000)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);

  //       // Initialize module if set to true
  //       if (isInitialized) {
  //         await morphoLeverageModule.initialize(
  //           setToken.address,
  //           [wsteth.address, usdc.address, wbtc.address], // Enable WBTC that is not a Set position
  //           [usdc.address, wsteth.address, wbtc.address],
  //         );
  //       }

  //       // Mint aTokens
  //       await wsteth.approve(aaveLendingPool.address, ether(1000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(wsteth.address, ether(1000), owner.address, ZERO);
  //       await usdc.approve(aaveLendingPool.address, ether(10000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(usdc.address, ether(10000), owner.address, ZERO);

  //       // Approve tokens to issuance module and call issue
  //       await awsteth.approve(debtIssuanceModule.address, ether(1000));
  //       await aUSDC.approve(debtIssuanceModule.address, ether(10000));

  //       // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //       const issueQuantity = ether(1);
  //       await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

  //       if (isInitialized) {
  //         // Leverage awsteth in SetToken
  //         const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [usdc.address, wsteth.address], // Swap path
  //           [500], // fees
  //           true,
  //         );

  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           usdc.address,
  //           wsteth.address,
  //           ether(2000),
  //           ether(1),
  //           "UNISWAPV3",
  //           leverEthTradeData,
  //         );

  //         const leverUsdcTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [wsteth.address, usdc.address], // Swap path
  //           [500], // fees
  //           true,
  //         );

  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           wsteth.address,
  //           usdc.address,
  //           ether(1),
  //           ether(1000),
  //           "UNISWAPV3",
  //           leverUsdcTradeData,
  //         );
  //       }
  //     };

  //     describe("when module is initialized", async () => {
  //       before(async () => {
  //         isInitialized = true;
  //       });

  //       cacheBeforeEach(initializeContracts);
  //       beforeEach(initializeSubjectVariables);

  //       it("should update the collateral positions on the SetToken correctly", async () => {
  //         const initialPositions = await setToken.getPositions();

  //         await subject();

  //         // cEther position is increased
  //         const currentPositions = await setToken.getPositions();
  //         const newFirstPosition = (await setToken.getPositions())[0];
  //         const newSecondPosition = (await setToken.getPositions())[1];

  //         const expectedFirstPositionUnit = await awsteth.balanceOf(setToken.address); // need not divide as total supply is 1.
  //         const expectedSecondPositionUnit = await aUSDC.balanceOf(setToken.address);

  //         expect(initialPositions.length).to.eq(4);
  //         expect(currentPositions.length).to.eq(4);
  //         expect(newFirstPosition.component).to.eq(awsteth.address);
  //         expect(newFirstPosition.positionState).to.eq(0); // Default
  //         expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
  //         expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

  //         expect(newSecondPosition.component).to.eq(aUSDC.address);
  //         expect(newSecondPosition.positionState).to.eq(0); // Default
  //         expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
  //         expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //       });

  //       it("should update the borrow positions on the SetToken correctly", async () => {
  //         const initialPositions = await setToken.getPositions();

  //         await subject();

  //         // cEther position is increased
  //         const currentPositions = await setToken.getPositions();
  //         const newThirdPosition = (await setToken.getPositions())[2];
  //         const newFourthPosition = (await setToken.getPositions())[3];

  //         const expectedThirdPositionUnit = (await variableDebtUSDC.balanceOf(setToken.address)).mul(
  //           -1,
  //         );
  //         const expectedFourthPositionUnit = (
  //           await variableDebtwsteth.balanceOf(setToken.address)
  //         ).mul(-1);

  //         expect(initialPositions.length).to.eq(4);
  //         expect(currentPositions.length).to.eq(4);
  //         expect(newThirdPosition.component).to.eq(usdc.address);
  //         expect(newThirdPosition.positionState).to.eq(1); // External
  //         expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
  //         expect(newThirdPosition.module).to.eq(morphoLeverageModule.address);

  //         expect(newFourthPosition.component).to.eq(wsteth.address);
  //         expect(newFourthPosition.positionState).to.eq(1); // External
  //         expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
  //         expect(newFourthPosition.module).to.eq(morphoLeverageModule.address);
  //       });

  //       describe("when leverage position has been liquidated", async () => {
  //         let liquidationRepayQuantity: BigNumber;
  //         let chainlinkAggregatorMock: ChainlinkAggregatorMock;
  //         let totalTokensSezied: BigNumber;
  //         const oracleDecimals = 8;

  //         cacheBeforeEach(async () => {
  //           chainlinkAggregatorMock = await deployer.mocks.deployChainlinkAggregatorMock(
  //             oracleDecimals,
  //           );
  //           // Leverage awsteth again
  //           const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //             [usdc.address, wsteth.address], // Swap path
  //             [500], // fees
  //             true,
  //           );

  //           await morphoLeverageModule.lever(
  //             setToken.address,
  //             usdc.address,
  //             wsteth.address,
  //             ether(2000),
  //             ether(1),
  //             "UNISWAPV3",
  //             leverEthTradeData,
  //           );
  //         });

  //         beforeEach(async () => {
  //           await subject();
  //           await aaveOracle.setAssetSources([usdc.address], [chainlinkAggregatorMock.address]);
  //           await chainlinkAggregatorMock.setLatestAnswer(utils.parseUnits("10.1", oracleDecimals));

  //           liquidationRepayQuantity = ether(100);
  //           await usdc.approve(aaveLendingPool.address, liquidationRepayQuantity);

  //           const awstethBalanceBefore = await awsteth.balanceOf(setToken.address);
  //           await aaveLendingPool
  //             .connect(owner.wallet)
  //             .liquidationCall(
  //               wsteth.address,
  //               usdc.address,
  //               setToken.address,
  //               liquidationRepayQuantity,
  //               true,
  //             );
  //           const awstethBalanceAfter = await awsteth.balanceOf(setToken.address);
  //           totalTokensSezied = awstethBalanceBefore.sub(awstethBalanceAfter);
  //         });

  //         it("should update the collateral positions on the SetToken correctly", async () => {
  //           const initialPositions = await setToken.getPositions();

  //           await subject();

  //           const currentPositions = await setToken.getPositions();
  //           const newFirstPosition = currentPositions[0];
  //           const newSecondPosition = currentPositions[1];

  //           const expectedFirstPositionUnit = initialPositions[0].unit.sub(totalTokensSezied);

  //           // awsteth position decreases
  //           expect(newFirstPosition.component).to.eq(awsteth.address);
  //           expect(newFirstPosition.positionState).to.eq(0); // Default
  //           expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(9999).div(10000));
  //           expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(10001).div(10000));
  //           expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

  //           // cUSDC position should stay the same
  //           expect(newSecondPosition.component).to.eq(aUSDC.address);
  //           expect(newSecondPosition.positionState).to.eq(0); // Default
  //           expect(newSecondPosition.unit).to.eq(newSecondPosition.unit);
  //           expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //         });

  //         it("should update the borrow position on the SetToken correctly", async () => {
  //           const initialPositions = await setToken.getPositions();

  //           await subject();

  //           const currentPositions = await setToken.getPositions();
  //           const newThirdPosition = (await setToken.getPositions())[2];
  //           const newFourthPosition = (await setToken.getPositions())[3];

  //           const expectedThirdPositionUnit = (
  //             await variableDebtUSDC.balanceOf(setToken.address)
  //           ).mul(-1);
  //           const expectedFourthPositionUnit = (
  //             await variableDebtwsteth.balanceOf(setToken.address)
  //           ).mul(-1);

  //           expect(initialPositions.length).to.eq(4);
  //           expect(currentPositions.length).to.eq(4);

  //           expect(newThirdPosition.component).to.eq(usdc.address);
  //           expect(newThirdPosition.positionState).to.eq(1); // External
  //           expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
  //           expect(newThirdPosition.module).to.eq(morphoLeverageModule.address);

  //           expect(newFourthPosition.component).to.eq(wsteth.address);
  //           expect(newFourthPosition.positionState).to.eq(1); // External
  //           expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
  //           expect(newFourthPosition.module).to.eq(morphoLeverageModule.address);
  //         });
  //       });

  //       describe("when SetToken is not valid", async () => {
  //         beforeEach(async () => {
  //           const nonEnabledSetToken = await createNonControllerEnabledSetToken(
  //             [wsteth.address],
  //             [ether(1)],
  //             [morphoLeverageModule.address],
  //           );

  //           subjectSetToken = nonEnabledSetToken.address;
  //         });

  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //         });
  //       });
  //     });

  //     describe("when module is not initialized", async () => {
  //       beforeEach(() => {
  //         isInitialized = false;
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //       });
  //     });
  //   });

  //   describe("when set token total supply is 0", async () => {
  //     const initializeContracts = async () => {
  //       setToken = await createSetToken(
  //         [awsteth.address, aUSDC.address],
  //         [ether(2), ether(1000)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);

  //       // Initialize module if set to true
  //       await morphoLeverageModule.initialize(
  //         setToken.address,
  //         [wsteth.address, usdc.address],
  //         [usdc.address, wsteth.address],
  //       );
  //     };

  //     beforeEach(async () => {
  //       await initializeContracts();
  //       await initializeSubjectVariables();
  //     });

  //     it("should preserve default positions", async () => {
  //       const initialPositions = await setToken.getPositions();
  //       await subject();
  //       const currentPositions = await setToken.getPositions();

  //       expect(currentPositions.length).to.eq(2); // 2 Default positions
  //       expect(initialPositions.length).to.eq(2);

  //       expect(currentPositions[0].component).to.eq(awsteth.address);
  //       expect(currentPositions[0].positionState).to.eq(0); // Default
  //       expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
  //       expect(currentPositions[0].module).to.eq(ADDRESS_ZERO);

  //       expect(currentPositions[1].component).to.eq(aUSDC.address);
  //       expect(currentPositions[1].positionState).to.eq(0); // Default
  //       expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
  //       expect(currentPositions[1].module).to.eq(ADDRESS_ZERO);
  //     });
  //   });
  // });

  // describe("#addCollateralAssets", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;

  //   let subjectSetToken: Address;
  //   let subjectCollateralAssets: Address[];
  //   let subjectCaller: Account;

  //   const initializeContracts = async () => {
  //     setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(1)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Initialize module if set to true
  //     if (isInitialized) {
  //       await morphoLeverageModule.initialize(setToken.address, [wsteth.address], []);
  //     }
  //   };

  //   const initializeSubjectVariables = () => {
  //     subjectSetToken = setToken.address;
  //     subjectCollateralAssets = [usdc.address];
  //     subjectCaller = owner;
  //   };

  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .addCollateralAssets(subjectSetToken, subjectCollateralAssets);
  //   }

  //   describe("when module is initialized", () => {
  //     before(() => {
  //       isInitialized = true;
  //     });

  //     cacheBeforeEach(initializeContracts);
  //     beforeEach(initializeSubjectVariables);

  //     it("should add the collateral asset to mappings", async () => {
  //       await subject();
  //       const collateralAssets = (await morphoLeverageModule.getEnabledAssets(setToken.address))[0];
  //       const isUsdcCollateral = await morphoLeverageModule.collateralAssetEnabled(
  //         setToken.address,
  //         usdc.address,
  //       );

  //       expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify([wsteth.address, usdc.address]));
  //       expect(isUsdcCollateral).to.be.true;
  //     });

  //     it("should emit the correct CollateralAssetsUpdated event", async () => {
  //       await expect(subject())
  //         .to.emit(morphoLeverageModule, "CollateralAssetsUpdated")
  //         .withArgs(subjectSetToken, true, subjectCollateralAssets);
  //     });

  //     context("before first issuance, aToken balance is zero", async () => {
  //       it("should not be able to enable collateral asset to be used as collateral on Aave", async () => {
  //         const beforeUsageAsCollateralEnabled = (
  //           await protocolDataProvider.getUserReserveData(usdc.address, setToken.address)
  //         ).usageAsCollateralEnabled;
  //         await subject();
  //         const afterUsageAsCollateralEnabled = (
  //           await protocolDataProvider.getUserReserveData(usdc.address, setToken.address)
  //         ).usageAsCollateralEnabled;

  //         expect(beforeUsageAsCollateralEnabled).to.be.false;
  //         expect(afterUsageAsCollateralEnabled).to.be.false;
  //       });
  //     });

  //     describe("when re-adding a removed collateral asset", async () => {
  //       beforeEach(async () => {
  //         // Mint aTokens
  //         await wsteth.approve(aaveLendingPool.address, ether(1000));
  //         await aaveLendingPool
  //           .connect(owner.wallet)
  //           .deposit(wsteth.address, ether(1000), owner.address, ZERO);

  //         // Approve tokens to issuance module and call issue
  //         await awsteth.approve(debtIssuanceModule.address, ether(1000));

  //         // Transfer of aToken to SetToken during issuance would enable the underlying to be used as collateral by SetToken on Aave
  //         const issueQuantity = ether(1);
  //         await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

  //         // Now remove collateral asset to disable underlying to be used as collateral on Aave
  //         await morphoLeverageModule.removeCollateralAssets(setToken.address, [wsteth.address]);

  //         subjectCollateralAssets = [wsteth.address]; // re-add wsteth
  //       });

  //       it("should re-enable asset to be used as collateral on Aave", async () => {
  //         const beforeUsageAsCollateralEnabled = (
  //           await protocolDataProvider.getUserReserveData(wsteth.address, setToken.address)
  //         ).usageAsCollateralEnabled;
  //         await subject();
  //         const afterUsageAsCollateralEnabled = (
  //           await protocolDataProvider.getUserReserveData(wsteth.address, setToken.address)
  //         ).usageAsCollateralEnabled;
  //         expect(beforeUsageAsCollateralEnabled).to.be.false;
  //         expect(afterUsageAsCollateralEnabled).to.be.true;
  //       });
  //     });

  //     describe("when collateral asset is duplicated", async () => {
  //       beforeEach(async () => {
  //         subjectCollateralAssets = [wsteth.address, wsteth.address];
  //       });

  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Collateral already enabled");
  //       });
  //     });

  //     describe("when a new Aave reserve is added as collateral", async () => {
  //       let mockToken: StandardTokenMock;
  //       beforeEach(async () => {
  //         mockToken = await registerMockToken();
  //         subjectCollateralAssets = [mockToken.address];
  //       });

  //       describe("when asset can be used as collateral", async () => {
  //         beforeEach(async () => {
  //           const ltv = 5500;
  //           const liquidationThreshold = 6100;
  //           const liquidationBonus = 10830;
  //           await lendingPoolConfigurator.configureReserveAsCollateral(
  //             mockToken.address,
  //             ltv,
  //             liquidationThreshold,
  //             liquidationBonus,
  //           );
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("Invalid aToken address");
  //         });

  //         describe("when updateUnderlyingToReserveTokenMappings is called before", async () => {
  //           beforeEach(async () => {
  //             await morphoLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
  //           });

  //           it("should add collateral asset to mappings", async () => {
  //             await subject();
  //             const collateralAssets = (
  //               await morphoLeverageModule.getEnabledAssets(setToken.address)
  //             )[0];
  //             const isMockTokenCollateral = await morphoLeverageModule.collateralAssetEnabled(
  //               setToken.address,
  //               mockToken.address,
  //             );

  //             expect(JSON.stringify(collateralAssets)).to.eq(
  //               JSON.stringify([wsteth.address, mockToken.address]),
  //             );
  //             expect(isMockTokenCollateral).to.be.true;
  //           });
  //         });

  //         describe("when collateral asset does not exist on Aave", async () => {
  //           beforeEach(async () => {
  //             subjectCollateralAssets = [await getRandomAddress()];
  //           });

  //           it("should revert", async () => {
  //             await expect(subject()).to.be.revertedWith("IAR");
  //           });
  //         });
  //         describe("when the caller is not the SetToken manager", async () => {
  //           beforeEach(async () => {
  //             subjectCaller = await getRandomAccount();
  //           });

  //           it("should revert", async () => {
  //             await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //           });
  //         });
  //       });

  //       describe("when asset can not be used as collateral", async () => {
  //         beforeEach(async () => {
  //           await morphoLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("CNE");
  //         });
  //       });
  //     });
  //   });

  //   describe("when module is not initialized", async () => {
  //     beforeEach(async () => {
  //       isInitialized = false;
  //       await initializeContracts();
  //       initializeSubjectVariables();
  //     });

  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //     });
  //   });
  // });

  // describe("#addBorrowAssets", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let subjectSetToken: Address;
  //   let subjectBorrowAssets: Address[];
  //   let subjectCaller: Account;
  //   const initializeContracts = async () => {
  //     setToken = await createSetToken(
  //       [wsteth.address, usdc.address],
  //       [ether(1), ether(100)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Initialize module if set to true
  //     if (isInitialized) {
  //       await morphoLeverageModule.initialize(setToken.address, [], [wsteth.address]);
  //     }
  //   };
  //   const initializeSubjectVariables = () => {
  //     subjectSetToken = setToken.address;
  //     subjectBorrowAssets = [usdc.address];
  //     subjectCaller = owner;
  //   };
  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .addBorrowAssets(subjectSetToken, subjectBorrowAssets);
  //   }
  //   describe("when module is initialized", () => {
  //     beforeEach(() => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(initializeContracts);
  //     beforeEach(initializeSubjectVariables);
  //     it("should add the borrow asset to mappings", async () => {
  //       await subject();
  //       const borrowAssets = (await morphoLeverageModule.getEnabledAssets(setToken.address))[1];
  //       const isUSDCBorrow = await morphoLeverageModule.borrowAssetEnabled(
  //         setToken.address,
  //         usdc.address,
  //       );
  //       expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([wsteth.address, usdc.address]));
  //       expect(isUSDCBorrow).to.be.true;
  //     });
  //     it("should emit the correct BorrowAssetsUpdated event", async () => {
  //       await expect(subject())
  //         .to.emit(morphoLeverageModule, "BorrowAssetsUpdated")
  //         .withArgs(subjectSetToken, true, subjectBorrowAssets);
  //     });
  //     describe("when borrow asset is duplicated", async () => {
  //       beforeEach(async () => {
  //         subjectBorrowAssets = [usdc.address, usdc.address];
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Borrow already enabled");
  //       });
  //     });
  //     describe("when a new Aave reserve is added as borrow", async () => {
  //       let mockToken: StandardTokenMock;
  //       beforeEach(async () => {
  //         mockToken = await registerMockToken();
  //         subjectBorrowAssets = [mockToken.address];
  //       });
  //       describe("when asset can be borrowed", async () => {
  //         beforeEach(async () => {
  //           await lendingPoolConfigurator.setReserveBorrowing(mockToken.address, true);
  //         });

  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("Invalid variable debt token address");
  //         });
  //         describe("when updateUnderlyingToReserveTokenMappings is called before", async () => {
  //           beforeEach(async () => {
  //             await morphoLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
  //           });
  //           it("should add collateral asset to mappings", async () => {
  //             await subject();
  //             const borrowAssets = (await morphoLeverageModule.getEnabledAssets(setToken.address))[1];
  //             const isMockTokenBorrow = await morphoLeverageModule.borrowAssetEnabled(
  //               setToken.address,
  //               mockToken.address,
  //             );
  //             expect(JSON.stringify(borrowAssets)).to.eq(
  //               JSON.stringify([wsteth.address, mockToken.address]),
  //             );
  //             expect(isMockTokenBorrow).to.be.true;
  //           });
  //         });
  //       });
  //       describe("when borrowing is disabled for an asset on Aave", async () => {
  //         beforeEach(async () => {
  //           await morphoLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
  //         });
  //         it("should revert", async () => {
  //           await expect(subject()).to.be.revertedWith("BNE");
  //         });
  //       });
  //     });
  //     describe("when borrow asset reserve does not exist on Aave", async () => {
  //       beforeEach(async () => {
  //         subjectBorrowAssets = [await getRandomAddress()];
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("IAR");
  //       });
  //     });
  //     describe("when borrow asset reserve is frozen on Aave", async () => {
  //       beforeEach(async () => {
  //         await lendingPoolConfigurator.setReserveFreeze(usdc.address, true);
  //       });
  //       afterEach(async () => {
  //         await lendingPoolConfigurator.setReserveFreeze(usdc.address, false);
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("FAR");
  //       });
  //     });
  //     describe("when the caller is not the SetToken manager", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = await getRandomAccount();
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //       });
  //     });
  //   });
  //   describe("when module is not initialized", async () => {
  //     beforeEach(async () => {
  //       isInitialized = false;
  //       await initializeContracts();
  //       initializeSubjectVariables();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //     });
  //   });
  // });

  // describe("#registerToModule", async () => {
  //   let setToken: SetToken;
  //   let otherIssuanceModule: DebtIssuanceMock;
  //   let isInitialized: boolean;
  //   let subjectSetToken: Address;
  //   let subjectDebtIssuanceModule: Address;
  //   const initializeContracts = async function () {
  //     otherIssuanceModule = await deployer.mocks.deployDebtIssuanceMock();
  //     await controller.addModule(otherIssuanceModule.address);
  //     setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(100)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Initialize module if set to true
  //     if (isInitialized) {
  //       await morphoLeverageModule.initialize(
  //         setToken.address,
  //         [wsteth.address, usdc.address, wbtc.address], // Enable WBTC that is not a Set position
  //         [usdc.address, wsteth.address, wbtc.address],
  //       );
  //     }
  //     // Add other issuance mock after initializing Aave Leverage module, so register is never called
  //     await setToken.addModule(otherIssuanceModule.address);
  //     await otherIssuanceModule.initialize(setToken.address);
  //   };
  //   const initializeSubjectVariables = () => {
  //     subjectSetToken = setToken.address;
  //     subjectDebtIssuanceModule = otherIssuanceModule.address;
  //   };
  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule.registerToModule(subjectSetToken, subjectDebtIssuanceModule);
  //   }
  //   describe("when module is initialized", () => {
  //     beforeEach(() => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(initializeContracts);
  //     beforeEach(initializeSubjectVariables);
  //     it("should register on the other issuance module", async () => {
  //       const previousIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
  //       await subject();
  //       const currentIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
  //       expect(previousIsRegistered).to.be.false;
  //       expect(currentIsRegistered).to.be.true;
  //     });
  //     describe("when SetToken is not valid", async () => {
  //       beforeEach(async () => {
  //         const nonEnabledSetToken = await createNonControllerEnabledSetToken(
  //           [wsteth.address],
  //           [ether(1)],
  //           [morphoLeverageModule.address],
  //         );
  //         subjectSetToken = nonEnabledSetToken.address;
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //       });
  //     });
  //     describe("when debt issuance module is not initialized on SetToken", async () => {
  //       beforeEach(async () => {
  //         await setToken.removeModule(otherIssuanceModule.address);
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Issuance not initialized");
  //       });
  //     });
  //   });
  //   describe("when module is not initialized", async () => {
  //     beforeEach(async () => {
  //       isInitialized = false;
  //       await initializeContracts();
  //       initializeSubjectVariables();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //     });
  //   });
  // });

  // describe("#moduleIssueHook", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let subjectSetToken: Address;
  //   let subjectCaller: Account;
  //   context("when awsteth and aUSDC are collateral and wsteth and USDC are borrow assets", async () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(async () => {
  //       // Add mock module to controller
  //       await controller.addModule(mockModule.address);
  //       setToken = await createSetToken(
  //         [awsteth.address, aUSDC.address],
  //         [ether(10), ether(5000)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //       // Initialize module if set to true
  //       if (isInitialized) {
  //         await morphoLeverageModule.initialize(
  //           setToken.address,
  //           [wsteth.address, usdc.address, wbtc.address], // Enable WBTC that is not a Set position
  //           [usdc.address, wsteth.address, wbtc.address],
  //         );
  //       }
  //       // Initialize mock module
  //       await setToken.addModule(mockModule.address);
  //       await setToken.connect(mockModule.wallet).initializeModule();
  //       // Mint aTokens
  //       await wsteth.approve(aaveLendingPool.address, ether(10));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(wsteth.address, ether(10), owner.address, ZERO);
  //       await usdc.approve(aaveLendingPool.address, ether(10000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(usdc.address, ether(10000), owner.address, ZERO);
  //       // Approve tokens to issuance module and call issue
  //       await awsteth.approve(debtIssuanceModule.address, ether(10));
  //       await aUSDC.approve(debtIssuanceModule.address, ether(10000));
  //       // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //       const issueQuantity = ether(1);
  //       await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //       // Lever both aUSDC and awsteth in SetToken
  //       if (isInitialized) {
  //         const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [usdc.address, wsteth.address], // Swap path
  //           [500], // fees
  //           true,
  //         );
  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           usdc.address,
  //           wsteth.address,
  //           ether(2000),
  //           ether(1),
  //           "UNISWAPV3",
  //           leverEthTradeData,
  //         );
  //         const leverUsdcTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [wsteth.address, usdc.address], // Swap path
  //           [500], // fees
  //           true,
  //         );
  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           wsteth.address,
  //           usdc.address,
  //           ether(1),
  //           ether(1000),
  //           "UNISWAPV3",
  //           leverUsdcTradeData,
  //         );
  //       }
  //     });
  //     beforeEach(() => {
  //       subjectSetToken = setToken.address;
  //       subjectCaller = mockModule;
  //     });
  //     async function subject(): Promise<any> {
  //       return morphoLeverageModule
  //         .connect(subjectCaller.wallet)
  //         .moduleIssueHook(subjectSetToken, ZERO);
  //     }
  //     it("should update the collateral positions on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();
  //       await subject();
  //       const currentPositions = await setToken.getPositions();
  //       const newFirstPosition = (await setToken.getPositions())[0];
  //       const newSecondPosition = (await setToken.getPositions())[1];
  //       const expectedFirstPositionUnit = await awsteth.balanceOf(setToken.address); // need not divide, since total Supply = 1
  //       const expectedSecondPositionUnit = await aUSDC.balanceOf(setToken.address);
  //       expect(initialPositions.length).to.eq(4);
  //       expect(currentPositions.length).to.eq(4);
  //       expect(newFirstPosition.component).to.eq(awsteth.address);
  //       expect(newFirstPosition.positionState).to.eq(0); // Default
  //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
  //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
  //       expect(newSecondPosition.component).to.eq(aUSDC.address);
  //       expect(newSecondPosition.positionState).to.eq(0); // Default
  //       expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
  //       expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //     });
  //     it("should update the borrow positions on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();
  //       await subject();
  //       // awsteth position is increased
  //       const currentPositions = await setToken.getPositions();
  //       const newThirdPosition = (await setToken.getPositions())[2];
  //       const newFourthPosition = (await setToken.getPositions())[3];
  //       const expectedThirdPositionUnit = (await variableDebtUSDC.balanceOf(setToken.address)).mul(
  //         -1,
  //       ); // since, variable debt mode
  //       const expectedFourthPositionUnit = (await variableDebtwsteth.balanceOf(setToken.address)).mul(
  //         -1,
  //       );
  //       expect(initialPositions.length).to.eq(4);
  //       expect(currentPositions.length).to.eq(4);
  //       expect(newThirdPosition.component).to.eq(usdc.address);
  //       expect(newThirdPosition.positionState).to.eq(1); // External
  //       expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
  //       expect(newThirdPosition.module).to.eq(morphoLeverageModule.address);
  //       expect(newFourthPosition.component).to.eq(wsteth.address);
  //       expect(newFourthPosition.positionState).to.eq(1); // External
  //       expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
  //       expect(newFourthPosition.module).to.eq(morphoLeverageModule.address);
  //     });
  //     describe("when caller is not module", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = owner;
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Only the module can call");
  //       });
  //     });
  //     describe("if disabled module is caller", async () => {
  //       beforeEach(async () => {
  //         await controller.removeModule(mockModule.address);
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
  //       });
  //     });
  //   });
  // });

  // describe("#moduleRedeemHook", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let subjectSetToken: Address;
  //   let subjectCaller: Account;
  //   context("when awsteth and aUSDC are collateral and wsteth and USDC are borrow assets", async () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(async () => {
  //       // Add mock module to controller
  //       await controller.addModule(mockModule.address);
  //       setToken = await createSetToken(
  //         [awsteth.address, aUSDC.address],
  //         [ether(10), ether(5000)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //       // Initialize module if set to true
  //       if (isInitialized) {
  //         await morphoLeverageModule.initialize(
  //           setToken.address,
  //           [wsteth.address, usdc.address, wbtc.address], // Enable WBTC that is not a Set position
  //           [usdc.address, wsteth.address, wbtc.address],
  //         );
  //       }
  //       // Initialize mock module
  //       await setToken.addModule(mockModule.address);
  //       await setToken.connect(mockModule.wallet).initializeModule();
  //       // Mint aTokens
  //       await wsteth.approve(aaveLendingPool.address, ether(10));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(wsteth.address, ether(10), owner.address, ZERO);
  //       await usdc.approve(aaveLendingPool.address, ether(10000));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(usdc.address, ether(10000), owner.address, ZERO);
  //       // Approve tokens to issuance module and call issue
  //       await awsteth.approve(debtIssuanceModule.address, ether(10));
  //       await aUSDC.approve(debtIssuanceModule.address, ether(10000));
  //       // Issue 10 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //       const issueQuantity = ether(1);
  //       await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //       // Lever both aUSDC and awsteth in SetToken
  //       if (isInitialized) {
  //         const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [usdc.address, wsteth.address], // Swap path
  //           [500], // fees
  //           true,
  //         );
  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           usdc.address,
  //           wsteth.address,
  //           ether(2000),
  //           ether(1),
  //           "UNISWAPV3",
  //           leverEthTradeData,
  //         );
  //         const leverUsdcTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [wsteth.address, usdc.address], // Swap path
  //           [500], // fees
  //           true,
  //         );
  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           wsteth.address,
  //           usdc.address,
  //           ether(1),
  //           ether(1000),
  //           "UNISWAPV3",
  //           leverUsdcTradeData,
  //         );
  //       }
  //     });
  //     beforeEach(() => {
  //       subjectSetToken = setToken.address;
  //       subjectCaller = mockModule;
  //     });
  //     async function subject(): Promise<any> {
  //       return morphoLeverageModule
  //         .connect(subjectCaller.wallet)
  //         .moduleRedeemHook(subjectSetToken, ZERO);
  //     }
  //     it("should update the collateral positions on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();
  //       await subject();
  //       const currentPositions = await setToken.getPositions();
  //       const newFirstPosition = (await setToken.getPositions())[0];
  //       const newSecondPosition = (await setToken.getPositions())[1];
  //       const expectedFirstPositionUnit = await awsteth.balanceOf(setToken.address); // need not divide, since total Supply = 1
  //       const expectedSecondPositionUnit = await aUSDC.balanceOf(setToken.address);
  //       expect(initialPositions.length).to.eq(4);
  //       expect(currentPositions.length).to.eq(4);
  //       expect(newFirstPosition.component).to.eq(awsteth.address);
  //       expect(newFirstPosition.positionState).to.eq(0); // Default
  //       expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
  //       expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
  //       expect(newSecondPosition.component).to.eq(aUSDC.address);
  //       expect(newSecondPosition.positionState).to.eq(0); // Default
  //       expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
  //       expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
  //     });
  //     it("should update the borrow positions on the SetToken correctly", async () => {
  //       const initialPositions = await setToken.getPositions();
  //       await subject();
  //       // awsteth position is increased
  //       const currentPositions = await setToken.getPositions();
  //       const newThirdPosition = (await setToken.getPositions())[2];
  //       const newFourthPosition = (await setToken.getPositions())[3];
  //       const expectedThirdPositionUnit = (await variableDebtUSDC.balanceOf(setToken.address)).mul(
  //         -1,
  //       ); // since, variable debt mode
  //       const expectedFourthPositionUnit = (await variableDebtwsteth.balanceOf(setToken.address)).mul(
  //         -1,
  //       );
  //       expect(initialPositions.length).to.eq(4);
  //       expect(currentPositions.length).to.eq(4);
  //       expect(newThirdPosition.component).to.eq(usdc.address);
  //       expect(newThirdPosition.positionState).to.eq(1); // External
  //       expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
  //       expect(newThirdPosition.module).to.eq(morphoLeverageModule.address);
  //       expect(newFourthPosition.component).to.eq(wsteth.address);
  //       expect(newFourthPosition.positionState).to.eq(1); // External
  //       expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
  //       expect(newFourthPosition.module).to.eq(morphoLeverageModule.address);
  //     });
  //     describe("when caller is not module", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = owner;
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Only the module can call");
  //       });
  //     });
  //     describe("if disabled module is caller", async () => {
  //       beforeEach(async () => {
  //         await controller.removeModule(mockModule.address);
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
  //       });
  //     });
  //   });
  // });

  // describe("#componentIssueHook", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let borrowQuantity: BigNumber;
  //   let subjectSetToken: Address;
  //   let subjectSetQuantity: BigNumber;
  //   let subjectComponent: Address;
  //   let subjectIsEquity: boolean;
  //   let subjectCaller: Account;
  //   let issueQuantity: BigNumber;
  //   context("when awsteth is collateral and USDC is borrow asset", async () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(async () => {
  //       // Add mock module to controller
  //       await controller.addModule(mockModule.address);
  //       setToken = await createSetToken(
  //         [awsteth.address],
  //         [ether(2)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //       // Initialize module if set to true
  //       if (isInitialized) {
  //         await morphoLeverageModule.initialize(
  //           setToken.address,
  //           [wsteth.address, usdc.address, wbtc.address], // Enable WBTC that is not a Set position
  //           [usdc.address, wsteth.address, wbtc.address],
  //         );
  //       }
  //       // Initialize mock module
  //       await setToken.addModule(mockModule.address);
  //       await setToken.connect(mockModule.wallet).initializeModule();
  //       // Mint aTokens
  //       await wsteth.approve(aaveLendingPool.address, ether(100));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(wsteth.address, ether(100), owner.address, ZERO);
  //       // Approve tokens to issuance module and call issue
  //       await awsteth.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));
  //       issueQuantity = ether(1);
  //       await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //       // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //       borrowQuantity = ether(2000);
  //       if (isInitialized) {
  //         // Lever cETH in SetToken
  //         const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [usdc.address, wsteth.address], // Swap path
  //           [500], // fees
  //           true,
  //         );
  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           usdc.address,
  //           wsteth.address,
  //           borrowQuantity,
  //           ether(0.9),
  //           "UNISWAPV3",
  //           leverEthTradeData,
  //         );
  //       }
  //     });
  //     beforeEach(() => {
  //       subjectSetToken = setToken.address;
  //       subjectSetQuantity = issueQuantity;
  //       subjectComponent = usdc.address;
  //       subjectIsEquity = false;
  //       subjectCaller = mockModule;
  //     });
  //     async function subject(): Promise<any> {
  //       return morphoLeverageModule
  //         .connect(subjectCaller.wallet)
  //         .componentIssueHook(
  //           subjectSetToken,
  //           subjectSetQuantity,
  //           subjectComponent,
  //           subjectIsEquity,
  //         );
  //     }
  //     it("should increase borrowed quantity on the SetToken", async () => {
  //       const previousUsdcBalance = await usdc.balanceOf(setToken.address);
  //       await subject();
  //       const currentUsdcBalance = await usdc.balanceOf(setToken.address);
  //       expect(previousUsdcBalance).to.eq(ZERO);
  //       expect(currentUsdcBalance).to.eq(preciseMul(borrowQuantity, subjectSetQuantity));
  //     });
  //     describe("when isEquity is false and component has positive unit (should not happen)", async () => {
  //       beforeEach(async () => {
  //         subjectComponent = awsteth.address;
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("CMBN");
  //       });
  //     });
  //     describe("when isEquity is true", async () => {
  //       beforeEach(async () => {
  //         subjectIsEquity = true;
  //       });
  //       it("should NOT increase borrowed quantity on the SetToken", async () => {
  //         const previousUsdcBalance = await usdc.balanceOf(setToken.address);
  //         await subject();
  //         const currentUsdcBalance = await usdc.balanceOf(setToken.address);
  //         expect(previousUsdcBalance).to.eq(ZERO);
  //         expect(currentUsdcBalance).to.eq(ZERO);
  //       });
  //     });
  //     describe("when caller is not module", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = owner;
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Only the module can call");
  //       });
  //     });
  //     describe("if disabled module is caller", async () => {
  //       beforeEach(async () => {
  //         await controller.removeModule(mockModule.address);
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
  //       });
  //     });
  //   });
  // });

  // describe("#componentRedeemHook", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let repayQuantity: BigNumber;
  //   let subjectSetToken: Address;
  //   let subjectSetQuantity: BigNumber;
  //   let subjectComponent: Address;
  //   let subjectIsEquity: boolean;
  //   let subjectCaller: Account;
  //   let issueQuantity: BigNumber;
  //   context("when awsteth is collateral and USDC is borrow asset", async () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(async () => {
  //       // Add mock module to controller
  //       await controller.addModule(mockModule.address);
  //       setToken = await createSetToken(
  //         [awsteth.address],
  //         [ether(2)],
  //         [morphoLeverageModule.address, debtIssuanceModule.address],
  //       );
  //       await initializeDebtIssuanceModule(setToken.address);
  //       // Add SetToken to allow list
  //       await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //       // Initialize module if set to true
  //       if (isInitialized) {
  //         await morphoLeverageModule.initialize(
  //           setToken.address,
  //           [wsteth.address, wbtc.address], // Enable WBTC that is not a Set position
  //           [usdc.address, wbtc.address],
  //         );
  //       }
  //       // Initialize mock module
  //       await setToken.addModule(mockModule.address);
  //       await setToken.connect(mockModule.wallet).initializeModule();
  //       // Mint aTokens
  //       await wsteth.approve(aaveLendingPool.address, ether(100));
  //       await aaveLendingPool
  //         .connect(owner.wallet)
  //         .deposit(wsteth.address, ether(100), owner.address, ZERO);
  //       // Approve tokens to issuance module and call issue
  //       await awsteth.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));
  //       issueQuantity = ether(1);
  //       await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //       repayQuantity = ether(1000);
  //       // Lever aETH in SetToken
  //       if (isInitialized) {
  //         const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [usdc.address, wsteth.address], // Swap path
  //           [500], // fees
  //           true,
  //         );
  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           usdc.address,
  //           wsteth.address,
  //           repayQuantity,
  //           ether(0.1),
  //           "UNISWAPV3",
  //           leverEthTradeData,
  //         );
  //       }
  //       // Transfer repay quantity to SetToken for repayment
  //       await usdc.transfer(setToken.address, repayQuantity);
  //     });
  //     beforeEach(() => {
  //       subjectSetToken = setToken.address;
  //       subjectSetQuantity = issueQuantity;
  //       subjectComponent = usdc.address;
  //       subjectIsEquity = false;
  //       subjectCaller = mockModule;
  //     });
  //     async function subject(): Promise<any> {
  //       return morphoLeverageModule
  //         .connect(subjectCaller.wallet)
  //         .componentRedeemHook(
  //           subjectSetToken,
  //           subjectSetQuantity,
  //           subjectComponent,
  //           subjectIsEquity,
  //         );
  //     }
  //     it("should decrease borrowed quantity on the SetToken", async () => {
  //       const previousUsdcBalance = await usdc.balanceOf(setToken.address);
  //       await subject();
  //       const currentUsdcBalance = await usdc.balanceOf(setToken.address);
  //       expect(previousUsdcBalance).to.eq(repayQuantity);
  //       expect(currentUsdcBalance).to.eq(ZERO);
  //     });
  //     describe("when _isEquity is false and component has positive unit", async () => {
  //       beforeEach(async () => {
  //         subjectComponent = awsteth.address;
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("CMBN");
  //       });
  //     });
  //     describe("when isEquity is true", async () => {
  //       beforeEach(async () => {
  //         subjectIsEquity = true;
  //       });
  //       it("should NOT decrease borrowed quantity on the SetToken", async () => {
  //         const previousUsdcBalance = await usdc.balanceOf(setToken.address);
  //         await subject();
  //         const currentUsdcBalance = await usdc.balanceOf(setToken.address);
  //         expect(previousUsdcBalance).to.eq(repayQuantity);
  //         expect(currentUsdcBalance).to.eq(repayQuantity);
  //       });
  //     });
  //     describe("when caller is not module", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = owner;
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Only the module can call");
  //       });
  //     });
  //     describe("if disabled module is caller", async () => {
  //       beforeEach(async () => {
  //         await controller.removeModule(mockModule.address);
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
  //       });
  //     });
  //   });
  // });

  // describe("#removeModule", async () => {
  //   let setToken: SetToken;
  //   let subjectModule: Address;
  //   cacheBeforeEach(async () => {
  //     setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(100)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     await morphoLeverageModule.initialize(
  //       setToken.address,
  //       [wsteth.address],
  //       [wsteth.address, usdc.address],
  //     );
  //     // Mint aTokens
  //     await wsteth.approve(aaveLendingPool.address, ether(1000));
  //     await aaveLendingPool
  //       .connect(owner.wallet)
  //       .deposit(wsteth.address, ether(1000), owner.address, ZERO);
  //     // Approve tokens to issuance module and call issue
  //     await awsteth.approve(debtIssuanceModule.address, ether(1000));
  //     await debtIssuanceModule.issue(setToken.address, ether(1), owner.address);
  //   });
  //   beforeEach(() => {
  //     subjectModule = morphoLeverageModule.address;
  //   });
  //   async function subject(): Promise<any> {
  //     return setToken.removeModule(subjectModule);
  //   }
  //   describe("When an EOA is registered as a module", () => {
  //     cacheBeforeEach(async () => {
  //       await controller.addModule(owner.address);
  //       await setToken.addModule(owner.address);
  //       await setToken.connect(owner.wallet).initializeModule();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("function call to a non-contract account");
  //     });
  //   });
  //   it("should remove the Module on the SetToken", async () => {
  //     await subject();
  //     const isModuleEnabled = await setToken.isInitializedModule(morphoLeverageModule.address);
  //     expect(isModuleEnabled).to.be.false;
  //   });
  //   it("should remove the Module on the SetToken", async () => {
  //     await subject();
  //     const isModuleEnabled = await setToken.isInitializedModule(morphoLeverageModule.address);
  //     expect(isModuleEnabled).to.be.false;
  //   });
  //   it("should delete the mappings", async () => {
  //     await subject();
  //     const collateralAssets = (await morphoLeverageModule.getEnabledAssets(setToken.address))[0];
  //     const borrowAssets = (await morphoLeverageModule.getEnabledAssets(setToken.address))[1];
  //     const iswstethCollateral = await morphoLeverageModule.collateralAssetEnabled(
  //       setToken.address,
  //       wsteth.address,
  //     );
  //     const isUsdcCollateral = await morphoLeverageModule.collateralAssetEnabled(
  //       setToken.address,
  //       wsteth.address,
  //     );
  //     const isUsdcBorrow = await morphoLeverageModule.borrowAssetEnabled(
  //       setToken.address,
  //       wsteth.address,
  //     );
  //     const isEtherBorrow = await morphoLeverageModule.borrowAssetEnabled(
  //       setToken.address,
  //       wsteth.address,
  //     );
  //     expect(collateralAssets.length).to.eq(0);
  //     expect(borrowAssets.length).to.eq(0);
  //     expect(iswstethCollateral).to.be.false;
  //     expect(isUsdcCollateral).to.be.false;
  //     expect(isUsdcBorrow).to.be.false;
  //     expect(isEtherBorrow).to.be.false;
  //   });
  //   it("should unregister on the debt issuance module", async () => {
  //     const isModuleIssuanceHookBefore = await debtIssuanceModule.isModuleIssuanceHook(
  //       setToken.address,
  //       morphoLeverageModule.address,
  //     );
  //     expect(isModuleIssuanceHookBefore).to.be.true;
  //     await subject();
  //     const isModuleIssuanceHookAfter = await debtIssuanceModule.isModuleIssuanceHook(
  //       setToken.address,
  //       morphoLeverageModule.address,
  //     );
  //     expect(isModuleIssuanceHookAfter).to.be.false;
  //   });
  //   describe("when borrow balance exists", async () => {
  //     beforeEach(async () => {
  //       // Lever SetToken
  //       const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //         [usdc.address, wsteth.address], // Swap path
  //         [500], // fees
  //         true,
  //       );
  //       await morphoLeverageModule.lever(
  //         setToken.address,
  //         usdc.address,
  //         wsteth.address,
  //         ether(2000),
  //         ether(1),
  //         "UNISWAPV3",
  //         leverTradeData,
  //       );
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("VDR");
  //     });
  //   });
  // });

  // describe("#removeCollateralAssets", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let subjectSetToken: Address;
  //   let subjectCollateralAssets: Address[];
  //   let subjectCaller: Account;
  //   const initializeContracts = async () => {
  //     setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(1)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Initialize module if set to true
  //     if (isInitialized) {
  //       await morphoLeverageModule.initialize(setToken.address, [wsteth.address, usdc.address], []);
  //     }
  //   };
  //   const initializeSubjectVariables = () => {
  //     subjectSetToken = setToken.address;
  //     subjectCollateralAssets = [usdc.address];
  //     subjectCaller = owner;
  //   };
  //   async function subject(): Promise<any> {
  //     return await morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .removeCollateralAssets(subjectSetToken, subjectCollateralAssets);
  //   }
  //   describe("when module is initialized", () => {
  //     before(async () => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(initializeContracts);
  //     beforeEach(initializeSubjectVariables);
  //     it("should remove the collateral asset from mappings", async () => {
  //       await subject();
  //       const collateralAssets = (await morphoLeverageModule.getEnabledAssets(setToken.address))[0];
  //       const isUSDCCollateral = await morphoLeverageModule.collateralAssetEnabled(
  //         setToken.address,
  //         usdc.address,
  //       );
  //       expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify([wsteth.address]));
  //       expect(isUSDCCollateral).to.be.false;
  //     });
  //     it("should emit the correct CollateralAssetsUpdated event", async () => {
  //       await expect(subject())
  //         .to.emit(morphoLeverageModule, "CollateralAssetsUpdated")
  //         .withArgs(subjectSetToken, false, subjectCollateralAssets);
  //     });
  //     describe("when removing a collateral asset which has been enabled to be used as collateral on aave", async () => {
  //       beforeEach(async () => {
  //         // Mint aTokens
  //         await wsteth.approve(aaveLendingPool.address, ether(1000));
  //         await aaveLendingPool
  //           .connect(owner.wallet)
  //           .deposit(wsteth.address, ether(1000), owner.address, ZERO);
  //         // Approve tokens to issuance module and call issue
  //         await awsteth.approve(debtIssuanceModule.address, ether(1000));
  //         // Transfer of aToken to SetToken during issuance would enable the underlying to be used as collateral by SetToken on Aave
  //         const issueQuantity = ether(1);
  //         await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //         subjectCollateralAssets = [wsteth.address]; // remove wsteth
  //       });
  //       it("should disable the asset to be used as collateral on aave", async () => {
  //         const beforeUsageAsCollateralEnabled = (
  //           await protocolDataProvider.getUserReserveData(wsteth.address, setToken.address)
  //         ).usageAsCollateralEnabled;
  //         await subject();
  //         const afterUsageAsCollateralEnabled = (
  //           await protocolDataProvider.getUserReserveData(wsteth.address, setToken.address)
  //         ).usageAsCollateralEnabled;
  //         expect(beforeUsageAsCollateralEnabled).to.be.true;
  //         expect(afterUsageAsCollateralEnabled).to.be.false;
  //       });
  //     });
  //     describe("when collateral asset is not enabled on module", async () => {
  //       beforeEach(async () => {
  //         subjectCollateralAssets = [wsteth.address, usdc.address];
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("CNE");
  //       });
  //     });
  //     describe("when the caller is not the SetToken manager", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = await getRandomAccount();
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //       });
  //     });
  //   });
  //   describe("when module is not initialized", async () => {
  //     beforeEach(async () => {
  //       isInitialized = false;
  //       await initializeContracts();
  //       initializeSubjectVariables();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //     });
  //   });
  // });

  // describe("#removeBorrowAssets", async () => {
  //   let setToken: SetToken;
  //   let isInitialized: boolean;
  //   let subjectSetToken: Address;
  //   let subjectBorrowAssets: Address[];
  //   let subjectCaller: Account;
  //   const initializeContracts = async () => {
  //     setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(2)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     await initializeDebtIssuanceModule(setToken.address);
  //     // Add SetToken to allow list
  //     await morphoLeverageModule.updateAllowedSetToken(setToken.address, true);
  //     // Mint aTokens
  //     await wsteth.approve(aaveLendingPool.address, ether(1000));
  //     await aaveLendingPool
  //       .connect(owner.wallet)
  //       .deposit(wsteth.address, ether(1000), owner.address, ZERO);
  //     // Approve tokens to issuance module and call issue
  //     await awsteth.approve(debtIssuanceModule.address, ether(1000));
  //     // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 USDC regardless of Set supply
  //     const issueQuantity = ether(1);
  //     await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
  //     // Initialize module if set to true
  //     if (isInitialized) {
  //       await morphoLeverageModule.initialize(
  //         setToken.address,
  //         [wsteth.address],
  //         [wsteth.address, usdc.address],
  //       );
  //     }
  //   };
  //   const initializeSubjectVariables = () => {
  //     subjectSetToken = setToken.address;
  //     subjectBorrowAssets = [usdc.address];
  //     subjectCaller = owner;
  //   };
  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .removeBorrowAssets(subjectSetToken, subjectBorrowAssets);
  //   }
  //   describe("when module is initialized", () => {
  //     before(() => {
  //       isInitialized = true;
  //     });
  //     cacheBeforeEach(initializeContracts);
  //     beforeEach(initializeSubjectVariables);
  //     it("should remove the borrow asset from mappings", async () => {
  //       await subject();
  //       const borrowAssets = (await morphoLeverageModule.getEnabledAssets(setToken.address))[1];
  //       const isUSDCBorrow = await morphoLeverageModule.borrowAssetEnabled(
  //         setToken.address,
  //         usdc.address,
  //       );
  //       expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([wsteth.address]));
  //       expect(isUSDCBorrow).to.be.false;
  //     });
  //     it("should emit the correct BorrowAssetsUpdated event", async () => {
  //       await expect(subject())
  //         .to.emit(morphoLeverageModule, "BorrowAssetsUpdated")
  //         .withArgs(subjectSetToken, false, subjectBorrowAssets);
  //     });
  //     describe("when borrow asset is not enabled on module", async () => {
  //       beforeEach(async () => {
  //         subjectBorrowAssets = [usdc.address, usdc.address];
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("BNE");
  //       });
  //     });
  //     describe("when borrow balance exists", async () => {
  //       beforeEach(async () => {
  //         // Lever SetToken
  //         const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
  //           [usdc.address, wsteth.address], // Swap path
  //           [500], // fees
  //           true,
  //         );
  //         await morphoLeverageModule.lever(
  //           setToken.address,
  //           usdc.address,
  //           wsteth.address,
  //           ether(2000),
  //           ether(1),
  //           "UNISWAPV3",
  //           leverTradeData,
  //         );
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("VDR");
  //       });
  //     });
  //     describe("when the caller is not the SetToken manager", async () => {
  //       beforeEach(async () => {
  //         subjectCaller = await getRandomAccount();
  //       });
  //       it("should revert", async () => {
  //         await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
  //       });
  //     });
  //   });
  //   describe("when module is not initialized", async () => {
  //     beforeEach(async () => {
  //       isInitialized = false;
  //       await initializeContracts();
  //       initializeSubjectVariables();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
  //     });
  //   });
  // });

  // describe("#updateAllowedSetToken", async () => {
  //   let setToken: SetToken;
  //   let subjectSetToken: Address;
  //   let subjectStatus: boolean;
  //   let subjectCaller: Account;
  //   beforeEach(async () => {
  //     setToken = setToken = await createSetToken(
  //       [awsteth.address],
  //       [ether(2)],
  //       [morphoLeverageModule.address, debtIssuanceModule.address],
  //     );
  //     subjectSetToken = setToken.address;
  //     subjectStatus = true;
  //     subjectCaller = owner;
  //   });
  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .updateAllowedSetToken(subjectSetToken, subjectStatus);
  //   }
  //   it("should add Set to allow list", async () => {
  //     await subject();
  //     const isAllowed = await morphoLeverageModule.allowedSetTokens(subjectSetToken);
  //     expect(isAllowed).to.be.true;
  //   });
  //   it("should emit the correct SetTokenStatusUpdated event", async () => {
  //     await expect(subject())
  //       .to.emit(morphoLeverageModule, "SetTokenStatusUpdated")
  //       .withArgs(subjectSetToken, subjectStatus);
  //   });
  //   describe("when disabling a Set", async () => {
  //     beforeEach(async () => {
  //       await subject();
  //       subjectStatus = false;
  //     });
  //     it("should remove Set from allow list", async () => {
  //       await subject();
  //       const isAllowed = await morphoLeverageModule.allowedSetTokens(subjectSetToken);
  //       expect(isAllowed).to.be.false;
  //     });
  //     it("should emit the correct SetTokenStatusUpdated event", async () => {
  //       await expect(subject())
  //         .to.emit(morphoLeverageModule, "SetTokenStatusUpdated")
  //         .withArgs(subjectSetToken, subjectStatus);
  //     });
  //     describe("when Set Token is removed on controller", async () => {
  //       beforeEach(async () => {
  //         await controller.removeSet(setToken.address);
  //       });
  //       it("should remove the Set from allow list", async () => {
  //         await subject();
  //         const isAllowed = await morphoLeverageModule.allowedSetTokens(subjectSetToken);
  //         expect(isAllowed).to.be.false;
  //       });
  //     });
  //   });
  //   describe("when Set is removed on controller", async () => {
  //     beforeEach(async () => {
  //       await controller.removeSet(setToken.address);
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("IST");
  //     });
  //   });
  //   describe("when not called by owner", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
  //     });
  //   });
  // });

  // describe("#updateAnySetAllowed", async () => {
  //   let subjectAnySetAllowed: boolean;
  //   let subjectCaller: Account;
  //   beforeEach(async () => {
  //     subjectAnySetAllowed = true;
  //     subjectCaller = owner;
  //   });
  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .updateAnySetAllowed(subjectAnySetAllowed);
  //   }
  //   it("should remove Set from allow list", async () => {
  //     await subject();
  //     const anySetAllowed = await morphoLeverageModule.anySetAllowed();
  //     expect(anySetAllowed).to.be.true;
  //   });
  //   it("should emit the correct AnySetAllowedUpdated event", async () => {
  //     await expect(subject())
  //       .to.emit(morphoLeverageModule, "AnySetAllowedUpdated")
  //       .withArgs(subjectAnySetAllowed);
  //   });
  //   describe("when not called by owner", async () => {
  //     beforeEach(async () => {
  //       subjectCaller = await getRandomAccount();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
  //     });
  //   });
  // });

  // describe("#addUnderlyingToReserveTokensMappings", async () => {
  //   let subjectUnderlying: Address;
  //   let subjectCaller: Account;
  //   beforeEach(async () => {
  //     const mockToken = await registerMockToken();
  //     subjectUnderlying = mockToken.address;
  //     subjectCaller = await getRandomAccount();
  //   });
  //   async function subject(): Promise<any> {
  //     return morphoLeverageModule
  //       .connect(subjectCaller.wallet)
  //       .addUnderlyingToReserveTokensMapping(subjectUnderlying);
  //   }
  //   it("should add the underlying to reserve tokens mappings", async () => {
  //     await subject();
  //     const reserveTokens = await morphoLeverageModule.underlyingToReserveTokens(subjectUnderlying);
  //     expect(reserveTokens.aToken).to.not.eq(ADDRESS_ZERO);
  //     expect(reserveTokens.variableDebtToken).to.not.eq(ADDRESS_ZERO);
  //   });
  //   it("should emit ReserveTokensUpdated event", async () => {
  //     await expect(subject()).to.emit(morphoLeverageModule, "ReserveTokensUpdated");
  //   });
  //   describe("when mapping already exists", async () => {
  //     beforeEach(async () => {
  //       subjectUnderlying = wsteth.address;
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("MAE");
  //     });
  //   });
  //   describe("when reserve is invalid", async () => {
  //     beforeEach(async () => {
  //       subjectUnderlying = await getRandomAddress();
  //     });
  //     it("should revert", async () => {
  //       await expect(subject()).to.be.revertedWith("IAE");
  //     });
  //   });
  // });
});
