// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MuseDogRewards} from "../src/MuseDogRewards.sol";

/// @notice Tests for MuseDogRewards. The merkle tree is built IN THIS TEST
///         with sorted pairs and leaf = keccak256(abi.encode(holder, amount)),
///         exactly matching the pinned backend scheme — so a passing claim here
///         proves the JS backend's identical construction will verify on-chain.
contract MuseDogRewardsTest is Test {
    MuseDogRewards internal vault;

    address internal publisher = address(0xB0B); // project multisig stand-in

    // happy-path holders (odd leaf count -> exercises self-pairing)
    address internal constant H1 = address(0xA11CE);
    address internal constant H2 = address(0xBEEF);
    address internal constant H3 = address(0xCAFE);
    uint256 internal constant A1 = 0.3 ether;
    uint256 internal constant A2 = 0.5 ether;
    uint256 internal constant A3 = 0.2 ether;

    event RootPublished(uint256 indexed epochId, bytes32 root, uint256 totalAmount);
    event Claimed(uint256 indexed epochId, address indexed holder, uint256 amount);

    // -------------------------------------------------------------------------
    // In-test merkle tree (sorted pairs, odd layer self-pairs — OZ convention)
    // -------------------------------------------------------------------------

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _buildLayers(bytes32[] memory leaves) internal pure returns (bytes32[][] memory layers) {
        require(leaves.length > 0, "no leaves");
        uint256 depth = 0;
        uint256 n = leaves.length;
        while (n > 1) {
            n = (n + 1) / 2;
            depth++;
        }
        layers = new bytes32[][](depth + 1);
        layers[0] = leaves;
        for (uint256 d = 0; d < depth; d++) {
            bytes32[] memory prev = layers[d];
            bytes32[] memory next = new bytes32[]((prev.length + 1) / 2);
            for (uint256 i = 0; i < next.length; i++) {
                bytes32 left = prev[2 * i];
                bytes32 right = (2 * i + 1 < prev.length) ? prev[2 * i + 1] : left;
                next[i] = _hashPair(left, right);
            }
            layers[d + 1] = next;
        }
    }

    function _proofOf(bytes32[][] memory layers, uint256 index) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](layers.length - 1);
        uint256 idx = index;
        for (uint256 d = 0; d < layers.length - 1; d++) {
            bytes32[] memory layer = layers[d];
            uint256 sib = idx ^ 1;
            proof[d] = sib < layer.length ? layer[sib] : layer[idx];
            idx = idx / 2;
        }
    }

    function _leaf(address holder, uint256 amount) internal pure returns (bytes32) {
        return keccak256(abi.encode(holder, amount));
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    function setUp() public {
        vault = new MuseDogRewards(publisher);
    }

    function test_constructor_zeroPublisherReverts() public {
        vm.expectRevert(MuseDogRewards.ZeroAddress.selector);
        new MuseDogRewards(address(0));
    }

    function test_publisherIsSet() public view {
        assertEq(vault.publisher(), publisher);
    }

    // -------------------------------------------------------------------------
    // Happy path (odd leaf count -> exercises self-pairing)
    // -------------------------------------------------------------------------

    function test_happyPath_claimSucceeds_exactlyOnce() public {
        uint256 epoch = 1;

        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = _leaf(H1, A1);
        leaves[1] = _leaf(H2, A2);
        leaves[2] = _leaf(H3, A3);
        bytes32[][] memory layers = _buildLayers(leaves);
        bytes32 root = layers[layers.length - 1][0];
        uint256 total = A1 + A2 + A3;

        // fund the vault (receive() payable)
        (bool sent, ) = payable(address(vault)).call{value: total}("");
        assertTrue(sent);
        assertEq(address(vault).balance, total);

        // publisher posts the root; event asserted
        vm.prank(publisher);
        vm.expectEmit(true, false, false, true);
        emit RootPublished(epoch, root, total);
        vault.publishRoot(epoch, root, total);
        assertEq(vault.epochRoot(epoch), root);
        assertEq(vault.epochTotal(epoch), total);

        _claimOnce(epoch, layers, 1, H2, A2);
        _claimOnce(epoch, layers, 0, H1, A1);
        _claimOnce(epoch, layers, 2, H3, A3);
        assertEq(address(vault).balance, 0);

        // second claim by H2 reverts
        vm.prank(H2);
        vm.expectRevert(abi.encodeWithSelector(MuseDogRewards.AlreadyClaimed.selector, epoch, H2));
        vault.claim(epoch, A2, _proofOf(layers, 1));
    }

    function _claimOnce(uint256 epoch, bytes32[][] memory layers, uint256 idx, address holder, uint256 amount)
        internal
    {
        uint256 before = holder.balance;
        vm.prank(holder);
        vm.expectEmit(true, true, false, true);
        emit Claimed(epoch, holder, amount);
        vault.claim(epoch, amount, _proofOf(layers, idx));
        assertEq(holder.balance, before + amount);
        assertTrue(vault.claimed(epoch, holder));
    }

    // -------------------------------------------------------------------------
    // publishRoot access + invariants
    // -------------------------------------------------------------------------

    function test_nonPublisher_publishRoot_reverts() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert(MuseDogRewards.NotPublisher.selector);
        vault.publishRoot(1, keccak256("root"), 1 ether);
    }

    function test_republish_sameEpoch_reverts() public {
        bytes32 root = keccak256("root");
        vm.prank(publisher);
        vault.publishRoot(1, root, 1 ether);
        vm.prank(publisher);
        vm.expectRevert(abi.encodeWithSelector(MuseDogRewards.RootAlreadyPublished.selector, 1));
        vault.publishRoot(1, keccak256("other"), 2 ether);
    }

    function test_zeroRoot_reverts() public {
        vm.prank(publisher);
        vm.expectRevert(MuseDogRewards.ZeroRoot.selector);
        vault.publishRoot(1, bytes32(0), 0);
    }

    // -------------------------------------------------------------------------
    // claim failures
    // -------------------------------------------------------------------------

    function _publishSimpleTree(uint256 epoch)
        internal
        returns (address holder, uint256 amount, bytes32[] memory proof, bytes32 root)
    {
        holder = address(0xF00D);
        amount = 1 ether;
        address other = address(0xD00D);
        uint256 otherAmt = 0.5 ether;
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = _leaf(holder, amount);
        leaves[1] = _leaf(other, otherAmt);
        bytes32[][] memory layers = _buildLayers(leaves);
        root = layers[1][0];
        proof = _proofOf(layers, 0);
        deal(address(vault), amount + otherAmt);
        vm.prank(publisher);
        vault.publishRoot(epoch, root, amount + otherAmt);
    }

    function test_claim_unknownEpoch_reverts() public {
        vm.prank(address(0xF00D));
        vm.expectRevert(abi.encodeWithSelector(MuseDogRewards.UnknownEpoch.selector, 999));
        vault.claim(999, 1 ether, new bytes32[](0));
    }

    function test_claim_wrongAmount_reverts() public {
        (address holder, uint256 amount, bytes32[] memory proof, ) = _publishSimpleTree(1);
        vm.prank(holder);
        vm.expectRevert(MuseDogRewards.InvalidProof.selector);
        vault.claim(1, amount + 1, proof); // valid proof, tampered amount
    }

    function test_claim_wrongProof_reverts() public {
        (address holder, uint256 amount, bytes32[] memory proof, ) = _publishSimpleTree(1);
        proof[0] = keccak256("tampered");
        vm.prank(holder);
        vm.expectRevert(MuseDogRewards.InvalidProof.selector);
        vault.claim(1, amount, proof);
    }

    function test_claim_wrongEpoch_reverts() public {
        // valid proof for epoch 1 used against epoch 2 (which has no root)
        (address holder, uint256 amount, bytes32[] memory proof, ) = _publishSimpleTree(1);
        vm.prank(holder);
        vm.expectRevert(abi.encodeWithSelector(MuseDogRewards.UnknownEpoch.selector, 2));
        vault.claim(2, amount, proof);
    }

    function test_claim_wrongHolder_reverts() public {
        // h1's proof cannot be used by h2 (leaf binds msg.sender)
        (address holder, , bytes32[] memory proof, ) = _publishSimpleTree(1);
        vm.prank(address(0xBADBAD));
        vm.expectRevert(MuseDogRewards.InvalidProof.selector);
        vault.claim(1, 1 ether, proof);
        assertTrue(!vault.claimed(1, holder));
    }

    function test_claim_noExpiry() public {
        // root published far in the past is still claimable
        (address holder, uint256 amount, bytes32[] memory proof, ) = _publishSimpleTree(1);
        vm.warp(block.timestamp + 365 days);
        uint256 before = holder.balance;
        vm.prank(holder);
        vault.claim(1, amount, proof);
        assertEq(holder.balance, before + amount);
    }

    // -------------------------------------------------------------------------
    // Fuzz: random holders/amounts, each valid claim succeeds exactly once
    // -------------------------------------------------------------------------

    function testFuzz_claimsSucceedExactlyOnce(uint8 nIn, uint256 seed) public {
        uint256 n = bound(nIn, 1, 16);
        bytes32[] memory leaves = new bytes32[](n);
        address[] memory holders = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256 total = 0;

        for (uint256 i = 0; i < n; i++) {
            holders[i] = address(uint160(uint256(keccak256(abi.encode("holder", seed, i)))));
            amounts[i] = bound(uint256(keccak256(abi.encode("amt", seed, i))), 1 wei, 1 ether);
            leaves[i] = _leaf(holders[i], amounts[i]);
            total += amounts[i];
        }

        bytes32[][] memory layers = _buildLayers(leaves);
        bytes32 root = layers[layers.length - 1][0];
        uint256 epoch = bound(seed, 1, type(uint256).max - 1);
        deal(address(vault), total);
        vm.prank(publisher);
        vault.publishRoot(epoch, root, total);

        for (uint256 i = 0; i < n; i++) {
            uint256 before = holders[i].balance;
            vm.prank(holders[i]);
            vault.claim(epoch, amounts[i], _proofOf(layers, i));
            assertEq(holders[i].balance, before + amounts[i]);
            assertTrue(vault.claimed(epoch, holders[i]));

            vm.prank(holders[i]);
            vm.expectRevert(
                abi.encodeWithSelector(MuseDogRewards.AlreadyClaimed.selector, epoch, holders[i])
            );
            vault.claim(epoch, amounts[i], _proofOf(layers, i));
        }
        assertEq(address(vault).balance, 0);
    }

    function testFuzz_publishRoot_accessOnlyPublisher(address who, uint256 epochId, bytes32 root) public {
        vm.assume(who != publisher);
        vm.assume(root != bytes32(0));
        vm.prank(who);
        vm.expectRevert(MuseDogRewards.NotPublisher.selector);
        vault.publishRoot(epochId, root, 0);
    }
}
