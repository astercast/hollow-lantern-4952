// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Royalty} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Muse Dogs
/// @notice 500-piece ERC-721 collection on Robinhood Chain (chain id 4663).
///         Name/symbol locked: "Muse Dogs" / "MUSEDOGS".
/// @dev DESIGN OVERVIEW — three supply buckets, enforced on-chain, never overlapping:
///        - 380 community mints: FREE, claimed via EIP-712 vouchers.
///          A backend relayer submits the tx and pays gas; the NFT always goes
///          to the voucher's `recipient` (never msg.sender). Max 3 per address.
///        - 100 holder-airdrop mints: same voucher system with
///          mintType = HOLDER. Max 3 per address. The $10 MDOG wallet check
///          happens ON MINT DAY, on-chain: the owner sets holderThresholdMDOG
///          (the raw MDOG amount worth ~$10 at the live price) and
///          mintWithVoucher reverts unless the recipient holds at least that
///          much MDOG at mint time. FAIL-CLOSED: until the threshold is set,
///          every HOLDER mint reverts with HolderThresholdNotSet, so the
///          holder path can never open early with no MDOG check. No balance
///          check happens before mint.
///        - 20 team/treasury mints: owner-only batch mint (the pre-launch test
///          mint by the deployer wallet, then ownership moves to the Safe).
///      380 + 100 + 20 = 500 = MAX_SUPPLY. Token IDs are sequential 1..500.
///
///      SECURITY PROPERTIES (see NOTES.md for the full audit log):
///        - Non-upgradeable: no proxies, no delegatecall, no selfdestruct.
///        - Vouchers bind chain id + this contract + recipient + mintType +
///          nonce + expiry (EIP-712). OZ's EIP712 recomputes the domain
///          separator if chainid ever changes, so fork replays are rejected.
///        - ECDSA.recover reverts on malleable signatures (s > n/2, bad v).
///        - Nonces are per-recipient and single-use; a voucher cannot be
///          replayed, redirected, or reused across mint types.
///        - Front-running the relayer is harmless: the NFT can only ever go to
///          the voucher's bound recipient.
///        - Royalty is a fixed 7% (700 bps) to the fee-splitter contract.
///          There is no setter for the bps and no way to raise it.
///        - baseURI can be set by the owner EXACTLY ONCE, then it is frozen
///          forever. No silent metadata changes are possible after that.
///        - Ownership uses Ownable2Step: a mistyped multisig address cannot
///          brick ownership; the new owner must call acceptOwnership().
contract MuseDogs is ERC721, ERC721Royalty, EIP712, Ownable2Step, ReentrancyGuard {
    using Strings for uint256;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @notice The two voucher-gated mint paths. Encoded as uint8 in EIP-712.
    enum MintType {
        COMMUNITY,
        HOLDER
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Absolute hard cap. 380 + 100 + 20; the bucket caps below sum to
    ///         exactly this, and every mint path is additionally guarded by it.
    uint256 public constant MAX_SUPPLY = 500;
    /// @notice Community (free, voucher) bucket cap.
    uint256 public constant COMMUNITY_CAP = 380;
    /// @notice Holder-airdrop (voucher) bucket cap.
    uint256 public constant HOLDER_CAP = 100;
    /// @notice Team/treasury (owner-only) bucket cap.
    uint256 public constant TEAM_CAP = 20;
    /// @notice Max community mints per recipient address.
    uint256 public constant MAX_COMMUNITY_PER_ADDRESS = 3;
    /// @notice Max holder-airdrop mints per recipient address.
    uint256 public constant MAX_HOLDER_PER_ADDRESS = 3;
    /// @notice EIP-2981 royalty: 700 bps = 7%, fixed forever. No setter exists.
    uint256 public constant ROYALTY_BPS = 700;
    /// @notice First token ID. Token IDs run 1..500 (1-based avoids token-0
    ///         edge cases in third-party tooling).
    uint256 public constant FIRST_TOKEN_ID = 1;

    /// @notice EIP-712 type hash for MintVoucher.
    /// @dev keccak256("MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)")
    ///      NOTE: this type intentionally differs from the earlier
    ///      `MintVoucher{to,quantity,nonce,deadline}` draft in VOUCHER_SPEC.md.
    ///      The JS signer (site/api/v1/_voucher.js) MUST be updated to this
    ///      exact type and re-cross-verified before mint opens, or vouchers
    ///      will not verify. See NOTES.md.
    bytes32 public constant MINT_VOUCHER_TYPEHASH =
        keccak256("MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)");

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice Next token ID to mint. Starts at FIRST_TOKEN_ID (1).
    uint256 private _nextTokenId = FIRST_TOKEN_ID;

    /// @notice Tokens minted per bucket (public so anyone can audit supply).
    uint256 public communityMinted;
    uint256 public holderMinted;
    uint256 public teamMinted;

    /// @notice Address authorized to sign mint vouchers. Dedicated key with no
    ///         other powers. Rotatable by the owner at any time (with event);
    ///         rotation instantly invalidates vouchers from the old key.
    address public voucherSigner;

    /// @notice recipient => nonce => true once consumed. Nonces are scoped per
    ///         recipient (NOT global, NOT per mint type): the backend must
    ///         issue nonces that are unique per recipient across BOTH mint
    ///         types, or the second voucher reverts with NonceAlreadyUsed.
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    /// @notice Community mints consumed per recipient (cap: 3).
    mapping(address => uint256) public communityMintsByAddress;
    /// @notice Holder-airdrop mints consumed per recipient (cap: 3).
    mapping(address => uint256) public holderMintsByAddress;

    /// @notice Arweave base URI, e.g. "https://arweave.net/<manifest-txid>/".
    ///         tokenURI = baseURI + tokenId + ".json". Settable exactly once.
    string private _baseTokenURI;
    /// @notice True once setBaseURI has been called; it can never be called again.
    bool public baseURIFrozen;

    /// @notice The fee-splitter contract receiving the 7% royalty.
    ///         Settable exactly once (constructor or setFeeSplitter).
    address public feeSplitter;
    /// @notice True once the fee splitter has been set; it can never change.
    bool public feeSplitterLocked;

    /// @notice MDOG token contract on Robinhood Chain. Immutable: the holder
    ///         path checks the recipient's MDOG balance on-chain at mint time.
    address public immutable mdogToken;

    /// @notice Raw MDOG amount (18 decimals) a recipient must hold for a
    ///         HOLDER mint. Set by the owner ON MINT DAY to the amount worth
    ///         ~$10 at the live price. The wallet check runs at mint time —
    ///         never before. FAIL-CLOSED: zero means UNSET, and every
    ///         HOLDER-path mint reverts with HolderThresholdNotSet until the
    ///         owner sets a nonzero threshold (an explicit set(0) is treated
    ///         as unset too, so the MDOG check can never be silently waived).
    uint256 public holderThresholdMDOG;

    // -------------------------------------------------------------------------
    // Errors (custom errors: no revert strings anywhere)
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error SameSigner();
    error NotAContract(address account);
    error InvalidMintType(uint8 mintType);
    error VoucherExpired(uint256 expiry, uint256 nowTimestamp);
    error NonceAlreadyUsed(address recipient, uint256 nonce);
    error BadVoucherSignature();
    error CommunityCapExceeded();
    error HolderCapExceeded();
    error TeamCapExceeded();
    error MaxSupplyExceeded();
    error CommunityLimitExceeded(address recipient);
    error HolderLimitExceeded(address recipient);
    error InsufficientMDOG(address recipient, uint256 thresholdMDOG);
    error HolderThresholdNotSet();
    error EmptyRecipients();
    error BaseURIAlreadySet();
    error EmptyBaseURI();
    error MetadataNotSet();
    error FeeSplitterAlreadySet();

    // -------------------------------------------------------------------------
    // Events (every state change emits)
    // -------------------------------------------------------------------------

    /// @notice Emitted for every community voucher mint.
    event CommunityMinted(
        address indexed recipient,
        uint256 indexed tokenId,
        uint256 nonce,
        uint256 expiry
    );
    /// @notice Emitted for every holder-airdrop voucher mint.
    event HolderMinted(
        address indexed recipient,
        uint256 indexed tokenId,
        uint256 nonce,
        uint256 expiry
    );
    /// @notice Emitted for every team/treasury batch mint.
    event TeamMinted(
        address indexed to,
        uint256 indexed firstTokenId,
        uint256 indexed lastTokenId,
        uint256 count
    );
    /// @notice Emitted when the voucher signer is set or rotated.
    event VoucherSignerSet(address indexed oldSigner, address indexed newSigner);
    /// @notice Emitted when the base URI is set (once, then frozen forever).
    event BaseURISet(string baseURI);
    /// @notice Emitted when the fee-splitter address is locked in.
    event FeeSplitterSet(address indexed feeSplitter);
    /// @notice Emitted when the owner sets the holder MDOG threshold (on mint day).
    event HolderThresholdSet(uint256 thresholdMDOG);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param initialOwner Multisig (Safe) that will own the contract. The
    ///        deployer (hot wallet) should transfer to the multisig via
    ///        transferOwnership + acceptOwnership (Ownable2Step) right after
    ///        the pre-launch team test mint.
    /// @param initialVoucherSigner Dedicated key that signs mint vouchers.
    ///        Never a hot wallet with other powers; its key never sends txs.
    /// @param initialFeeSplitter Royalty-splitter contract, or address(0) to
    ///        wire it later via setFeeSplitter (once). Until it is set,
    ///        royaltyInfo returns a zero receiver — set it before secondary
    ///        sales matter.
    /// @param mdogToken_ MDOG ERC20 on Robinhood Chain, used for the on-chain
    ///        holder balance check at mint time. Must be a contract.
    constructor(
        address initialOwner,
        address initialVoucherSigner,
        address initialFeeSplitter,
        address mdogToken_
    ) ERC721("Muse Dogs", "MUSEDOGS") EIP712("Muse Dogs", "1") Ownable(initialOwner) {
        if (initialOwner == address(0) || initialVoucherSigner == address(0)) {
            revert ZeroAddress();
        }
        if (mdogToken_.code.length == 0) {
            revert NotAContract(mdogToken_);
        }
        mdogToken = mdogToken_;
        voucherSigner = initialVoucherSigner;
        emit VoucherSignerSet(address(0), initialVoucherSigner);

        if (initialFeeSplitter != address(0)) {
            // The royalty stream is irrevocable once wired: refuse EOAs and
            // typos so a misconfigured address can never silently swallow it.
            if (initialFeeSplitter.code.length == 0) {
                revert NotAContract(initialFeeSplitter);
            }
            feeSplitter = initialFeeSplitter;
            feeSplitterLocked = true;
            _setDefaultRoyalty(initialFeeSplitter, uint96(ROYALTY_BPS));
            emit FeeSplitterSet(initialFeeSplitter);
        }
    }

    // -------------------------------------------------------------------------
    // Voucher mints (community 380 + holder 100)
    // -------------------------------------------------------------------------

    /// @notice Mint one NFT against an EIP-712 voucher signed by voucherSigner.
    /// @dev Permissionless: anyone may submit (the backend relayer does), but
    ///      the NFT ALWAYS goes to `recipient` — the signature binds the
    ///      recipient, so a stolen or front-run voucher cannot be redirected.
    ///      The mint price is 0; the submitter pays only Robinhood Chain gas.
    ///      Checks-effects-interactions: nonce and counters are updated BEFORE
    ///      _safeMint (which calls into the recipient). nonReentrant on top.
    /// @param recipient The whitelisted Bankr address receiving the NFT.
    /// @param mintType  0 = COMMUNITY (max 3/address, 380 cap),
    ///                  1 = HOLDER (max 3/address, 100 cap).
    /// @param nonce     Server-issued serial, single-use per recipient.
    /// @param expiry    Unix timestamp; the voucher is valid while
    ///                  block.timestamp <= expiry.
    /// @param signature EIP-712 signature over the MintVoucher struct.
    function mintWithVoucher(
        address recipient,
        uint8 mintType,
        uint256 nonce,
        uint256 expiry,
        bytes calldata signature
    ) external nonReentrant {
        // Cheap checks first (in increasing gas order); the ecrecover runs
        // last so exhausted caps revert before any signature work is done.
        if (recipient == address(0)) revert ZeroAddress();
        if (mintType > uint8(MintType.HOLDER)) revert InvalidMintType(mintType);
        if (block.timestamp > expiry) revert VoucherExpired(expiry, block.timestamp);
        if (usedNonces[recipient][nonce]) revert NonceAlreadyUsed(recipient, nonce);

        // Bucket + per-address caps. Community and holder buckets are
        // independent: 380 + 100 + 20 == 500 == MAX_SUPPLY.
        if (mintType == uint8(MintType.COMMUNITY)) {
            if (communityMinted >= COMMUNITY_CAP) revert CommunityCapExceeded();
            if (communityMintsByAddress[recipient] >= MAX_COMMUNITY_PER_ADDRESS) {
                revert CommunityLimitExceeded(recipient);
            }
        } else {
            if (holderMinted >= HOLDER_CAP) revert HolderCapExceeded();
            if (holderMintsByAddress[recipient] >= MAX_HOLDER_PER_ADDRESS) {
                revert HolderLimitExceeded(recipient);
            }
            // FAIL-CLOSED: the $10 MDOG wallet check happens here, at mint
            // time — never before. Until the owner sets holderThresholdMDOG
            // (on mint day), every HOLDER mint reverts. Zero is treated as
            // unset so the check can never be silently waived by omission.
            if (holderThresholdMDOG == 0) revert HolderThresholdNotSet();
            if (IERC20(mdogToken).balanceOf(recipient) < holderThresholdMDOG) {
                revert InsufficientMDOG(recipient, holderThresholdMDOG);
            }
        }
        // Defense-in-depth: even if a bucket cap were ever mis-set, the hard
        // cap can never be crossed.
        if (totalMinted() >= MAX_SUPPLY) revert MaxSupplyExceeded();

        // Recompute the digest exactly as the signer did and recover.
        // OZ v5.4 ECDSA takes bytes memory; copy from calldata.
        // recover() REVERTS on malleable signatures (s > n/2, invalid v),
        // so signature malleability cannot produce a second valid signature.
        bytes32 structHash = keccak256(
            abi.encode(MINT_VOUCHER_TYPEHASH, recipient, mintType, nonce, expiry)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        bytes memory sigBytes = signature;
        address recovered = ECDSA.recover(digest, sigBytes);
        if (recovered != voucherSigner) revert BadVoucherSignature();

        // ---- effects (before the external _safeMint call) ----
        usedNonces[recipient][nonce] = true;
        uint256 tokenId = _nextTokenId++;
        if (mintType == uint8(MintType.COMMUNITY)) {
            communityMinted++;
            communityMintsByAddress[recipient]++;
            emit CommunityMinted(recipient, tokenId, nonce, expiry);
        } else {
            holderMinted++;
            holderMintsByAddress[recipient]++;
            emit HolderMinted(recipient, tokenId, nonce, expiry);
        }

        // ---- interaction ----
        _safeMint(recipient, tokenId);
    }

    /// @notice Rotate the voucher-signing key. Callable by the owner at any
    ///         time; rotation is instant and emits an event. Outstanding
    ///         vouchers from the old key become invalid immediately.
    /// @dev There is deliberately no pause mechanism: the design keeps owner
    ///      powers minimal. Blast radius of a compromised signer is bounded by
    ///      the bucket caps (380/100) and voucher expiries. See NOTES.md.
    function setVoucherSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        if (newSigner == voucherSigner) revert SameSigner();
        address oldSigner = voucherSigner;
        voucherSigner = newSigner;
        emit VoucherSignerSet(oldSigner, newSigner);
    }

    // -------------------------------------------------------------------------
    // Team / treasury mints (20, owner-only)
    // -------------------------------------------------------------------------

    /// @notice Mint to a list of team/treasury recipients. Owner-only.
    /// @dev Used for the pre-launch test mint (deployer wallet mints 20, then
    ///      transfers ownership to the Safe multisig). Strict: any zero
    ///      address reverts the whole batch — the multisig fixes its input
    ///      rather than silently skipping entries.
    /// @param recipients Addresses receiving one NFT each. Total across all
    ///        calls can never exceed TEAM_CAP (20).
    function teamMint(address[] calldata recipients) external onlyOwner nonReentrant {
        uint256 count = recipients.length;
        if (count == 0) revert EmptyRecipients();
        if (teamMinted + count > TEAM_CAP) revert TeamCapExceeded();
        if (totalMinted() + count > MAX_SUPPLY) revert MaxSupplyExceeded();

        uint256 firstTokenId = _nextTokenId;
        // Effects first: reserve the whole range before any external call.
        teamMinted += count;
        _nextTokenId += count;

        for (uint256 i = 0; i < count; i++) {
            address to = recipients[i];
            if (to == address(0)) revert ZeroAddress();
            uint256 tokenId = firstTokenId + i;
            _safeMint(to, tokenId);
            emit TeamMinted(to, tokenId, tokenId, 1);
        }
    }

    // -------------------------------------------------------------------------
    // Metadata: set-once-then-frozen base URI (immediate reveal)
    // -------------------------------------------------------------------------

    /// @notice Set the base URI exactly ONCE. The call freezes it atomically:
    ///         there is no separate freeze step and no way to change it after.
    /// @dev Reveal is immediate — art is visible from the first mint — so this
    ///      must point at the final Arweave manifest URL before mint opens.
    ///      tokenURI reverts until this is set, so no broken metadata can
    ///      ever be served.
    /// @param newBaseURI e.g. "https://arweave.net/<manifest-txid>/".
    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        if (baseURIFrozen) revert BaseURIAlreadySet();
        if (bytes(newBaseURI).length == 0) revert EmptyBaseURI();
        _baseTokenURI = newBaseURI;
        baseURIFrozen = true;
        emit BaseURISet(newBaseURI);
    }

    /// @notice tokenURI = baseURI + tokenId + ".json", e.g.
    ///         https://arweave.net/<txid>/42.json
    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        _requireOwned(tokenId);
        if (!baseURIFrozen) revert MetadataNotSet();
        return string.concat(_baseTokenURI, tokenId.toString(), ".json");
    }

    // -------------------------------------------------------------------------
    // Royalties: fixed 7% to the fee splitter, settable exactly once
    // -------------------------------------------------------------------------

    /// @notice Wire the fee-splitter contract (if not set in the constructor).
    ///         One-shot: after this call the receiver can never change, and
    ///         the 7% rate itself has no setter anywhere — it is immutable.
    function setFeeSplitter(address newFeeSplitter) external onlyOwner {
        if (feeSplitterLocked) revert FeeSplitterAlreadySet();
        if (newFeeSplitter == address(0)) revert ZeroAddress();
        if (newFeeSplitter.code.length == 0) revert NotAContract(newFeeSplitter);
        feeSplitter = newFeeSplitter;
        feeSplitterLocked = true;
        _setDefaultRoyalty(newFeeSplitter, uint96(ROYALTY_BPS));
        emit FeeSplitterSet(newFeeSplitter);
    }

    /// @notice Set the MDOG amount required for holder mints. Called by the
    ///         owner ON MINT DAY: set to the raw MDOG amount (18 decimals)
    ///         worth ~$10 at the live price. The check itself runs on-chain
    ///         at mint time inside mintWithVoucher. Emits HolderThresholdSet.
    /// @dev Fail-closed: while the threshold is zero (unset), HOLDER mints
    ///      revert with HolderThresholdNotSet. Setting 0 explicitly is
    ///      accepted but behaves exactly like unset — the holder path stays
    ///      closed until a nonzero threshold is set.
    function setHolderThresholdMDOG(uint256 thresholdMDOG) external onlyOwner {
        holderThresholdMDOG = thresholdMDOG;
        emit HolderThresholdSet(thresholdMDOG);
    }

    // -------------------------------------------------------------------------
    // Supply views
    // -------------------------------------------------------------------------

    /// @notice Total minted across all three buckets.
    function totalMinted() public view returns (uint256) {
        return _nextTokenId - FIRST_TOKEN_ID;
    }

    /// @notice Remaining community voucher mints (380 - communityMinted).
    function communityRemaining() external view returns (uint256) {
        return COMMUNITY_CAP - communityMinted;
    }

    /// @notice Remaining holder-airdrop voucher mints (100 - holderMinted).
    function holderRemaining() external view returns (uint256) {
        return HOLDER_CAP - holderMinted;
    }

    /// @notice Remaining team/treasury mints (20 - teamMinted).
    function teamRemaining() external view returns (uint256) {
        return TEAM_CAP - teamMinted;
    }

    // -------------------------------------------------------------------------
    // ERC-165
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
