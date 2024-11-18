import "module-alias/register";
import { BigNumber, utils } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, EMPTY_BYTES } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getLastBlockTimestamp,
  getWaffleExpect,
  getRandomAddress,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { AerodromeExchangeAdapter } from "../../../../typechain/AerodromeExchangeAdapter";
import {
  IAerodromeRouterInterface,
} from "../../../../typechain/IAerodromeRouter";
import {
  IAerodromeRouter__factory,
} from "../../../../typechain/factories/IAerodromeRouter__factory";
const expect = getWaffleExpect();

describe("AerodromeExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let swapRouterInterface: IAerodromeRouterInterface;
  let swapRouterAddress: Address;
  let poolFactoryAddress: Address;
  let aerodromeExchangeAdapter: AerodromeExchangeAdapter;

  before(async () => {
    [owner, mockSetToken] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    swapRouterInterface = IAerodromeRouter__factory.createInterface();
    swapRouterAddress = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
    poolFactoryAddress = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
    aerodromeExchangeAdapter = await deployer.adapters.deployAerodromeExchangeAdapter(
      swapRouterAddress,
      poolFactoryAddress,
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSwapRouter: Address;
    let subjectPoolFactory: Address;

    beforeEach(async () => {
      subjectSwapRouter = swapRouterAddress;
      subjectPoolFactory = poolFactoryAddress;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployAerodromeExchangeAdapter(
        subjectSwapRouter,
        subjectPoolFactory,
      );
    }

    it("should have the correct SwapRouter address", async () => {
      const deployedAerodromeExchangeAdapter = await subject();

      const actualRouterAddress = await deployedAerodromeExchangeAdapter.router();
      expect(actualRouterAddress).to.eq(swapRouterAddress);
    });

    it("should have the correct PoolFactory address", async () => {
      const deployedAerodromeExchangeAdapter = await subject();

      const actualRouterAddress = await deployedAerodromeExchangeAdapter.factory();
      expect(actualRouterAddress).to.eq(poolFactoryAddress);
    });
  });

  describe("#getSpender", async () => {
    async function subject(): Promise<any> {
      return await aerodromeExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(swapRouterAddress);
    });
  });

  describe("#getTradeCalldata", async () => {
    let fixIn: boolean;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectRoute: Bytes;
    let subjectDestinationAddress: Address;

    beforeEach(async () => {
      fixIn = true;

      subjectSourceToken = setup.wbtc.address;
      subjectSourceQuantity = BigNumber.from(100000000);
      subjectDestinationToken = setup.weth.address;
      subjectMinDestinationQuantity = ether(25);
      subjectMockSetToken = mockSetToken.address;
      subjectRoute = utils.defaultAbiCoder.encode(
        ["address", "address", "bool", "address"],
        [subjectSourceToken, subjectDestinationToken, false, poolFactoryAddress],
      );
      subjectDestinationAddress = mockSetToken.address;
    });

    async function subject(): Promise<any> {
      return await aerodromeExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectRoute,
      );
    }

    it("should return the correct trade calldata", async () => {
      const blockTimestamp = await getLastBlockTimestamp();
      const calldata = await subject();

        console.log("generating expected data");
      const expectedCallData = swapRouterInterface.encodeFunctionData("swapExactTokensForTokens", [
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        [
          {
            from: subjectSourceToken,
            to: subjectDestinationToken,
            stable: false,
            factory: poolFactoryAddress,
          },
        ],
        subjectMockSetToken,
        blockTimestamp,
      ]);

      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([swapRouterAddress, ZERO, expectedCallData]),
      );
    });

    context("when data is of invalid length", async () => {
      beforeEach(() => {
        // Skip encoding `fixIn` bool
        subjectRoute = utils.defaultAbiCoder.encode(
          ["address", "uint24", "address"],
          [subjectSourceToken, BigNumber.from(3000), subjectDestinationToken],
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid data");
      });
    });

    context("when source token does not match path", async () => {
      beforeEach(async () => {
        subjectSourceToken = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Source token path mismatch");
      });
    });

    context("when destination token does not match path", async () => {
      beforeEach(async () => {
        subjectDestinationToken = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Destination token path mismatch");
      });
    });

    context("when fixIn boolean is invalid number", async () => {
      beforeEach(async () => {
        subjectRoute = utils.defaultAbiCoder.encode(
          ["address", "address", "uint8", "address"],
          [subjectSourceToken, subjectDestinationToken, BigNumber.from(2), poolFactoryAddress],
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid bool data");
      });
    });
  });

  describe("#generateDataParam", async () => {
    let subjectToken1: Address;
    let subjectToken2: Address;
    let subjectFixIn: boolean;

    beforeEach(async () => {
      subjectToken1 = setup.wbtc.address;
      subjectToken2 = setup.dai.address;
      subjectFixIn = true;
    });

    async function subject(): Promise<string> {
      return await aerodromeExchangeAdapter.generateDataParam(
        subjectToken1,
        subjectToken2,
        subjectFixIn,
      );
    }

    it("should create correct calldata", async () => {
      const data = await subject();

      const expectedData = utils.defaultAbiCoder.encode(
        ["address", "address", "bool", "address"],
        [subjectToken1, subjectToken2, false, poolFactoryAddress],
      );

      expect(data).to.eq(expectedData);
    });

    describe("when fixIn is false", async () => {
      beforeEach(async () => {
        subjectFixIn = false;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only swapExactTokensForTokens is supported");
      });
    });
  });
});
