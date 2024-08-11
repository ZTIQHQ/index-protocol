import "module-alias/register";

import { BigNumber } from "ethers";

import { Address, CustomOracleNAVIssuanceSettings } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, ADDRESS_ZERO } from "@utils/constants";
import {
  RebasingComponentAssetLimitModule,
  CustomOracleNavIssuanceModule,
  SetToken,
  CustomSetValuerMock
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  usdc,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getRandomAccount,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("RebasingComponentAssetLimitModule", () => {
  let owner: Account;
  let feeRecipient: Account;
  let recipient: Account;
  let deployer: DeployHelper;

  let setup: SystemFixture;
  let navIssuanceModule: CustomOracleNavIssuanceModule;
  let setToken: SetToken;
  let setValuer: CustomSetValuerMock;

  let rebasingComponentAssetLimitModule: RebasingComponentAssetLimitModule;

  const setRedeemLimit: BigNumber = ether(435);
  const usdcIssueLimit: BigNumber = usdc(100000);
  const ethIssueLimit: BigNumber = ether(435);

  before(async () => {
    [
      owner,
      feeRecipient,
      recipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    navIssuanceModule = await deployer.modules.deployCustomOracleNavIssuanceModule(
      setup.controller.address,
      setup.weth.address
    );
    await setup.controller.addModule(navIssuanceModule.address);

    rebasingComponentAssetLimitModule = await deployer.modules.deployRebasingComponentAssetLimitModule(
      setup.controller.address
    );
    await setup.controller.addModule(rebasingComponentAssetLimitModule.address);

    setToken = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [navIssuanceModule.address, setup.issuanceModule.address, rebasingComponentAssetLimitModule.address]
    );

    setValuer = await deployer.mocks.deployCustomSetValuerMock();

    const navIssuanceSettings = {
      managerIssuanceHook: rebasingComponentAssetLimitModule.address,
      managerRedemptionHook: rebasingComponentAssetLimitModule.address,
      setValuer: setValuer.address,
      reserveAssets: [setup.usdc.address, setup.weth.address],
      feeRecipient: feeRecipient.address,
      managerFees: [ether(0.001), ether(0.002)],
      maxManagerFee: ether(0.02),
      premiumPercentage: ether(0.01),
      maxPremiumPercentage: ether(0.1),
      minSetTokenSupply: ether(100),
    } as CustomOracleNAVIssuanceSettings;

    await navIssuanceModule.initialize(
      setToken.address,
      navIssuanceSettings
    );

    await setup.weth.approve(setup.issuanceModule.address, ether(100));
    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectController: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
    });

    async function subject(): Promise<RebasingComponentAssetLimitModule> {
      return await deployer.modules.deployRebasingComponentAssetLimitModule(subjectController);
    }

    it("should set the correct controller", async () => {
      const aaveLeverageModule = await subject();

      const controller = await aaveLeverageModule.controller();
      expect(controller).to.eq(subjectController);
    });
  });

  describe("#issue", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectReserveQuantity: BigNumber;
    let subjectMinSetTokenReceived: BigNumber;
    let subjectTo: Account;

    beforeEach(async () => {
      await rebasingComponentAssetLimitModule.initialize(
        setToken.address,
        [setup.weth.address, setup.wbtc.address],
        [setup.weth.address, setup.usdc.address, setToken.address],
        [ethIssueLimit, usdcIssueLimit, setRedeemLimit]
      );

      await setup.issuanceModule.issue(setToken.address, ether(99), owner.address);

      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectReserveQuantity = usdc(100000);
      subjectMinSetTokenReceived = ZERO;
      subjectTo = recipient;

      await setup.usdc.approve(navIssuanceModule.address, subjectReserveQuantity);
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.issue(
        subjectSetToken,
        subjectReserveAsset,
        subjectReserveQuantity,
        subjectMinSetTokenReceived,
        subjectTo.address
      );
    }

    it("should sync rebasing components", async () => {
      const initialPositions = await setToken.getPositions();
      const initialFirstPosition = (await setToken.getPositions())[0];

      // Send units to SetToken to simulate rebasing
      await setup.wbtc.transfer(setToken.address, bitcoin(100));
      await subject();

      const currentPositions = await setToken.getPositions();
      const newFirstPosition = (await setToken.getPositions())[0];
      const newSecondPosition = (await setToken.getPositions())[1];
      const newThirdPosition = (await setToken.getPositions())[2];

      expect(initialPositions.length).to.eq(1);
      expect(currentPositions.length).to.eq(3);

      expect(newFirstPosition.component).to.eq(setup.weth.address);
      expect(newFirstPosition.positionState).to.eq(0); // Default
      expect(newFirstPosition.unit).to.lt(initialFirstPosition.unit);
      expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

      expect(newSecondPosition.component).to.eq(setup.wbtc.address);
      expect(newSecondPosition.positionState).to.eq(0); // Default
      expect(newSecondPosition.unit).to.gt(ZERO);
      expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);

      expect(newThirdPosition.component).to.eq(setup.usdc.address);
      expect(newThirdPosition.positionState).to.eq(0); // Default
      expect(newThirdPosition.unit).to.gt(ZERO);
      expect(newThirdPosition.module).to.eq(ADDRESS_ZERO);
    });

    describe("when reserve asset quantity exceeds limit", async () => {
      beforeEach(async () => {
        subjectReserveQuantity = ether(110000);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Issue size exceeds asset limit");
      });
    });
  });

  describe("#redeem", async () => {
    let subjectSetToken: Address;
    let subjectReserveAsset: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectMinReserveQuantityReceived: BigNumber;
    let subjectTo: Account;

    beforeEach(async () => {
      await rebasingComponentAssetLimitModule.initialize(
        setToken.address,
        [setup.weth.address, setup.wbtc.address],
        [setup.weth.address, setup.usdc.address, setToken.address],
        [ethIssueLimit, usdcIssueLimit, setRedeemLimit]
      );

      await setup.issuanceModule.issue(setToken.address, ether(99), owner.address);

      await setup.usdc.approve(navIssuanceModule.address, usdc(100000));
      await navIssuanceModule.issue(
        setToken.address,
        setup.usdc.address,
        usdc(100000),
        ZERO,
        owner.address
      );

      subjectSetToken = setToken.address;
      subjectReserveAsset = setup.usdc.address;
      subjectSetTokenQuantity = ether(400);
      subjectMinReserveQuantityReceived = ZERO;
      subjectTo = recipient;
    });

    async function subject(): Promise<any> {
      return navIssuanceModule.redeem(
        subjectSetToken,
        subjectReserveAsset,
        subjectSetTokenQuantity,
        subjectMinReserveQuantityReceived,
        subjectTo.address
      );
    }

    it("should sync rebasing components", async () => {
      const initialPositions = await setToken.getPositions();
      const initialFirstPosition = (await setToken.getPositions())[0];
      const initialSecondPosition = (await setToken.getPositions())[1];

      // Send units to SetToken to simulate rebasing
      await setup.wbtc.transfer(setToken.address, bitcoin(100));

      await subject();

      const currentPositions = await setToken.getPositions();
      const newFirstPosition = (await setToken.getPositions())[0];
      const newSecondPosition = (await setToken.getPositions())[1];
      const newThirdPosition = (await setToken.getPositions())[2];

      expect(initialPositions.length).to.eq(2);
      expect(currentPositions.length).to.eq(3);

      expect(newFirstPosition.component).to.eq(setup.weth.address);
      expect(newFirstPosition.positionState).to.eq(0); // Default
      expect(newFirstPosition.unit).to.gt(initialFirstPosition.unit);
      expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

      expect(newSecondPosition.component).to.eq(setup.usdc.address);
      expect(newSecondPosition.positionState).to.eq(0); // Default
      expect(newSecondPosition.unit).to.gt(initialSecondPosition.unit);
      expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);

      expect(newThirdPosition.component).to.eq(setup.wbtc.address);
      expect(newThirdPosition.positionState).to.eq(0); // Default
      expect(newThirdPosition.unit).to.gt(ZERO);
      expect(newThirdPosition.module).to.eq(ADDRESS_ZERO);
    });

    describe("when call is from contract but greater than redeem limit", async () => {
      beforeEach(async () => {
        subjectSetTokenQuantity = ether(500);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Redeem size exceeds asset limit");
      });
    });
  });

  describe("#sync", async () => {
    let subjectSetToken: Address;
    let subjectCaller: Account;

    async function subject(): Promise<any> {
      return rebasingComponentAssetLimitModule.connect(subjectCaller.wallet).sync(subjectSetToken);
    }

    context("when WETH is rebasing collateral", async () => {
      describe("when module is initialized", async () => {
        beforeEach(async () => {
          await rebasingComponentAssetLimitModule.initialize(
            setToken.address,
            [setup.weth.address],
            [setup.weth.address],
            [ethIssueLimit]
          );

          subjectSetToken = setToken.address;
          subjectCaller = await getRandomAccount();
        });

        it("should update the rebasing component positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          // Send units to SetToken to simulate rebasing
          await setup.weth.transfer(setToken.address, ether(1));
          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const expectedFirstPositionUnit = await setup.weth.balanceOf(setToken.address);  // need not divide as total supply is 1.

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(1);
          expect(newFirstPosition.component).to.eq(setup.weth.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [rebasingComponentAssetLimitModule.address],
              owner.address
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      describe("when module is not initialized", async () => {
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("when set token total supply is 0", async () => {
      beforeEach(async () => {
        await rebasingComponentAssetLimitModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.weth.address],
          [ethIssueLimit]
        );

        await setToken.approve(setup.issuanceModule.address, ether(1));
        await setup.issuanceModule.redeem(setToken.address, ether(1), owner.address);

        subjectSetToken = setToken.address;
        subjectCaller = await getRandomAccount();
      });

      it("should preserve default positions", async () => {
        const initialPositions = await setToken.getPositions();

        // Send units to SetToken to simulate rebasing
        await setup.weth.transfer(setToken.address, ether(1));
        await subject();

        const currentPositions = await setToken.getPositions();

        expect(currentPositions.length).to.eq(1);
        expect(initialPositions.length).to.eq(1);

        expect(currentPositions[0].component).to.eq(setup.weth.address);
        expect(currentPositions[0].positionState).to.eq(0);
        expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
        expect(currentPositions[0].module).to.eq(ADDRESS_ZERO);
      });
    });
  });

  describe("#removeModule", async () => {
    let subjectModule: Address;

    beforeEach(async () => {
      await rebasingComponentAssetLimitModule.initialize(
        setToken.address,
        [setup.weth.address],
        [setup.weth.address],
        [ethIssueLimit]
      );
      subjectModule = rebasingComponentAssetLimitModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(rebasingComponentAssetLimitModule.address);
      expect(isModuleEnabled).to.be.false;
    });

    it("should delete the mappings", async () => {
      await subject();
      const rebasingComponents = await rebasingComponentAssetLimitModule.getRebasingComponents(setToken.address);
      const isWethRebasingComponent = await rebasingComponentAssetLimitModule.rebasingComponentEnabled(setToken.address, setup.weth.address);

      expect(rebasingComponents.length).to.eq(0);
      expect(isWethRebasingComponent).to.be.false;

      const assets = await rebasingComponentAssetLimitModule.getAssets(setToken.address);
      const wethAssetLimit = await rebasingComponentAssetLimitModule.getAssetLimit(setToken.address, setup.weth.address);

      expect(assets.length).to.eq(0);
      expect(wethAssetLimit).to.eq(0);
    });
  });

  describe("#addRebasingComponents", async () => {
    let subjectSetToken: Address;
    let subjectRebasingComponents: Address[];
    let subjectCaller: Account;

    async function subject(): Promise<any> {
      return rebasingComponentAssetLimitModule.connect(subjectCaller.wallet).addRebasingComponents(
        subjectSetToken,
        subjectRebasingComponents,
      );
    }

    describe("when module is initialized", () => {
      beforeEach(async () => {
        await rebasingComponentAssetLimitModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.weth.address],
          [ethIssueLimit]
        );

        subjectSetToken = setToken.address;
        subjectRebasingComponents = [setup.dai.address];
        subjectCaller = owner;
      });

      it("should add the rebasing component to mappings", async () => {
        await subject();
        const rebasingComponents = await rebasingComponentAssetLimitModule.getRebasingComponents(setToken.address);
        const isDaiRebasingComponent = await rebasingComponentAssetLimitModule.rebasingComponentEnabled(setToken.address, setup.dai.address);

        expect(JSON.stringify(rebasingComponents)).to.eq(JSON.stringify([setup.weth.address, setup.dai.address]));
        expect(isDaiRebasingComponent).to.be.true;
      });

      it("should emit the correct RebasingComponentsUpdated event", async () => {
        await expect(subject()).to.emit(rebasingComponentAssetLimitModule, "RebasingComponentsUpdated").withArgs(
          subjectSetToken,
          true,
          subjectRebasingComponents,
        );
      });

      describe("when rebasing component is duplicated", async () => {
        beforeEach(async () => {
          subjectRebasingComponents = [setup.weth.address, setup.weth.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebasing component already enabled");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectRebasingComponents = [setup.dai.address];
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeRebasingComponents", async () => {
    let subjectSetToken: Address;
    let subjectRebasingComponents: Address[];
    let subjectCaller: Account;

    async function subject(): Promise<any> {
      return rebasingComponentAssetLimitModule.connect(subjectCaller.wallet).removeRebasingComponents(
        subjectSetToken,
        subjectRebasingComponents,
      );
    }

    describe("when module is initialized", () => {
      beforeEach(async () => {
        await rebasingComponentAssetLimitModule.initialize(
          setToken.address,
          [setup.weth.address, setup.dai.address],
          [setup.weth.address],
          [ethIssueLimit]
        );

        subjectSetToken = setToken.address;
        subjectRebasingComponents = [setup.dai.address];
        subjectCaller = owner;
      });

      it("should remove the rebasing component from mappings", async () => {
        await subject();
        const rebasingComponents = await rebasingComponentAssetLimitModule.getRebasingComponents(setToken.address);
        const isDaiRebasingComponent = await rebasingComponentAssetLimitModule.rebasingComponentEnabled(setToken.address, setup.dai.address);
        expect(JSON.stringify(rebasingComponents)).to.eq(JSON.stringify([setup.weth.address]));
        expect(isDaiRebasingComponent).to.be.false;
      });

      it("should emit the correct RebasingComponentsUpdated event", async () => {
        await expect(subject()).to.emit(rebasingComponentAssetLimitModule, "RebasingComponentsUpdated").withArgs(
          subjectSetToken,
          false,
          subjectRebasingComponents,
        );
      });

      describe("when rebasing component is not enabled on module", async () => {
        beforeEach(async () => {
          subjectRebasingComponents = [setup.weth.address, setup.usdc.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Rebasing component not enabled");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectRebasingComponents = [setup.dai.address];
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#addAssetLimit", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectLimit: BigNumber;
    let subjectCaller: Account;

    async function subject(): Promise<any> {
      return rebasingComponentAssetLimitModule.connect(subjectCaller.wallet).addAssetLimit(
        subjectSetToken,
        subjectAsset,
        subjectLimit,
      );
    }

    describe("when module is initialized", () => {
      beforeEach(async () => {
        await rebasingComponentAssetLimitModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.weth.address],
          [ethIssueLimit]
        );

        subjectSetToken = setToken.address;
        subjectAsset = setup.wbtc.address;
        subjectLimit = bitcoin(10);
        subjectCaller = owner;
      });

      it("should set the correct limits", async () => {
        await subject();

        const wbtcLimit = await rebasingComponentAssetLimitModule.getAssetLimit(subjectSetToken, subjectAsset);
        expect(wbtcLimit).to.eq(subjectLimit);
      });

      it("should add wbtc to assets array", async () => {
        await subject();

        const assets = await rebasingComponentAssetLimitModule.getAssets(subjectSetToken);
        expect(assets).to.contain(subjectAsset);
      });

      describe("when asset is duplicated", async () => {
        beforeEach(async () => {
          subjectAsset = setup.weth.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Asset already added");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAsset = setup.wbtc.address;
        subjectLimit = bitcoin(10);
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#editAssetLimit", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectLimit: BigNumber;
    let subjectCaller: Account;

    async function subject(): Promise<any> {
      return rebasingComponentAssetLimitModule.connect(subjectCaller.wallet).editAssetLimit(
        subjectSetToken,
        subjectAsset,
        subjectLimit,
      );
    }

    describe("when module is initialized", () => {
      beforeEach(async () => {
        await rebasingComponentAssetLimitModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.weth.address],
          [ethIssueLimit]
        );

        subjectSetToken = setToken.address;
        subjectAsset = setup.weth.address;
        subjectLimit = bitcoin(10);
        subjectCaller = owner;
      });

      it("should set the correct limits", async () => {
        await subject();

        const wethLimit = await rebasingComponentAssetLimitModule.getAssetLimit(subjectSetToken, subjectAsset);
        expect(wethLimit).to.eq(subjectLimit);
      });

      describe("when asset is not already added", async () => {
        beforeEach(async () => {
          subjectAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Asset not added");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAsset = setup.weth.address;
        subjectLimit = bitcoin(10);
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeAssetLimit", async () => {
    let subjectSetToken: Address;
    let subjectAsset: Address;
    let subjectCaller: Account;

    async function subject(): Promise<any> {
      return rebasingComponentAssetLimitModule.connect(subjectCaller.wallet).removeAssetLimit(
        subjectSetToken,
        subjectAsset,
      );
    }

    describe("when module is initialized", () => {
      beforeEach(async () => {
        await rebasingComponentAssetLimitModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.weth.address],
          [ethIssueLimit]
        );

        subjectSetToken = setToken.address;
        subjectAsset = setup.weth.address;
        subjectCaller = owner;
      });

      it("should set the correct limits", async () => {
        await subject();

        const wethLimit = await rebasingComponentAssetLimitModule.getAssetLimit(subjectSetToken, subjectAsset);
        expect(wethLimit).to.eq(ZERO);
      });

      it("should remove weth from assets array", async () => {
        await subject();

        const assets = await rebasingComponentAssetLimitModule.getAssets(subjectSetToken);
        expect(assets).to.not.contain(subjectAsset);
      });

      describe("when asset is not already added", async () => {
        beforeEach(async () => {
          subjectAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Asset not added");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAsset = setup.weth.address;
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });
});
