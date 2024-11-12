import "module-alias/register";
import { BigNumber } from "ethers";

import {
  Address,
  ContractTransaction,
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
  getRandomAddress,
  getRandomAccount,
  getTransactionTimestamp
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/index";

const expect = getWaffleExpect();

describe("CachedSetValuer", () => {
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

    initialMaxStaleness = BigNumber.from(3600);
  });

  beforeEach(async () => {
    rebasingComponentModule = await deployer.modules.deployRebasingComponentModule(setup.controller.address);
    await setup.controller.addModule(rebasingComponentModule.address);

    const components = [setup.weth.address, setup.usdc.address];
    const units = [ether(1), usdc(100)];
    const modules = [setup.issuanceModule.address, rebasingComponentModule.address];
    setToken = await setup.createSetToken(components, units, modules);

    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await rebasingComponentModule.initialize(setToken.address, components);

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

  describe("#setMaxStaleness", async () => {
    let subjectMaxStaleness: BigNumber;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectMaxStaleness = BigNumber.from(7200);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return cachedSetValuer.connect(subjectCaller.wallet).setMaxStaleness(subjectMaxStaleness);
    }

    it("should update maxStaleness", async () => {
      await subject();
      const newMaxStaleness = await cachedSetValuer.maxStaleness();
      expect(newMaxStaleness).to.eq(subjectMaxStaleness);
    });

    it("should emit MaxStalenessUpdated event", async () => {
      await expect(subject())
        .to.emit(cachedSetValuer, "MaxStalenessUpdated")
        .withArgs(subjectMaxStaleness);
    });

    describe("when caller is not owner", () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setSetValuer", () => {
    let subjectSetValuer: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const newSetValuer = await deployer.core.deploySetValuer(setup.controller.address);
      await setup.controller.addResource(newSetValuer.address, 3);
      subjectSetValuer = newSetValuer.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return cachedSetValuer.connect(subjectCaller.wallet).setSetValuer(subjectSetValuer);
    }

    it("should set the new SetValuer", async () => {
      await subject();
      expect(await cachedSetValuer.setValuer()).to.eq(subjectSetValuer);
    });

    it("should emit SetValuerUpdated event", async () => {
      await expect(subject())
        .to.emit(cachedSetValuer, "SetValuerUpdated")
        .withArgs(subjectSetValuer);
    });

    describe("when SetValuer is not enabled on controller", () => {
      beforeEach(async () => {
        const newSetValuer = await deployer.core.deploySetValuer(setup.controller.address);
        subjectSetValuer = newSetValuer.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("SetValuer must be enabled on Controller");
      });
    });

    describe("when caller is not owner", () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#updateCache", () => {
    let subjectSetToken: Address;
    let subjectQuoteAsset: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectQuoteAsset = setup.usdc.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return cachedSetValuer.updateCache(subjectSetToken, subjectQuoteAsset);
    }

    it("should update the cache with current valuation", async () => {
      await subject();

      const cachedValuation = await cachedSetValuer.cachedValuations(subjectSetToken, subjectQuoteAsset);
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
      const txn = await subject();
      const timestamp = await getTransactionTimestamp(txn);

      await expect(subject())
        .to.emit(cachedSetValuer, "CacheUpdated")
        .withArgs(subjectSetToken, subjectQuoteAsset, expectedValuation, timestamp.add(1));
    });

    describe("when rebasing module is zero address", () => {
      beforeEach(async () => {
        cachedSetValuer = await deployer.product.deployCachedSetValuer(
          setup.controller.address,
          setup.setValuer.address,
          ADDRESS_ZERO,
          initialMaxStaleness
        );
      });

      it("should update cache without syncing rebasing components", async () => {
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

  describe("#previewValuation", () => {
    let subjectSetToken: Address;
    let subjectQuoteAsset: Address;

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectQuoteAsset = setup.usdc.address;

      await cachedSetValuer.calculateSetTokenValuation(subjectSetToken, subjectQuoteAsset);
    });

    async function subject(): Promise<any> {
      return cachedSetValuer.previewValuation(subjectSetToken, subjectQuoteAsset);
    }

    it("should return correct cached and current valuations", async () => {
      const valuationInfo = await subject();
      const expectedCurrentValue = await setup.setValuer.calculateSetTokenValuation(
        subjectSetToken,
        subjectQuoteAsset
      );

      expect(valuationInfo.currentValue).to.eq(expectedCurrentValue);
      expect(valuationInfo.cachedValue).to.eq(expectedCurrentValue);
      expect(valuationInfo.isStale).to.be.false;
    });

    describe("when cache is stale", () => {
      beforeEach(async () => {
        await increaseTimeAsync(initialMaxStaleness.add(1));
      });

      it("should indicate cache is stale", async () => {
        const valuationInfo = await subject();
        expect(valuationInfo.isStale).to.be.true;
      });
    });

    describe("when no cached value exists", () => {
      let mockSetToken: SetToken;

      beforeEach(async () => {
        const components = [setup.weth.address];
        const units = [ether(1)];
        const modules = [setup.issuanceModule.address];
        mockSetToken = await setup.createSetToken(
          components,
          units,
          modules,
          setup.controller.address,
          "Mock SetToken",
          "MOCK"
        );

        subjectSetToken = mockSetToken.address;
        subjectQuoteAsset = setup.usdc.address;
      });

      it("should return zero for cached value", async () => {
        const valuationInfo = await subject();
        expect(valuationInfo.cachedValue).to.eq(ZERO);
        expect(valuationInfo.lastUpdateTimestamp).to.eq(ZERO);
        expect(valuationInfo.isStale).to.be.true;
        expect(valuationInfo.currentValue).to.gt(ZERO);
      });
    });
  });

  describe("#setRebasingModule", () => {
    let subjectRebasingModule: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      const newRebasingModule = await deployer.modules.deployRebasingComponentModule(setup.controller.address);
      await setup.controller.addModule(newRebasingModule.address);
      subjectRebasingModule = newRebasingModule.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return cachedSetValuer.connect(subjectCaller.wallet).setRebasingModule(subjectRebasingModule);
    }

    it("should set the new RebasingModule", async () => {
      await subject();
      expect(await cachedSetValuer.rebasingModule()).to.eq(subjectRebasingModule);
    });

    it("should emit RebasingModuleUpdated event", async () => {
      await expect(subject())
        .to.emit(cachedSetValuer, "RebasingModuleUpdated")
        .withArgs(subjectRebasingModule);
    });

    describe("when RebasingModule is not enabled on controller", () => {
      beforeEach(async () => {
        const newRebasingModule = await deployer.modules.deployRebasingComponentModule(setup.controller.address);
        subjectRebasingModule = newRebasingModule.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("RebasingModule must be enabled on Controller");
      });
    });

    describe("when caller is not owner", () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#_isCacheValid", () => {
    beforeEach(async () => {
      await cachedSetValuer.calculateSetTokenValuation(setToken.address, setup.usdc.address);
    });

    it("should return true for fresh cache", async () => {
      const valuationInfo = await cachedSetValuer.previewValuation(setToken.address, setup.usdc.address);
      expect(valuationInfo.isStale).to.be.false;
    });

    it("should return false for stale cache", async () => {
      await increaseTimeAsync(initialMaxStaleness.add(1));
      const valuationInfo = await cachedSetValuer.previewValuation(setToken.address, setup.usdc.address);
      expect(valuationInfo.isStale).to.be.true;
    });
  });
});
