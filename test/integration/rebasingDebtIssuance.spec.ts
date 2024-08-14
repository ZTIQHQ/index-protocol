import "module-alias/register";
import { BigNumber} from "ethers";
import { getSystemFixture } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";
import { addSnapshotBeforeRestoreAfterEach, impersonateAccount } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { MAX_UINT_256, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/index";
import { network } from "hardhat";
import { forkingConfig } from "../../hardhat.config";
import {
  DebtIssuanceModuleV2,
  IERC20,
  IERC20__factory,
  SetToken,
  RebasingComponentModule,
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

describe.only("Rebasing USDC DebtIssuanceModuleV2 integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let setV2Setup: SystemFixture;

  let debtIssuanceModule: DebtIssuanceModuleV2;
  let rebasingComponentModule: RebasingComponentModule;

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
    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(debtIssuanceModule.address);

    rebasingComponentModule = await deployer.modules.deployRebasingComponentModule(setV2Setup.controller.address);
    await setV2Setup.controller.addModule(rebasingComponentModule.address);

    // SetToken setup
    setToken = await setV2Setup.createSetToken(
      [tokenAddresses.usdc, tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC],
      [usdc(5), usdc(35), usdc(30), usdc(30)],
      [debtIssuanceModule.address, rebasingComponentModule.address]
    );

    // Initialize Modules
    await rebasingComponentModule.initialize(
      setToken.address,
      [tokenAddresses.aEthUSDC, tokenAddresses.cUSDCv3, tokenAddresses.aUSDC]
    );

    await debtIssuanceModule.initialize(
      setToken.address,
      ZERO,
      ZERO,
      ZERO,
      owner.address,
      rebasingComponentModule.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#issue", async () => {
    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Account;

    before(async () => {
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

      subjectSetToken = setToken.address;
      subjectQuantity = ether(100);
      subjectTo = owner;
    });

    async function subject(): Promise<any> {
      return debtIssuanceModule.issue(
        subjectSetToken,
        subjectQuantity,
        subjectTo.address
      );
    }

    it("should sync rebasing components", async () => {
      const initialUsdcUnit = await setToken.getDefaultPositionRealUnit(setV2Setup.usdc.address);
      const initialAEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const initialCUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const initialAUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const initialPositionMultiplier = await setToken.positionMultiplier();

      const [,expectedIssuanceUnits] = await debtIssuanceModule.connect(owner.wallet).getRequiredComponentIssuanceUnits(
        subjectSetToken,
        subjectQuantity
      );

      const usdcBalanceBefore = await usdc_erc20.balanceOf(owner.address);
      const aEthUSDCBalanceBefore = await aEthUSDC_erc20.balanceOf(owner.address);
      const cUSDCv3BalanceBefore = await cUSDCv3_erc20.balanceOf(owner.address);
      const aUSDCBalanceBefore = await aUSDC_erc20.balanceOf(owner.address);
      const setTokenBalanceBefore = await setToken.balanceOf(owner.address);

      await subject();

      const usdcUnit = await setToken.getDefaultPositionRealUnit(setV2Setup.usdc.address);
      const aEthUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aEthUSDC);
      const cUsdcV3Unit = await setToken.getDefaultPositionRealUnit(tokenAddresses.cUSDCv3);
      const aUsdcUnit = await setToken.getDefaultPositionRealUnit(tokenAddresses.aUSDC);
      const positionMultiplier = await setToken.positionMultiplier();

      const usdcBalanceAfter = await usdc_erc20.balanceOf(owner.address);
      const aEthUSDCBalanceAfter = await aEthUSDC_erc20.balanceOf(owner.address);
      const cUSDCv3BalanceAfter = await cUSDCv3_erc20.balanceOf(owner.address);
      const aUSDCBalanceAfter = await aUSDC_erc20.balanceOf(owner.address);
      const setTokenBalanceAfter = await setToken.balanceOf(owner.address);

      expect(usdcUnit).to.be.eq(initialUsdcUnit);
      expect(aEthUsdcUnit).to.be.gt(initialAEthUsdcUnit);
      expect(cUsdcV3Unit).to.be.gt(initialCUsdcV3Unit);
      expect(aUsdcUnit).to.be.gt(initialAUsdcUnit);
      expect(positionMultiplier).to.be.eq(initialPositionMultiplier);

      expect(usdcBalanceBefore.sub(usdcBalanceAfter)).to.be.eq(expectedIssuanceUnits[0]);
      expect(aEthUSDCBalanceBefore.sub(aEthUSDCBalanceAfter)).to.be.gt(expectedIssuanceUnits[1]);
      expect(cUSDCv3BalanceBefore.sub(cUSDCv3BalanceAfter)).to.be.gt(expectedIssuanceUnits[2]);
      expect(aUSDCBalanceBefore.sub(aUSDCBalanceAfter)).to.be.gt(expectedIssuanceUnits[3]);
      expect(setTokenBalanceAfter.sub(setTokenBalanceBefore)).to.be.eq(subjectQuantity);
    });
  });
});
