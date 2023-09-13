/*
    Copyright 2020 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache-2.0
*/

pragma solidity 0.8.19;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/utils/math/SafeMath.sol";

// Mock contract implementation of 1Inch
contract OneInchExchangeMock {

    using SafeMath for uint256;

    struct SwapDescription {
        IERC20 srcToken;
        IERC20 dstToken;
        address srcReceiver;
        address dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 guaranteedAmount;
        uint256 flags;
        address referrer;
        bytes permit;
    }

    struct CallDescription {
        uint256 targetWithMandatory;
        uint256 gasLimit;
        uint256 value;
        bytes data;
    }

    address public mockReceiveToken;
    address public mockSendToken;
    uint256 public mockReceiveAmount;
    uint256 public mockSendAmount;
    // Address of SetToken which will send/receive token
    address public setTokenAddress;

    constructor(
        address _mockSendToken,
        address _mockReceiveToken,
        uint256 _mockSendAmount,
        uint256 _mockReceiveAmount
    ) public {
        mockSendToken = _mockSendToken;
        mockReceiveToken = _mockReceiveToken;
        mockSendAmount = _mockSendAmount;
        mockReceiveAmount = _mockReceiveAmount;
    }

    // Initialize SetToken address which will send/receive tokens for the trade
    function addSetTokenAddress(address _setTokenAddress) external {
        setTokenAddress = _setTokenAddress;
    }

    function updateSendAmount(uint256 _newSendAmount) external {
        mockSendAmount = _newSendAmount;
    }

    function updateReceiveAmount(uint256 _newReceiveAmount) external {
        mockReceiveAmount = _newReceiveAmount;
    }

    // Conform to 1Inch Swap interface
    function swap(
        address /* caller */,
        SwapDescription calldata /* desc */,
        CallDescription[] calldata /* calls */
    )
        external
        payable
        returns (uint256)
    {
        require(ERC20(mockSendToken).transferFrom(setTokenAddress, address(this), mockSendAmount), "ERC20 TransferFrom failed");
        require(ERC20(mockReceiveToken).transfer(setTokenAddress, mockReceiveAmount), "ERC20 transfer failed");

        return mockReceiveAmount;
    }
}