import "module-alias/register";

import { BigNumber, utils } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { cacheBeforeEach, getAccounts } from "@utils/test/index";
import { impersonateAccount } from "@utils/test/testingUtils";

import { DebtIssuanceModuleV2 } from "@typechain/DebtIssuanceModuleV2";
import { DebtIssuanceModuleV2__factory } from "@typechain/factories/DebtIssuanceModuleV2__factory";
import { IERC20 } from "@typechain/IERC20";
import { IERC20__factory } from "@typechain/factories/IERC20__factory";
import { SetToken } from "@typechain/SetToken";
import { SetToken__factory } from "@typechain/factories/SetToken__factory";
import { takeSnapshot, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Reproducing issuance failure for leveraged tokens on arbitrum [ @forked-mainnet ]", () => {
  let owner: Account;
  let manager: Account;
  const debtIssuanceModuleAddress = "0x120d2f26B7ffd35a8917415A5766Fa63B2af94aa";
  let debtIssuanceModule: DebtIssuanceModuleV2;

  const aWETHAddress = "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8";
  let aWETH: IERC20;
  const aWETHWhaleAddress = "0xb7fb2b774eb5e2dad9c060fb367acbdc7fa7099b";
  const usdcAddress = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  let usdc: IERC20;
  const usdcWhaleAddress = "0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D";

  const setTokenAddress = "0x67d2373f0321Cd24a1b58e3c81fC1b6Ef15B205C"; // ETH2X
  let setToken: SetToken;

  cacheBeforeEach(async () => {
    [owner, manager] = await getAccounts();
    const aWethWhaleSigner = await impersonateAccount(aWETHWhaleAddress);
    aWETH = IERC20__factory.connect(aWETHAddress, owner.wallet);
    const aWETHToTransfer = utils.parseEther("10");
    await aWETH.connect(aWethWhaleSigner).transfer(owner.address, aWETHToTransfer);
    aWETH.approve(debtIssuanceModuleAddress, aWETHToTransfer);
    usdc = IERC20__factory.connect(usdcAddress, owner.wallet);
    setToken = SetToken__factory.connect(setTokenAddress, owner.wallet);
    const totalSupply = await setToken.totalSupply();
    console.log("set token total supply", totalSupply.toString());
    debtIssuanceModule = DebtIssuanceModuleV2__factory.connect(
      debtIssuanceModuleAddress,
      owner.wallet,
    );
  });

  describe("#DebtIssuanceModuleV2.issue", async () => {
    let subjectSetToken: Address;
    let subjectCaller: Account;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let blockTimestamp: number;
    beforeEach(async () => {
      subjectSetToken = setTokenAddress;
      subjectCaller = owner;
      subjectQuantity = utils.parseEther("1");
      subjectTo = subjectCaller.address;
    });
    async function subject(): Promise<any> {
      return debtIssuanceModule
        .connect(subjectCaller.wallet)
        .issue(subjectSetToken, subjectQuantity, subjectTo);
    }

    // First timestamp results in revertion second one doesn't
    [7, 8].forEach(i => {
      context(`when timestamp offset is ${i}`, async () => {
        beforeEach(async () => {
          const newTimestamp = Math.floor(new Date("2024-04-23T07:30:00.000Z").getTime() / 1000);
          await time.setNextBlockTimestamp(newTimestamp + i);
        });

        it("should not revert", async () => {
          await subject();
        });
      });
    });
  });
});
