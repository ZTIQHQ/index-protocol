import "module-alias/register";
import { BigNumber } from "ethers";

import {
  Address,
} from "@utils/types";
import { Account } from "@utils/test/types";
import { CachedSetValuer, SetToken, RebasingComponentModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  increaseTimeAsync,
  getLastBlockTimestamp,
  getRandomAddress
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/index";

const expect = getWaffleExpect();

describe.only("CachedSetValuer", () => {
  let owner: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let setToken: SetToken;
  let cachedSetValuer: CachedSetValuer;
  let rebasingComponentModule: RebasingComponentModule;

  let initialMaxStaleness: BigNumber;

  before(async () => {
    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    rebasingComponentModule = await deployer.modules.deployRebasingComponentModule(setup.controller.address);
    await setup.controller.addModule(rebasingComponentModule.address);

    const components = [setup.weth.address, setup.usdc.address];
    const units = [ether(1), usdc(100)];
    const modules = [setup.issuanceModule.address, rebasingComponentModule.address];
    setToken = await setup.createSetToken(
      components,
      units,
      modules
    );

    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await rebasingComponentModule.initialize(setToken.address, components);

    initialMaxStaleness = BigNumber.from(3600);

    cachedSetValuer = await deployer.product.deployCachedSetValuer(
      setup.controller.address,
      setup.setValuer.address,
      rebasingComponentModule.address,
      initialMaxStaleness
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectSetValuer: Address;
    let subjectRebasingModule: Address;
    let subjectMaxStaleness: BigNumber;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectSetValuer = setup.setValuer.address;
      subjectRebasingModule = rebasingComponentModule.address;
      subjectMaxStaleness = initialMaxStaleness;
    });

    async function subject(): Promise<CachedSetValuer> {
      return deployer.product.deployCachedSetValuer(
        subjectController,
        subjectSetValuer,
        subjectRebasingModule,
        subjectMaxStaleness
      );
    }

    it("should set the correct Controller address", async () => {
      const cachedSetValuer = await subject();
      const actualController = await cachedSetValuer.controller();
      expect(actualController).to.eq(subjectController);
    });

    it("should set the correct SetValuer address", async () => {
      const cachedSetValuer = await subject();
      const actualSetValuer = await cachedSetValuer.setValuer();
      expect(actualSetValuer).to.eq(subjectSetValuer);
    });

    it("should set the correct RebasingComponentModule address", async () => {
      const cachedSetValuer = await subject();
      const actualRebasingModule = await cachedSetValuer.rebasingModule();
      expect(actualRebasingModule).to.eq(subjectRebasingModule);
    });

    it("should set the correct maxStaleness", async () => {
      const cachedSetValuer = await subject();
      const actualMaxStaleness = await cachedSetValuer.maxStaleness();
      expect(actualMaxStaleness).to.eq(subjectMaxStaleness);
    });

    describe("when the SetValuer address is zero", async () => {
      beforeEach(async () => {
        subjectSetValuer = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("SetValuer must be enabled on Controller");
      });
    });

    describe("when SetValuer is not enabled on controller", async () => {
      beforeEach(async () => {
        subjectSetValuer = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("SetValuer must be enabled on Controller");
      });
    });

    describe("when rebasing module is zero address", async () => {
      beforeEach(async () => {
        subjectRebasingModule = ADDRESS_ZERO;
      });

      it("should set the rebasing module to zero address", async () => {
        const cachedSetValuer = await subject();
        const actualRebasingModule = await cachedSetValuer.rebasingModule();
        expect(actualRebasingModule).to.eq(ADDRESS_ZERO);
      });
    });

    describe("when rebasing module is not enabled on controller", async () => {
      beforeEach(async () => {
        await setup.controller.removeModule(subjectRebasingModule);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("RebasingModule must be enabled on Controller");
      });
    });
  });

  describe("#calculateSetTokenValuation", async () => {
    let subjectSetToken: Address;
    let subjectQuoteAsset: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectQuoteAsset = setup.usdc.address;
    });

    async function subject(): Promise<void> {
      await cachedSetValuer.calculateSetTokenValuation(
        subjectSetToken,
        subjectQuoteAsset
      );
    }

    it("should store the correct valuation on first call", async () => {
      await subject();

      const cachedValuation = await cachedSetValuer.cachedValuations(subjectSetToken, subjectQuoteAsset);
      const expectedValuation = await setup.setValuer.calculateSetTokenValuation(
        subjectSetToken,
        subjectQuoteAsset
      );
      expect(cachedValuation.value).to.eq(expectedValuation);
    });

    it("should cache the valuation with correct timestamp", async () => {
      await subject();

      const cachedValuation = await cachedSetValuer.cachedValuations(
        subjectSetToken,
        subjectQuoteAsset
      );

      expect(cachedValuation.value).to.gt(ZERO);
      expect(cachedValuation.timestamp).to.eq(await getLastBlockTimestamp());
    });

    describe("when cache is stale", async () => {
      beforeEach(async () => {
        await subject();
        await increaseTimeAsync(initialMaxStaleness.add(1));
      });

      it("should update to new valuation", async () => {
        await subject();

        const cachedValuation = await cachedSetValuer.cachedValuations(subjectSetToken, subjectQuoteAsset);
        const expectedValuation = await setup.setValuer.calculateSetTokenValuation(
          subjectSetToken,
          subjectQuoteAsset
        );
        expect(cachedValuation.value).to.eq(expectedValuation);
      });
    });

    describe("when SetToken is invalid", async () => {
      beforeEach(async () => {
        subjectSetToken = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when rebasing module is zero address", async () => {
      beforeEach(async () => {
        cachedSetValuer = await deployer.product.deployCachedSetValuer(
          setup.controller.address,
          setup.setValuer.address,
          ADDRESS_ZERO,
          initialMaxStaleness
        );
      });

      it("should store valuation without syncing rebasing components", async () => {
        await subject();

        const cachedValuation = await cachedSetValuer.cachedValuations(subjectSetToken, subjectQuoteAsset);
        const expectedValuation = await setup.setValuer.calculateSetTokenValuation(
          subjectSetToken,
          subjectQuoteAsset
        );
        expect(cachedValuation.value).to.eq(expectedValuation);
      });
    });
  });

  describe.skip("#setMaxStaleness", async () => {
    let subjectMaxStaleness: BigNumber;

    beforeEach(async () => {
      subjectMaxStaleness = await BigNumber.from(7200);
    });

    async function subject(): Promise<any> {
      return cachedSetValuer.connect(owner.wallet).setMaxStaleness(subjectMaxStaleness);
    }

    it("should update maxStaleness", async () => {
      await subject();
      const newMaxStaleness = await cachedSetValuer.maxStaleness();
      expect(newMaxStaleness).to.eq(subjectMaxStaleness);
    });

    it("should emit correct MaxStalenessUpdated event", async () => {
      await expect(subject()).to.emit(cachedSetValuer, "MaxStalenessUpdated")
        .withArgs(initialMaxStaleness, subjectMaxStaleness);
    });

    describe("when caller is not owner", async () => {
      let caller: Account;

      beforeEach(async () => {
        [, caller] = await getAccounts();
      });

      async function subject(): Promise<any> {
        return cachedSetValuer.connect(caller.wallet).setMaxStaleness(subjectMaxStaleness);
      }

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe.skip("#setSetValuer", async () => {
    let subjectSetValuer: Address;

    beforeEach(async () => {
      const newSetValuer = await deployer.core.deploySetValuer(setup.controller.address);
      await setup.controller.addResource(newSetValuer.address, 3);
      subjectSetValuer = newSetValuer.address;
    });

    async function subject(): Promise<any> {
      return cachedSetValuer.connect(owner.wallet).setSetValuer(subjectSetValuer);
    }

    it("should update SetValuer", async () => {
      const oldSetValuer = await cachedSetValuer.setValuer();
      await subject();
      expect(await cachedSetValuer.setValuer()).to.eq(subjectSetValuer);
      expect(await cachedSetValuer.setValuer()).to.not.eq(oldSetValuer);
    });

    it("should emit SetValuerUpdated event", async () => {
      const oldSetValuer = await cachedSetValuer.setValuer();
      await expect(subject())
        .to.emit(cachedSetValuer, "SetValuerUpdated")
        .withArgs(oldSetValuer, subjectSetValuer);
    });

    describe("when new SetValuer is not enabled on controller", async () => {
      beforeEach(async () => {
        const newSetValuer = await deployer.core.deploySetValuer(setup.controller.address);
        subjectSetValuer = newSetValuer.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("SetValuer must be enabled on Controller");
      });
    });

    describe("when new SetValuer is zero address", async () => {
      beforeEach(async () => {
        subjectSetValuer = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid SetValuer address");
      });
    });
  });

  describe.skip("#setRebasingModule", async () => {
    let subjectRebasingModule: Address;
    let newRebasingModule: Account;

    beforeEach(async () => {
      [, newRebasingModule] = await getAccounts();
      subjectRebasingModule = newRebasingModule.address;
    });

    async function subject(): Promise<any> {
      return cachedSetValuer.connect(owner.wallet).setRebasingModule(subjectRebasingModule);
    }

    describe("when new RebasingModule is not enabled on controller", async () => {
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("RebasingModule must be enabled on Controller");
      });
    });
  });

  describe.skip("#updateCache", async () => {
    let subjectSetToken: Address;
    let subjectQuoteAsset: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectQuoteAsset = setup.usdc.address;
    });

    async function subject(): Promise<any> {
      return cachedSetValuer.updateCache(
        subjectSetToken,
        subjectQuoteAsset
      );
    }

    it("should update cache with new valuation", async () => {
      await subject();

      const cachedValuation = await cachedSetValuer.cachedValuations(
        subjectSetToken,
        subjectQuoteAsset
      );
      const expectedValuation = await setup.setValuer.calculateSetTokenValuation(
        subjectSetToken,
        subjectQuoteAsset
      );
      expect(cachedValuation.value).to.eq(expectedValuation);
    });

    it("should emit CacheUpdated event", async () => {
      const expectedValuation = await setup.setValuer.calculateSetTokenValuation(
        subjectSetToken,
        subjectQuoteAsset
      );

      await expect(subject())
        .to.emit(cachedSetValuer, "CacheUpdated")
        .withArgs(subjectSetToken, subjectQuoteAsset, expectedValuation, await getLastBlockTimestamp());
    });
  });
});
