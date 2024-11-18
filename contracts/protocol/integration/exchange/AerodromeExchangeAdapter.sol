/*
    Copyright 2021 Set Labs Inc.

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

/**
 * @title AerodromeExchangeAdapter
 * @author Set Protocol
 *
 * A Aerodrome Router exchange adapter that returns calldata for trading. Includes option for 2 different trade types on Aerodrome.
 *
 * CHANGE LOG:
 * - Add helper that encodes path and boolean into bytes
 * - Generalized ability to choose whether to swap an exact amount of source token for a min amount of receive token or swap a max amount of source token for
 * an exact amount of receive token
 * - Add helper to generate data parameter for `getTradeCallData`
 *
 */
contract AerodromeExchangeAdapter {

    struct Route {
        address sourceToken;
        address destinationToken;
        bool stable;
        address factory;
    }

    /* ============ State Variables ============ */

    // Address of Aerodrome  Router contract
    address public immutable router;
    address public immutable factory;
    // Aerodrome router function string for swapping exact tokens for a minimum of receive tokens
    string internal constant SWAP_EXACT_TOKENS_FOR_TOKENS = "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256 )";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router       Address of Aerodrome  Router contract
     * @param _factory      Address of Aerodrome  Pool Factory contract
     */
    constructor(address _router, address _factory) public {
        router = _router;
        factory = _factory;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for Aerodrome  Router. Trade paths and bool to select trade function are encoded in the arbitrary data parameter.
     *
     * Note: When selecting the swap for exact tokens function, _sourceQuantity is defined as the max token quantity you are willing to trade, and
     * _minDestinationQuantity is the exact quantity of token you are receiving.
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _destinationAddress       Address that assets should be transferred to
     * @param  _sourceQuantity           Fixed/Max amount of source token to sell
     * @param  _destinationQuantity      Min/Fixed amount of destination token to buy
     *
     * @return address                   Target contract address
     * @return uint256                   Call value
     * @return bytes                     Trade calldata
     */
    function getTradeCalldata(
        address  _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        uint256 _sourceQuantity,
        uint256 _destinationQuantity,
        bytes memory /* _data */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {

        Route[] memory routes = new Route[](1);
        routes[0] = Route(_sourceToken, _destinationToken, false, factory);
        
        bytes memory callData = abi.encodeWithSignature(
            SWAP_EXACT_TOKENS_FOR_TOKENS,
            _sourceQuantity,
            _destinationQuantity,
            routes,
            _destinationAddress,
            block.timestamp
        );
        return (router, 0, callData);
    }

    /**
     * Generate data parameter to be passed to `getTradeCallData`. Returns encoded trade paths and bool to select trade function.
     *
     * @param _sourceToken          Address of the source token to be sold
     * @param _destinationToken     Address of the destination token to buy
     * @param _fixIn                Boolean representing if input tokens amount is fixed
     *
     * @return data                 Data parameter to be passed to `getTradeCallData`
     */
    function generateDataParam(address _sourceToken, address _destinationToken, bool _fixIn)
        external
        pure
        returns (bytes memory data)
    {
        require(!_fixIn, "Only swapExactTokensForTokens is supported");
    }

    /**
     * Returns the address to approve source tokens to for trading. This is the Aerodrome router address
     *
     * @return address             Address of the contract to approve tokens to
     */
    function getSpender() external view returns (address) {
        return router;
    }
}
