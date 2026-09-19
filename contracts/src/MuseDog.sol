// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Muse Dogs
/// @notice 500-piece ERC-721 collection on Robinhood Chain (chain id 4663).
///         Name/symbol locked 2026-09-18: "Muse Dogs" / "MUSEDOGS".
/// @dev Non-upgradeable. No proxies, no selfdestruct, no delegatecall, no owner "god mint".
///      Supply is split into three contract-enforced buckets that can never overlap:
///        - 380 holder airdrops  (owner-only batch mint to verified addresses)
///        - 100 community claims (free, voucher-based, one per address)
///        - 20  reserve          (owner-only mints for waitlist, prizes, team)
///      380 + 100 + 20 = 500 = MAX_SUPPLY. Token IDs are sequential across buckets.
contract MuseDog is ERC721, ERC721Royalty, EIP712, Ownable, Pausable, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Absolute hard cap. Nothing can ever mint above this.
    uint256 public constant MAX_SUPPLY = 500;
    /// @notice Holder airdrop bucket cap (direct mints by the project).
    uint256 public constant HOLDER_CAP = 380;
    /// @notice Community bucket cap (voucher claims + reserve combined).
    uint256 public constant COMMUNITY_CAP = 120;
    /// @notice Reserve slice inside the community bucket.
    uint256 public constant RESERVE_MAX = 20;
    /// @notice Max voucher claims: COMMUNITY_CAP - RESERVE_MAX = 100.
    uint256 public constant COMMUNITY_CLAIM_MAX = COMMUNITY_CAP - RESERVE_MAX;
    /// @notice Max recipients per holderMintBatch call (gas safety).
    uint256 public constant MAX_BATCH = 100;
    /// @notice Royalty ceiling: 700 bps = 7%. Never changeable above this.
    uint96 public constant MAX_ROYALTY_BPS = 700;
    /// @notice Robinhood Chain mainnet chain id, bound into every voucher.
    uint256 public constant CHAIN_ID = 4663;

    /// @notice EIP-712 type hash for the claim voucher.
    ///         Keccak of "ClaimVoucher(address claimant,uint256 nonce,uint256 expiresAt)".
    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("ClaimVoucher(address claimant,uint256 nonce,uint256 expiresAt)");

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    uint256 private _nextTokenId;
    uint256 public holderMinted;
    uint256 public communityMinted;
    uint256 public reserveMinted;

    /// @notice Nonces already consumed by a community claim (replay protection).
    mapping(uint256 => bool) public consumedNonce;
    /// @notice Addresses that already claimed via voucher (one claim per address).
    mapping(address => bool) public hasClaimed;

    /// @notice Address authorized to sign community claim vouchers. Rotatable by
    ///         the owner while the contract is paused (so rotation is deliberate).
    address public voucherSigner;

    string private _baseTokenURI;
    bool public metadataFrozen;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error BatchTooLarge(uint256 size);
    error EmptyBatch();
    error HolderCapExceeded();
    error CommunityCapExceeded();
    error ReserveCapExceeded();
    error MaxSupplyExceeded();
    error VoucherExpired();
    error NonceConsumed();
    error AlreadyClaimed();
    error BadVoucherSignature();
    error MetadataAlreadyFrozen();
    error RoyaltyTooHigh();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event HolderBatchMinted(uint256 count, uint256 firstTokenId, uint256 lastTokenId);
    event CommunityClaimed(address indexed claimant, uint256 indexed tokenId, uint256 nonce);
    event ReserveMinted(address indexed to, uint256 qty, uint256 firstTokenId, uint256 lastTokenId);
    event VoucherSignerRotated(address indexed oldSigner, address indexed newSigner);
    event BaseURIUpdated(string baseURI);
    event MetadataFrozen();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param initialOwner      Multisig that owns the contract (2-of-3 Safe).
    /// @param initialVoucherSigner Dedicated KMS key that signs claim vouchers.
    /// @param initialBaseURI    Arweave gateway/manifesto base URI (e.g. https://arweave.net/<manifest-txid>/),
    ///                           set once the 500 images + metadata are uploaded (see storage-plan-arweave.md).
    ///                           Reveal is immediate, so this must be final before the mint opens.
    /// @param royaltyReceiver  EIP-2981 royalty receiver (zero address disables).
    /// @param royaltyBps       EIP-2981 royalty in basis points, bounded at 700 (7%).
    constructor(
        address initialOwner,
        address initialVoucherSigner,
        string memory initialBaseURI,
        address royaltyReceiver,
        uint96 royaltyBps
    )
        ERC721("Muse Dogs", "MUSEDOGS")
        EIP712("Muse Dogs", "1")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || initialVoucherSigner == address(0)) revert ZeroAddress();
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        voucherSigner = initialVoucherSigner;
        _baseTokenURI = initialBaseURI;
        if (royaltyReceiver != address(0) && royaltyBps > 0) {
            _setDefaultRoyalty(royaltyReceiver, royaltyBps);
        }
    }

    // -------------------------------------------------------------------------
    // Holder airdrop path (bucket 1 of 3)
    // -------------------------------------------------------------------------

    /// @notice Mint directly to verified holder addresses in one transaction.
    /// @dev Zero addresses are skipped (not reverted) so one bad entry cannot
    ///      brick a batch. Caps are enforced on the count of valid recipients.
    function holderMintBatch(address[] calldata recipients)
        external
        onlyOwner
        whenNotPaused
    {
        uint256 size = recipients.length;
        if (size == 0) revert EmptyBatch();
        if (size > MAX_BATCH) revert BatchTooLarge(size);

        uint256 valid = 0;
        for (uint256 i = 0; i < size; i++) {
            if (recipients[i] != address(0)) valid++;
        }
        if (valid == 0) revert EmptyBatch();
        if (holderMinted + valid > HOLDER_CAP) revert HolderCapExceeded();
        if (_nextTokenId + valid > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 firstTokenId = _nextTokenId;
        for (uint256 i = 0; i < size; i++) {
            address to = recipients[i];
            if (to == address(0)) continue;
            _safeMint(to, _nextTokenId++);
            holderMinted++;
        }
        emit HolderBatchMinted(valid, firstTokenId, _nextTokenId - 1);
    }

    // -------------------------------------------------------------------------
    // Community free-mint path (bucket 2 of 3) — voucher claims
    // -------------------------------------------------------------------------

    /// @notice Claim one free NFT with an EIP-712 voucher signed by voucherSigner.
    /// @dev The signature binds: chain id 4663, this contract, the claimant,
    ///      a unique nonce, and an expiry timestamp. The function is non-payable:
    ///      mint price is 0; the claimer only pays Robinhood Chain gas.
    ///      Anyone may submit the transaction; the NFT always goes to `claimant`.
    function claim(
        address claimant,
        uint256 nonce,
        uint256 expiresAt,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        if (claimant == address(0)) revert ZeroAddress();
        if (block.timestamp > expiresAt) revert VoucherExpired();
        if (consumedNonce[nonce]) revert NonceConsumed();
        if (hasClaimed[claimant]) revert AlreadyClaimed();
        if (communityMinted >= COMMUNITY_CLAIM_MAX) revert CommunityCapExceeded();
        if (_nextTokenId >= MAX_SUPPLY) revert MaxSupplyExceeded();

        bytes32 structHash = keccak256(abi.encode(CLAIM_TYPEHASH, claimant, nonce, expiresAt));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != voucherSigner) revert BadVoucherSignature();

        // Effects before interaction: replay and double-claim are impossible
        // even if the recipient is a contract that re-enters.
        consumedNonce[nonce] = true;
        hasClaimed[claimant] = true;
        communityMinted++;

        uint256 tokenId = _nextTokenId++;
        _safeMint(claimant, tokenId);
        emit CommunityClaimed(claimant, tokenId, nonce);
    }

    /// @notice Rotate the voucher signer. Only while paused, so a rotation is a
    ///         deliberate, announced emergency action — never a silent hot-swap.
    function setVoucherSigner(address newSigner) external onlyOwner whenPaused {
        if (newSigner == address(0)) revert ZeroAddress();
        address old = voucherSigner;
        voucherSigner = newSigner;
        emit VoucherSignerRotated(old, newSigner);
    }

    // -------------------------------------------------------------------------
    // Reserve path (bucket 3 of 3)
    // -------------------------------------------------------------------------

    /// @notice Mint from the 20-token reserve: waitlist releases, prizes,
    ///         collaborators. Every reserve move should be announced publicly.
    function reserveMint(address to, uint256 qty) external onlyOwner whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        if (qty == 0) revert EmptyBatch();
        if (reserveMinted + qty > RESERVE_MAX) revert ReserveCapExceeded();
        if (_nextTokenId + qty > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 firstTokenId = _nextTokenId;
        for (uint256 i = 0; i < qty; i++) {
            _safeMint(to, _nextTokenId++);
            reserveMinted++;
        }
        emit ReserveMinted(to, qty, firstTokenId, _nextTokenId - 1);
    }

    // -------------------------------------------------------------------------
    // Pause
    // -------------------------------------------------------------------------

    /// @notice Halt ALL minting (holder, community, reserve). Transfers stay open.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume minting after an incident is resolved.
    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Metadata
    // -------------------------------------------------------------------------

    /// @notice Update the base URI. Blocked forever after freezeMetadata().
    /// @dev Intended use: point at the final Arweave manifest URL
    ///      (see storage-plan-arweave.md) before freezing.
    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        if (metadataFrozen) revert MetadataAlreadyFrozen();
        _baseTokenURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    /// @notice Permanently freeze metadata. One-way: there is no unfreeze.
    function freezeMetadata() external onlyOwner {
        if (metadataFrozen) revert MetadataAlreadyFrozen();
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // -------------------------------------------------------------------------
    // Royalties (EIP-2981)
    // -------------------------------------------------------------------------

    /// @notice Update the default royalty. Bounded at 7%.
    /// @dev The 7% total is unchanged; the fee-engine receiver routes 0.5%
    ///      of it to Mikey's Bankr address and runs its loop on the rest.
    ///      Passing (address(0), 0) removes the default royalty entirely.
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        if (feeNumerator > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (receiver == address(0)) {
            if (feeNumerator != 0) revert ZeroAddress();
            _deleteDefaultRoyalty();
        } else {
            _setDefaultRoyalty(receiver, feeNumerator);
        }
    }

    // -------------------------------------------------------------------------
    // Supply helpers
    // -------------------------------------------------------------------------

    /// @notice Total minted across all three buckets.
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @notice Remaining voucher claims available (100 - communityMinted).
    function communityClaimsRemaining() external view returns (uint256) {
        return COMMUNITY_CLAIM_MAX - communityMinted;
    }

    /// @notice Remaining reserve mints available (20 - reserveMinted).
    function reserveRemaining() external view returns (uint256) {
        return RESERVE_MAX - reserveMinted;
    }

    // -------------------------------------------------------------------------
    // Overrides
    // -------------------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Royalty)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
