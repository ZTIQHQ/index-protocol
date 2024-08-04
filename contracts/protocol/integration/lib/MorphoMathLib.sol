// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.6.10;


/// @title MathLib
/// @author Morpho Labs
/// @notice Library to manage fixed-point arithmetic.
library MorphoMathLib {
    /// @dev Returns (`x` * `y`) / `d` rounded down.
    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y) / d;
    }

    /// @dev Returns (`x` * `y`) / `d` rounded up.
    function mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y + (d - 1)) / d;
    }
}

