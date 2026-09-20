// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MuseDogRewards — weekly merkle-distributed holder rewards vault
/// @notice Holds ETH from the 3.5% royalty slice of the Muse Dogs collection
///         (7% total royalty: 0.7% Mikey, 3.5% holder rewards, 2.8% fee engine).
///         An off-chain backend takes a daily holder-balance snapshot at
///         00:00 UTC, builds a weekly epoch (Monday 00:00 UTC -> next Monday
///         00:00 UTC) with time-weighted pro-rata shares, and computes a
///         merkle root. The immutable `publisher` (project multisig) posts one
///         root per epoch via `publishRoot`. Holders pull their share any time
///         via `claim` — claims never expire.
/// @dev MERKLE LEAF SCHEME (backend JS MUST match this exactly):
///      leaf = keccak256(abi.encode(address holder, uint256 amount))
///      Tree is built with SORTED PAIRS (OpenZeppelin MerkleProof default:
///      at each level, the two child hashes are sorted before hashing, i.e.
///      hash = keccak256(sort(a, b)) via _hashPair). The JS backend must:
///        1. Compute leaf = keccak256(solidityPackedEncode(["address","uint256"],
///           [holder, amount])) — identical bytes to abi.encode for these types.
///        2. Build the tree with sorted pairs at every level (e.g. OpenZeppelin
///           JS merkle-tree: new StandardMerkleTree(rows.map(...)) with the
///           default hash pair ordering, or manual sort-then-hash).
///      On-chain verification uses OpenZeppelin's MerkleProof.verify, which
///      assumes the same sorted-pair construction.
contract MuseDogRewards is ReentrancyGuard {
    /// @notice Address authorized to publish weekly merkle roots (project multisig). Immutable.
    address public immutable publisher;

    /// @notice epochId -> published merkle root. bytes32(0) = no root published yet.
    mapping(uint256 => bytes32) public epochRoot;

    /// @notice epochId -> total ETH distributable for that epoch (informational; the root defines exact payouts).
    mapping(uint256 => uint256) public epochTotal;

    /// @notice epochId -> holder -> true once claimed. Claims never expire; once claimed, never payable again.
    mapping(uint256 => mapping(address => bool)) public claimed;

    /// @notice Emitted when the publisher posts a weekly root.
    event RootPublished(uint256 indexed epochId, bytes32 root, uint256 totalAmount);

    /// @notice Emitted when a holder pulls their epoch payout.
    event Claimed(uint256 indexed epochId, address indexed holder, uint256 amount);

    error ZeroAddress();
    error NotPublisher();
    error RootAlreadyPublished(uint256 epochId);
    error ZeroRoot();
    error UnknownEpoch(uint256 epochId);
    error AlreadyClaimed(uint256 epochId, address holder);
    error InvalidProof();
    error EthSendFailed();

    /// @param _publisher Project multisig authorized to publish weekly roots. Cannot be zero.
    constructor(address _publisher) {
        if (_publisher == address(0)) revert ZeroAddress();
        publisher = _publisher;
    }

    /// @notice Accept ETH royalty deposits (the 2% rewards slice of the splitter).
    receive() external payable {}

    /// @notice Publish the merkle root for one weekly epoch. One root per epoch, forever.
    /// @param epochId Weekly epoch id (backend convention: Monday 00:00 UTC timestamp / epoch seconds).
    /// @param root Merkle root over leaves of keccak256(abi.encode(holder, amount)), sorted-pair tree.
    /// @param totalAmount Total ETH payable under this epoch's tree (informational, for the UI).
    function publishRoot(uint256 epochId, bytes32 root, uint256 totalAmount) external {
        if (msg.sender != publisher) revert NotPublisher();
        if (epochRoot[epochId] != bytes32(0)) revert RootAlreadyPublished(epochId);
        if (root == bytes32(0)) revert ZeroRoot();
        epochRoot[epochId] = root;
        epochTotal[epochId] = totalAmount;
        emit RootPublished(epochId, root, totalAmount);
    }

    /// @notice Claim this epoch's payout. Permissionless; anyone may claim for msg.sender only.
    /// @dev CEI: claimed is marked before the ETH transfer. nonReentrant on top.
    ///      No expiry — a root published in 2026 is still claimable forever.
    /// @param epochId Weekly epoch to claim from.
    /// @param amount Exact wei amount assigned to msg.sender in this epoch's tree.
    /// @param proof Merkle proof from leaf = keccak256(abi.encode(msg.sender, amount)) to epochRoot[epochId].
    function claim(uint256 epochId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        bytes32 root = epochRoot[epochId];
        if (root == bytes32(0)) revert UnknownEpoch(epochId);
        if (claimed[epochId][msg.sender]) revert AlreadyClaimed(epochId, msg.sender);

        bytes32 leaf = keccak256(abi.encode(msg.sender, amount));
        if (!MerkleProof.verify(proof, root, leaf)) revert InvalidProof();

        claimed[epochId][msg.sender] = true; // effects before interaction
        emit Claimed(epochId, msg.sender, amount);

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert EthSendFailed();
    }
}
