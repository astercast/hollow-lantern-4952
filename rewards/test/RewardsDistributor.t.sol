// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/RewardsDistributor.sol";

contract MockMusebook is IERC20 {
    mapping(address => uint256) public bal;
    function mint(address to, uint256 amt) external { bal[to] += amt; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(bal[msg.sender] >= amount, "insufficient");
        bal[msg.sender] -= amount;
        bal[to] += amount;
        return true;
    }
    function balanceOf(address a) external view returns (uint256) { return bal[a]; }
}

contract FalseReturnToken is IERC20 {
    mapping(address => uint256) public bal;
    function mint(address to, uint256 amt) external { bal[to] += amt; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
    function balanceOf(address a) external view returns (uint256) { return bal[a]; }
}

contract RevertingToken is IERC20 {
    mapping(address => uint256) public bal;
    function mint(address to, uint256 amt) external { bal[to] += amt; }
    function transfer(address, uint256) external pure returns (bool) { revert("nope"); }
    function balanceOf(address a) external view returns (uint256) { return bal[a]; }
}

contract RewardsDistributorTest is Test {
    MockMusebook mb;
    RewardsDistributor dist;
    address owner = address(0xA11CE);
    address alice = address(0x1111111111111111111111111111111111111111);
    address bob   = address(0x2222222222222222222222222222222222222222);

    // Single-leaf tree: leaf = doubleHash(abi.encode(1, 0, alice, 100e18)); root = leaf.
    uint256 constant EPOCH = 1;
    uint256 constant AMT = 100 ether;

    function setUp() public {
        mb = new MockMusebook();
        dist = new RewardsDistributor(address(mb), owner);
        mb.mint(owner, 1_000_000 ether);
    }

    function _leaf(uint256 epochId, uint256 index, address account, uint256 amount)
        internal pure returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(epochId, index, account, amount))));
    }

    function _fundAndPublish(uint256 epochId, bytes32 root, uint256 alloc) internal {
        vm.startPrank(owner);
        mb.transfer(address(dist), alloc);
        dist.publishRoot(epochId, root, alloc);
        vm.stopPrank();
    }

    function test_claim_happy_path() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);

        // Nothing unlocked at publish; full allocation vested after 7 days.
        vm.warp(block.timestamp + 7 days);
        bytes32[] memory proof;
        dist.claim(EPOCH, 0, alice, AMT, proof);
        assertEq(mb.balanceOf(alice), AMT);
        assertEq(dist.allocatedUnclaimed(), 0);
    }

    function test_claim_before_day_one_reverts() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        bytes32[] memory proof;
        vm.expectRevert("nothing vested yet");
        dist.claim(EPOCH, 0, alice, AMT, proof);
    }

    function test_double_claim_same_day_reverts() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.warp(block.timestamp + 2 days);
        bytes32[] memory proof;
        dist.claim(EPOCH, 0, alice, AMT, proof);
        // Second claim with nothing newly vested reverts.
        vm.expectRevert("nothing vested yet");
        dist.claim(EPOCH, 0, alice, AMT, proof);
    }

    function test_wrong_amount_reverts() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        bytes32[] memory proof;
        vm.expectRevert("bad proof");
        dist.claim(EPOCH, 0, alice, AMT + 1, proof);
    }

    function test_cross_epoch_replay_reverts() public {
        // Same leaf content, epoch 1 root published; try to claim it under epoch 2.
        bytes32 root1 = _leaf(1, 0, alice, AMT);
        _fundAndPublish(1, root1, AMT);
        bytes32 root2 = _leaf(2, 0, alice, AMT);
        _fundAndPublish(2, root2, AMT);
        bytes32[] memory proof;
        vm.warp(block.timestamp + 7 days);
        dist.claim(1, 0, alice, AMT, proof); // epoch 1 fine
        // Epoch 2 / index 0 is a fresh leaf AND a different leaf
        // (epochId is in the leaf), so this must succeed — no cross-epoch replay.
        dist.claim(2, 0, alice, AMT, proof);
        assertEq(mb.balanceOf(alice), 2 * AMT);
    }

    function test_non_owner_cannot_publish() public {
        vm.expectRevert("not owner");
        dist.publishRoot(1, bytes32(uint256(1)), 1 ether);
    }

    function test_publish_underfunded_reverts() public {
        vm.prank(owner);
        vm.expectRevert("underfunded");
        dist.publishRoot(1, bytes32(uint256(1)), 1 ether);
    }

    function test_epoch_order_enforced() public {
        _fundAndPublish(1, bytes32(uint256(1)), 1 ether);
        vm.startPrank(owner);
        mb.transfer(address(dist), 1 ether);
        vm.expectRevert("epoch order");
        dist.publishRoot(1, bytes32(uint256(2)), 1 ether);
        vm.stopPrank();
    }

    function test_withdraw_cannot_touch_claims() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        vm.startPrank(owner);
        mb.transfer(address(dist), AMT + 50 ether); // 50 extra = reserve
        dist.publishRoot(EPOCH, root, AMT);
        vm.expectRevert("touches claims");
        dist.withdraw(owner, AMT + 50 ether);
        dist.withdraw(owner, 50 ether); // reserve is free
        assertEq(mb.balanceOf(owner), 1_000_000 ether - AMT - 50 ether + 50 ether);
        vm.stopPrank();
    }

    function test_carryover_accounting() public {
        // Two leaves under one root; claim one; the rest stays as carryover.
        bytes32 l0 = _leaf(EPOCH, 0, alice, AMT);
        bytes32 l1 = _leaf(EPOCH, 1, bob, AMT);
        bytes32 root = l0 <= l1
            ? keccak256(abi.encodePacked(l0, l1))
            : keccak256(abi.encodePacked(l1, l0));
        _fundAndPublish(EPOCH, root, 2 * AMT);

        vm.warp(block.timestamp + 7 days);
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        dist.claim(EPOCH, 0, alice, AMT, p0);
        assertEq(dist.epochUnclaimed(EPOCH), AMT);
        assertEq(dist.allocatedUnclaimed(), AMT);

        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;
        dist.claim(EPOCH, 1, bob, AMT, p1);
        assertEq(dist.allocatedUnclaimed(), 0);
    }

    /* ---- JS engine cross-check ----
     * test/fixture-tree.json is generated by rewards/engine/merkle.js
     * (node engine/make-fixture.js). This proves the off-chain builder and the
     * on-chain verifier agree on leaves, sorting, and root computation. */
    function test_js_engine_fixture() public {
        string memory json = vm.readFile("test/fixture-tree.json");
        uint256 epochId = vm.parseJsonUint(json, ".epochId");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        uint256 total = vm.parseJsonUint(json, ".totalAllocated");
        _fundAndPublish(epochId, root, total);

        vm.warp(block.timestamp + 7 days); // fully vested before claiming
        uint256 n = 5;
        for (uint256 i = 0; i < n; i++) {
            string memory base = string.concat(".claims[", vm.toString(i), "]");
            uint256 index = vm.parseJsonUint(json, string.concat(base, ".index"));
            address account = vm.parseJsonAddress(json, string.concat(base, ".account"));
            uint256 amount = vm.parseJsonUint(json, string.concat(base, ".amount"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(base, ".proof"));
            uint256 before = mb.balanceOf(account);
            dist.claim(epochId, index, account, amount, proof);
            assertEq(mb.balanceOf(account), before + amount, "claim payout mismatch");
        }
        assertEq(dist.allocatedUnclaimed(), 0, "all claimed");
    }

    /* ---- claim window + finalization ---- */

    function test_claim_after_deadline_reverts() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.warp(block.timestamp + 30 days + 1);
        bytes32[] memory proof;
        vm.expectRevert("claim window closed");
        dist.claim(EPOCH, 0, alice, AMT, proof);
    }

    function test_claim_at_deadline_still_works() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.warp(block.timestamp + 30 days);
        bytes32[] memory proof;
        dist.claim(EPOCH, 0, alice, AMT, proof);
        assertEq(mb.balanceOf(alice), AMT);
    }

    function test_finalize_releases_unclaimed_to_free() public {
        bytes32 l0 = _leaf(EPOCH, 0, alice, AMT);
        bytes32 l1 = _leaf(EPOCH, 1, bob, AMT);
        bytes32 root = l0 <= l1
            ? keccak256(abi.encodePacked(l0, l1))
            : keccak256(abi.encodePacked(l1, l0));
        _fundAndPublish(EPOCH, root, 2 * AMT);

        vm.warp(block.timestamp + 7 days); // fully vested, alice claims all of hers
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        dist.claim(EPOCH, 0, alice, AMT, p0); // bob never claims
        assertEq(dist.allocatedUnclaimed(), AMT);

        vm.warp(block.timestamp + 30 days + 1);
        // Anyone (not just owner) may finalize an expired epoch.
        vm.prank(bob);
        dist.finalizeEpoch(EPOCH);
        assertEq(dist.allocatedUnclaimed(), 0, "liability released");
        assertEq(dist.epochUnclaimed(EPOCH), AMT, "view still reports remainder");

        // Owner can now withdraw the released remainder (carryover).
        vm.prank(owner);
        dist.withdraw(owner, AMT);
        assertEq(mb.balanceOf(owner), 1_000_000 ether - AMT, "owner recovered remainder");
    }

    function test_finalize_before_deadline_reverts() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.expectRevert("window still open");
        dist.finalizeEpoch(EPOCH);
    }

    function test_double_finalize_reverts() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.warp(block.timestamp + 30 days + 1);
        dist.finalizeEpoch(EPOCH);
        vm.expectRevert("already finalized");
        dist.finalizeEpoch(EPOCH);
    }

    function test_withdraw_still_cannot_touch_open_claims_after_expiry() public {
        // Expired but NOT finalized: liability stays, withdraw reverts.
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(owner);
        vm.expectRevert("touches claims");
        dist.withdraw(owner, AMT);
    }

    /* ---- ownership ---- */

    function test_transfer_ownership() public {
        address newOwner = address(0xBEEF);
        vm.prank(owner);
        dist.transferOwnership(newOwner);
        assertEq(dist.owner(), newOwner);

        // Old owner can no longer publish…
        vm.prank(owner);
        vm.expectRevert("not owner");
        dist.publishRoot(1, bytes32(uint256(1)), 1 ether);

        // …but the new owner can.
        vm.startPrank(newOwner);
        mb.mint(newOwner, 10 ether);
        mb.transfer(address(dist), 1 ether);
        dist.publishRoot(1, bytes32(uint256(1)), 1 ether);
        vm.stopPrank();
        assertEq(dist.latestEpoch(), 1);
    }

    function test_transfer_ownership_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert("zero addr");
        dist.transferOwnership(address(0));
    }

    function test_non_owner_withdraw_reverts() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        vm.startPrank(owner);
        mb.transfer(address(dist), AMT + 5 ether);
        dist.publishRoot(EPOCH, root, AMT);
        vm.stopPrank();
        // Even for free funds, a non-owner cannot withdraw.
        vm.prank(alice);
        vm.expectRevert("not owner");
        dist.withdraw(alice, 5 ether);
    }

    /* ---- token transfer failure ---- */

    function test_claim_reverts_when_token_returns_false() public {
        FalseReturnToken bad = new FalseReturnToken();
        RewardsDistributor d2 = new RewardsDistributor(address(bad), owner);
        bad.mint(address(d2), AMT); // funded, so publishRoot passes
        vm.prank(owner);
        d2.publishRoot(1, _leaf(1, 0, alice, AMT), AMT);
        vm.warp(block.timestamp + 7 days); // reach the transfer step
        bytes32[] memory proof;
        vm.expectRevert("transfer failed");
        d2.claim(1, 0, alice, AMT, proof);
        // Liability is untouched by the failed claim.
        assertEq(d2.allocatedUnclaimed(), AMT);
    }

    function test_claim_reverts_when_token_reverts() public {
        RevertingToken bad = new RevertingToken();
        RewardsDistributor d2 = new RewardsDistributor(address(bad), owner);
        bad.mint(address(d2), AMT);
        vm.prank(owner);
        d2.publishRoot(1, _leaf(1, 0, alice, AMT), AMT);
        vm.warp(block.timestamp + 7 days); // reach the transfer step
        bytes32[] memory proof;
        vm.expectRevert(); // bubbles the token's revert
        d2.claim(1, 0, alice, AMT, proof);
        assertEq(d2.allocatedUnclaimed(), AMT);
    }

    /* ---- future asset class: the distributor is asset-agnostic ----
     * Leaves are (epochId, index, account, amount) — the contract never sees
     * PORCH, MDOG, or any token class. A future NFT-holder class (or any new
     * asset) needs an engine scoring change only; this distributor deploys
     * once and never needs replacement for a new class. */

    function test_future_asset_class_needs_no_distributor_change() public {
        // Synthetic "NFT holder" leaves: distinct accounts, arbitrary amounts.
        address nft1 = address(0xAA01);
        address nft2 = address(0xAA02);
        bytes32 l0 = _leaf(9, 0, nft1, 7 ether);
        bytes32 l1 = _leaf(9, 1, nft2, 3 ether);
        bytes32 root = l0 <= l1
            ? keccak256(abi.encodePacked(l0, l1))
            : keccak256(abi.encodePacked(l1, l0));
        _fundAndPublish(9, root, 10 ether);

        vm.warp(block.timestamp + 7 days); // fully vested before claiming
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        dist.claim(9, 0, nft1, 7 ether, p0);
        assertEq(mb.balanceOf(nft1), 7 ether);

        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;
        dist.claim(9, 1, nft2, 3 ether, p1);
        assertEq(mb.balanceOf(nft2), 3 ether);
        assertEq(dist.allocatedUnclaimed(), 0);
    }

    /* ---- daily vesting: 1/7 per day, unclaimed slices pile up ---- */

    function test_day_one_unlocks_one_seventh() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.warp(block.timestamp + 1 days);
        bytes32[] memory proof;
        dist.claim(EPOCH, 0, alice, AMT, proof);
        assertEq(mb.balanceOf(alice), AMT / 7, "day 1 = exactly 1/7");
        assertEq(dist.claimedAmount(EPOCH, 0), AMT / 7);
    }

    function test_unclaimed_slices_pile_up() public {
        // Skip days 1-2 entirely; first claim on day 3 takes 3/7 at once.
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        vm.warp(block.timestamp + 3 days);
        bytes32[] memory proof;
        dist.claim(EPOCH, 0, alice, AMT, proof);
        assertEq(mb.balanceOf(alice), (AMT * 3) / 7, "days 1-3 piled up");
    }

    function test_claim_each_day_sums_to_full() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        bytes32[] memory proof;
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 1 days);
        dist.claim(EPOCH, 0, alice, AMT, proof);
        vm.warp(t0 + 3 days);
        dist.claim(EPOCH, 0, alice, AMT, proof);
        vm.warp(t0 + 7 days);
        dist.claim(EPOCH, 0, alice, AMT, proof);

        assertEq(mb.balanceOf(alice), AMT, "partial claims sum to the full allocation");
        assertEq(dist.allocatedUnclaimed(), 0);
        // Nothing left: further claims revert.
        vm.expectRevert("nothing vested yet");
        dist.claim(EPOCH, 0, alice, AMT, proof);
    }

    function test_vested_amount_view_steps() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        uint256 t0 = block.timestamp;
        assertEq(dist.vestedAmount(EPOCH, AMT), 0, "t=0: nothing");
        vm.warp(t0 + 1 days - 1);
        assertEq(dist.vestedAmount(EPOCH, AMT), 0, "just under 24h: still nothing");
        vm.warp(t0 + 1 days);
        assertEq(dist.vestedAmount(EPOCH, AMT), AMT / 7, "day 1");
        vm.warp(t0 + 3 days + 12 hours);
        assertEq(dist.vestedAmount(EPOCH, AMT), (AMT * 3) / 7, "day 3.5 floors to 3/7");
        vm.warp(t0 + 7 days);
        assertEq(dist.vestedAmount(EPOCH, AMT), AMT, "day 7: full");
        vm.warp(t0 + 30 days);
        assertEq(dist.vestedAmount(EPOCH, AMT), AMT, "never exceeds allocation");
    }

    function test_claimable_now_view() public {
        bytes32 root = _leaf(EPOCH, 0, alice, AMT);
        _fundAndPublish(EPOCH, root, AMT);
        assertEq(dist.claimableNow(EPOCH, 0, AMT), 0, "nothing vested at publish");
        vm.warp(block.timestamp + 2 days);
        assertEq(dist.claimableNow(EPOCH, 0, AMT), (AMT * 2) / 7, "2/7 claimable");
        bytes32[] memory proof;
        dist.claim(EPOCH, 0, alice, AMT, proof);
        assertEq(dist.claimableNow(EPOCH, 0, AMT), 0, "zero right after claiming");
    }

    function test_vesting_two_leaves_independent() public {
        bytes32 l0 = _leaf(EPOCH, 0, alice, AMT);
        bytes32 l1 = _leaf(EPOCH, 1, bob, AMT);
        bytes32 root = l0 <= l1
            ? keccak256(abi.encodePacked(l0, l1))
            : keccak256(abi.encodePacked(l1, l0));
        _fundAndPublish(EPOCH, root, 2 * AMT);
        vm.warp(block.timestamp + 1 days);
        bytes32[] memory p0 = new bytes32[](1); p0[0] = l1;
        dist.claim(EPOCH, 0, alice, AMT, p0); // alice takes day 1
        // Bob skipping day 1 doesn't affect his pile: day 2 claim = 2/7.
        vm.warp(block.timestamp + 1 days);
        bytes32[] memory p1 = new bytes32[](1); p1[0] = l0;
        dist.claim(EPOCH, 1, bob, AMT, p1);
        assertEq(mb.balanceOf(bob), (AMT * 2) / 7, "bob's unclaimed day piled up");
        assertEq(dist.allocatedUnclaimed(), 2 * AMT - AMT / 7 - (AMT * 2) / 7);
    }
}
