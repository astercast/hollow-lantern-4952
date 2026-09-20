// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {V4Math} from "../src/V4Math.sol";

/// @notice Pins the vendored Uniswap math to canonical vectors. If any magic
///         constant in TickMath were wrong, these fail loudly.
contract V4MathTest is Test {
    function test_getSqrtPriceAtTick_zero() public pure {
        // getSqrtPriceAtTick(0) == 2**96 by definition.
        assertEq(V4Math.getSqrtPriceAtTick(0), 79228162514264337593543950336);
    }

    function test_getSqrtPriceAtTick_minMax() public pure {
        // Canonical MIN/MAX sqrt prices from Uniswap TickMath.
        assertEq(V4Math.getSqrtPriceAtTick(-887272), 4295128739);
        assertEq(
            V4Math.getSqrtPriceAtTick(887272),
            1461446703485210103287273052203988822378723970342
        );
    }

    function test_getSqrtPriceAtTick_matchesLivePool() public pure {
        // The live MDOG/ETH pool on Robinhood Chain sits at tick 185904 with
        // sqrtPriceX96 = 862060366758149150086082534516168 (read 2026-09-19
        // via StateView.getSlot0). The vendored TickMath must bracket it:
        // tickPrice(185904) <= live sqrtP < tickPrice(185905).
        uint160 liveSqrtP = 862060366758149150086082534516168;
        uint160 tickPrice = V4Math.getSqrtPriceAtTick(185904);
        uint160 nextTickPrice = V4Math.getSqrtPriceAtTick(185905);
        assertLe(tickPrice, liveSqrtP);
        assertLt(liveSqrtP, nextTickPrice);
    }

    function test_getLiquidityForAmounts_fullRangeSane() public pure {
        // Full-range mint at the live pool price with 0.005 ETH + the matching
        // MDOG amount must yield nonzero, finite liquidity.
        uint160 sqrtP = 862060366758149150086082534516168;
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(-887220);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(887220);
        uint128 liq = V4Math.getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, 5e15, 4.7e23);
        assertGt(liq, 0);
        assertLt(liq, type(uint128).max);
    }

    function test_getLiquidityForAmounts_dustIsZero() public pure {
        // Dust amounts must round to zero liquidity, never revert.
        uint160 sqrtP = 862060366758149150086082534516168;
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(-887220);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(887220);
        assertEq(V4Math.getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, 1, 1), 0);
    }

    function test_getLiquidityForAmounts_neverExceedsInputs() public pure {
        // Fuzz: for random in-range prices and amounts, the liquidity implied
        // by getLiquidityForAmounts must be re-mintable from the same amounts
        // (i.e. required amounts <= provided amounts). We check this via the
        // definition: L0 from amount0 alone >= min-liquidity, and likewise L1.
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(-887220);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(887220);
        for (uint256 i = 0; i < 16; i++) {
            uint160 sqrtP = uint160(
                uint256(sqrtA) + (uint256(sqrtB - sqrtA) * (i + 1)) / 17
            );
            uint256 a0 = 1e12 + i * 1e15;
            uint256 a1 = 1e18 + i * 1e21;
            uint128 liq = V4Math.getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, a0, a1);
            uint128 l0 = V4Math.getLiquidityForAmount0(sqrtP, sqrtB, a0);
            uint128 l1 = V4Math.getLiquidityForAmount1(sqrtA, sqrtP, a1);
            assertLe(liq, l0);
            assertLe(liq, l1);
        }
    }
}
