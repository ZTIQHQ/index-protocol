// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.21;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20ReturnFalseMock is ERC20 {
    uint8 private numDecimals;
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) ERC20(_name, _symbol) {
        numDecimals = _decimals;
    }

    function decimals() public view virtual override returns (uint8) {
        return numDecimals;
    }

    function transfer(address, uint256) public override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public override returns (bool) {
        return false;
    }

    function approve(address, uint256) public override returns (bool) {
        return false;
    }
}
