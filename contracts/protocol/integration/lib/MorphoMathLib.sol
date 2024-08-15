// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.6.10;
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";


/// @title MathLib
/// @author Morpho Labs
/// @notice Library to manage fixed-point arithmetic.
library MorphoMathLib {
    using SafeMath for uint256;

    /// @dev Returns (`x` * `y`) / `d` rounded down.
    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x.mul(y)).div(d);
    }

    /// @dev Returns (`x` * `y`) / `d` rounded up.
    function mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return x.mul(y).add(d.sub(1)).div(d);
    }
}

