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
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import { DebtIssuanceModuleV2 } from "./DebtIssuanceModuleV2.sol";
import { IController } from "../../../interfaces/IController.sol";
import { Invoke } from "../../lib/Invoke.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { IssuanceValidationUtils } from "../../lib/IssuanceValidationUtils.sol";
import { Position } from "../../lib/Position.sol";


/**
 * @title DebtIssuanceModuleV3
 * @author Set Protocol
 *
 * This Module is an adjusted version of the DebtIssuanceModuleV2 that increases / decreases transfered in / out token amounts by a slight factor 
 * to account for rounding errors in some tokens that mean balanceAfter != balanceBefore + amountTransferred
 *
 */
contract DebtIssuanceModuleV3 is DebtIssuanceModuleV2 {
    using Position for uint256;

    // Amount in WEI by which we will adjust token transfers to avoid revertions on rounding errors
    uint256 immutable public tokenTransferBuffer;

    /* ============ Constructor ============ */

    constructor(
        IController _controller,
        uint256 _tokenTransferBuffer
    ) public DebtIssuanceModuleV2(_controller) {
        tokenTransferBuffer = _tokenTransferBuffer;
    }

    /* ============ External View Functions ============ */

    /**
     * @dev Same as in v2 but adjusting the positions by the tokenTransferBuffer currently configured
     */
    function getRequiredComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        view
        override
        returns (address[] memory components, uint256[] memory equityUnits, uint256[] memory debtUnits)
    {
        (components, equityUnits, debtUnits) = _getRequiredComponentIssuanceUnits(_setToken, _quantity);
        for(uint256 i = 0; i < components.length; i++) {
            if(equityUnits[i] > 0) {
                equityUnits[i] += tokenTransferBuffer;
            }
            if(debtUnits[i] > tokenTransferBuffer) {
                debtUnits[i] -= tokenTransferBuffer;
            } else {
                debtUnits[i] = 0;
            }
        }
    }

    /**
     * @dev Same as in v2 but adjusting the positions by the tokenTransferBuffer currently configured
     */
    function getRequiredComponentRedemptionUnits(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        view
        override
        returns (address[] memory components, uint256[] memory equityUnits, uint256[] memory debtUnits)
    {
        (
            uint256 totalQuantity,,
        ) = calculateTotalFees(_setToken, _quantity, false);

        (components, equityUnits, debtUnits) = _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, false);
        for(uint256 i = 0; i < components.length; i++) {
            if(debtUnits[i] > 0) {
                debtUnits[i] += tokenTransferBuffer;
            }
            if(equityUnits[i] > tokenTransferBuffer) {
                equityUnits[i] -= tokenTransferBuffer;
            } else {
                equityUnits[i] = 0;
            }
        }
    }

    /* ============ Internal Functions ============ */

    function _getRequiredComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity
    )
        internal
        view
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (
            uint256 totalQuantity,,
        ) = calculateTotalFees(_setToken, _quantity, true);

        if(_setToken.totalSupply() == 0) {
            return _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, true);
        } else {
            (
                address[] memory components,
                uint256[] memory equityUnits,
                uint256[] memory debtUnits
            ) = _getTotalIssuanceUnitsFromBalances(_setToken);

            uint256 componentsLength = components.length;
            uint256[] memory totalEquityUnits = new uint256[](componentsLength);
            uint256[] memory totalDebtUnits = new uint256[](componentsLength);
            for (uint256 i = 0; i < components.length; i++) {
                // Use preciseMulCeil to round up to ensure overcollateration of equity when small issue quantities are provided
                // and use preciseMul to round debt calculations down to make sure we don't return too much debt to issuer
                totalEquityUnits[i] = equityUnits[i].preciseMulCeil(totalQuantity);
                totalDebtUnits[i] = debtUnits[i].preciseMul(totalQuantity);
            }

            return (components, totalEquityUnits, totalDebtUnits);
        }
    }


    /**
     * @dev Same as in v2 but adjusting the token transfers by the tokenTransferBuffer (adding when transferring in, subtracting when transferring out)
     */
    function _resolveEquityPositions(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentEquityQuantities,
        uint256 _initialSetSupply,
        uint256 _finalSetSupply
    )
        internal
        override
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentEquityQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        // Add buffer to account for rounding errors
                        componentQuantity + tokenTransferBuffer 
                    );

                    IssuanceValidationUtils.validateCollateralizationPostTransferInPreHook(_setToken, component, _initialSetSupply, componentQuantity);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, true);
                } else {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, true);

                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer
                    // Subtract buffer to account for rounding errors
                    _setToken.invokeTransfer(component, _to, componentQuantity - tokenTransferBuffer); 


                    IssuanceValidationUtils.validateCollateralizationPostTransferOut(_setToken, component, _finalSetSupply);
                }
            }
        }
    }

    /**
     * @dev Same as in v2 but adjusting the token transfers by the tokenTransferBuffer (adding when transferring in, subtracting when transferring out)
     */
    function _resolveDebtPositions(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentDebtQuantities,
        uint256 _initialSetSupply,
        uint256 _finalSetSupply
    )
        internal
        override
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentDebtQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, false);

                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer
                    // Subtract buffer to account for rounding errors
                    _setToken.invokeTransfer(component, msg.sender, componentQuantity - tokenTransferBuffer); 

                    IssuanceValidationUtils.validateCollateralizationPostTransferOut(_setToken, component, _finalSetSupply);
                } else {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        // Add buffer to account for rounding errors
                        componentQuantity + tokenTransferBuffer
                    );

                    IssuanceValidationUtils.validateCollateralizationPostTransferInPreHook(_setToken, component, _initialSetSupply, componentQuantity);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, false);
                }
            }
        }
    }
}
