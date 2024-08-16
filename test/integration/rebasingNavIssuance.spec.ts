import "module-alias/register";
import { BigNumber} from "ethers";
import { getSystemFixture } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address, CustomOracleNAVIssuanceSettings } from "@utils/types";
import { addSnapshotBeforeRestoreAfterEach, impersonateAccount, increaseTimeAsync } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/index";
import { network } from "hardhat";
import { forkingConfig } from "../../hardhat.config";
import {
  DebtIssuanceModuleV3,
  CustomOracleNavIssuanceModule,
  ERC4626Oracle,
  IERC20,
  IERC20__factory,
  SetToken,
  RebasingComponentAssetLimitModule,
  RebasingComponentModule,
} from "@typechain/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  aEthUSDC: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
  cUSDCv3: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  aUSDC: "0xBcca60bB61934080951369a648Fb03DF4F96263C",
  gtUSDC: "0xdd0f28e19C1780eb6396170735D45153D261490d",
};

const whales = {
  usdc: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  justin_sun: "0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296", // aEthUSDC
  wan_liang: "0xCcb12611039c7CD321c0F23043c841F1d97287A5", // cUSDCv3
  mane_lee: "0xBF370B6E9d97D928497C2f2d72FD74f4D9ca5825", // aUSDC
  morpho_seeding: "0x6ABfd6139c7C3CC270ee2Ce132E309F59cAaF6a2", // gtUSDC
};

