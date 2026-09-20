// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MuseDog} from "../src/MuseDog.sol";
import {MuseDogRoyaltySplitter} from "../src/MuseDogRoyaltySplitter.sol";

/// @notice Test suite for the MuseDogRoyaltySplitter and the collection's pinned
///         5% ERC-2981 royalty: split math, payout integrity, and constructor guards.
/// @dev DRAFT — not audited, not deployed. Coverage only, no security claims.
contract MuseDogRoyaltySplitterTest is Test {
    MuseDogRoyaltySplitter public splitter;
    MuseDog public muse;

    address public owner = makeAddr("multisig-owner");
    uint256 public signerKey = 0xA11CE;
    address public voucherSigner;

    /// @dev Mikey's Bankr address (10% recipient), locked 2026-09-19.
    address public mikey = 0x3A66aEc855E605966AebbA7df75eB858019B8516;
    address public rewardsVault = makeAddr("rewards-vault");
    address public feeEngine = makeAddr("fee-engine");

    string constant BASE = "ipfs://musedog-collection/";

    event RoyaltySplit(
        uint256 total,
        uint256 mikeyShare,
        uint256 vaultShare,
        uint256 engineShare
    );

    function setUp() public {
        voucherSigner = vm.addr(signerKey);
        splitter = new MuseDogRoyaltySplitter(mikey, rewardsVault, feeEngine);
        muse = new MuseDog(owner, voucherSigner, BASE, address(splitter));
    }

    /// @dev Push ETH into the splitter and report each party's delta.
    function _split(uint256 total)
        internal
        returns (uint256 mikeyPaid, uint256 vaultPaid, uint256 enginePaid)
    {
        uint256 mikeyBefore = mikey.balance;
        uint256 vaultBefore = rewardsVault.balance;
        uint256 engineBefore = feeEngine.balance;
        (bool ok, ) = address(splitter).call{value: total}("");
        require(ok, "send to splitter failed");
        mikeyPaid = mikey.balance - mikeyBefore;
        vaultPaid = rewardsVault.balance - vaultBefore;
        enginePaid = feeEngine.balance - engineBefore;
    }

    // -------------------------------------------------------------------------
    // Pinned royalty on the collection
    // -------------------------------------------------------------------------

    /// @dev royaltyInfo() returns exactly (splitter, 500 bps) on any token id.
    function test_RoyaltyInfoReturnsSplitterAnd500Bps() public view {
        (address receiver, uint256 amount) = muse.royaltyInfo(0, 1 ether);
        assertEq(receiver, address(splitter));
        assertEq(amount, 0.05 ether);

        (receiver, amount) = muse.royaltyInfo(499, 10_000);
        assertEq(receiver, address(splitter));
        assertEq(amount, 500);
    }

    // -------------------------------------------------------------------------
    // Exact split
    // -------------------------------------------------------------------------

    /// @dev 1 ETH in → 0.1 / 0.4 / 0.5 out, nothing left behind.
    function test_SplitsOneEthExactly() public {
        (uint256 m, uint256 v, uint256 e) = _split(1 ether);
        assertEq(m, 0.1 ether);
        assertEq(v, 0.4 ether);
        assertEq(e, 0.5 ether);
        assertEq(address(splitter).balance, 0);
    }

    /// @dev The RoyaltySplit event carries the exact per-party amounts.
    function test_EmitsRoyaltySplit() public {
        vm.expectEmit(true, true, true, true, address(splitter));
        emit RoyaltySplit(1 ether, 0.1 ether, 0.4 ether, 0.5 ether);
        (bool ok, ) = address(splitter).call{value: 1 ether}("");
        assertTrue(ok);
    }

    // -------------------------------------------------------------------------
    // Tiny amounts: every wei accounted for
    // -------------------------------------------------------------------------

    /// @dev On totals too small to split cleanly, the two floored shares plus
    ///      the engine remainder still sum to the total — dust goes to the engine.
    function test_TinyAmountsAllWeiAccountedFor() public {
        uint256[3] memory totals = [uint256(1), uint256(7), uint256(99)];
        for (uint256 i = 0; i < totals.length; i++) {
            uint256 total = totals[i];
            (uint256 m, uint256 v, uint256 e) = _split(total);
            assertEq(m, (total * 1_000) / 10_000, "mikey gets the floored 10%");
            assertEq(v, (total * 4_000) / 10_000, "vault gets the floored 40%");
            assertEq(e, total - m - v, "engine gets the remainder (all dust)");
            assertEq(m + v + e, total, "payouts must equal the amount received");
            assertEq(address(splitter).balance, 0, "no wei stranded");
        }
    }

    // -------------------------------------------------------------------------
    // Odd amounts: within 1 wei of the true 10/40/50
    // -------------------------------------------------------------------------

    /// @dev On an odd total, floor math keeps each computed share within 1 wei of
    ///      the exact percentage, except the engine: it absorbs the dust from
    ///      BOTH floored shares (mikey and vault), so it can land up to 2 wei
    ///      above the true 50%. It is never below.
    function test_OddAmountSharesWithinOneWei() public {
        uint256 total = 1_000_000_000_000_000_007; // 1 ETH + 7 wei
        (uint256 m, uint256 v, uint256 e) = _split(total);
        assertEq(m + v + e, total, "payouts must equal the amount received");

        // Floored shares are always within 1 wei of the true percentage.
        assertApproxEqAbs(m, total / 10, 1);
        assertApproxEqAbs(v, (total * 4) / 10, 1);
        // Engine: within 2 wei above the true 50%, never below it.
        assertApproxEqAbs(e, total / 2, 2);
        assertGe(e, total / 2);
        assertEq(address(splitter).balance, 0, "no wei stranded");
    }

    // -------------------------------------------------------------------------
    // Fuzz: conservation of wei
    // -------------------------------------------------------------------------

    /// @dev Fuzz: for any amount, the three payouts sum to exactly what arrived
    ///      and the splitter holds nothing afterwards.
    function testFuzz_SplitConservesWei(uint256 total) public {
        total = bound(total, 1, 1_000_000 ether);
        vm.deal(address(this), total);
        (uint256 m, uint256 v, uint256 e) = _split(total);
        assertEq(m + v + e, total, "payouts must equal the amount received");
        assertEq(address(splitter).balance, 0, "no wei stranded");
    }

    // -------------------------------------------------------------------------
    // Constructor guards
    // -------------------------------------------------------------------------

    /// @dev Any zero recipient would burn or deadlock ETH — deploy reverts.
    function test_ConstructorRevertsOnZeroAddress() public {
        vm.expectRevert(MuseDogRoyaltySplitter.ZeroAddress.selector);
        new MuseDogRoyaltySplitter(address(0), rewardsVault, feeEngine);

        vm.expectRevert(MuseDogRoyaltySplitter.ZeroAddress.selector);
        new MuseDogRoyaltySplitter(mikey, address(0), feeEngine);

        vm.expectRevert(MuseDogRoyaltySplitter.ZeroAddress.selector);
        new MuseDogRoyaltySplitter(mikey, rewardsVault, address(0));
    }
}
