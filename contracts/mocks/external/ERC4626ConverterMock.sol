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

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

contract ERC4626ConverterMock {
    using SafeMath for uint256;

    uint256 public decimals;
    uint256 public pricePerShare;

    constructor(uint256 _decimals, uint256 _pricePerShare) public {
        decimals = _decimals;
        pricePerShare = _pricePerShare;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return shares.mul(pricePerShare).div(10 ** decimals);
    }
}
