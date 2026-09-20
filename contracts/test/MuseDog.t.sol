// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MuseDog} from "../src/MuseDog.sol";
import {MuseDogRoyaltySplitter} from "../src/MuseDogRoyaltySplitter.sol";

/// @notice Full test suite for the Muse Dogs collection contract.
///         Covers caps, both mint paths, voucher replay safety, pause,
///         metadata freeze, access control, and the pinned royalty.
contract MuseDogTest is Test {
    MuseDog public muse;
    MuseDogRoyaltySplitter public splitter;

    address public owner = makeAddr("multisig-owner");
    uint256 public signerKey = 0xA11CE;
    address public voucherSigner;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    string constant BASE = "ipfs://musedog-collection/";

    function setUp() public {
        voucherSigner = vm.addr(signerKey);
        // 10/40/50 royalty splitter: Mikey / rewards vault / fee engine.
        splitter = new MuseDogRoyaltySplitter(
            makeAddr("mikey"),
            makeAddr("rewards-vault"),
            makeAddr("fee-engine")
        );
        muse = new MuseDog(owner, voucherSigner, BASE, address(splitter));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// @dev Locked collection identity: name "Muse Dogs", symbol "MUSEDOGS".
    function test_NameAndSymbol() public view {
        assertEq(muse.name(), "Muse Dogs");
        assertEq(muse.symbol(), "MUSEDOGS");
    }

    /// @dev Sign a voucher digest for (claimant, nonce, expiresAt) with the real signer key.
    function _signVoucher(address claimant, uint256 nonce, uint256 expiresAt)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(muse.CLAIM_TYPEHASH(), claimant, nonce, expiresAt)
        );
        // Rebuild the EIP-712 digest exactly like the contract does.
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Muse Dogs")),
                keccak256(bytes("1")),
                block.chainid,
                address(muse)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Sign a voucher digest with an overridden chain id / verifying contract.
    function _signVoucherSpoofed(
        address claimant,
        uint256 nonce,
        uint256 expiresAt,
        uint256 chainIdOverride,
        address contractOverride
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(muse.CLAIM_TYPEHASH(), claimant, nonce, expiresAt)
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Muse Dogs")),
                keccak256(bytes("1")),
                chainIdOverride,
                contractOverride
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _batch(uint256 n, uint256 seed) internal pure returns (address[] memory) {
        address[] memory addrs = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            addrs[i] = address(uint160(seed * 1_000_000 + i + 1));
        }
        return addrs;
    }

    // -------------------------------------------------------------------------
    // Holder batch path
    // -------------------------------------------------------------------------

    function test_HolderBatchMintsSequentialTokenIds() public {
        vm.prank(owner);
        muse.holderMintBatch(_batch(3, 1));
        assertEq(muse.ownerOf(0), _batch(3, 1)[0]);
        assertEq(muse.ownerOf(2), _batch(3, 1)[2]);
        assertEq(muse.holderMinted(), 3);
    }

    function test_HolderBatchEnforcesCap() public {
        // Fill the holder bucket exactly: one full batch of 100.
        vm.prank(owner);
        muse.holderMintBatch(_batch(100, 100));
        assertEq(muse.holderMinted(), 100);

        address[] memory one = new address[](1);
        one[0] = alice;
        vm.prank(owner);
        vm.expectRevert(MuseDog.HolderCapExceeded.selector);
        muse.holderMintBatch(one);
    }

    function test_HolderBatchRejectsOver100() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MuseDog.BatchTooLarge.selector, 101));
        muse.holderMintBatch(_batch(101, 7));
    }

    function test_HolderBatchSkipsZeroAddress() public {
        address[] memory addrs = new address[](3);
        addrs[0] = alice;
        addrs[1] = address(0); // skipped, not reverted
        addrs[2] = bob;
        vm.prank(owner);
        muse.holderMintBatch(addrs);
        assertEq(muse.ownerOf(0), alice);
        assertEq(muse.ownerOf(1), bob);
        assertEq(muse.holderMinted(), 2);
    }

    function test_HolderBatchAllZeroReverts() public {
        address[] memory addrs = new address[](2);
        vm.prank(owner);
        vm.expectRevert(MuseDog.EmptyBatch.selector);
        muse.holderMintBatch(addrs);
    }

    // -------------------------------------------------------------------------
    // Community voucher path
    // -------------------------------------------------------------------------

    function test_VoucherHappyPath() public {
        uint256 nonce = 1;
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(alice, nonce, expiry);

        // Anyone can submit; the NFT goes to the claimant.
        vm.prank(bob);
        muse.claim(alice, nonce, expiry, sig);

        assertEq(muse.ownerOf(0), alice);
        assertTrue(muse.hasClaimed(alice));
        assertTrue(muse.consumedNonce(nonce));
        assertEq(muse.communityMinted(), 1);
    }

    function test_VoucherReplayReverts() public {
        uint256 nonce = 2;
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(alice, nonce, expiry);
        muse.claim(alice, nonce, expiry, sig);

        vm.expectRevert(MuseDog.NonceConsumed.selector);
        muse.claim(bob, nonce, expiry, sig); // same nonce, different claimant
    }

    function test_VoucherWrongClaimantReverts() public {
        uint256 nonce = 3;
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(alice, nonce, expiry); // signed for alice

        vm.expectRevert(MuseDog.BadVoucherSignature.selector);
        muse.claim(bob, nonce, expiry, sig); // claimed for bob
    }

    function test_VoucherExpiredReverts() public {
        uint256 nonce = 4;
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(alice, nonce, expiry);

        vm.warp(expiry + 1);
        vm.expectRevert(MuseDog.VoucherExpired.selector);
        muse.claim(alice, nonce, expiry, sig);
    }

    function test_VoucherWrongChainIdReverts() public {
        uint256 nonce = 5;
        uint256 expiry = block.timestamp + 1 hours;
        // Signed as if for chain id 1 (mainnet) instead of 4663.
        bytes memory sig = _signVoucherSpoofed(alice, nonce, expiry, 1, address(muse));

        vm.expectRevert(MuseDog.BadVoucherSignature.selector);
        muse.claim(alice, nonce, expiry, sig);
    }

    function test_VoucherWrongContractReverts() public {
        uint256 nonce = 6;
        uint256 expiry = block.timestamp + 1 hours;
        // Signed binding a different contract address.
        bytes memory sig = _signVoucherSpoofed(
            alice, nonce, expiry, block.chainid, address(0xdead)
        );

        vm.expectRevert(MuseDog.BadVoucherSignature.selector);
        muse.claim(alice, nonce, expiry, sig);
    }

    function test_VoucherWrongSignerKeyReverts() public {
        uint256 nonce = 7;
        uint256 expiry = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(muse.CLAIM_TYPEHASH(), alice, nonce, expiry)
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Muse Dogs")),
                keccak256(bytes("1")),
                block.chainid,
                address(muse)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest); // attacker's key
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(MuseDog.BadVoucherSignature.selector);
        muse.claim(alice, nonce, expiry, sig);
    }

    function test_SecondClaimBySameAddressReverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        muse.claim(alice, 8, expiry, _signVoucher(alice, 8, expiry));

        bytes memory sig2 = _signVoucher(alice, 9, expiry); // precompute: nested calls defeat expectRevert
        vm.expectRevert(MuseDog.AlreadyClaimed.selector);
        muse.claim(alice, 9, expiry, sig2);
    }

    function test_CommunityClaimCapEnforced() public {
        uint256 expiry = block.timestamp + 7 days;
        // Fill all 380 voucher claims.
        for (uint256 i = 0; i < 380; i++) {
            address claimant = address(uint160(i + 1));
            muse.claim(claimant, i + 1000, expiry, _signVoucher(claimant, i + 1000, expiry));
        }
        assertEq(muse.communityMinted(), 380);
        assertEq(muse.communityClaimsRemaining(), 0);

        bytes memory lastSig = _signVoucher(alice, 9999, expiry); // precompute: nested calls defeat expectRevert
        vm.expectRevert(MuseDog.CommunityCapExceeded.selector);
        muse.claim(alice, 9999, expiry, lastSig);
    }

    // -------------------------------------------------------------------------
    // Reserve path
    // -------------------------------------------------------------------------

    function test_ReserveMintAndCap() public {
        vm.prank(owner);
        muse.reserveMint(alice, 10);
        assertEq(muse.reserveMinted(), 10);
        assertEq(muse.ownerOf(0), alice);
        assertEq(muse.reserveRemaining(), 10);

        // Fill to exactly 20.
        vm.prank(owner);
        muse.reserveMint(bob, 10);
        assertEq(muse.reserveRemaining(), 0);

        vm.prank(owner);
        vm.expectRevert(MuseDog.ReserveCapExceeded.selector);
        muse.reserveMint(alice, 1);
    }

    // -------------------------------------------------------------------------
    // Global supply invariants
    // -------------------------------------------------------------------------

    function test_CapsNeverExceed500() public {
        // 100 holder + 380 claims + 20 reserve = exactly 500.
        vm.prank(owner);
        muse.holderMintBatch(_batch(100, 500));
        uint256 expiry = block.timestamp + 7 days;
        for (uint256 i = 0; i < 380; i++) {
            address claimant = address(uint160(9_000_000 + i));
            muse.claim(claimant, 50_000 + i, expiry, _signVoucher(claimant, 50_000 + i, expiry));
        }
        vm.prank(owner);
        muse.reserveMint(alice, 20);

        assertEq(muse.totalMinted(), 500);

        // Every further mint path is dead.
        address[] memory one = new address[](1);
        one[0] = bob;
        vm.prank(owner);
        vm.expectRevert(MuseDog.HolderCapExceeded.selector);
        muse.holderMintBatch(one);
        bytes memory deadSig = _signVoucher(bob, 77_777, expiry); // precompute: nested calls defeat expectRevert
        vm.expectRevert(MuseDog.CommunityCapExceeded.selector);
        muse.claim(bob, 77_777, expiry, deadSig);
        vm.prank(owner);
        vm.expectRevert(MuseDog.ReserveCapExceeded.selector);
        muse.reserveMint(bob, 1);
    }

    // -------------------------------------------------------------------------
    // Pause
    // -------------------------------------------------------------------------

    function test_PauseBlocksHolderAndCommunityButNotTransfers() public {
        // Seed one holder mint so there is a token to transfer.
        address[] memory one = new address[](1);
        one[0] = alice;
        vm.prank(owner);
        muse.holderMintBatch(one);

        vm.prank(owner);
        muse.pause();

        // Both mint paths revert while paused.
        vm.prank(owner);
        vm.expectRevert(); // OZ ExpectedPause
        muse.holderMintBatch(one);

        uint256 expiry = block.timestamp + 1 hours;
        bytes memory bobSig = _signVoucher(bob, 11, expiry); // precompute: nested calls defeat expectRevert
        vm.expectRevert(); // OZ ExpectedPause
        muse.claim(bob, 11, expiry, bobSig);

        // Ordinary transfers keep working.
        vm.prank(alice);
        muse.transferFrom(alice, bob, 0);
        assertEq(muse.ownerOf(0), bob);

        // Unpause restores minting.
        vm.prank(owner);
        muse.unpause();
        vm.prank(owner);
        muse.holderMintBatch(one);
        assertEq(muse.holderMinted(), 2);
    }

    function test_ReserveBlockedWhilePaused() public {
        vm.prank(owner);
        muse.pause();
        vm.prank(owner);
        vm.expectRevert();
        muse.reserveMint(alice, 1);
    }

    // -------------------------------------------------------------------------
    // Voucher signer rotation
    // -------------------------------------------------------------------------

    function test_SignerRotationOnlyWhilePaused() public {
        address newSigner = makeAddr("new-kms");

        // Rotation while live is rejected by OZ's whenPaused (EnforcedPause).
        vm.prank(owner);
        try muse.setVoucherSigner(newSigner) {
            revert("rotation must revert while unpaused");
        } catch {
            // expected
        }

        vm.prank(owner);
        muse.pause();
        vm.prank(owner);
        muse.setVoucherSigner(newSigner);
        assertEq(muse.voucherSigner(), newSigner);

        // Old signer can no longer issue valid vouchers.
        uint256 expiry = block.timestamp + 1 hours;
        vm.prank(owner);
        muse.unpause();
        bytes memory staleSig = _signVoucher(alice, 12, expiry); // precompute: nested calls defeat expectRevert
        vm.expectRevert(MuseDog.BadVoucherSignature.selector);
        muse.claim(alice, 12, expiry, staleSig);
    }

    // -------------------------------------------------------------------------
    // Access control
    // -------------------------------------------------------------------------

    function test_NonOwnerCannotMintPauseOrRotate() public {
        address attacker = makeAddr("attacker");

        vm.prank(attacker);
        vm.expectRevert();
        muse.holderMintBatch(_batch(1, 99));

        vm.prank(attacker);
        vm.expectRevert();
        muse.reserveMint(attacker, 1);

        vm.prank(attacker);
        vm.expectRevert();
        muse.pause();

        vm.prank(owner);
        muse.pause();
        vm.prank(attacker);
        vm.expectRevert();
        muse.setVoucherSigner(attacker);

        vm.prank(attacker);
        vm.expectRevert();
        muse.setBaseURI("ipfs://evil/");

        vm.prank(attacker);
        vm.expectRevert();
        muse.freezeMetadata();
    }

    // -------------------------------------------------------------------------
    // Metadata
    // -------------------------------------------------------------------------

    function test_MetadataFreezeIsOneWay() public {
        address[] memory one = new address[](1);
        one[0] = alice;
        vm.prank(owner);
        muse.holderMintBatch(one);
        assertEq(muse.tokenURI(0), string.concat(BASE, "0"));

        // Update works before freeze.
        vm.prank(owner);
        muse.setBaseURI("ipfs://revealed/");
        assertEq(muse.tokenURI(0), "ipfs://revealed/0");

        // Freeze is one-way.
        vm.prank(owner);
        muse.freezeMetadata();
        assertTrue(muse.metadataFrozen());

        vm.prank(owner);
        vm.expectRevert(MuseDog.MetadataAlreadyFrozen.selector);
        muse.setBaseURI("ipfs://evil/");

        vm.prank(owner);
        vm.expectRevert(MuseDog.MetadataAlreadyFrozen.selector);
        muse.freezeMetadata();
    }

    // -------------------------------------------------------------------------
    // Royalties
    // -------------------------------------------------------------------------

    /// @dev The royalty is pinned, not settable: ERC-2981 points at the splitter
    ///      with a fixed 500 bps (5%) on every token id. There is no setter to
    ///      probe, so the invariant is "royaltyInfo always returns (splitter, 5%)".
    function test_RoyaltyPinnedAtFivePercent() public view {
        assertEq(muse.ROYALTY_BPS(), 500);

        (address receiver, uint256 amount) = muse.royaltyInfo(0, 10_000);
        assertEq(receiver, address(splitter));
        assertEq(amount, 500);

        // Same on a different token id and a realistic sale price.
        (receiver, amount) = muse.royaltyInfo(499, 1 ether);
        assertEq(receiver, address(splitter));
        assertEq(amount, 0.05 ether);
    }

    function test_ConstructorRejectsBadParams() public {
        // OZ's Ownable base constructor rejects a zero owner before our body runs.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MuseDog(address(0), voucherSigner, BASE, address(splitter));

        vm.expectRevert(MuseDog.ZeroAddress.selector);
        new MuseDog(owner, address(0), BASE, address(splitter));

        // A zero royalty splitter would kill royalties — it reverts.
        vm.expectRevert(MuseDog.ZeroAddress.selector);
        new MuseDog(owner, voucherSigner, BASE, address(0));
    }
}