describe("Rebasing and ERC4626 CustomOracleNavIssuanceModule integration [ @forked-mainnet ]", () => {
  const TOKEN_TRANSFER_BUFFER = 10;

  let owner: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;

  let setV2Setup: SystemFixture;

  let debtIssuanceModule: DebtIssuanceModuleV3;
  let rebasingComponentModule: RebasingComponentModule;

  let navIssuanceModule: CustomOracleNavIssuanceModule;
  let rebasingComponentAssetLimitModule: RebasingComponentAssetLimitModule;

  let erc4626Oracle: ERC4626Oracle;

  let setToken: SetToken;

  let usdc_erc20: IERC20;
  let aEthUSDC_erc20: IERC20;
  let cUSDCv3_erc20: IERC20;
  let aUSDC_erc20: IERC20;
  let gtUSDC_erc20: IERC20;

  const blockNumber = 20528609;
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

  before(async () => {
    [ owner, feeRecipient ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    // Token setup
    usdc_erc20 = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
    aEthUSDC_erc20 = IERC20__factory.connect(tokenAddresses.aEthUSDC, owner.wallet);
    cUSDCv3_erc20 = IERC20__factory.connect(tokenAddresses.cUSDCv3, owner.wallet);
    aUSDC_erc20 = IERC20__factory.connect(tokenAddresses.aUSDC, owner.wallet);
    gtUSDC_erc20 = IERC20__factory.connect(tokenAddresses.gtUSDC, owner.wallet);

    // Index Protocol setup
    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV3(
      setV2Setup.controller.address,
      TOKEN_TRANSFER_BUFFER,
    );
    await setV2Setup.controller.addModule(debtIssuanceModule.address);

    rebasingComponentModule = await deployer.modules.deployRebasingComponentModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(rebasingComponentModule.address);

    navIssuanceModule = await deployer.modules.deployCustomOracleNavIssuanceModule(
      setV2Setup.controller.address,
      setV2Setup.weth.address
    );
    await setV2Setup.controller.addModule(navIssuanceModule.address);

    rebasingComponentAssetLimitModule = await deployer.modules.deployRebasingComponentAssetLimitModule(
      setV2Setup.controller.address
    );
    await setV2Setup.controller.addModule(rebasingComponentAssetLimitModule.address);

    // Oracle setup
    const unitOracle = await deployer.mocks.deployOracleMock(ether(1));
    await setV2Setup.priceOracle.editMasterQuoteAsset(tokenAddresses.usdc);
    await setV2Setup.priceOracle.addPair(tokenAddresses.usdc, tokenAddresses.usdc, unitOracle.address);
    await setV2Setup.priceOracle.addPair(tokenAddresses.aEthUSDC, tokenAddresses.usdc, unitOracle.address);
    await setV2Setup.priceOracle.addPair(tokenAddresses.cUSDCv3, tokenAddresses.usdc, unitOracle.address);
    await setV2Setup.priceOracle.addPair(tokenAddresses.aUSDC, tokenAddresses.usdc, unitOracle.address);

    erc4626Oracle = await deployer.oracles.deployERC4626Oracle(
      tokenAddresses.gtUSDC,
      "gtUSDC - USDC Calculated Oracle",
    );
    await setV2Setup.priceOracle.addAdapter(erc4626Oracle.address);
    await setV2Setup.priceOracle.addPair(tokenAddresses.gtUSDC, tokenAddresses.usdc, erc4626Oracle.address);

    // SetToken setup
    setToken = await setV2Setup.createSetToken(
      [
        tokenAddresses.usdc,
        tokenAddresses.aEthUSDC,
        tokenAddresses.cUSDCv3,
        tokenAddresses.aUSDC,
        tokenAddresses.gtUSDC,
      ],
      [usdc(20), usdc(20), usdc(20), usdc(20), ether(20)],
      [
        debtIssuanceModule.address,
        rebasingComponentModule.address,
        navIssuanceModule.address,
        rebasingComponentAssetLimitModule.address
      ]
    );

    // Initialize Modules
    await debtIssuanceModule.initialize(
      setToken.address,
      ZERO,
      ZERO,
      ZERO,
      owner.address,
      ADDRESS_ZERO
    );

    await rebasingComponentModule.initialize(
      setToken.address,
      [tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC]
    );

    const navIssuanceSettings = {
      managerIssuanceHook: rebasingComponentAssetLimitModule.address,
      managerRedemptionHook: rebasingComponentAssetLimitModule.address,
      setValuer: ADDRESS_ZERO,
      reserveAssets: [tokenAddresses.usdc],
      feeRecipient: feeRecipient.address,
      managerFees: [ether(0.001), ether(0.002)],
      maxManagerFee: ether(0.02),
      premiumPercentage: ether(0.01),
      maxPremiumPercentage: ether(0.1),
      minSetTokenSupply: ether(5),
    } as CustomOracleNAVIssuanceSettings;

    await navIssuanceModule.initialize(
      setToken.address,
      navIssuanceSettings
    );

    await rebasingComponentAssetLimitModule.initialize(
      setToken.address,
      [tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC],
      [tokenAddresses.usdc, setToken.address],
      [usdc(1000000), ether(1000000)],
    );

    // Issue initial units via the debt issuance module V3
    const justin_sun = await impersonateAccount(whales.justin_sun);
    const wan_liang = await impersonateAccount(whales.wan_liang);
    const mane_lee = await impersonateAccount(whales.mane_lee);
    const morpho_seeding = await impersonateAccount(whales.morpho_seeding);
    await usdc_erc20.connect(justin_sun).transfer(owner.address, usdc(1000));
    await aEthUSDC_erc20.connect(justin_sun).transfer(owner.address, usdc(10000));
    await cUSDCv3_erc20.connect(wan_liang).transfer(owner.address, usdc(10000));
    await aUSDC_erc20.connect(mane_lee).transfer(owner.address, usdc(10000));
    await gtUSDC_erc20.connect(morpho_seeding).transfer(owner.address, ether(10000));
    await usdc_erc20.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);
    await aEthUSDC_erc20.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);
    await cUSDCv3_erc20.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);
    await aUSDC_erc20.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);
    await gtUSDC_erc20.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);
    await debtIssuanceModule.issue(setToken.address, ether(10), owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#sync", async () => {
    let subjectSetToken: Address;

    before(async () => {
      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<any> {
      return rebasingComponentAssetLimitModule.sync(subjectSetToken);
    }

    it("should sync rebasing components", async () => {
      const initialUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.usdc);
      const initialAEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const initialCUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const initialAUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const initialGTUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.gtUSDC);
      const initialPositionMultiplier = await setToken.positionMultiplier();

      await increaseTimeAsync(usdc(10));

      await subject();

      const usdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.usdc);
      const aEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const cUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const aUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const gtUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.gtUSDC);
      const positionMultiplier = await setToken.positionMultiplier();

      expect(usdcUnit).to.be.eq(initialUsdcUnit);
      expect(aEthUsdcUnit).to.be.gt(initialAEthUsdcUnit);
      expect(cUsdcV3Unit).to.be.gt(initialCUsdcV3Unit);
      expect(aUsdcUnit).to.be.gt(initialAUsdcUnit);
      expect(gtUsdcUnit).to.be.eq(initialGTUsdcUnit);
      expect(positionMultiplier).to.be.eq(initialPositionMultiplier);
    });
  });

  describe("#issue", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;
    let subjectMinSetTokenReceived: BigNumber;
    let subjectTo: Account;

    before(async () => {
      subjectSetToken = setToken.address;
      subjectReserveAsset = tokenAddresses.usdc;
      subjectReserveQuantity = usdc(100);
      subjectMinSetTokenReceived = ZERO;
      subjectTo = owner;

      const justin_sun = await impersonateAccount(whales.justin_sun);
      await usdc_erc20.connect(justin_sun).transfer(owner.address, subjectReserveQuantity);
      await usdc_erc20.approve(navIssuanceModule.address, subjectReserveQuantity);
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.issue(
        subjectSetToken,
        subjectReserveAsset,
        subjectReserveQuantity,
        subjectMinSetTokenReceived,
        subjectTo.address
      );
    }

    it("should sync rebasing components", async () => {
      const initialUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.usdc);
      const initialAEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const initialCUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const initialAUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const initialGTUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.gtUSDC);
      const initialPositionMultiplier = await setToken.positionMultiplier();

      await increaseTimeAsync(usdc(10));

      const expectedOutputBeforeRebase = await navIssuanceModule.connect(owner.wallet).getExpectedSetTokenIssueQuantity(
        subjectSetToken,
        subjectReserveAsset,
        subjectReserveQuantity
      );
      const usdcBalanceBefore = await usdc_erc20.balanceOf(owner.address);
      const setTokenBalanceBefore = await setToken.balanceOf(owner.address);

      await subject();

      const usdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.usdc);
      const aEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const cUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const aUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const gtUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.gtUSDC);
      const positionMultiplier = await setToken.positionMultiplier();
      const usdcBalanceAfter = await usdc_erc20.balanceOf(owner.address);
      const usdcSpent = usdcBalanceBefore.sub(usdcBalanceAfter);
      const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
      const actualOutput = setTokenBalanceAfter.sub(setTokenBalanceBefore);

      expect(usdcUnit).to.be.gt(initialUsdcUnit);
      expect(aEthUsdcUnit).to.be.lt(initialAEthUsdcUnit);
      expect(cUsdcV3Unit).to.be.lt(initialCUsdcV3Unit);
      expect(aUsdcUnit).to.be.lt(initialAUsdcUnit);
      expect(gtUsdcUnit).to.be.lt(initialGTUsdcUnit);
      expect(positionMultiplier).to.be.lt(initialPositionMultiplier);
      expect(actualOutput).to.be.lt(expectedOutputBeforeRebase);
      expect(usdcSpent).to.be.eq(subjectReserveQuantity);
    });
  });

  describe("#redeem", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectMinReserveQuantityReceived: BigNumber;
    let subjectTo: Account;

    before(async () => {
      subjectSetToken = setToken.address;
      subjectReserveAsset = tokenAddresses.usdc;
      subjectSetTokenQuantity = ether(1);
      subjectMinReserveQuantityReceived = ZERO;
      subjectTo = owner;

      await setToken.approve(navIssuanceModule.address, subjectSetTokenQuantity);
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.redeem(
        subjectSetToken,
        subjectReserveAsset,
        subjectSetTokenQuantity,
        subjectMinReserveQuantityReceived,
        subjectTo.address
      );
    }

    it("should sync rebasing components", async () => {
      const initialUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.usdc);
      const initialAEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const initialCUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const initialAUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const initialGTUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.gtUSDC);
      const initialPositionMultiplier = await setToken.positionMultiplier();

      await increaseTimeAsync(usdc(10));

      const expectedOutputBeforeRebase = await navIssuanceModule.connect(owner.wallet).getExpectedReserveRedeemQuantity(
        subjectSetToken,
        subjectReserveAsset,
        subjectSetTokenQuantity
      );
      const usdcBalanceBefore = await usdc_erc20.balanceOf(owner.address);
      const setTokenBalanceBefore = await setToken.balanceOf(owner.address);

      await subject();

      const usdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.usdc);
      const aEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const cUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const aUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const gtUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.gtUSDC);
      const positionMultiplier = await setToken.positionMultiplier();
      const usdcBalanceAfter = await usdc_erc20.balanceOf(owner.address);
      const actualOutput = usdcBalanceAfter.sub(usdcBalanceBefore);
      const setTokenBalanceAfter = await setToken.balanceOf(owner.address);
      const setTokenBalanceChange = setTokenBalanceBefore.sub(setTokenBalanceAfter);

      expect(usdcUnit).to.be.lt(initialUsdcUnit);
      expect(aEthUsdcUnit).to.be.gt(initialAEthUsdcUnit);
      expect(cUsdcV3Unit).to.be.gt(initialCUsdcV3Unit);
      expect(aUsdcUnit).to.be.gt(initialAUsdcUnit);
      expect(gtUsdcUnit).to.be.gt(initialGTUsdcUnit);
      expect(positionMultiplier).to.be.gt(initialPositionMultiplier);
      expect(actualOutput).to.be.gt(expectedOutputBeforeRebase);
      expect(setTokenBalanceChange).to.be.eq(subjectSetTokenQuantity);
    });
  });
});
