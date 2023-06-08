import "module-alias/register";

import { BigNumber } from "ethers";
import { utils } from "ethers";

import { Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { BalancerV2ExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getLastBlockTimestamp
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("BalancerV2ExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let balancerV2ExchangeAdapter: BalancerV2ExchangeAdapter;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    balancerV2ExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapter(balancerSetup.router.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectVault: Address;

    beforeEach(async () => {
      subjectVault = ADDRESS_ZERO;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployUniswapV2ExchangeAdapter(subjectVault);
    }

    it("should have the correct router address", async () => {
      const deployedUniswapV2ExchangeAdapter = await subject();

      const actualRouterAddress = await deployedUniswapV2ExchangeAdapter.router();
      expect(actualRouterAddress).to.eq(ADDRESS_ZERO);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await balancerV2ExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(ADDRESS_ZERO);
    });
  });

  describe("getTradeCalldata", async () => {
    let sourceAddress: Address;
    let destinationAddress: Address;
    let sourceQuantity: BigNumber;
    let destinationQuantity: BigNumber;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceAddress = setup.wbtc.address;          // WBTC Address
      sourceQuantity = BigNumber.from(100000000);  // Trade 1 WBTC
      destinationAddress = setup.dai.address;      // DAI Address
      destinationQuantity = ether(30000);         // Receive at least 30k DAI

      subjectSourceToken = sourceAddress;
      subjectDestinationToken = destinationAddress;
      subjectMockSetToken = mockSetToken.address;
      subjectSourceQuantity = sourceQuantity;
      subjectMinDestinationQuantity = destinationQuantity;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await balancerV2ExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectData,
      );
    }

    it("should return the correct trade calldata", async () => {
      const calldata = await subject();
      const callTimestamp = await getLastBlockTimestamp();
      const expectedCallData = balancerSetup.router.interface.encodeFunctionData("swapExactTokensForTokens", [
        sourceQuantity,
        destinationQuantity,
        [sourceAddress, destinationAddress],
        subjectMockSetToken,
        callTimestamp,
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([balancerSetup.router.address, ZERO, expectedCallData]));
    });

    describe("when passed in custom path to trade data", async () => {
      beforeEach(async () => {
        const path = [sourceAddress, setup.weth.address, destinationAddress];
        subjectData = utils.defaultAbiCoder.encode(
          ["address[]"],
          [path]
        );
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = balancerSetup.router.interface.encodeFunctionData("swapExactTokensForTokens", [
          sourceQuantity,
          destinationQuantity,
          [sourceAddress, setup.weth.address, destinationAddress],
          subjectMockSetToken,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([balancerSetup.router.address, ZERO, expectedCallData]));
      });
    });
  });
});
