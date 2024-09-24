import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ERC4626ConverterMock, ERC4626Oracle } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  addSnapshotBeforeRestoreAfterEach,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe.only("ERC4626Oracle", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let usdcVault: ERC4626ConverterMock;

  let erc4626UsdcOracle: ERC4626Oracle;

  let price: BigNumber;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    // System setup
    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    price = ether(1.02);

    usdcVault = await deployer.mocks.deployERC4626ConverterMock(setup.usdc.address, 18, price);

    erc4626UsdcOracle = await deployer.oracles.deployERC4626Oracle(
      usdcVault.address,
      "usdcVault-usdc Oracle"
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectVaultAddress: Address;
    let subjectDataDescription: string;

    before(async () => {
      subjectVaultAddress = usdcVault.address;
      subjectDataDescription = "usdcVault-usdc Oracle";
    });

    async function subject(): Promise<ERC4626Oracle> {
      return deployer.oracles.deployERC4626Oracle(
        subjectVaultAddress,
        subjectDataDescription
      );
    }

    it("sets the correct vault address", async () => {
      const erc4626UsdcOracle = await subject();
      const vaultAddress = await erc4626UsdcOracle.vault();
      expect(vaultAddress).to.equal(subjectVaultAddress);
    });


    it("sets the correct full units", async () => {
      const erc4626UsdcOracle = await subject();
      const underlyingFullUnit = await erc4626UsdcOracle.underlyingFullUnit();
      const vaultFullUnit = await erc4626UsdcOracle.vaultFullUnit();
      expect(underlyingFullUnit).to.eq(usdc(1));
      expect(vaultFullUnit).to.eq(ether(1));
    });

    it("sets the correct data description", async () => {
      const erc4626UsdcOracle = await subject();
      const actualDataDescription = await erc4626UsdcOracle.dataDescription();
      expect(actualDataDescription).to.eq(subjectDataDescription);
    });
  });


  describe("#read", async () => {
    async function subject(): Promise<BigNumber> {
      return erc4626UsdcOracle.read();
    }

    it("returns the correct vault value", async () => {
      const result = await subject();
      expect(result).to.eq(price);
    });
  });
});
