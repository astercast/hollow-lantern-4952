// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MuseDogs RewardsDistributor
/// @notice Weekly MUSEBOOK holder rewards for the Muse Dogs town.
/// Each epoch, the owner (the treasury wallet) publishes a merkle root over
/// (epochId, index, account, amount) leaves. Holders claim pull-style —
/// anyone may submit a claim for any account, the claimer pays their own gas.
///
/// Claim window: each epoch's claims stay open for CLAIM_WINDOW (30 days)
/// after its root is published. After the deadline, claims for that epoch
/// revert, and anyone may call finalizeEpoch() to release the epoch's
/// unclaimed remainder back to free funds. The engine counts those free
/// funds as carryover into the next epoch's pot, so unclaimed rewards roll
/// forward instead of locking up forever. Without finalization, unclaimed
/// allocations remain a permanent liability and can never be reused —
/// old proofs stay valid only while the window is open.
///
/// There is no treasury reserve and no treasury cut: 100% of every epoch pot
/// is allocated to eligible holders. The owner can only ever move funds that
/// are not backing outstanding claims (see withdraw()).
/// @dev Merkle verification uses sorted-pair hashing (OpenZeppelin
/// MerkleProof semantics), implemented inline so the contract is dependency-free.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract RewardsDistributor {
    IERC20 public immutable musebook;
    address public owner;
    uint256 public latestEpoch;

    /// @notice How long after publishRoot() an epoch stays claimable.
    /// Chosen window: 30 days (~4+ weekly epochs of grace). Unclaimed value
    /// is not lost — it rolls into the next epoch's pot via carryover.
    uint256 public constant CLAIM_WINDOW = 30 days;

    struct Epoch {
        bytes32 root;
        uint256 totalAllocated;
        uint256 totalClaimed;
        uint64 claimDeadline;
        bool finalized;
        bool exists;
    }

    mapping(uint256 => Epoch) public epochs;
    // epochId => word index => bitmask of claimed leaf indexes
    mapping(uint256 => mapping(uint256 => uint256)) private claimedBits;

    /// @notice Allocated-but-unclaimed across every epoch. Free funds =
    /// balanceOf(this) - allocatedUnclaimed. Finalizing an expired epoch
    /// moves its unclaimed remainder out of this liability.
    uint256 public allocatedUnclaimed;

    event RootPublished(uint256 indexed epochId, bytes32 indexed root, uint256 totalAllocated, uint64 claimDeadline);
    event Claimed(uint256 indexed epochId, uint256 indexed index, address indexed account, uint256 amount);
    event EpochFinalized(uint256 indexed epochId, uint256 released);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _musebook, address _owner) {
        require(_musebook != address(0) && _owner != address(0), "zero addr");
        musebook = IERC20(_musebook);
        owner = _owner;
    }

    /// @notice Publish one epoch's claim root. Epoch ids must strictly increase.
    /// @dev totalAllocated must already be funded: the contract's balance must
    /// cover it, so a root can never promise more than is here.
    function publishRoot(uint256 epochId, bytes32 root, uint256 totalAllocated) external onlyOwner {
        require(epochId > latestEpoch, "epoch order");
        require(root != bytes32(0), "zero root");
        require(totalAllocated > 0, "zero allocation");
        require(
            musebook.balanceOf(address(this)) >= allocatedUnclaimed + totalAllocated,
            "underfunded"
        );
        uint64 deadline = uint64(block.timestamp + CLAIM_WINDOW);
        epochs[epochId] = Epoch({
            root: root,
            totalAllocated: totalAllocated,
            totalClaimed: 0,
            claimDeadline: deadline,
            finalized: false,
            exists: true
        });
        allocatedUnclaimed += totalAllocated;
        latestEpoch = epochId;
        emit RootPublished(epochId, root, totalAllocated, deadline);
    }

    /// @notice Claim one leaf. Callable by anyone for any account.
    /// Reverts once the epoch's claim window has closed.
    function claim(
        uint256 epochId,
        uint256 index,
        address account,
        uint256 amount,
        bytes32[] calldata proof
    ) external {
        Epoch storage e = epochs[epochId];
        require(e.exists, "no epoch");
        require(block.timestamp <= e.claimDeadline, "claim window closed");

        uint256 word = index / 256;
        uint256 bit = index % 256;
        require((claimedBits[epochId][word] & (1 << bit)) == 0, "already claimed");
        claimedBits[epochId][word] |= (1 << bit);

        // Double-hashed leaf (prevents second-preimage attacks on the tree).
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(epochId, index, account, amount))));
        require(_verify(proof, e.root, leaf), "bad proof");

        e.totalClaimed += amount;
        require(e.totalClaimed <= e.totalAllocated, "over allocation");
        allocatedUnclaimed -= amount;

        require(musebook.transfer(account, amount), "transfer failed");
        emit Claimed(epochId, index, account, amount);
    }

    /// @notice After an epoch's claim window closes, release its unclaimed
    /// remainder from the liability so it becomes free (carryover) funds.
    /// Permissionless — anyone may finalize an expired epoch.
    function finalizeEpoch(uint256 epochId) external {
        Epoch storage e = epochs[epochId];
        require(e.exists, "no epoch");
        require(!e.finalized, "already finalized");
        require(block.timestamp > e.claimDeadline, "window still open");
        uint256 released = e.totalAllocated - e.totalClaimed;
        e.finalized = true;
        allocatedUnclaimed -= released;
        emit EpochFinalized(epochId, released);
    }

    /// @notice How much of one epoch is still claimable.
    function epochUnclaimed(uint256 epochId) external view returns (uint256) {
        Epoch storage e = epochs[epochId];
        require(e.exists, "no epoch");
        return e.totalAllocated - e.totalClaimed;
    }

    /// @notice Whether a leaf index was already claimed (for UIs).
    function isClaimed(uint256 epochId, uint256 index) external view returns (bool) {
        return (claimedBits[epochId][index / 256] & (1 << (index % 256))) != 0;
    }

    /// @notice Owner-only: move free funds (e.g. back to treasury).
    /// @dev Can never touch allocated-but-unclaimed claim funds. Free funds
    /// are: dust below the payout floor, plus unclaimed remainders of
    /// finalized (expired) epochs. The engine reads this free balance as
    /// next epoch's carryover.
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero addr");
        uint256 free = musebook.balanceOf(address(this)) - allocatedUnclaimed;
        require(amount <= free, "touches claims");
        require(musebook.transfer(to, amount), "transfer failed");
        emit Withdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero addr");
        owner = newOwner;
        emit OwnershipTransferred(newOwner);
    }

    /// @notice Sorted-pair merkle proof verification (OZ MerkleProof semantics).
    function _verify(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }
}
