/*
    Copyright 2024 Index Coop

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IController } from "../../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../../interfaces/IDebtIssuanceModule.sol";
import { IExchangeAdapter } from "../../../interfaces/IExchangeAdapter.sol";
import { IModuleIssuanceHook } from "../../../interfaces/IModuleIssuanceHook.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { ModuleBase } from "../../lib/ModuleBase.sol";

/**
 * @title Morpho Leverage Module
 * @author Index Coop
 * @notice Smart contract that enables leverage trading using Morpho Blue as the lending protocol.
 */
contract MorphoLeverageModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook {

    /* ============ Structs ============ */

    struct EnabledAssets {
        address[] collateralAssets;             // Array of enabled underlying collateral assets for a SetToken
        address[] borrowAssets;                 // Array of enabled underlying borrow assets for a SetToken
    }

    struct ActionInfo {
        ISetToken setToken;                      // SetToken instance
        IExchangeAdapter exchangeAdapter;        // Exchange adapter instance
        uint256 setTotalSupply;                  // Total supply of SetToken
        uint256 notionalSendQuantity;            // Total notional quantity sent to exchange
        uint256 minNotionalReceiveQuantity;      // Min total notional received from exchange
        IERC20 collateralAsset;                  // Address of collateral asset
        IERC20 borrowAsset;                      // Address of borrow asset
        uint256 preTradeReceiveTokenBalance;     // Balance of pre-trade receive token balance
    }

    /* ============ Events ============ */

    /**
     * @dev Emitted on lever()
     * @param _setToken             Instance of the SetToken being levered
     * @param _borrowAsset          Asset being borrowed for leverage
     * @param _collateralAsset      Collateral asset being levered
     * @param _exchangeAdapter      Exchange adapter used for trading
     * @param _totalBorrowAmount    Total amount of `_borrowAsset` borrowed
     * @param _totalReceiveAmount   Total amount of `_collateralAsset` received by selling `_borrowAsset`
     * @param _protocolFee          Protocol fee charged
     */
    event LeverageIncreased(
        ISetToken indexed _setToken,
        IERC20 indexed _borrowAsset,
        IERC20 indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalBorrowAmount,
        uint256 _totalReceiveAmount,
        uint256 _protocolFee
    );

    /**
     * @dev Emitted on delever() and deleverToZeroBorrowBalance()
     * @param _setToken             Instance of the SetToken being delevered
     * @param _collateralAsset      Asset sold to decrease leverage
     * @param _repayAsset           Asset being bought to repay to Morpho
     * @param _exchangeAdapter      Exchange adapter used for trading
     * @param _totalRedeemAmount    Total amount of `_collateralAsset` being sold
     * @param _totalRepayAmount     Total amount of `_repayAsset` being repaid
     * @param _protocolFee          Protocol fee charged
     */
    event LeverageDecreased(
        ISetToken indexed _setToken,
        IERC20 indexed _collateralAsset,
        IERC20 indexed _repayAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalRedeemAmount,
        uint256 _totalRepayAmount,
        uint256 _protocolFee
    );

    /**
     * @dev Emitted on addCollateralAssets() and removeCollateralAssets()
     * @param _setToken Instance of SetToken whose collateral assets is updated
     * @param _added    true if assets are added false if removed
     * @param _assets   Array of collateral assets being added/removed
     */
    event CollateralAssetsUpdated(
        ISetToken indexed _setToken,
        bool indexed _added,
        IERC20[] _assets
    );

    /**
     * @dev Emitted on addBorrowAssets() and removeBorrowAssets()
     * @param _setToken Instance of SetToken whose borrow assets is updated
     * @param _added    true if assets are added false if removed
     * @param _assets   Array of borrow assets being added/removed
     */
    event BorrowAssetsUpdated(
        ISetToken indexed _setToken,
        bool indexed _added,
        IERC20[] _assets
    );


    /**
     * @dev Emitted on updateAllowedSetToken()
     * @param _setToken SetToken being whose allowance to initialize this module is being updated
     * @param _added    true if added false if removed
     */
    event SetTokenStatusUpdated(
        ISetToken indexed _setToken,
        bool indexed _added
    );

    /**
     * @dev Emitted on updateAnySetAllowed()
     * @param _anySetAllowed    true if any set is allowed to initialize this module, false otherwise
     */
    event AnySetAllowedUpdated(
        bool indexed _anySetAllowed
    );

    /* ============ Constants ============ */


    // String identifying the DebtIssuanceModule in the IntegrationRegistry. Note: Governance must add DefaultIssuanceModule as
    // the string as the integration name
    string constant internal DEFAULT_ISSUANCE_MODULE_NAME = "DefaultIssuanceModule";

    // 0 index stores protocol fee % on the controller, charged in the _executeTrade function
    uint256 constant internal PROTOCOL_TRADE_FEE_INDEX = 0;

    /* ============ State Variables ============ */

    // Mapping to efficiently check if collateral asset is enabled in SetToken
    mapping(ISetToken => mapping(IERC20 => bool)) public collateralAssetEnabled;

    // Mapping to efficiently check if a borrow asset is enabled in SetToken
    mapping(ISetToken => mapping(IERC20 => bool)) public borrowAssetEnabled;

    // Internal mapping of enabled collateral and borrow tokens for syncing positions
    mapping(ISetToken => EnabledAssets) internal enabledAssets;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list. Updateable by governance.
    bool public anySetAllowed;

    /* ============ Constructor ============ */

    /**
     * @dev Instantiate addresses. Underlying to reserve tokens mapping is created.
     * @param _controller                       Address of controller contract
     */
    constructor(
        IController _controller
    )
        public
        ModuleBase(_controller)
    {
    }

    /* ============ External Functions ============ */

    /**
     * @dev MANAGER ONLY: Increases leverage for a given collateral position using an enabled borrow asset.
     * Borrows _borrowAsset from Morpho Market. Performs a DEX trade, exchanging the _borrowAsset for _collateralAsset.
     * Deposits _collateralAsset to Morpho Market
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset.
     * @param _setToken                     Instance of the SetToken
     * @param _borrowAsset                  Address of underlying asset being borrowed for leverage
     * @param _collateralAsset              Address of underlying collateral asset
     * @param _borrowQuantityUnits          Borrow quantity of asset in position units
     * @param _minReceiveQuantityUnits      Min receive quantity of collateral asset to receive post-trade in position units
     * @param _tradeAdapterName             Name of trade adapter
     * @param _tradeData                    Arbitrary data for trade
     */
    function lever(
        ISetToken _setToken,
        IERC20 _borrowAsset,
        IERC20 _collateralAsset,
        uint256 _borrowQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        // For levering up, send quantity is derived from borrow asset and receive quantity is derived from
        // collateral asset
        ActionInfo memory leverInfo = _createAndValidateActionInfo(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            _borrowQuantityUnits,
            _minReceiveQuantityUnits,
            _tradeAdapterName,
            true
        );

        _borrow(leverInfo.setToken, leverInfo.borrowAsset, leverInfo.notionalSendQuantity);

        uint256 postTradeReceiveQuantity = _executeTrade(leverInfo, _borrowAsset, _collateralAsset, _tradeData);

        uint256 protocolFee = _accrueProtocolFee(_setToken, _collateralAsset, postTradeReceiveQuantity);

        uint256 postTradeCollateralQuantity = postTradeReceiveQuantity.sub(protocolFee);

        _deposit(leverInfo.setToken, _collateralAsset, postTradeCollateralQuantity);

        _updateLeverPositions(leverInfo, _borrowAsset);

        emit LeverageIncreased(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            leverInfo.exchangeAdapter,
            leverInfo.notionalSendQuantity,
            postTradeCollateralQuantity,
            protocolFee
        );
    }

    /**
     * @dev MANAGER ONLY: Decrease leverage for a given collateral position using an enabled borrow asset.
     * Withdraws _collateralAsset from Morpho. Performs a DEX trade, exchanging the _collateralAsset for _repayAsset.
     * Repays _repayAsset to Morpho
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset.
     * @param _setToken                 Instance of the SetToken
     * @param _collateralAsset          Address of underlying collateral asset being withdrawn
     * @param _repayAsset               Address of underlying borrowed asset being repaid
     * @param _redeemQuantityUnits      Quantity of collateral asset to delever in position units
     * @param _minRepayQuantityUnits    Minimum amount of repay asset to receive post trade in position units
     * @param _tradeAdapterName         Name of trade adapter
     * @param _tradeData                Arbitrary data for trade
     */
    function delever(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantityUnits,
        uint256 _minRepayQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        // Note: for delevering, send quantity is derived from collateral asset and receive quantity is derived from
        // repay asset
        ActionInfo memory deleverInfo = _createAndValidateActionInfo(
            _setToken,
            _collateralAsset,
            _repayAsset,
            _redeemQuantityUnits,
            _minRepayQuantityUnits,
            _tradeAdapterName,
            false
        );

        _withdraw(deleverInfo.setToken, _collateralAsset, deleverInfo.notionalSendQuantity);

        uint256 postTradeReceiveQuantity = _executeTrade(deleverInfo, _collateralAsset, _repayAsset, _tradeData);

        uint256 protocolFee = _accrueProtocolFee(_setToken, _repayAsset, postTradeReceiveQuantity);

        uint256 repayQuantity = postTradeReceiveQuantity.sub(protocolFee);

        _repayBorrow(deleverInfo.setToken, _repayAsset, repayQuantity);

        _updateDeleverPositions(deleverInfo, _repayAsset);

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            repayQuantity,
            protocolFee
        );
    }

    /** @dev MANAGER ONLY: Pays down the borrow asset to 0 selling off a given amount of collateral asset.
     * Withdraws _collateralAsset from Morpho Market. Performs a DEX trade, exchanging the _collateralAsset for _repayAsset.
     * Minimum receive amount for the DEX trade is set to the current variable debt balance of the borrow asset.
     * Repays received _repayAsset to Morpho market. Any extra received borrow asset is .
     * updated as equity. No protocol fee is charged.
     * Note: Both collateral and borrow assets need to be enabled, and they must not be the same asset.
     * The function reverts if not enough collateral asset is redeemed to buy the required minimum amount of _repayAsset.
     * @param _setToken             Instance of the SetToken
     * @param _collateralAsset      Address of underlying collateral asset being redeemed
     * @param _repayAsset           Address of underlying asset being repaid
     * @param _redeemQuantityUnits  Quantity of collateral asset to delever in position units
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     * @return uint256              Notional repay quantity
     */
    function deleverToZeroBorrowBalance(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantityUnits,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns (uint256)
    {
        uint256 setTotalSupply = _setToken.totalSupply();
        uint256 notionalRedeemQuantity = _redeemQuantityUnits.preciseMul(setTotalSupply);
        // TODO: Review conversion
        uint256 notionalRepayQuantity = notionalRedeemQuantity;

        require(borrowAssetEnabled[_setToken][_repayAsset], "Borrow not enabled");

        ActionInfo memory deleverInfo = _createAndValidateActionInfoNotional(
            _setToken,
            _collateralAsset,
            _repayAsset,
            notionalRedeemQuantity,
            notionalRepayQuantity,
            _tradeAdapterName,
            false,
            setTotalSupply
        );

        _withdraw(deleverInfo.setToken, _collateralAsset, deleverInfo.notionalSendQuantity);

        _executeTrade(deleverInfo, _collateralAsset, _repayAsset, _tradeData);

        _repayBorrow(deleverInfo.setToken, _repayAsset, notionalRepayQuantity);

        _updateDeleverPositions(deleverInfo, _repayAsset);

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            notionalRepayQuantity,
            0   // No protocol fee
        );

        return notionalRepayQuantity;
    }

    /**
     * @dev CALLABLE BY ANYBODY: Sync Set positions with ALL enabled Morpho collateral and borrow positions.
     * @param _setToken               Instance of the SetToken
     */
    function sync(ISetToken _setToken) public nonReentrant onlyValidAndInitializedSet(_setToken) {
    }

    /**
     * @dev MANAGER ONLY: Initializes this module to the SetToken. Either the SetToken needs to be on the allowed list
     * or anySetAllowed needs to be true. Only callable by the SetToken's manager.
     * Note: Managers can enable collateral and borrow assets that don't exist as positions on the SetToken
     * @param _setToken             Instance of the SetToken to initialize
     * @param _collateralAssets     Underlying tokens to be enabled as collateral in the SetToken
     * @param _borrowAssets         Underlying tokens to be enabled as borrow in the SetToken
     */
    function initialize(
        ISetToken _setToken,
        IERC20[] memory _collateralAssets,
        IERC20[] memory _borrowAssets
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        if (!anySetAllowed) {
            require(allowedSetTokens[_setToken], "Not allowed SetToken");
        }

        // Initialize module before trying register
        _setToken.initializeModule();

        // Get debt issuance module registered to this module and require that it is initialized
        require(_setToken.isInitializedModule(getAndValidateAdapter(DEFAULT_ISSUANCE_MODULE_NAME)), "Issuance not initialized");

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).registerToIssuanceModule(_setToken) {} catch {}
        }

        // _collateralAssets and _borrowAssets arrays are validated in their respective internal functions
        _addCollateralAssets(_setToken, _collateralAssets);
        _addBorrowAssets(_setToken, _borrowAssets);
    }

    /**
     * @dev MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Any deposited collateral assets
     * are disabled to be used as collateral on Morpho. Morpho Settings and manager enabled assets state is deleted.
     * Note: Function should revert is there is any debt remaining on Morpho
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        sync(setToken);

        address[] memory borrowAssets = enabledAssets[setToken].borrowAssets;
        for(uint256 i = 0; i < borrowAssets.length; i++) {
            IERC20 borrowAsset = IERC20(borrowAssets[i]);

            delete borrowAssetEnabled[setToken][borrowAsset];
        }

        address[] memory collateralAssets = enabledAssets[setToken].collateralAssets;
        for(uint256 i = 0; i < collateralAssets.length; i++) {
            IERC20 collateralAsset = IERC20(collateralAssets[i]);
            delete collateralAssetEnabled[setToken][collateralAsset];
        }

        delete enabledAssets[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
        }
    }

    /**
     * @dev MANAGER ONLY: Add registration of this module on the debt issuance module for the SetToken.
     * Note: if the debt issuance module is not added to SetToken before this module is initialized, then this function
     * needs to be called if the debt issuance module is later added and initialized to prevent state inconsistencies
     * @param _setToken             Instance of the SetToken
     * @param _debtIssuanceModule   Debt issuance module address to register
     */
    function registerToModule(ISetToken _setToken, IDebtIssuanceModule _debtIssuanceModule) external onlyManagerAndValidSet(_setToken) {
        require(_setToken.isInitializedModule(address(_debtIssuanceModule)), "Issuance not initialized");

        _debtIssuanceModule.registerToIssuanceModule(_setToken);
    }

    /**
     * @dev MANAGER ONLY: Add collateral assets. 
     * Note: Reverts with "Collateral already enabled" if there are duplicate assets in the passed _newCollateralAssets array.
     *
     * NOTE: ALL ADDED COLLATERAL ASSETS CAN BE ADDED AS A POSITION ON THE SET TOKEN WITHOUT MANAGER'S EXPLICIT PERMISSION.
     * UNWANTED EXTRA POSITIONS CAN BREAK EXTERNAL LOGIC, INCREASE COST OF MINT/REDEEM OF SET TOKEN, AMONG OTHER POTENTIAL UNINTENDED CONSEQUENCES.
     * SO, PLEASE ADD ONLY THOSE COLLATERAL ASSETS WHOSE CORRESPONDING aTOKENS ARE NEEDED AS DEFAULT POSITIONS ON THE SET TOKEN.
     *
     * @param _setToken             Instance of the SetToken
     * @param _newCollateralAssets  Addresses of new collateral underlying assets
     */
    function addCollateralAssets(ISetToken _setToken, IERC20[] memory _newCollateralAssets) external onlyManagerAndValidSet(_setToken) {
        _addCollateralAssets(_setToken, _newCollateralAssets);
    }

    /**
     * @dev MANAGER ONLY: Remove collateral assets. Disable deposited assets to be used as collateral on Morpho market.
     * @param _setToken             Instance of the SetToken
     * @param _collateralAssets     Addresses of collateral underlying assets to remove
     */
    function removeCollateralAssets(ISetToken _setToken, IERC20[] memory _collateralAssets) external onlyManagerAndValidSet(_setToken) {

        for(uint256 i = 0; i < _collateralAssets.length; i++) {
            IERC20 collateralAsset = _collateralAssets[i];
            require(collateralAssetEnabled[_setToken][collateralAsset], "Collateral not enabled");

            delete collateralAssetEnabled[_setToken][collateralAsset];
            enabledAssets[_setToken].collateralAssets.removeStorage(address(collateralAsset));
        }
        emit CollateralAssetsUpdated(_setToken, false, _collateralAssets);
    }

    /**
     * @dev MANAGER ONLY: Add borrow assets. Debt tokens corresponding to borrow assets are tracked for syncing positions.
     * Note: Reverts with "Borrow already enabled" if there are duplicate assets in the passed _newBorrowAssets array.
     * @param _setToken             Instance of the SetToken
     * @param _newBorrowAssets      Addresses of borrow underlying assets to add
     */
    function addBorrowAssets(ISetToken _setToken, IERC20[] memory _newBorrowAssets) external onlyManagerAndValidSet(_setToken) {
        _addBorrowAssets(_setToken, _newBorrowAssets);
    }

    /**
     * @dev MANAGER ONLY: Remove borrow assets.
     * Note: If there is a borrow balance, borrow asset cannot be removed
     * @param _setToken             Instance of the SetToken
     * @param _borrowAssets         Addresses of borrow underlying assets to remove
     */
    function removeBorrowAssets(ISetToken _setToken, IERC20[] memory _borrowAssets) external onlyManagerAndValidSet(_setToken) {

        for(uint256 i = 0; i < _borrowAssets.length; i++) {
            IERC20 borrowAsset = _borrowAssets[i];

            require(borrowAssetEnabled[_setToken][borrowAsset], "Borrow not enabled");

            delete borrowAssetEnabled[_setToken][borrowAsset];
            enabledAssets[_setToken].borrowAssets.removeStorage(address(borrowAsset));
        }
        emit BorrowAssetsUpdated(_setToken, false, _borrowAssets);
    }

    /**
     * @dev GOVERNANCE ONLY: Enable/disable ability of a SetToken to initialize this module. Only callable by governance.
     * @param _setToken             Instance of the SetToken
     * @param _status               Bool indicating if _setToken is allowed to initialize this module
     */
    function updateAllowedSetToken(ISetToken _setToken, bool _status) external onlyOwner {
        require(controller.isSet(address(_setToken)) || allowedSetTokens[_setToken], "Invalid SetToken");
        allowedSetTokens[_setToken] = _status;
        emit SetTokenStatusUpdated(_setToken, _status);
    }

    /**
     * @dev GOVERNANCE ONLY: Toggle whether ANY SetToken is allowed to initialize this module. Only callable by governance.
     * @param _anySetAllowed             Bool indicating if ANY SetToken is allowed to initialize this module
     */
    function updateAnySetAllowed(bool _anySetAllowed) external onlyOwner {
        anySetAllowed = _anySetAllowed;
        emit AnySetAllowedUpdated(_anySetAllowed);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to issuance to sync positions on SetToken. Only callable by valid module.
     * @param _setToken             Instance of the SetToken
     */
    function moduleIssueHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external override onlyModule(_setToken) {
        sync(_setToken);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to redemption to sync positions on SetToken. For redemption, always use current borrowed
     * balance after interest accrual. Only callable by valid module.
     * @param _setToken             Instance of the SetToken
     */
    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external override onlyModule(_setToken) {
        sync(_setToken);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to looping through each component on issuance. Invokes borrow in order for
     * module to return debt to issuer. Only callable by valid module.
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken
     * @param _component            Address of component
     */
    function componentIssueHook(ISetToken _setToken, uint256 _setTokenQuantity, IERC20 _component, bool _isEquity) external override onlyModule(_setToken) {
        // Check hook not being called for an equity position. If hook is called with equity position and outstanding borrow position
        // exists the loan would be taken out twice potentially leading to liquidation
        if (!_isEquity) {
            int256 componentDebt = _setToken.getExternalPositionRealUnit(address(_component), address(this));

            require(componentDebt < 0, "Component must be negative");

            uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMul(_setTokenQuantity);
            _borrowForHook(_setToken, _component, notionalDebt);
        }
    }

    /**
     * @dev MODULE ONLY: Hook called prior to looping through each component on redemption. Invokes repay after
     * the issuance module transfers debt from the issuer. Only callable by valid module.
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken
     * @param _component            Address of component
     */
    function componentRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity, IERC20 _component, bool _isEquity) external override onlyModule(_setToken) {
        // Check hook not being called for an equity position. If hook is called with equity position and outstanding borrow position
        // exists the loan would be paid down twice, decollateralizing the Set
        if (!_isEquity) {
            int256 componentDebt = _setToken.getExternalPositionRealUnit(address(_component), address(this));

            require(componentDebt < 0, "Component must be negative");

            uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMulCeil(_setTokenQuantity);
            _repayBorrowForHook(_setToken, _component, notionalDebt);
        }
    }

    /* ============ External Getter Functions ============ */

    /**
     * @dev Get enabled assets for SetToken. Returns an array of collateral and borrow assets.
     * @return Underlying collateral assets that are enabled
     * @return Underlying borrowed assets that are enabled
     */
    function getEnabledAssets(ISetToken _setToken) external view returns(address[] memory, address[] memory) {
        return (
            enabledAssets[_setToken].collateralAssets,
            enabledAssets[_setToken].borrowAssets
        );
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Invoke deposit (as collateral) from SetToken using Morpho Blue
     */
    function _deposit(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        //@TODO: Implement
    }

    /**
     * @dev Invoke withdraw from SetToken using Morpho Blue
     */
    function _withdraw(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        //@TODO: Implement
    }

    /**
     * @dev Invoke repay from SetToken using Morpho Blue
     */
    function _repayBorrow(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        //@TODO: Implement
    }

    /**
     * @dev Invoke borrow from the SetToken during issuance hook. 
     */
    function _repayBorrowForHook(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        //@TODO: Implement
    }

    /**
     * @dev Invoke borrow from the SetToken using Morpho 
     */
    function _borrow(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        //@TODO: Implement
    }

    /**
     * @dev Invoke borrow from the SetToken during issuance hook.
     */
    function _borrowForHook(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        //@TODO: Implement
    }

    /**
     * @dev Invokes approvals, gets trade call data from exchange adapter and invokes trade from SetToken
     * @return uint256     The quantity of tokens received post-trade
     */
    function _executeTrade(
        ActionInfo memory _actionInfo,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        bytes memory _data
    )
        internal
        returns (uint256)
    {
        ISetToken setToken = _actionInfo.setToken;
        uint256 notionalSendQuantity = _actionInfo.notionalSendQuantity;

        setToken.invokeApprove(
            address(_sendToken),
            _actionInfo.exchangeAdapter.getSpender(),
            notionalSendQuantity
        );

        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _actionInfo.exchangeAdapter.getTradeCalldata(
            address(_sendToken),
            address(_receiveToken),
            address(setToken),
            notionalSendQuantity,
            _actionInfo.minNotionalReceiveQuantity,
            _data
        );

        setToken.invoke(targetExchange, callValue, methodData);

        uint256 receiveTokenQuantity = _receiveToken.balanceOf(address(setToken)).sub(_actionInfo.preTradeReceiveTokenBalance);
        require(
            receiveTokenQuantity >= _actionInfo.minNotionalReceiveQuantity,
            "Slippage too high"
        );

        return receiveTokenQuantity;
    }

    /**
     * @dev Calculates protocol fee on module and pays protocol fee from SetToken
     * @return uint256          Total protocol fee paid
     */
    function _accrueProtocolFee(ISetToken _setToken, IERC20 _receiveToken, uint256 _exchangedQuantity) internal returns(uint256) {
        uint256 protocolFeeTotal = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);

        payProtocolFeeFromSetToken(_setToken, address(_receiveToken), protocolFeeTotal);

        return protocolFeeTotal;
    }

    /**
     * @dev Updates the collateral  and borrow position of the SetToken
     */
    function _updateLeverPositions(ActionInfo memory _actionInfo, IERC20 _borrowAsset) internal {
        //@TODO: Implement / or remove
    }

    /**
     * @dev Updates positions as per _updateLeverPositions and updates Default position for borrow asset in case Set is
     * delevered all the way to zero any remaining borrow asset after the debt is paid can be added as a position.
     */
    function _updateDeleverPositions(ActionInfo memory _actionInfo, IERC20 _repayAsset) internal {
        //@TODO: Implement / or remove
    }

    /**
     * @dev Updates default position unit for given collateralToken on SetToken
     */
    function _updateCollateralPosition(ISetToken _setToken, IERC20 _collateralToken, uint256 _newPositionUnit) internal {
        //@TODO: Implement / or remove
    }

    /**
     * @dev Updates external position unit for given borrow asset on SetToken
     */
    function _updateBorrowPosition(ISetToken _setToken, IERC20 _underlyingAsset, int256 _newPositionUnit) internal {
        //@TODO: Implement / or remove
    }

    /**
     * @dev Construct the ActionInfo struct for lever and delever
     * @return ActionInfo       Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfo(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _sendQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bool _isLever
    )
        internal
        view
        returns(ActionInfo memory)
    {
        uint256 totalSupply = _setToken.totalSupply();

        return _createAndValidateActionInfoNotional(
            _setToken,
            _sendToken,
            _receiveToken,
            _sendQuantityUnits.preciseMul(totalSupply),
            _minReceiveQuantityUnits.preciseMul(totalSupply),
            _tradeAdapterName,
            _isLever,
            totalSupply
        );
    }

    /**
     * @dev Construct the ActionInfo struct for lever and delever accepting notional units
     * @return ActionInfo       Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfoNotional(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        string memory _tradeAdapterName,
        bool _isLever,
        uint256 _setTotalSupply
    )
        internal
        view
        returns(ActionInfo memory)
    {
        ActionInfo memory actionInfo = ActionInfo ({
            exchangeAdapter: IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName)),
            setToken: _setToken,
            collateralAsset: _isLever ? _receiveToken : _sendToken,
            borrowAsset: _isLever ? _sendToken : _receiveToken,
            setTotalSupply: _setTotalSupply,
            notionalSendQuantity: _notionalSendQuantity,
            minNotionalReceiveQuantity: _minNotionalReceiveQuantity,
            preTradeReceiveTokenBalance: IERC20(_receiveToken).balanceOf(address(_setToken))
        });

        _validateCommon(actionInfo);

        return actionInfo;
    }

    /**
     * @dev Add collateral assets to SetToken. Updates the collateralAssetsEnabled and enabledAssets mappings.
     * Emits CollateralAssetsUpdated event.
     */
    function _addCollateralAssets(ISetToken _setToken, IERC20[] memory _newCollateralAssets) internal {
        for(uint256 i = 0; i < _newCollateralAssets.length; i++) {
            IERC20 collateralAsset = _newCollateralAssets[i];

            _validateNewCollateralAsset(_setToken, collateralAsset);

            collateralAssetEnabled[_setToken][collateralAsset] = true;
            enabledAssets[_setToken].collateralAssets.push(address(collateralAsset));
        }
        emit CollateralAssetsUpdated(_setToken, true, _newCollateralAssets);
    }

    /**
     * @dev Add borrow assets to SetToken. Updates the borrowAssetsEnabled and enabledAssets mappings.
     * Emits BorrowAssetsUpdated event.
     */
    function _addBorrowAssets(ISetToken _setToken, IERC20[] memory _newBorrowAssets) internal {
        for(uint256 i = 0; i < _newBorrowAssets.length; i++) {
            IERC20 borrowAsset = _newBorrowAssets[i];

            _validateNewBorrowAsset(_setToken, borrowAsset);

            borrowAssetEnabled[_setToken][borrowAsset] = true;
            enabledAssets[_setToken].borrowAssets.push(address(borrowAsset));
        }
        emit BorrowAssetsUpdated(_setToken, true, _newBorrowAssets);
    }

    /**
     * @dev Validate common requirements for lever and delever
     */
    function _validateCommon(ActionInfo memory _actionInfo) internal view {
        require(collateralAssetEnabled[_actionInfo.setToken][_actionInfo.collateralAsset], "Collateral not enabled");
        require(borrowAssetEnabled[_actionInfo.setToken][_actionInfo.borrowAsset], "Borrow not enabled");
        require(_actionInfo.collateralAsset != _actionInfo.borrowAsset, "Collateral and borrow asset must be different");
        require(_actionInfo.notionalSendQuantity > 0, "Quantity is 0");
    }

    /**
     * @dev Validates if a new asset can be added as collateral asset for given SetToken
     */
    function _validateNewCollateralAsset(ISetToken _setToken, IERC20 _asset) internal view {
        // @TODO: Implement
    }

    /**
     * @dev Validates if a new asset can be added as borrow asset for given SetToken
     */
    function _validateNewBorrowAsset(ISetToken _setToken, IERC20 _asset) internal view {
        // @TODO: Implement
    }

    /**
     * @dev Reads collateral Position from Morpho
     *
     * @return collateralPosition  uint256 external collateral position unit
     */
    function _getCollateralPosition(ISetToken _setToken, IERC20 _collateralToken, uint256 _setTotalSupply) internal view returns (uint256 collateralPosition) {
        // @TODO: Implement
    }

    /**
     * @dev Reads debt position from Morpho
     *
     * @return borrowPosition  int256  external borrow position unit
     */
    function _getBorrowPosition(ISetToken _setToken, IERC20 _borrowAsset, uint256 _setTotalSupply) internal view returns (int256 borrowPosition) {
        // @TODO: Implement
    }
}
