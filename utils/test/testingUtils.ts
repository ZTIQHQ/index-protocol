import chai from "chai";
import { solidity } from "ethereum-waffle";
import { SetToken } from "@utils/contracts";
import { Contract } from "ethers";

chai.use(solidity);

// Use HARDHAT version of providers
import { ethers, network } from "hardhat";
import { BigNumber, providers, Signer } from "ethers";
import { Blockchain } from "../common";

const provider = new ethers.providers.JsonRpcProvider();
// const blockchain = new Blockchain(provider);

// HARDHAT-SPECIFIC Provider
export const getProvider = (): providers.JsonRpcProvider => {
  return ethers.provider;
};

// HARDHAT / WAFFLE
export const getWaffleExpect = (): Chai.ExpectStatic => {
  return chai.expect;
};

// And this is our test sandboxing. It snapshots and restores between each test.
// Note: if a test suite uses fastForward at all, then it MUST also use these snapshots,
// otherwise it will update the block time of the EVM and future tests that expect a
// starting timestamp will fail.
export const addSnapshotBeforeRestoreAfterEach = () => {
  const blockchain = new Blockchain(provider);
  beforeEach(async () => {
    await blockchain.saveSnapshotAsync();
  });

  afterEach(async () => {
    await blockchain.revertAsync();
  });
};

// This is test sandboxing for nested snapshots. Can be used like a `beforeEach` statement.
// The same caveats about time noted in the comment above apply.
const SNAPSHOTS: string[] = [];

export function cacheBeforeEach(initializer: Mocha.AsyncFunc): void {
  let initialized = false;
  const blockchain = new Blockchain(provider);

  beforeEach(async function () {
    if (!initialized) {
      await initializer.call(this);
      SNAPSHOTS.push(await blockchain.saveSnapshotAsync());
      initialized = true;
    } else {
      const snapshotId = SNAPSHOTS.pop()!;
      await blockchain.revertByIdAsync(snapshotId);
      SNAPSHOTS.push(await blockchain.saveSnapshotAsync());
    }
  });

  after(async function () {
    if (initialized) {
      SNAPSHOTS.pop();
    }
  });
}

export async function getTransactionTimestamp(asyncTxn: any): Promise<BigNumber> {
  const txData = await asyncTxn;
  return BigNumber.from((await provider.getBlock(txData.block)).timestamp);
}

export async function getLastBlockTimestamp(): Promise<BigNumber> {
  return BigNumber.from((await provider.getBlock("latest")).timestamp);
}

export async function mineBlockAsync(): Promise<any> {
  await sendJSONRpcRequestAsync("evm_mine", []);
}

export async function increaseTimeAsync(duration: BigNumber): Promise<any> {
  await sendJSONRpcRequestAsync("evm_increaseTime", [duration.toNumber()]);
  await mineBlockAsync();
}

async function sendJSONRpcRequestAsync(method: string, params: any[]): Promise<any> {
  return provider.send(method, params);
}

export async function convertNotionalToPosition(
  notionalAmount: BigNumber,
  setToken: SetToken,
): Promise<BigNumber> {
  return notionalAmount.mul(BigNumber.from(10).pow(18)).div(await setToken.totalSupply());
}

export async function convertPositionToNotional(
  positionAmount: BigNumber,
  setToken: SetToken,
): Promise<BigNumber> {
  return positionAmount.mul(await setToken.totalSupply()).div(BigNumber.from(10).pow(18));
}

export async function impersonateAccount(address: string): Promise<Signer> {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  return await ethers.getSigner(address);
}

export async function waitForEvent(contract: Contract, event: string): Promise<any> {
  return new Promise(resolve => {
    contract.on(event, (...args: any[]) => {
      resolve(args);
    });
  });
}
