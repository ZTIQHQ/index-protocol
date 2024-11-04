/*
    Copyright 2024 Index Cooperative

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

import { ISetToken } from "../interfaces/ISetToken.sol";
import { ISetValuer } from "../interfaces/ISetValuer.sol";
import { IRebasingComponentModule } from "../interfaces/IRebasingComponentModule.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IController } from "../interfaces/IController.sol";

/**
 * @title CachedSetValuer
 * @author Index Cooperative
 *
 * Contract that caches SetToken valuations to reduce gas costs during NAV issuance.
 * Valuations are only recalculated after the cache becomes stale.
 * 
 * @dev WARNING: Components using oracle adapters for NAV calculations must be evaluated for potential 
 * read-only reentrancy vulnerabilities in the oracle's read function. Vulnerable components should 
 * not use this module.
 */
contract CachedSetValuer is Ownable {
    /* ============ Structs ============ */

    struct CachedValuation {
        uint256 value;
        uint256 timestamp;
    }

    struct ValuationInfo {
        uint256 cachedValue;          // Last cached valuation
        uint256 currentValue;         // Current real-time valuation
        uint256 lastUpdateTimestamp;  // When cache was last updated
        bool isStale;                 // Whether cache is considered stale
    }

    /* ============ Events ============ */
    
    event CacheUpdated(
        ISetToken indexed _setToken,
        address indexed _quoteAsset,
        uint256 _valuation,
        uint256 _timestamp
    );
    event MaxStalenessUpdated(uint256 _oldStalenessPeriod, uint256 _newStalenessPeriod);
    event SetValuerUpdated(address _oldSetValuer, address _newSetValuer);
    event RebasingModuleUpdated(address _oldModule, address _newModule);

    /* ============ State Variables ============ */

    // Immutable reference to Controller contract
    IController public immutable controller;
    
    // Mapping of SetToken to quote asset to cached valuation info
    mapping(ISetToken => mapping(address => CachedValuation)) public cachedValuations;
    
    // Maximum time a cached value can be used before requiring refresh
    uint256 public maxStaleness;
    
    // Reference to main SetValuer contract
    ISetValuer public setValuer;

    // Reference to RebasingComponentModule for syncing
    IRebasingComponentModule public rebasingModule;

    /* ============ Constructor ============ */

    /**
     * @param _controller         Address of Controller contract
     * @param _setValuer          Address of SetValuer contract
     * @param _rebasingModule     Address of RebasingComponentModule
     * @param _maxStaleness       Maximum staleness period in seconds
     */
    constructor(
        IController _controller,
        ISetValuer _setValuer,
        IRebasingComponentModule _rebasingModule,
        uint256 _maxStaleness
    )
        public
    {
        require(
            _controller.isResource(address(_setValuer)),
            "SetValuer must be enabled on Controller"
        );
        
        if (address(_rebasingModule) != address(0)) {
            require(
                _controller.isModule(address(_rebasingModule)),
                "RebasingModule must be enabled on Controller"
            );
        }
        
        controller = _controller;
        setValuer = _setValuer;
        rebasingModule = _rebasingModule;
        maxStaleness = _maxStaleness;
    }

    /* ============ External Functions ============ */

    /**
     * Gets cached valuation if fresh, otherwise calculates new valuation.
     * Syncs rebasing components before calculation if cache is stale and rebasing module is set.
     *
     * @param _setToken        SetToken to get valuation for
     * @param _quoteAsset      Asset to quote valuation in
     * @return uint256         SetToken valuation in terms of quote asset
     */
    function calculateSetTokenValuation(
        ISetToken _setToken,
        address _quoteAsset
    )
        external
        returns (uint256)
    {
        require(
            controller.isResource(address(setValuer)),
            "SetValuer must be enabled on Controller"
        );

        CachedValuation storage cachedValuation = cachedValuations[_setToken][_quoteAsset];
        
        if (_isCacheValid(cachedValuation.timestamp)) {
            return cachedValuation.value;
        }

        // Sync rebasing components before getting new valuation if module is set
        if (address(rebasingModule) != address(0)) {
            rebasingModule.sync(_setToken);
        }
        
        uint256 newValuation = setValuer.calculateSetTokenValuation(_setToken, _quoteAsset);
        
        _updateCache(_setToken, _quoteAsset, newValuation);
        
        return newValuation;
    }

    /**
     * Force updates cache with current valuation.
     * 
     * @param _setToken        SetToken to update cache for
     * @param _quoteAsset      Asset to quote valuation in
     */
    function updateCache(
        ISetToken _setToken,
        address _quoteAsset
    )
        external
    {
        if (address(rebasingModule) != address(0)) {
            rebasingModule.sync(_setToken);
        }
        
        uint256 newValuation = setValuer.calculateSetTokenValuation(_setToken, _quoteAsset);
        
        _updateCache(_setToken, _quoteAsset, newValuation);
    }

    /**
     * Returns both cached and current valuations for comparison.
     * Does not modify state or update cache.
     * 
     * @param _setToken        SetToken to get valuation for
     * @param _quoteAsset      Asset to quote valuation in
     * @return ValuationInfo   Struct containing cached and current valuations
     */
    function previewValuation(
        ISetToken _setToken,
        address _quoteAsset
    )
        external
        view
        returns (ValuationInfo memory)
    {
        CachedValuation storage cachedValuation = cachedValuations[_setToken][_quoteAsset];
        
        // Get current valuation without updating state
        uint256 currentValue = setValuer.calculateSetTokenValuation(_setToken, _quoteAsset);
        
        return ValuationInfo({
            cachedValue: cachedValuation.value,
            currentValue: currentValue,
            lastUpdateTimestamp: cachedValuation.timestamp,
            isStale: !_isCacheValid(cachedValuation.timestamp)
        });
    }

    /* ============ External Admin Functions ============ */

    /**
     * ADMIN ONLY: Updates maximum staleness period for cached valuations.
     * 
     * @param _maxStaleness    New maximum staleness period in seconds
     */
    function setMaxStaleness(uint256 _maxStaleness)
        external
        onlyOwner
    {
        uint256 oldStalenessPeriod = maxStaleness;
        maxStaleness = _maxStaleness;
        emit MaxStalenessUpdated(oldStalenessPeriod, _maxStaleness);
    }

    /**
     * ADMIN ONLY: Updates SetValuer contract reference.
     * 
     * @param _setValuer    New SetValuer contract address
     */
    function setSetValuer(ISetValuer _setValuer)
        external
        onlyOwner
    {
        require(
            address(_setValuer) != address(0),
            "Invalid SetValuer address"
        );
        require(
            controller.isResource(address(_setValuer)),
            "SetValuer must be enabled on Controller"
        );

        address oldSetValuer = address(setValuer);
        setValuer = _setValuer;
        emit SetValuerUpdated(oldSetValuer, address(_setValuer));
    }

    /**
     * ADMIN ONLY: Updates RebasingComponentModule contract reference.
     * 
     * @param _rebasingModule    New RebasingComponentModule contract address
     */
    function setRebasingModule(IRebasingComponentModule _rebasingModule)
        external
        onlyOwner
    {
        if (address(_rebasingModule) != address(0)) {
            require(
                controller.isModule(address(_rebasingModule)),
                "RebasingModule must be enabled on Controller"
            );
        }

        address oldModule = address(rebasingModule);
        rebasingModule = _rebasingModule;
        emit RebasingModuleUpdated(oldModule, address(_rebasingModule));
    }

    /* ============ Internal Functions ============ */

    /**
     * Checks if cached valuation timestamp is still valid.
     */
    function _isCacheValid(uint256 _timestamp)
        internal
        view
        returns (bool)
    {
        return _timestamp != 0 && block.timestamp <= _timestamp + maxStaleness;
    }

    /**
     * Updates cached valuation for SetToken and quote asset pair.
     */
    function _updateCache(
        ISetToken _setToken,
        address _quoteAsset,
        uint256 _newValuation
    )
        internal
    {
        cachedValuations[_setToken][_quoteAsset] = CachedValuation({
            value: _newValuation,
            timestamp: block.timestamp
        });

        emit CacheUpdated(_setToken, _quoteAsset, _newValuation, block.timestamp);
    }
}
