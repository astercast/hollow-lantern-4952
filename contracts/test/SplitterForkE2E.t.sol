// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// END-TO-END fork verification of the wired splitter: deploys the real
// MuseDogsFeeSplitter against live Robinhood Chain state and runs the
// MDOG/musebook liquidity leg (ETH -> META -> {MDOG, musebook}, LP NFT to the
// dead address) plus the MDOG/ETH liquidity leg.
// Run with:
//   forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract SplitterForkE2E -vvv
// NOTE: the musebook/META routing pool key below is still UNVERIFIED (fee /
// tickSpacing / hooks not yet confirmed on-chain). Do not treat a green fork
// run as mainnet-ready until that key is verified; see the deploy checklist.

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MuseDogsFeeSplitter, PoolKey} from "../src/MuseDogsFeeSplitter.sol";

contract MockVault {
    receive() external payable {}
}

contract SplitterForkE2E is Test {
    address constant PM_ADDR = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant POSM_ADDR = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant MDOG = 0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC;
    address constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
    address constant MUSEBOOK = 0x91A2DAe9699f0B82540B5886b0d8759C22820bA3;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    MuseDogsFeeSplitter splitter;
    MockVault vault;

    function setUp() public {
        vault = new MockVault();
        PoolKey memory metaEth = PoolKey({currency0: address(0), currency1: META, fee: 9000, tickSpacing: 90, hooks: address(0)});
        PoolKey memory metaMdog = PoolKey({
            currency0: MDOG,
            currency1: META,
            fee: 0,
            tickSpacing: 200,
            hooks: 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
        });
        PoolKey memory mdogEth = PoolKey({currency0: address(0), currency1: MDOG, fee: 3000, tickSpacing: 60, hooks: address(0)});
        // UNVERIFIED: fee/tickSpacing/hooks of the real musebook/META pool are
        // not yet confirmed. Replace with the verified key before mainnet.
        PoolKey memory metaMusebook = PoolKey({
            currency0: MUSEBOOK,
            currency1: META,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        // Verified 2026-09-20: the MDOG/musebook pool the splitter mints into.
        // Pool ID 0x7edc541fce494a314d0eb46410581208b1ca24d8e8e20bd3b7d666e1258fa1b0.
        PoolKey memory mdogMusebook = PoolKey({
            currency0: MDOG,
            currency1: MUSEBOOK,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        splitter = new MuseDogsFeeSplitter(
            payable(address(0xBEEF)), // mikeyBankr (test)
            payable(address(vault)),
            address(this),
            0.01 ether,
            PM_ADDR,
            POSM_ADDR,
            META,
            MDOG,
            MUSEBOOK,
            metaEth,
            metaMdog,
            metaMusebook,
            mdogEth,
            mdogMusebook
        );
    }

    function test_musebookLiquidityLegEndToEnd() public {
        // Fund the splitter with 0.1 ETH of "royalties".
        vm.deal(address(splitter), 0.1 ether);

        // process(): 10% to mikey, 50% to vault, 20% MDOG/musebook LP,
        // 20% MDOG/ETH LP. Either DEX leg may fail on the fork (e.g. Permit2
        // setup, or the UNVERIFIED musebook/META routing key); the fail-safe
        // skips it and leaves the bucket escrowed. This test checks process()
        // never reverts and the direct legs pay out.
        uint256 mikeyBefore = address(0xBEEF).balance;
        uint256 vaultBefore = address(vault).balance;
        splitter.process();

        assertEq(address(0xBEEF).balance - mikeyBefore, 0.01 ether, "mikey 10%");
        assertEq(address(vault).balance - vaultBefore, 0.05 ether, "vault 50%");
        assertEq(IERC20(META).balanceOf(address(splitter)), 0, "META dust left");
        assertEq(IERC20(MDOG).balanceOf(address(splitter)), 0, "MDOG dust left");
        assertEq(IERC20(MUSEBOOK).balanceOf(address(splitter)), 0, "musebook dust left");
        assertEq(
            address(splitter).balance,
            splitter.musebookLiquidityPending() + splitter.liquidityPending(),
            "no unaccounted ETH"
        );
    }

    function test_processRunsBothLegs() public {
        // 0.1 ETH total: 0.025 per DEX leg. Larger amounts can hit the
        // price-limit fail-safe on the real pool (which is the correct
        // behavior — the leg reverts and funds stay escrowed).
        vm.deal(address(splitter), 0.1 ether);
        // process() runs both DEX legs; each needs Permit2 approval for its
        // ERC20 pulls, which the splitter sets itself via forceApprove. The
        // Permit2 allowance must target the PositionManager as spender.
        // This test just checks process() does not revert and buckets clear.
        splitter.process();
        assertEq(splitter.musebookLiquidityPending(), 0, "musebook-liquidity pending");
        assertEq(splitter.liquidityPending(), 0, "liquidity pending");
    }
}
