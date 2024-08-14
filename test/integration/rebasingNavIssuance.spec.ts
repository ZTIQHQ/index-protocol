import "module-alias/register";
import { BigNumber} from "ethers";
import { getSystemFixture } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address, CustomOracleNAVIssuanceSettings } from "@utils/types";
import { addSnapshotBeforeRestoreAfterEach, impersonateAccount } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/index";
import { network } from "hardhat";
import { forkingConfig } from "../../hardhat.config";
import {
  CustomOracleNavIssuanceModule,
  IERC20,
  IERC20__factory,
  SetToken,
  RebasingComponentAssetLimitModule,
} from "@typechain/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  aEthUSDC: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
  cUSDCv3: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  aUSDC: "0xBcca60bB61934080951369a648Fb03DF4F96263C",
};

const whales = {
  usdc: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  justin_sun: "0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296", // aEthUSDC
  wan_liang: "0xCcb12611039c7CD321c0F23043c841F1d97287A5", // cUSDCv3
  mane_lee: "0xBF370B6E9d97D928497C2f2d72FD74f4D9ca5825", // aUSDC
};

describe("Rebasing USDC CustomOracleNavIssuanceModule integration", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let setV2Setup: SystemFixture;

  let navIssuanceModule: CustomOracleNavIssuanceModule;
  let rebasingComponentAssetLimitModule: RebasingComponentAssetLimitModule;

  let setToken: SetToken;

  let usdc_erc20: IERC20;
  let aEthUSDC_erc20: IERC20;
  let cUSDCv3_erc20: IERC20;
  let aUSDC_erc20: IERC20;

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
    [ owner ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    // Token setup
    usdc_erc20 = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
    aEthUSDC_erc20 = IERC20__factory.connect(tokenAddresses.aEthUSDC, owner.wallet);
    cUSDCv3_erc20 = IERC20__factory.connect(tokenAddresses.cUSDCv3, owner.wallet);
    aUSDC_erc20 = IERC20__factory.connect(tokenAddresses.aUSDC, owner.wallet);

    // Index Protocol setup
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
    await setV2Setup.priceOracle.addPair(tokenAddresses.aEthUSDC, tokenAddresses.usdc, unitOracle.address);
    await setV2Setup.priceOracle.addPair(tokenAddresses.cUSDCv3, tokenAddresses.usdc, unitOracle.address);
    await setV2Setup.priceOracle.addPair(tokenAddresses.aUSDC, tokenAddresses.usdc, unitOracle.address);

    // SetToken setup
    setToken = await setV2Setup.createSetToken(
      [tokenAddresses.usdc, tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC],
      [usdc(5), usdc(35), usdc(30), usdc(30)],
      [setV2Setup.issuanceModule.address, navIssuanceModule.address, rebasingComponentAssetLimitModule.address]
    );

    // Initialize NAV Issuance Module and Rebasing Component Asset Limit Module
    const navIssuanceSettings = {
      managerIssuanceHook: rebasingComponentAssetLimitModule.address,
      managerRedemptionHook: rebasingComponentAssetLimitModule.address,
      setValuer: ADDRESS_ZERO,
      reserveAssets: [tokenAddresses.usdc],
      feeRecipient: owner.address,
      managerFees: [ether(0.001), ether(0.002)],
      maxManagerFee: ether(0.02),
      premiumPercentage: ether(0.01),
      maxPremiumPercentage: ether(0.1),
      minSetTokenSupply: ether(100),
    } as CustomOracleNAVIssuanceSettings;

    await navIssuanceModule.initialize(
      setToken.address,
      navIssuanceSettings
    );

    await rebasingComponentAssetLimitModule.initialize(
      setToken.address,
      [tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC],
      [setV2Setup.usdc.address],
      [usdc(1000000)]
    );

    // Issue initial units via the basic issuance module
    const usdc_whale = await impersonateAccount(whales.usdc);
    const justin_sun = await impersonateAccount(whales.justin_sun);
    const wan_liang = await impersonateAccount(whales.wan_liang);
    const mane_lee = await impersonateAccount(whales.mane_lee);

    await aEthUSDC_erc20.connect(justin_sun).transfer(whales.usdc, usdc(10000));
    await cUSDCv3_erc20.connect(wan_liang).transfer(whales.usdc, usdc(10000));
    await aUSDC_erc20.connect(mane_lee).transfer(whales.usdc, usdc(10000));

    await usdc_erc20.connect(usdc_whale).approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await aEthUSDC_erc20.connect(usdc_whale).approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await cUSDCv3_erc20.connect(usdc_whale).approve(setV2Setup.issuanceModule.address, MAX_UINT_256);
    await aUSDC_erc20.connect(usdc_whale).approve(setV2Setup.issuanceModule.address, MAX_UINT_256);

    await setV2Setup.issuanceModule.connect(usdc_whale).issue(setToken.address, ether(1000), owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#issue", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;
    let subjectMinSetTokenReceived: BigNumber;
    let subjectTo: Account;

    before(async () => {
      subjectSetToken = setToken.address;
      subjectReserveAsset = setV2Setup.usdc.address;
      subjectReserveQuantity = usdc(1000);
      subjectMinSetTokenReceived = ZERO;
      subjectTo = owner;

      await setV2Setup.usdc.approve(navIssuanceModule.address, subjectReserveQuantity);
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
      const initialUsdcUnit = await setToken.getDefaultPositionRealUnit(setV2Setup.usdc.address);
      const initialAEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const initialCUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const initialAUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const initialPositionMultiplier = await setToken.positionMultiplier();

      const expectedOutputBeforeRebase = navIssuanceModule.connect(owner.wallet).getExpectedSetTokenIssueQuantity(
        subjectSetToken,
        subjectReserveAsset,
        subjectReserveQuantity
      );

      const setTokenBalanceBefore = await setToken.balanceOf(owner.address);

      await subject();

      const usdcUnit = await setToken.getDefaultPositionRealUnit(setV2Setup.usdc.address);
      const aEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const cUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const aUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const positionMultiplier = await setToken.positionMultiplier();

      const setTokenBalanceAfter = await setToken.balanceOf(owner.address);

      const actualOutput = setTokenBalanceAfter.sub(setTokenBalanceBefore);

      expect(usdcUnit).to.be.gt(initialUsdcUnit);
      expect(aEthUsdcUnit).to.be.gt(initialAEthUsdcUnit);
      expect(cUsdcV3Unit).to.be.gt(initialCUsdcV3Unit);
      expect(aUsdcUnit).to.be.gt(initialAUsdcUnit);
      expect(positionMultiplier).to.be.gt(initialPositionMultiplier);
      expect(actualOutput).to.be.lt(expectedOutputBeforeRebase);
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
      subjectReserveAsset = setV2Setup.usdc.address;
      subjectSetTokenQuantity = ether(500);
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
      const initialUsdcUnit = await setToken.getDefaultPositionRealUnit(setV2Setup.usdc.address);
      const initialAEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const initialCUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const initialAUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const initialPositionMultiplier = await setToken.positionMultiplier();

      const expectedOutputBeforeRebase = navIssuanceModule.connect(owner.wallet).getExpectedReserveRedeemQuantity(
        subjectSetToken,
        subjectReserveAsset,
        subjectSetTokenQuantity
      );

      const usdcBalanceBefore = await usdc_erc20.balanceOf(owner.address);

      await subject();

      const usdcUnit = await setToken.getDefaultPositionRealUnit(setV2Setup.usdc.address);
      const aEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const cUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const aUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const positionMultiplier = await setToken.positionMultiplier();

      const usdcBalanceAfter = await usdc_erc20.balanceOf(owner.address);

      const actualOutput = usdcBalanceAfter.sub(usdcBalanceBefore);

      expect(usdcUnit).to.be.lt(initialUsdcUnit);
      expect(aEthUsdcUnit).to.be.gt(initialAEthUsdcUnit);
      expect(cUsdcV3Unit).to.be.gt(initialCUsdcV3Unit);
      expect(aUsdcUnit).to.be.gt(initialAUsdcUnit);
      expect(positionMultiplier).to.be.lt(initialPositionMultiplier);
      expect(actualOutput).to.be.lt(expectedOutputBeforeRebase);
    });
  });
});
