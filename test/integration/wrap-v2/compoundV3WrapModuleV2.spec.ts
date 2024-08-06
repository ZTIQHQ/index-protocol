import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ONE, ZERO_BYTES } from "@utils/constants";
import { SetToken, WrapModuleV2 } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  usdc
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import {
  IERC20,
  IERC20__factory,
} from "@typechain/index";
import { network } from "hardhat";
import { forkingConfig } from "../../../hardhat.config";
import { impersonateAccount } from "@utils/test/testingUtils";

const expect = getWaffleExpect();

const tokenAddresses = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  cUSDCv3: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
};

const whales = {
  usdc: "0xf584F8728B874a6a5c7A8d4d387C9aae9172D621",
};

describe.only("CompoundV3WrapModule", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let wrapModule: WrapModuleV2;

  let underlyingToken: IERC20;
  let wrappedToken: IERC20;

  const compoundV3WrapAdapterIntegrationName: string = "COMPOUND_V3_USDC_WRAPPER";

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
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Token setup
    underlyingToken = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
    wrappedToken = IERC20__factory.connect(tokenAddresses.cUSDCv3, owner.wallet);

    // WrapModule setup
    wrapModule = await deployer.modules.deployWrapModuleV2(setup.controller.address, setup.weth.address);
    await setup.controller.addModule(wrapModule.address);

    // CompoundV3WrapAdapter setup
    const compoundV3WrapAdapter = await deployer.adapters.deployCompoundV3WrapV2Adapter(tokenAddresses.cUSDCv3);
    await setup.integrationRegistry.addIntegration(wrapModule.address, compoundV3WrapAdapterIntegrationName, compoundV3WrapAdapter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  context("when a SetToken has been deployed and issued", async () => {
    let setToken: SetToken;
    let setTokensIssued: BigNumber;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [tokenAddresses.usdc],
        [usdc(100)],
        [setup.issuanceModule.address, wrapModule.address]
      );

      // Initialize modules
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await wrapModule.initialize(setToken.address);

      // Issue some Sets
      setTokensIssued = ether(1000);
      const underlyingRequired = setTokensIssued;

      const usdcWhale = await impersonateAccount(whales.usdc);
      await underlyingToken.connect(usdcWhale).approve(setup.issuanceModule.address, underlyingRequired);
      await setup.issuanceModule.connect(usdcWhale).issue(setToken.address, setTokensIssued, owner.address);
    });

    describe("#wrap", async () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectUnderlyingUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectWrapData: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = tokenAddresses.usdc;
        subjectWrappedToken = tokenAddresses.cUSDCv3;
        subjectUnderlyingUnits = usdc(100);
        subjectIntegrationName = compoundV3WrapAdapterIntegrationName;
        subjectCaller = owner;
        subjectWrapData = ZERO_BYTES;
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectUnderlyingUnits,
          subjectIntegrationName,
          subjectWrapData
        );
      }

      it("should reduce the underlying quantity and mint the wrapped asset to the SetToken", async () => {
        const previousUnderlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const previousWrappedBalance = await wrappedToken.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const wrappedBalance = await wrappedToken.balanceOf(setToken.address);

        const delta = preciseMul(setTokensIssued, subjectUnderlyingUnits);

        const expectedUnderlyingBalance = previousUnderlyingBalance.sub(delta);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.add(delta).sub(ONE); // 1 wei rounding loss
        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });
    });

    describe("#unwrap", () => {
      let subjectSetToken: Address;
      let subjectUnderlyingToken: Address;
      let subjectWrappedToken: Address;
      let subjectWrappedTokenUnits: BigNumber;
      let subjectIntegrationName: string;
      let subjectCaller: Account;
      let subjectUnwrapData: string;

      let wrappedQuantity: BigNumber;

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectUnderlyingToken = tokenAddresses.usdc;
        subjectWrappedToken = tokenAddresses.cUSDCv3;
        subjectWrappedTokenUnits = ONE;
        subjectIntegrationName = compoundV3WrapAdapterIntegrationName;
        subjectUnwrapData = ZERO_BYTES;
        subjectCaller = owner;

        wrappedQuantity = usdc(100);

        await wrapModule.wrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          wrappedQuantity,
          subjectIntegrationName,
          ZERO_BYTES
        );
      });

      async function subject(): Promise<any> {
        return wrapModule.connect(subjectCaller.wallet).unwrap(
          subjectSetToken,
          subjectUnderlyingToken,
          subjectWrappedToken,
          subjectWrappedTokenUnits,
          subjectIntegrationName,
          subjectUnwrapData
        );
      }

      it("should burn the wrapped asset to the SetToken and increase the underlying quantity", async () => {
        const previousUnderlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const previousWrappedBalance = await wrappedToken.balanceOf(setToken.address);

        await subject();

        const underlyingBalance = await underlyingToken.balanceOf(setToken.address);
        const wrappedBalance = await wrappedToken.balanceOf(setToken.address);

        const delta = preciseMul(setTokensIssued, wrappedQuantity.sub(subjectWrappedTokenUnits));

        const expectedUnderlyingBalance = previousUnderlyingBalance.add(delta);
        expect(underlyingBalance).to.eq(expectedUnderlyingBalance);

        const expectedWrappedBalance = previousWrappedBalance.sub(delta);
        expect(wrappedBalance).to.eq(expectedWrappedBalance);
      });
    });
  });
});
