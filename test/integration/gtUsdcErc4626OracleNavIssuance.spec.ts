import "module-alias/register";

import { BigNumber, Signer } from "ethers";
import { Address, CustomOracleNAVIssuanceSettings } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO } from "@utils/constants";
import { CustomOracleNavIssuanceModule, SetToken, ERC4626Oracle } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  usdc,
} from "@utils/index";
import {
  getAccounts,
  getRandomAddress,
  addSnapshotBeforeRestoreAfterEach,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import {
  IERC20,
  IERC20__factory,
} from "@typechain/index";
import { network } from "hardhat";
import { forkingConfig } from "../../hardhat.config";
import { impersonateAccount } from "@utils/test/testingUtils";

const expect = getWaffleExpect();

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  gtUSDC: "0xdd0f28e19C1780eb6396170735D45153D261490d",
};

const whales = {
  gtUSDC: "0x73738c989398EBAfdAfD097836Fd910BAc14CCDC",
};

describe("gtUSDC - ERC4626Oracle - CustomOracleNavIssuanceModule Integration Tests", () => {
  let owner: Account;
  let feeRecipient: Account;
  let recipient: Account;
  let deployer: DeployHelper;

  let setup: SystemFixture;
  let customOracleNavIssuanceModule: CustomOracleNavIssuanceModule;

  let erc4626Oracle: ERC4626Oracle;

  let gtUSDC: IERC20;

  const blockNumber = 20420724;
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
    [
      owner,
      feeRecipient,
      recipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    customOracleNavIssuanceModule = await deployer.modules.deployCustomOracleNavIssuanceModule(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(customOracleNavIssuanceModule.address);

    erc4626Oracle = await deployer.oracles.deployERC4626Oracle(
      tokenAddresses.gtUSDC,
      "gtUSDC - USDC Calculated Oracle",
    );
    await setup.priceOracle.addPair(tokenAddresses.gtUSDC, tokenAddresses.usdc, erc4626Oracle.address);

    gtUSDC = IERC20__factory.connect(tokenAddresses.gtUSDC, owner.wallet);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;

    let navIssuanceSettings: CustomOracleNAVIssuanceSettings;

    beforeEach(async () => {
      const usdcUnits = usdc(50);
      const gtUSDCUnits = ether(50);

      setToken = await setup.createSetToken(
        [tokenAddresses.usdc, tokenAddresses.gtUSDC],
        [usdcUnits, gtUSDCUnits],
        [setup.issuanceModule.address, customOracleNavIssuanceModule.address]
      );

      // Initialize debt issuance module
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Issue some Sets
      const setTokensIssued = ether(1);
      const whale = await impersonateAccount(whales.gtUSDC);
      await setup.usdc.connect(whale).approve(setup.issuanceModule.address, preciseMul(usdcUnits, setTokensIssued));
      await gtUSDC.connect(whale).approve(setup.issuanceModule.address, preciseMul(gtUSDCUnits, setTokensIssued));
      await setup.issuanceModule.connect(whale).issue(setToken.address, setTokensIssued, owner.address);

      // Initialize NAV Issuance Module
      const managerIssuanceHook = ADDRESS_ZERO;
      const setValuerAddress = ADDRESS_ZERO;
      const managerFees = [ether(0), ether(0)];
      const premiumPercentage = ether(0.005);
      const managerRedemptionHook = await getRandomAddress();
      const reserveAssets = [tokenAddresses.usdc];
      const managerFeeRecipient = feeRecipient.address;
      const maxManagerFee = ether(0.2);
      const maxPremiumPercentage = ether(0.1);
      const minSetTokenSupply = ether(1);

      navIssuanceSettings = {
        managerIssuanceHook,
        managerRedemptionHook,
        setValuer: setValuerAddress,
        reserveAssets,
        feeRecipient: managerFeeRecipient,
        managerFees,
        maxManagerFee,
        premiumPercentage,
        maxPremiumPercentage,
        minSetTokenSupply,
      } as CustomOracleNAVIssuanceSettings;

      await customOracleNavIssuanceModule.initialize(setToken.address, navIssuanceSettings);
    });

    describe("#issue", async () => {
      let subjectSetToken: Address;
      let subjectReserveAsset: Address;
      let subjectReserveQuantity: BigNumber;
      let subjectMinSetTokenReceived: BigNumber;
      let subjectTo: Account;
      let subjectCaller: Signer;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectReserveAsset = setup.usdc.address;
        subjectReserveQuantity = usdc(100);
        subjectMinSetTokenReceived = ether(99);
        subjectTo = recipient;
        subjectCaller = await impersonateAccount(whales.gtUSDC);
      });

      async function subject(): Promise<any> {
        return customOracleNavIssuanceModule.connect(subjectCaller).issue(
          subjectSetToken,
          subjectReserveAsset,
          subjectReserveQuantity,
          subjectMinSetTokenReceived,
          subjectTo.address
        );
      }

      it("should reduce the underlying quantity and mint the wrapped asset to the SetToken", async () => {
        const totalSupplyBefore = await setToken.totalSupply();
        const usdcCollateralBefore = await setup.usdc.balanceOf(setToken.address);
        const gtUSDCCollateralBefore = await gtUSDC.balanceOf(setToken.address);
        const usdcBalanceBefore = await setup.usdc.balanceOf(whales.gtUSDC);

        expect(totalSupplyBefore).to.eq(ether(1));
        expect(usdcCollateralBefore).to.eq(usdc(50));
        expect(gtUSDCCollateralBefore).to.eq(ether(50));

        await subject();

        const totalSupplyAfter = await setToken.totalSupply();
        const usdcCollateralAfter = await setup.usdc.balanceOf(setToken.address);
        const gtUSDCCollateralAfter = await gtUSDC.balanceOf(setToken.address);
        const usdcBalanceAfter = await setup.usdc.balanceOf(whales.gtUSDC);

        expect(totalSupplyAfter).to.eq(ether(2));
        expect(usdcCollateralAfter).to.eq(usdc(150));
        expect(gtUSDCCollateralAfter).to.eq(ether(50));

        expect(usdcBalanceAfter).to.eq(usdcBalanceBefore.sub(usdc(100)));
      });
    });
  });
});
