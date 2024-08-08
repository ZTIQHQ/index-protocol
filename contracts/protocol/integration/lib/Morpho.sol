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
pragma experimental ABIEncoderV2;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IMorpho } from "../../../interfaces/external/morpho/IMorpho.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";

/**
 * @title Morpho
 * @author Index Coop
 * 
 * Collection of helper functions for interacting with Morpho Blue
 */
library Morpho {
    /* ============ External ============ */
    
    function getSupplyCollateralCalldata(
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _assets,
        address _onBehalfOf,
        bytes memory _data
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        // TODO: Check why encodeWithSelector is not working
        bytes memory callData = abi.encodeWithSelector(
            0x238d6579, 
            _marketParams, 
            _assets, 
            _onBehalfOf,
            _data
        );
        
        return (address(_morpho), 0, callData);
    }
    
    function invokeSupplyCollateral(
        ISetToken _setToken,
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _amountNotional
    )
        external
    {
        bytes memory data = bytes("");
        ( , , bytes memory supplyCollateralCalldata) = getSupplyCollateralCalldata(
            _morpho,
            _marketParams,
            _amountNotional, 
            address(_setToken), 
            data
        );
        
        _setToken.invoke(address(_morpho), 0, supplyCollateralCalldata);
    }

    function getBorrowCalldata(
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _assets,
        uint256 _shares,
        address _onBehalfOf,
        address _receiver
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSelector(
            0x50d8cd4b,
            _marketParams, 
            _assets, 
            _shares, 
            _onBehalfOf,
            _receiver
        );
        
        return (address(_morpho), 0, callData);
    }
    
    function invokeBorrow(
        ISetToken _setToken,
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _amountNotional
    )
        external
    {
        ( , , bytes memory borrowCalldata) = getBorrowCalldata(
            _morpho,
            _marketParams,
            _amountNotional, 
            0,
            address(_setToken), 
            address(_setToken)
        );
        
        _setToken.invoke(address(_morpho), 0, borrowCalldata);
    }

    function getWithdrawCollateralCalldata(
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _assets,
        uint256 _shares,
        address _onBehalfOf,
        address _receiver
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSelector(
            0x8720316d,
            _marketParams, 
            _assets, 
            _shares, 
            _onBehalfOf,
            _receiver
        );
        
        return (address(_morpho), 0, callData);
    }
    
    function invokeWithdrawCollateral(
        ISetToken _setToken,
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _amountNotional
    )
        external
    {
        ( , , bytes memory withdrawCollateralCalldata) = getWithdrawCollateralCalldata(
            _morpho,
            _marketParams,
            _amountNotional, 
            0,
            address(_setToken), 
            address(_setToken)
        );
        
        _setToken.invoke(address(_morpho), 0, withdrawCollateralCalldata);
    }
    
    
     function getRepayCalldata(
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _assets,
        uint256 _shares,
        address _onBehalfOf
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory data = bytes("");
        bytes memory callData = abi.encodeWithSelector(
            0x20b76e81,
            _marketParams, 
            _assets, 
            _shares, 
            _onBehalfOf,
            data
        );
        
        return (address(_morpho), 0, callData);
    }
    
    function invokeRepay(
        ISetToken _setToken,
        IMorpho _morpho,
        IMorpho.MarketParams memory _marketParams,
        uint256 _amountNotional
    )
        external
    {
        ( , , bytes memory repayCalldata) = getRepayCalldata(
            _morpho,
            _marketParams,
            _amountNotional, 
            0,
            address(_setToken)
        );
        
        _setToken.invoke(address(_morpho), 0, repayCalldata);
    }
    
    
}
