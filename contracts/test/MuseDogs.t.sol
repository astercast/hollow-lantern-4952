// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MuseDogs} from "../src/MuseDogs.sol";
import {MuseDogsFeeSplitter, PoolKey} from "../src/MuseDogsFeeSplitter.sol";
import {MuseDogRewards} from "../src/MuseDogRewards.sol";
import {MockPoolManager, MockPositionManager, MockToken} from "./MuseDogsFeeSplitter.t.sol";

/// @notice Test suite for MuseDogs: voucher mints, caps, team mint, metadata
///         freeze, royalties, access control, and reentrancy.
/// @dev Voucher digests are built by hand in _signVoucher using the exact
///      EIP-712 construction the contract uses (name "Muse Dogs", version
///      "1", block.chainid, verifyingContract). If the JS signer produces a
///      different digest for the same inputs, THE JS IS WRONG — see NOTES.md.
contract MuseDogsTest is Test {
    MuseDogs nft;

    uint256 internal signerKey = 0xA11CE;
    address internal signer;
    address internal owner = address(0xBEEF);
    address internal relayer = address(0xCAFE);
    address payable internal mikey = payable(address(0xD06));
    address internal splitter; // real MuseDogsFeeSplitter, deployed in setUp

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        vm.chainId(4663); // fee splitter constructor pins to Robinhood Chain
        signer = vm.addr(signerKey);
        // Deploy the real fee splitter (with the real rewards vault) so the
        // royalty wiring is integration-tested, not mocked. The Uniswap v4
        // wiring is stubbed with mocks (pools unconfigured, so any DEX leg
        // would skip — the NFT tests never call process() anyway).
        MuseDogRewards vault = new MuseDogRewards(owner);
        // Etched token addresses: the splitter's pool keys require
        // currency0 < currency1 (MDOG < musebook < META); see the splitter
        // test setUp.
        MockToken tokenTemplate = new MockToken();
        vm.etch(address(uint160(0xF002)), address(tokenTemplate).code);
        vm.etch(address(uint160(0xF003)), address(tokenTemplate).code);
        vm.etch(address(uint160(0xF004)), address(tokenTemplate).code);
        MockToken mdog = MockToken(address(uint160(0xF002)));
        MockToken musebook = MockToken(address(uint160(0xF003)));
        MockToken meta = MockToken(address(uint160(0xF004)));
        MockPoolManager pm = new MockPoolManager();
        MockPositionManager posm = new MockPositionManager(mdog, musebook);
        PoolKey memory metaEthKey =
            PoolKey({currency0: address(0), currency1: address(meta), fee: 3000, tickSpacing: 60, hooks: address(0)});
        PoolKey memory metaMdogKey = PoolKey({
            currency0: address(mdog), currency1: address(meta), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        PoolKey memory mdogEthKey =
            PoolKey({currency0: address(0), currency1: address(mdog), fee: 3000, tickSpacing: 60, hooks: address(0)});
        PoolKey memory metaMusebookKey = PoolKey({
            currency0: address(musebook), currency1: address(meta), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        PoolKey memory mdogMusebookKey = PoolKey({
            currency0: address(mdog), currency1: address(musebook), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        MuseDogsFeeSplitter realSplitter = new MuseDogsFeeSplitter(
            mikey,
            payable(address(vault)),
            owner,
            0.1 ether,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            metaEthKey,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
        splitter = address(realSplitter);
        nft = new MuseDogs(owner, signer, splitter);
        vm.prank(owner); // setBaseURI is onlyOwner; the test contract is not the owner
        nft.setBaseURI("https://arweave.net/test-manifest/");
    }

    // -------------------------------------------------------------------------
    // Voucher signing helper (mirrors the contract's EIP-712 construction)
    // -------------------------------------------------------------------------

    function _signVoucher(uint256 key, address recipient, uint8 mintType, uint256 nonce, uint256 expiry)
        internal
        view
        returns (bytes memory sig)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes("Muse Dogs")), keccak256(bytes("1")), block.chainid, address(nft)
            )
        );
        bytes32 structHash = keccak256(abi.encode(nft.MINT_VOUCHER_TYPEHASH(), recipient, mintType, nonce, expiry));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _mint(address recipient, uint8 mintType, uint256 nonce, uint256 expiry)
        internal
        returns (uint256 tokenId)
    {
        bytes memory sig = _signVoucher(signerKey, recipient, mintType, nonce, expiry);
        uint256 before = nft.totalMinted();
        vm.prank(relayer); // relayer submits; NFT must still go to recipient
        nft.mintWithVoucher(recipient, mintType, nonce, expiry, sig);
        tokenId = before + 1;
        assertEq(nft.ownerOf(tokenId), recipient);
    }

    // -------------------------------------------------------------------------
    // Happy paths
    // -------------------------------------------------------------------------

    function test_CommunityMintHappyPath() public {
        address alice = address(0xA11CE);
        uint256 tokenId = _mint(alice, 0, 1, block.timestamp + 1 days);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.communityMinted(), 1);
        assertEq(nft.communityMintsByAddress(alice), 1);
        assertTrue(nft.usedNonces(alice, 1));
        assertEq(
            nft.tokenURI(tokenId), string.concat("https://arweave.net/test-manifest/", vm.toString(tokenId), ".json")
        );
    }

    function test_HolderMintHappyPath() public {
        address bob = address(0xB0B);
        _mint(bob, 1, 7, block.timestamp + 1 days);
        assertEq(nft.holderMinted(), 1);
        assertEq(nft.holderMintsByAddress(bob), 1);
        // Community bucket untouched.
        assertEq(nft.communityMinted(), 0);
    }

    function test_NonceIndependentAcrossRecipients() public {
        // Same nonce value is fine for different recipients (per-address nonces).
        _mint(address(0x1), 0, 42, block.timestamp + 1 days);
        _mint(address(0x2), 0, 42, block.timestamp + 1 days);
    }

    function test_NonceIndependentAcrossMintTypesIsBlocked() public {
        // Nonces are per-recipient, NOT per mint type: reusing a nonce for the
        // other mint type must revert. The backend must issue nonces unique
        // per recipient across both types.
        address alice = address(0xA11CE);
        _mint(alice, 0, 9, block.timestamp + 1 days);
        bytes memory sig = _signVoucher(signerKey, alice, 1, 9, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MuseDogs.NonceAlreadyUsed.selector, alice, 9));
        nft.mintWithVoucher(alice, 1, 9, block.timestamp + 1 days, sig);
    }

    // -------------------------------------------------------------------------
    // Voucher validation
    // -------------------------------------------------------------------------

    function test_WrongSignerReverts() public {
        bytes memory sig = _signVoucher(0xBAD, address(0x1), 0, 1, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(MuseDogs.BadVoucherSignature.selector);
        nft.mintWithVoucher(address(0x1), 0, 1, block.timestamp + 1 days, sig);
    }

    function test_TamperedRecipientReverts() public {
        address alice = address(0xA11CE);
        bytes memory sig = _signVoucher(signerKey, alice, 0, 1, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(MuseDogs.BadVoucherSignature.selector);
        nft.mintWithVoucher(address(0xE711), 0, 1, block.timestamp + 1 days, sig);
    }

    function test_TamperedMintTypeReverts() public {
        address alice = address(0xA11CE);
        bytes memory sig = _signVoucher(signerKey, alice, 0, 1, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(MuseDogs.BadVoucherSignature.selector);
        nft.mintWithVoucher(alice, 1, 1, block.timestamp + 1 days, sig);
    }

    function test_ExpiredVoucherReverts() public {
        address alice = address(0xA11CE);
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(signerKey, alice, 0, 1, expiry);
        vm.warp(expiry + 1); // one second past expiry
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MuseDogs.VoucherExpired.selector, expiry, expiry + 1));
        nft.mintWithVoucher(alice, 0, 1, expiry, sig);
    }

    function test_ExpiryBoundaryIsInclusive() public {
        address alice = address(0xA11CE);
        uint256 expiry = block.timestamp + 1 hours;
        bytes memory sig = _signVoucher(signerKey, alice, 0, 1, expiry);
        vm.warp(expiry); // exactly at expiry: still valid
        vm.prank(relayer);
        nft.mintWithVoucher(alice, 0, 1, expiry, sig);
        assertEq(nft.ownerOf(1), alice);
    }

    function test_NonceReuseReverts() public {
        address alice = address(0xA11CE);
        _mint(alice, 0, 5, block.timestamp + 1 days);
        bytes memory sig = _signVoucher(signerKey, alice, 0, 5, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MuseDogs.NonceAlreadyUsed.selector, alice, 5));
        nft.mintWithVoucher(alice, 0, 5, block.timestamp + 1 days, sig);
    }

    function test_InvalidMintTypeReverts() public {
        address alice = address(0xA11CE);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MuseDogs.InvalidMintType.selector, 2));
        nft.mintWithVoucher(alice, 2, 1, block.timestamp + 1 days, "");
    }

    function test_ZeroRecipientReverts() public {
        vm.prank(relayer);
        vm.expectRevert(MuseDogs.ZeroAddress.selector);
        nft.mintWithVoucher(address(0), 0, 1, block.timestamp + 1 days, "");
    }

    function test_MalleableSignatureReverts() public {
        // Flip s -> n - s (classic malleability): OZ recover must reject it.
        address alice = address(0xA11CE);
        bytes memory sig = _signVoucher(signerKey, alice, 0, 1, block.timestamp + 1 days);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        // secp256k1 order
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sMalleated = bytes32(n - uint256(s));
        uint8 vFlipped = v == 27 ? 28 : 27;
        bytes memory malleated = abi.encodePacked(r, sMalleated, vFlipped);
        vm.prank(relayer);
        vm.expectRevert(); // ECDSA: invalid signature (revert, not BadVoucherSignature)
        nft.mintWithVoucher(alice, 0, 1, block.timestamp + 1 days, malleated);
    }

    // -------------------------------------------------------------------------
    // Per-address and bucket caps
    // -------------------------------------------------------------------------

    function test_CommunityLimitThreePerAddress() public {
        address alice = address(0xA11CE);
        _mint(alice, 0, 1, block.timestamp + 1 days);
        _mint(alice, 0, 2, block.timestamp + 1 days);
        _mint(alice, 0, 3, block.timestamp + 1 days);
        bytes memory sig = _signVoucher(signerKey, alice, 0, 4, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MuseDogs.CommunityLimitExceeded.selector, alice));
        nft.mintWithVoucher(alice, 0, 4, block.timestamp + 1 days, sig);
    }

    function test_HolderLimitThreePerAddress() public {
        address bob = address(0xB0B);
        _mint(bob, 1, 1, block.timestamp + 1 days);
        _mint(bob, 1, 2, block.timestamp + 1 days);
        _mint(bob, 1, 3, block.timestamp + 1 days);
        bytes memory sig = _signVoucher(signerKey, bob, 1, 4, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(MuseDogs.HolderLimitExceeded.selector, bob));
        nft.mintWithVoucher(bob, 1, 4, block.timestamp + 1 days, sig);
    }

    function test_CommunityCap380() public {
        // 126 addresses x 3 = 378, then 2 more = 380. The 381st must revert.
        for (uint256 a = 0; a < 126; a++) {
            address r = address(uint160(0x1000 + a));
            _mint(r, 0, 1, block.timestamp + 1 days);
            _mint(r, 0, 2, block.timestamp + 1 days);
            _mint(r, 0, 3, block.timestamp + 1 days);
        }
        address last = address(0x2000);
        _mint(last, 0, 1, block.timestamp + 1 days);
        _mint(last, 0, 2, block.timestamp + 1 days);
        assertEq(nft.communityMinted(), 380);

        bytes memory sig = _signVoucher(signerKey, last, 0, 3, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(MuseDogs.CommunityCapExceeded.selector);
        nft.mintWithVoucher(last, 0, 3, block.timestamp + 1 days, sig);
    }

    function test_HolderCap100() public {
        for (uint256 a = 0; a < 100; a++) {
            _mint(address(uint160(0x3000 + a)), 1, 1, block.timestamp + 1 days);
        }
        assertEq(nft.holderMinted(), 100);
        bytes memory sig = _signVoucher(signerKey, address(0x9999), 1, 1, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(MuseDogs.HolderCapExceeded.selector);
        nft.mintWithVoucher(address(0x9999), 1, 1, block.timestamp + 1 days, sig);
    }

    function test_HardCap500AcrossBuckets() public {
        // Fill all three buckets to their caps: total must be exactly 500.
        for (uint256 a = 0; a < 126; a++) {
            address r = address(uint160(0x1000 + a));
            _mint(r, 0, 1, block.timestamp + 1 days);
            _mint(r, 0, 2, block.timestamp + 1 days);
            _mint(r, 0, 3, block.timestamp + 1 days);
        }
        _mint(address(0x2000), 0, 1, block.timestamp + 1 days);
        _mint(address(0x2000), 0, 2, block.timestamp + 1 days);
        for (uint256 a = 0; a < 100; a++) {
            _mint(address(uint160(0x3000 + a)), 1, 1, block.timestamp + 1 days);
        }
        address[] memory team = new address[](20);
        for (uint256 i = 0; i < 20; i++) {
            team[i] = address(uint160(0x4000 + i));
        }
        vm.prank(owner);
        nft.teamMint(team);
        assertEq(nft.totalMinted(), 500);
        assertEq(nft.ownerOf(500), address(0x4013));
    }

    // -------------------------------------------------------------------------
    // Team mint
    // -------------------------------------------------------------------------

    function test_TeamMintAcrossCalls() public {
        address[] memory batch1 = new address[](13);
        address[] memory batch2 = new address[](7);
        for (uint256 i = 0; i < 13; i++) {
            batch1[i] = address(uint160(0x5000 + i));
        }
        for (uint256 i = 0; i < 7; i++) {
            batch2[i] = address(uint160(0x6000 + i));
        }
        vm.startPrank(owner);
        nft.teamMint(batch1);
        nft.teamMint(batch2);
        vm.stopPrank();
        assertEq(nft.teamMinted(), 20);
        assertEq(nft.ownerOf(1), address(0x5000));
        assertEq(nft.ownerOf(20), address(0x6006));
    }

    function test_TeamMint21stReverts() public {
        address[] memory team = new address[](20);
        for (uint256 i = 0; i < 20; i++) {
            team[i] = address(uint160(0x7000 + i));
        }
        vm.prank(owner);
        nft.teamMint(team);
        address[] memory one = new address[](1);
        one[0] = address(0x1);
        vm.prank(owner);
        vm.expectRevert(MuseDogs.TeamCapExceeded.selector);
        nft.teamMint(one);
    }

    function test_TeamMintOnlyOwner() public {
        address[] memory one = new address[](1);
        one[0] = address(0x1);
        vm.prank(relayer);
        vm.expectRevert();
        nft.teamMint(one);
    }

    function test_TeamMintZeroAddressRevertsWholeBatch() public {
        address[] memory team = new address[](2);
        team[0] = address(0x1);
        team[1] = address(0);
        vm.prank(owner);
        vm.expectRevert(MuseDogs.ZeroAddress.selector);
        nft.teamMint(team);
        assertEq(nft.teamMinted(), 0); // nothing minted
    }

    function test_TeamMintEmptyReverts() public {
        vm.prank(owner);
        vm.expectRevert(MuseDogs.EmptyRecipients.selector);
        nft.teamMint(new address[](0));
    }

    // -------------------------------------------------------------------------
    // Metadata: set-once-then-frozen
    // -------------------------------------------------------------------------

    function test_BaseURISetOnceThenFrozen() public {
        // Already set in setUp; a second call must revert.
        vm.prank(owner);
        vm.expectRevert(MuseDogs.BaseURIAlreadySet.selector);
        nft.setBaseURI("https://evil.example/");
        assertTrue(nft.baseURIFrozen());
    }

    function test_TokenURIRevertsBeforeBaseURISet() public {
        MuseDogs fresh = new MuseDogs(owner, signer, splitter);
        address[] memory one = new address[](1);
        one[0] = address(0x1);
        vm.prank(owner);
        fresh.teamMint(one);
        vm.expectRevert(MuseDogs.MetadataNotSet.selector);
        fresh.tokenURI(1);
    }

    function test_TokenURIRevertsForNonexistent() public {
        vm.expectRevert();
        nft.tokenURI(999);
    }

    function test_SetBaseURIOnlyOwner() public {
        MuseDogs fresh = new MuseDogs(owner, signer, splitter);
        vm.prank(relayer);
        vm.expectRevert();
        fresh.setBaseURI("https://x/");
    }

    // -------------------------------------------------------------------------
    // Royalties + fee splitter wiring
    // -------------------------------------------------------------------------

    function test_RoyaltyIsFivePercentToSplitter() public {
        (address receiver, uint256 amount) = nft.royaltyInfo(1, 10 ether);
        assertEq(receiver, splitter);
        assertEq(amount, 0.5 ether);
    }

    function test_FeeSplitterSetOnce() public {
        MuseDogs fresh = new MuseDogs(owner, signer, address(0));
        (address receiver,) = fresh.royaltyInfo(1, 1 ether);
        assertEq(receiver, address(0)); // unset until wired
        vm.prank(owner);
        fresh.setFeeSplitter(splitter);
        assertEq(fresh.feeSplitter(), splitter);
        assertTrue(fresh.feeSplitterLocked());
        (receiver,) = fresh.royaltyInfo(1, 1 ether);
        assertEq(receiver, splitter);
        vm.prank(owner);
        vm.expectRevert(MuseDogs.FeeSplitterAlreadySet.selector);
        fresh.setFeeSplitter(address(0x1));
    }

    function test_FeeSplitterZeroReverts() public {
        MuseDogs fresh = new MuseDogs(owner, signer, address(0));
        vm.prank(owner);
        vm.expectRevert(MuseDogs.ZeroAddress.selector);
        fresh.setFeeSplitter(address(0));
    }

    function test_FeeSplitterEOAReverts() public {
        // An EOA (no code) can never be the royalty receiver: it would
        // silently swallow the irrevocable royalty stream.
        MuseDogs fresh = new MuseDogs(owner, signer, address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MuseDogs.NotAContract.selector, address(0xE0A)));
        fresh.setFeeSplitter(address(0xE0A));
    }

    // -------------------------------------------------------------------------
    // Voucher signer rotation + Ownable2Step
    // -------------------------------------------------------------------------

    function test_VoucherSignerRotation() public {
        address newSigner = address(0x9E9E);
        vm.prank(owner);
        nft.setVoucherSigner(newSigner);
        assertEq(nft.voucherSigner(), newSigner);

        // Old signer's vouchers are dead.
        bytes memory oldSig = _signVoucher(signerKey, address(0x1), 0, 1, block.timestamp + 1 days);
        vm.prank(relayer);
        vm.expectRevert(MuseDogs.BadVoucherSignature.selector);
        nft.mintWithVoucher(address(0x1), 0, 1, block.timestamp + 1 days, oldSig);
    }

    function test_VoucherSignerZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(MuseDogs.ZeroAddress.selector);
        nft.setVoucherSigner(address(0));
    }

    function test_Ownable2StepTransfer() public {
        address multisig = address(0x5AFE);
        vm.prank(owner);
        nft.transferOwnership(multisig);
        // Ownership does NOT move until accepted (typo'd address can't brick it).
        assertEq(nft.owner(), owner);
        vm.prank(multisig);
        nft.acceptOwnership();
        assertEq(nft.owner(), multisig);
    }

    function test_ConstructorZeroChecks() public {
        // Zero owner is rejected by OZ Ownable itself (runs before our body).
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new MuseDogs(address(0), signer, splitter);
        // Zero voucher signer is rejected by our own check.
        vm.expectRevert(MuseDogs.ZeroAddress.selector);
        new MuseDogs(owner, address(0), splitter);
    }

    // -------------------------------------------------------------------------
    // Reentrancy: malicious recipient tries to double-mint via onERC721Received
    // -------------------------------------------------------------------------

    function test_ReentrantRecipientCannotDoubleMint() public {
        ReentrantMinter attacker = new ReentrantMinter(nft, signerKey);
        // Give the attacker a valid voucher for itself.
        uint256 expiry = block.timestamp + 1 days;
        bytes memory sig = _signVoucher(signerKey, address(attacker), 0, 1, expiry);
        attacker.setVoucher(address(attacker), 0, 1, expiry, sig);
        // The attacker's onERC721Received tries to mint a second voucher (nonce 2).
        bytes memory sig2 = _signVoucher(signerKey, address(attacker), 0, 2, expiry);
        attacker.setSecondVoucher(address(attacker), 0, 2, expiry, sig2);

        vm.prank(relayer);
        nft.mintWithVoucher(address(attacker), 0, 1, expiry, sig);

        // Exactly one mint happened; the reentrant attempt failed.
        assertEq(nft.balanceOf(address(attacker)), 1);
        assertEq(nft.communityMinted(), 1);
        assertTrue(attacker.reentered());
        assertFalse(attacker.doubleMinted());
    }

    // -------------------------------------------------------------------------
    // ERC-165
    // -------------------------------------------------------------------------

    function test_SupportsInterfaces() public {
        assertTrue(nft.supportsInterface(0x01ffc9a7)); // ERC165
        assertTrue(nft.supportsInterface(0x80ac58cd)); // ERC721
        assertTrue(nft.supportsInterface(0x5b5e139f)); // ERC721Metadata
        assertTrue(nft.supportsInterface(0x2a55205a)); // ERC2981
    }
}

/// @notice Malicious recipient: tries to re-enter mintWithVoucher from
///         onERC721Received with a second valid voucher.
contract ReentrantMinter {
    MuseDogs internal nft;
    uint256 internal signerKey;
    bool public reentered;
    bool public doubleMinted;

    address r1;
    uint8 t1;
    uint256 n1;
    uint256 e1;
    bytes s1;
    address r2;
    uint8 t2;
    uint256 n2;
    uint256 e2;
    bytes s2;

    constructor(MuseDogs _nft, uint256 _signerKey) {
        nft = _nft;
        signerKey = _signerKey;
    }

    function setVoucher(address r, uint8 t, uint256 n, uint256 e, bytes calldata s) external {
        (r1, t1, n1, e1, s1) = (r, t, n, e, s);
    }

    function setSecondVoucher(address r, uint8 t, uint256 n, uint256 e, bytes calldata s) external {
        (r2, t2, n2, e2, s2) = (r, t, n, e, s);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        reentered = true;
        // Try to mint again with a second, fully-valid voucher.
        try nft.mintWithVoucher(r2, t2, n2, e2, s2) {
            doubleMinted = true;
        } catch {
            // expected: ReentrancyGuard blocks this
        }
        return this.onERC721Received.selector;
    }
}
