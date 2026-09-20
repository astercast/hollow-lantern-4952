// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

// ---------------------------------------------------------------------------
// Minimal Uniswap v4 types
// ---------------------------------------------------------------------------

/// @notice Uniswap v4 pool key. This is ABI-identical to v4-core's PoolKey:
///         `Currency` and `IHooks` are address-wrapped types there, so plain
///         `address` fields encode to the exact same bytes, and
///         keccak256(abi.encode(key)) equals the canonical pool id.
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice Uniswap v4 swap parameters (ABI-identical to v4-core's SwapParams).
/// @dev amountSpecified sign follows canonical v4: < 0 = exact input,
///      > 0 = exact output. (An earlier revision of this file had the signs
///      flipped; the fork-verified flow uses NEGATIVE for exact input.)
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // < 0 = exact input, > 0 = exact output
    uint160 sqrtPriceLimitX96; // 0 = no limit
}

/// @notice Packed (amount0, amount1) currency deltas returned by
///         PoolManager.swap. *** CHAIN-SPECIFIC ***: on Robinhood Chain's
///         modified PoolManager, amount0 occupies the HIGH 128 bits and
///         amount1 the LOW 128 bits (flipped vs canonical v4-core, where
///         amount0 is low). Verified against live fork state 2026-09-20:
///         the passing probe extracts amount0 from the high bits and the
///         sign/partial-fill assertions hold. Negative = the caller owes
///         that currency to the pool; positive = the pool owes the caller.
type BalanceDelta is bytes32;

library BalanceDeltaLib {
    function amount0(BalanceDelta d) internal pure returns (int128) {
        // High 128 bits, two's-complement sign-extended via truncation.
        // The shift bounds the value below 2^128 so the int256 cast is safe.
        return int128(int256(uint256(BalanceDelta.unwrap(d)) >> 128));
    }

    function amount1(BalanceDelta d) internal pure returns (int128) {
        // Low 128 bits, two's-complement sign-extended via truncation.
        // Masked first so the int256 cast can never see bit 255 set.
        uint256 low = uint256(BalanceDelta.unwrap(d)) & ((uint256(1) << 128) - 1);
        return int128(int256(low));
    }
}

/// @notice Minimal Uniswap v4 PoolManager interface: only the functions this
///         splitter uses. The splitter acts as its own router via unlock().
/// @dev *** CHAIN-SPECIFIC (verified 2026-09-20 against live bytecode) ***:
///      Robinhood Chain's PoolManager is MODIFIED vs canonical v4-core:
///      - `settle(address)` / `settle(Currency)` does NOT exist (selector
///        0x6a256b29 is absent). The no-args `settle()` handles BOTH native
///        ETH (with msg.value) and ERC20 (after sync+transfer, no value).
///        Calling `settle(currency)` reverts via the fallback.
///      - `getSlot0(bytes32)` does NOT exist. Slot0 is read via `extsload`
///        at keccak256(abi.encode(poolId, uint256(6))) — the pools mapping
///        lives at storage slot 6.
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (BalanceDelta delta);
    /// @notice Settle a debt: native ETH with msg.value, or ERC20 after
    ///         sync(currency) + transfer to the PoolManager (no value).
    ///         This single function covers both cases on this chain.
    function settle() external payable returns (uint256 paid);
    function sync(address currency) external;
    function take(address currency, address recipient, uint256 amount) external;
    /// @notice Raw storage read, used for slot0 (see above).
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @notice Callback the PoolManager invokes on the unlock() caller.
interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @notice Minimal Uniswap v4 PositionManager interface. unlockData is
///         abi.encode(uint256[] actions, bytes[] params) following the
///         v4-periphery Actions convention (MINT_POSITION = 2,
///         SETTLE_PAIR = 13, SWEEP = 20, packed as bytes).
interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    /// @notice The Permit2 contract this PositionManager pulls ERC20s through.
    function permit2() external view returns (address);
}

/// @notice Minimal Permit2 interface: only the approval the mint needs.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title MuseDogsFeeSplitter
/// @notice Splits Muse Dogs royalty ETH and autonomously routes the DEX legs
///         through Uniswap v4 on Robinhood Chain (chain id 4663).
///
/// @dev Royalty split: every wei that arrives is divided 10% Mikey's Bankr
///      address (raw ETH) / 40% holder-rewards vault (raw ETH) /
///      25% MDOG/musebook liquidity / 25% MDOG/ETH liquidity. The Mikey/vault
///      legs are pushed immediately and FAIL OPEN into claimable pending
///      buckets if the recipient reverts; the DEX legs FAIL SAFE (skip, funds
///      stay escrowed).
///
///      The two DEX legs route through META instead of swapping ETH directly
///      for MDOG, because the MDOG/ETH pool is too thin to absorb royalty
///      flow safely. The deep META pools carry the volume:
///
///        MUSEBOOK-LP (25%): half the leg goes native ETH -> META -> MDOG,
///                        the other half goes native ETH -> META -> musebook;
///                        then a full-range MDOG/musebook v4 position is
///                        minted directly to the dead address (locked forever).
///        ETH-LP (25%):     half stays native ETH; the other half goes
///                        ETH -> META -> MDOG; then a full-range MDOG/native-ETH
///                        v4 position is minted directly to the dead address.
///
///      The splitter is its own v4 router: swaps run inside
///      poolManager.unlock(), with this contract as the IUnlockCallback. No
///      external swap router is trusted.
///
///      The splitter ONLY ever touches its own escrowed royalty funds. It
///      mints brand-new position NFTs to the dead address; it never reads,
///      moves, or modifies any existing LP position (including the owner's
///      personal MDOG/ETH and MDOG/musebook positions).
///
///      Pool keys are constructor-set (no setter exists, so the deploy-time
///      pinning cannot be changed afterwards). The deployer supplies
///      the exact verified (currency0, currency1, fee, tickSpacing, hooks) for
///      each of the five pools; the constructor pins each key's currencies to
///      the token set (native/META, MDOG/META, musebook/META, native/MDOG,
///      MDOG/musebook) and rejects anything else, so a misconfigured key
///      cannot silently buy the wrong token.
///
/// @dev Slippage / MEV design (read carefully):
///      - v4 core has no TWAP oracle, so there is no time-weighted guard.
///      - Each hop carries TWO independent guards derived from the pool's spot
///        price read immediately before the leg (same transaction, so no
///        interleaving is possible between the read and the swaps):
///          1. sqrtPriceLimitX96: bounds how far the pool price may move
///             during OUR swap (a fail-safe against our own price impact and
///             against executing into a drained/manipulated pool). For
///             zeroForOne the limit sits (1 - s) below spot; for oneForZero it
///             sits (1 + s) above spot, where s = maxSlippageBps.
///          2. amountOutMinimum per hop: quoted from spot, discounted by
///             maxSlippageBps (hop 2 chains off hop 1's worst case).
///        A partial fill (price limit hit mid-swap) reverts the leg instead of
///        leaving half-spent funds behind.
///      - Sandwich protection is ECONOMIC, not cryptographic: the legs trade
///        in the deep META pools (the whole reason for META routing) and each
///        leg is bounded by processThreshold. A same-block frontrun moves the
///        spot read itself, so no on-chain spot guard can see it; what makes
///        the attack unprofitable is the capital required to move a deep pool
///        versus the small leg size. If a leg ever does fill badly, it reverts
///        and the bucket stays escrowed for a later keeper call.
///      - process() is permissionless once processThreshold is reached, so any
///        keeper can retry a skipped leg.
///
/// @dev Fail-safe accounting:
///      - Buckets are zeroed BEFORE any external call; a revert restores them.
///      - process() try/catches each DEX leg: a failed leg is skipped and its
///        ETH stays escrowed; direct payouts are never blocked by a DEX failure.
///      - Each DEX leg only ever consumes its OWN bucket's ETH, so legs can
///        never eat each other's escrow.
///      - Leftover native ETH stays native (no wrapping) and is swept as new
///        funds on the next process(); leftover ERC20 dust is picked up by the
///        next DEX leg.
///      - Approvals are set with forceApprove for the exact amount needed and
///        reset to zero after use.
///      - Invariant: address(this).balance >= totalPending() always holds,
///        because every wei that leaves does so through a bucket decrement of
///        at least the same size.
///
/// @dev Native-ETH mint note: the v4 PositionManager does NOT refund excess
///      msg.value, so the MDOG/ETH leg computes the EXACT native amount the
///      mint will consume (rounding up, matching v4-core's SqrtPriceMath) and
///      sends exactly that. Any remainder stays in the splitter and is swept
///      on the next process(). (The MDOG/musebook leg mints with two ERC20s
///      and sends no native value at all.)
///
/// @dev Assumptions (documented, fail-safe if violated):
///      - META, MDOG and musebook are standard ERC20s. The META settle step
///        pays the pool an EXACT amount; a fee-on-transfer META would underpay
///        and the leg would revert (funds stay escrowed, nothing is lost).
///      - v4-periphery action ids MINT_POSITION = 2, SETTLE_PAIR = 13,
///        SWEEP = 20 (packed bytes), and
///        their params encoding, match the deployed PositionManager. Verify
///        against the v4-periphery Actions.sol used on Robinhood Chain before
///        mainnet use.
contract MuseDogsFeeSplitter is Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLib for BalanceDelta;

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    /// @notice Robinhood Chain id. Deployment on any other chain reverts.
    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;

    /// @notice Uniswap v4 PoolManager on Robinhood Chain, verified on-chain:
    ///         PositionManager.poolManager() returns this address.
    address public constant ROBINHOOD_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    /// @notice Uniswap v4 PositionManager on Robinhood Chain, verified on-chain:
    ///         a live MDOG/ETH position (NFT) exists under it.
    address public constant ROBINHOOD_POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;

    /// @notice MDOG token on Robinhood Chain (Andrew-confirmed).
    address public constant MDOG_TOKEN = 0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC;

    /// @notice META token on Robinhood Chain (routing intermediate).
    address public constant META_TOKEN = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;

    /// @notice musebook token on Robinhood Chain (Andrew-confirmed).
    address public constant MUSEBOOK_TOKEN = 0x91A2DAe9699f0B82540B5886b0d8759C22820bA3;

    /// @notice Burn / dead address: LP NFTs go here (locked forever).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Royalty split, in basis points.
    uint256 public constant MIKEY_BPS = 1000; // 10% raw ETH to Mikey's Bankr address
    uint256 public constant REWARDS_BPS = 4000; // 40% raw ETH to the holder-rewards vault
    uint256 public constant MUSEBOOK_LP_BPS = 2500; // 25% MDOG/musebook LP to the dead address (via META)
    uint256 public constant LIQUIDITY_BPS = 2500; // 25% MDOG/ETH LP to the dead address (via META)
    uint256 public constant TOTAL_BPS = 10000;

    uint256 internal constant SLIPPAGE_BPS = 10000;
    uint256 public constant MAX_SLIPPAGE_BPS = 2000; // 20%: looser is not "protection"

    uint256 internal constant Q96 = 2 ** 96;

    /// @notice Storage slot of the pools mapping in this chain's PoolManager.
    ///         Slot0 of a pool lives at keccak256(abi.encode(poolId, 6)).
    ///         Verified against live bytecode 2026-09-20.
    uint256 internal constant POOLS_SLOT = 6;

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;

    /// @notice v4-periphery Actions ids (verify against the deployed periphery
    ///         before mainnet use).
    uint256 internal constant ACTION_MINT_POSITION = 2;
    uint256 internal constant ACTION_SETTLE_PAIR = 13;
    uint256 internal constant ACTION_SWEEP = 20;

    // -----------------------------------------------------------------------
    // Immutable config
    // -----------------------------------------------------------------------

    address payable public immutable mikeyBankr;
    address payable public immutable rewardsVault;
    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    address public immutable metaToken;
    address public immutable mdogToken;
    address public immutable musebookToken;

    /// @notice ETH/META pool key (currency0 = native ETH, currency1 = META).
    ///         Set once in the constructor; there is no setter.
    PoolKey internal metaEthPoolKey;
    /// @notice MDOG/META pool key (currency0 = MDOG, currency1 = META).
    ///         Set once in the constructor; there is no setter.
    PoolKey internal metaMdogPoolKey;
    /// @notice musebook/META pool key (currency0 = musebook, currency1 = META).
    ///         Set once in the constructor; there is no setter.
    PoolKey internal metaMusebookPoolKey;
    /// @notice MDOG/native-ETH pool key (currency0 = native ETH, currency1 = MDOG).
    ///         Set once in the constructor; there is no setter.
    PoolKey internal mdogEthPoolKey;
    /// @notice MDOG/musebook pool key (currency0 = MDOG, currency1 = musebook).
    ///         Set once in the constructor; there is no setter.
    PoolKey internal mdogMusebookPoolKey;

    // -----------------------------------------------------------------------
    // Mutable config + state
    // -----------------------------------------------------------------------

    /// @notice Minimum new wei that must arrive before process() runs.
    uint256 public processThreshold;
    /// @notice Max slippage per multihop hop, in bps (default 3%).
    uint256 public maxSlippageBps = 300;

    /// @notice ETH escrowed for the MDOG/musebook-LP leg, awaiting swaps+mint.
    uint256 public musebookLiquidityPending;
    /// @notice ETH escrowed for the MDOG/ETH-LP leg, awaiting swap+mint.
    uint256 public liquidityPending;
    /// @notice Reentrancy flag held while a DEX leg's external interactions run.
    ///         process() refuses to run while it is set, which closes the
    ///         reentrant-process() hole that a malicious token callback could
    ///         otherwise open during a standalone leg (the leg's bucket is
    ///         zeroed first, so its in-flight ETH would look "unaccounted" to
    ///         a reentrant process). Reverts roll the flag back automatically.
    bool private _inDexLeg;
    /// @notice Mikey's ETH that failed to push (claimable via claimMikey()).
    uint256 public mikeyPending;
    /// @notice Vault ETH that failed to push (claimable via claimRewards()).
    uint256 public rewardsPending;

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error ZeroThreshold();
    error NotAContract(address account);
    error BelowThreshold(uint256 threshold, uint256 newFunds);
    error TransferFailed();
    error InsufficientPending(uint256 requested, uint256 available);
    error NothingPending();
    error WrongChainId(uint256 expected, uint256 actual);
    error InvalidPoolKey();
    error PoolNotInitialized(bytes32 poolId);
    error SlippageExceeded(uint256 received, uint256 minimumRequired);
    error SlippageBpsTooHigh(uint256 bps);
    error SwapPartialFill(uint256 consumed, uint256 expected);
    error InvalidSwapDelta();
    error NotPoolManager(address caller);
    error ZeroLiquidity();
    error PriceLimitOverflow();
    error TickOutOfRange(int24 tick);
    error DexLegReentrant();

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event RoyaltyReceived(address indexed from, uint256 amount);
    event Processed(
        uint256 newFunds,
        uint256 mikeyShare,
        uint256 rewardsShare,
        uint256 musebookLpShare,
        uint256 liquidityShare,
        bool mikeyPushed,
        bool rewardsPushed
    );
    event MikeyPaid(uint256 amount);
    event RewardsPaid(uint256 amount);
    event MusebookLiquidityExecuted(
        uint256 ethIn, uint256 mdogUsed, uint256 musebookUsed, int24 tickLower, int24 tickUpper
    );
    event LiquidityExecuted(uint256 ethIn, uint256 ethUsed, uint256 mdogUsed, int24 tickLower, int24 tickUpper);
    event DexLegSkipped(string leg);
    event MusebookLiquidityForwarded(address indexed destination, uint256 amount);
    event LiquidityForwarded(address indexed destination, uint256 amount);
    event ThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);
    event MaxSlippageBpsUpdated(uint256 oldBps, uint256 newBps);

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /// @param _mikeyBankr Mikey's Bankr address (10% leg, raw ETH).
    /// @param _rewardsVault Holder-rewards vault (40% leg, raw ETH). Must be a contract.
    /// @param _initialOwner Initial owner (the Safe multisig after launch).
    /// @param _initialThreshold Minimum new wei per process() call.
    /// @param _poolManager Uniswap v4 PoolManager (must be a contract).
    /// @param _positionManager Uniswap v4 PositionManager (must be a contract).
    /// @param _metaToken META ERC20 (must be a contract; cannot be address(0)).
    /// @param _mdogToken MDOG ERC20 (must be a contract; cannot be address(0)).
    /// @param _musebookToken musebook ERC20 (must be a contract; cannot be address(0)).
    /// @param _metaEthPoolKey Verified ETH/META pool key (currencies: native, META).
    /// @param _metaMdogPoolKey Verified MDOG/META pool key (currencies: MDOG, META).
    /// @param _metaMusebookPoolKey Verified musebook/META pool key (currencies: musebook, META).
    /// @param _mdogEthPoolKey MDOG/native-ETH pool key (currencies: native, MDOG).
    ///        Working scripts used fee 3000, tickSpacing 60, no hooks for this
    ///        pool; pass the verified values at deploy time.
    /// @param _mdogMusebookPoolKey MDOG/musebook pool key (currencies: MDOG, musebook).
    ///        Verified 2026-09-20: fee 3000, tickSpacing 60, no hooks,
    ///        pool id 0x7edc541fce494a314d0eb46410581208b1ca24d8e8e20bd3b7d666e1258fa1b0.
    constructor(
        address payable _mikeyBankr,
        address payable _rewardsVault,
        address _initialOwner,
        uint256 _initialThreshold,
        address _poolManager,
        address _positionManager,
        address _metaToken,
        address _mdogToken,
        address _musebookToken,
        PoolKey memory _metaEthPoolKey,
        PoolKey memory _metaMdogPoolKey,
        PoolKey memory _metaMusebookPoolKey,
        PoolKey memory _mdogEthPoolKey,
        PoolKey memory _mdogMusebookPoolKey
    ) Ownable(_initialOwner) {
        if (_mikeyBankr == address(0)) revert ZeroAddress();
        if (_rewardsVault == address(0)) revert ZeroAddress();
        if (_initialOwner == address(0)) revert ZeroAddress();
        if (_poolManager == address(0) || _positionManager == address(0)) revert ZeroAddress();
        if (_initialThreshold == 0) revert ZeroThreshold();
        if (_metaToken == address(0) || _mdogToken == address(0) || _musebookToken == address(0)) {
            revert ZeroAddress();
        }
        if (_metaToken == _mdogToken || _metaToken == _musebookToken || _mdogToken == _musebookToken) {
            revert ZeroAddress();
        }
        // The Uniswap addresses pinned by this contract are verified ONLY for
        // Robinhood Chain. Refuse to deploy anywhere else.
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChainId(ROBINHOOD_CHAIN_ID, block.chainid);
        if (_rewardsVault.code.length == 0) revert NotAContract(_rewardsVault);
        if (_poolManager.code.length == 0) revert NotAContract(_poolManager);
        if (_positionManager.code.length == 0) revert NotAContract(_positionManager);
        if (_metaToken.code.length == 0) revert NotAContract(_metaToken);
        if (_mdogToken.code.length == 0) revert NotAContract(_mdogToken);
        if (_musebookToken.code.length == 0) revert NotAContract(_musebookToken);

        // Pin each pool key to its exact expected currency pair so a
        // misconfigured key can never silently trade the wrong pair.
        _validatePoolKey(_metaEthPoolKey, address(0), _metaToken);
        _validatePoolKey(_metaMdogPoolKey, _mdogToken, _metaToken);
        _validatePoolKey(_metaMusebookPoolKey, _musebookToken, _metaToken);
        _validatePoolKey(_mdogEthPoolKey, address(0), _mdogToken);
        _validatePoolKey(_mdogMusebookPoolKey, _mdogToken, _musebookToken);

        mikeyBankr = _mikeyBankr;
        rewardsVault = _rewardsVault;
        processThreshold = _initialThreshold;
        poolManager = IPoolManager(_poolManager);
        positionManager = IPositionManager(_positionManager);
        metaToken = _metaToken;
        mdogToken = _mdogToken;
        musebookToken = _musebookToken;
        metaEthPoolKey = _metaEthPoolKey;
        metaMdogPoolKey = _metaMdogPoolKey;
        metaMusebookPoolKey = _metaMusebookPoolKey;
        mdogEthPoolKey = _mdogEthPoolKey;
        mdogMusebookPoolKey = _mdogMusebookPoolKey;
    }

    /// @notice Returns the configured ETH/META pool key.
    function getMetaEthPoolKey() external view returns (PoolKey memory) {
        return metaEthPoolKey;
    }

    /// @notice Returns the configured MDOG/META pool key.
    function getMetaMdogPoolKey() external view returns (PoolKey memory) {
        return metaMdogPoolKey;
    }

    /// @notice Returns the configured musebook/META pool key.
    function getMetaMusebookPoolKey() external view returns (PoolKey memory) {
        return metaMusebookPoolKey;
    }

    /// @notice Returns the configured MDOG/ETH pool key.
    function getMdogEthPoolKey() external view returns (PoolKey memory) {
        return mdogEthPoolKey;
    }

    /// @notice Returns the configured MDOG/musebook pool key.
    function getMdogMusebookPoolKey() external view returns (PoolKey memory) {
        return mdogMusebookPoolKey;
    }

    /// @notice Clearly-marked default MDOG/ETH pool key from the working
    ///         scripts (fee 3000, tickSpacing 60, no hooks). The deployer may
    ///         pass different verified values to the constructor instead.
    function defaultMdogEthPoolKey() external view returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: mdogToken, fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    /// @notice Clearly-marked default MDOG/musebook pool key from the verified
    ///         live pool (fee 3000, tickSpacing 60, no hooks, pool id
    ///         0x7edc541fce494a314d0eb46410581208b1ca24d8e8e20bd3b7d666e1258fa1b0).
    ///         The deployer may pass different verified values to the
    ///         constructor instead.
    function defaultMdogMusebookPoolKey() external view returns (PoolKey memory) {
        return PoolKey({currency0: mdogToken, currency1: musebookToken, fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    function _validatePoolKey(PoolKey memory key, address expected0, address expected1) internal pure {
        if (key.currency0 != expected0 || key.currency1 != expected1) revert InvalidPoolKey();
        if (key.currency0 >= key.currency1) revert InvalidPoolKey();
        // The verified MDOG/META Pons pool uses fee=0: the Pons hook takes its
        // ~2% (creator tax + hook fee) via afterSwap, not via the pool's fee
        // parameter. A zero fee is only acceptable when a hook is present to
        // account for it; unhooked pools must have a non-zero fee.
        if (key.fee == 0 && key.hooks == address(0)) revert InvalidPoolKey();
        if (key.tickSpacing <= 0) revert InvalidPoolKey();
    }

    /// @notice Royalty payments arrive here as plain ETH transfers.
    receive() external payable {
        emit RoyaltyReceived(msg.sender, msg.value);
    }

    // -----------------------------------------------------------------------
    // Permissionless processing
    // -----------------------------------------------------------------------

    /// @notice Split newly arrived royalties and settle the autonomous Uniswap legs.
    /// @dev Anyone can call once `newFunds >= processThreshold`. The split legs for
    ///      Mikey and the vault are pushed immediately (fail-open into pending
    ///      buckets, as before). The two LP legs are then executed against
    ///      Uniswap in a fail-SAFE way: a leg that cannot complete is
    ///      skipped, its ETH stays escrowed, and the rest of process() is unaffected.
    function process() external nonReentrant {
        // A DEX leg is mid-flight (its bucket is zeroed, so its in-flight
        // funds would look "unaccounted" to this computation). Refuse rather
        // than double-count.
        if (_inDexLeg) revert DexLegReentrant();

        uint256 balance = address(this).balance;
        uint256 accounted = totalPending();
        // Invariant: balance >= accounted always holds, because every wei that
        // leaves does so through a bucket decrement of at least the same size.
        uint256 newFunds = balance - accounted;
        if (newFunds < processThreshold) {
            revert BelowThreshold(processThreshold, newFunds);
        }

        uint256 mikeyShare = (newFunds * MIKEY_BPS) / TOTAL_BPS;
        uint256 rewardsShare = (newFunds * REWARDS_BPS) / TOTAL_BPS;
        uint256 musebookLpShare = (newFunds * MUSEBOOK_LP_BPS) / TOTAL_BPS;
        // Remainder math: dust from the three floored divisions lands in the
        // MDOG/ETH liquidity leg, so the four legs sum to EXACTLY newFunds and
        // no wei can ever be stranded outside the buckets.
        uint256 liquidityShare = newFunds - mikeyShare - rewardsShare - musebookLpShare;

        // ---- effects ----
        mikeyPending += mikeyShare;
        rewardsPending += rewardsShare;
        musebookLiquidityPending += musebookLpShare;
        liquidityPending += liquidityShare;

        // ---- interactions: push the two direct legs, failing OPEN ----
        // Skips (and does not emit for) legs with a zero pending balance, so
        // no zero-amount Paid events are ever emitted.
        bool mikeyPushed = mikeyPending > 0 ? _tryPush(mikeyBankr, mikeyPending) : true;
        if (mikeyPending > 0 && mikeyPushed) {
            emit MikeyPaid(mikeyPending);
            mikeyPending = 0;
        }
        bool rewardsPushed = rewardsPending > 0 ? _tryPush(rewardsVault, rewardsPending) : true;
        if (rewardsPending > 0 && rewardsPushed) {
            emit RewardsPaid(rewardsPending);
            rewardsPending = 0;
        }

        emit Processed(newFunds, mikeyShare, rewardsShare, musebookLpShare, liquidityShare, mikeyPushed, rewardsPushed);

        // ---- autonomous Uniswap legs (fail-safe: a failed leg never reverts process()) ----
        _settleDexLegs();
    }

    /// @notice Total ETH currently earmarked in pending buckets.
    function totalPending() public view returns (uint256) {
        return mikeyPending + rewardsPending + musebookLiquidityPending + liquidityPending;
    }

    /// @notice Settle both DEX legs, skipping (not reverting) any leg that fails.
    function _settleDexLegs() internal {
        if (musebookLiquidityPending > 0) {
            try this.executeMusebookLiquidity() {}
            catch {
                emit DexLegSkipped("musebook-liquidity");
            }
        }
        if (liquidityPending > 0) {
            try this.executeLiquidity() {}
            catch {
                emit DexLegSkipped("liquidity");
            }
        }
    }

    // -----------------------------------------------------------------------
    // Autonomous Uniswap legs
    // -----------------------------------------------------------------------

    /// @notice Pair the escrowed MDOG/musebook-LP ETH with freshly swapped
    ///         MDOG and musebook (both via META) and mint a full-range
    ///         MDOG/musebook v4 position DIRECTLY to the dead address (locked
    ///         forever).
    /// @dev Public so any keeper can retry it standalone. Reentrancy safety:
    ///      the bucket is zeroed before any external call AND _inDexLeg is
    ///      held for the whole body, so a malicious token callback can
    ///      neither re-enter the leg (flag) nor open a reentrant process()
    ///      against the zeroed bucket (process() checks the flag too). A
    ///      revert anywhere below rolls the bucket zeroing back automatically,
    ///      so the ETH is restored to escrow with no manual bookkeeping.
    ///      Pre-existing MDOG/musebook dust on the splitter is swept into the
    ///      mint (it can only have come from an earlier leg's rounding).
    /// @return mdogUsed MDOG pulled by the PositionManager for the mint.
    /// @return musebookUsed musebook pulled by the PositionManager for the mint.
    function executeMusebookLiquidity() public returns (uint256 mdogUsed, uint256 musebookUsed) {
        if (_inDexLeg) revert DexLegReentrant();
        _inDexLeg = true;
        (mdogUsed, musebookUsed) = _executeMusebookLiquidity();
        _inDexLeg = false;
    }

    function _executeMusebookLiquidity() internal returns (uint256 mdogUsed, uint256 musebookUsed) {
        uint256 ethIn = musebookLiquidityPending;
        if (ethIn == 0) revert NothingPending();
        // Effects first; any revert below restores this automatically.
        musebookLiquidityPending = 0;

        // The MDOG/musebook pool must exist; otherwise the mint would revert
        // deep inside the periphery with no clear reason.
        (uint160 sqrtP,,,) = _slot0(mdogMusebookPoolKey);
        if (sqrtP == 0) revert PoolNotInitialized(_poolId(mdogMusebookPoolKey));

        // Split the leg: half is routed to MDOG, half to musebook. The 1-wei
        // remainder (if ethIn is odd) rides with the musebook half.
        uint256 half = ethIn / 2;
        uint256 other = ethIn - half;
        if (half > 0) {
            _swapEthForTokenViaMeta(half, metaMdogPoolKey, mdogToken);
        }
        if (other > 0) {
            _swapEthForTokenViaMeta(other, metaMusebookPoolKey, musebookToken);
        }

        uint256 mdogBal = IERC20(mdogToken).balanceOf(address(this));
        uint256 musebookBal = IERC20(musebookToken).balanceOf(address(this));

        // Full-range ticks aligned to the pool's tick spacing so the mint can
        // never revert on an invalid tick.
        int24 ts = mdogMusebookPoolKey.tickSpacing;
        int24 tickLower = (MIN_TICK / ts) * ts;
        int24 tickUpper = (MAX_TICK / ts) * ts;
        uint160 sqrtA = _getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = _getSqrtRatioAtTick(tickUpper);

        // v4-core LiquidityAmounts.getLiquidityForAmounts: in-range, amount0
        // only covers [current price, upper tick] and amount1 only covers
        // [lower tick, current price]. currency0 here is MDOG, currency1 is
        // musebook.
        uint256 liquidity = _getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, mdogBal, musebookBal);
        if (liquidity == 0 || liquidity > type(uint128).max) revert ZeroLiquidity();

        // Exact amounts the mint will consume, rounding UP to match v4-core's
        // SqrtPriceMath (roundUp = true), so the amountMax caps below never
        // bind incorrectly.
        (uint256 amount0, uint256 amount1) = _getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
        // Never consume more than is actually held (1-wei rounding edge
        // included). If the pool truly needs a wei more, the mint reverts and
        // the leg is skipped (fail-safe, funds stay escrowed).
        mdogUsed = amount0 > mdogBal ? mdogBal : amount0;
        musebookUsed = amount1 > musebookBal ? musebookBal : amount1;

        bool mdogApproved = _approveErc20ForMint(mdogToken, mdogUsed);
        bool musebookApproved = _approveErc20ForMint(musebookToken, musebookUsed);

        // Both sides are ERC20s: no native value is sent with this mint.
        positionManager.modifyLiquidities(
            _mintErc20Calldata(mdogMusebookPoolKey, tickLower, tickUpper, liquidity, mdogUsed, musebookUsed),
            block.timestamp
        );

        _revokeErc20ForMint(mdogToken, mdogApproved);
        _revokeErc20ForMint(musebookToken, musebookApproved);

        emit MusebookLiquidityExecuted(ethIn, mdogUsed, musebookUsed, tickLower, tickUpper);
    }

    /// @notice Pair the escrowed MDOG/ETH-LP ETH with MDOG (via META) and mint a
    ///         full-range MDOG/native-ETH v4 position DIRECTLY to the dead
    ///         address (locked forever).
    /// @dev Same reentrancy design as {executeMusebookLiquidity}: the bucket is
    ///      zeroed and _inDexLeg is held before any external call. Half the leg
    ///      stays native ETH, half is swapped to MDOG (guarded multihop), then the
    ///      position is minted from the leg's own funds only — the leg can
    ///      never consume the other bucket's escrowed ETH. Leftover native
    ///      dust stays native so the next process() sweeps it as new royalty
    ///      funds; MDOG dust stays for the next DEX leg.
    /// @return ethUsed Native ETH consumed by the mint (sent as exact msg.value).
    /// @return mdogUsed MDOG pulled by the PositionManager for the mint.
    function executeLiquidity() public returns (uint256 ethUsed, uint256 mdogUsed) {
        if (_inDexLeg) revert DexLegReentrant();
        _inDexLeg = true;
        (ethUsed, mdogUsed) = _executeLiquidity();
        _inDexLeg = false;
    }

    function _executeLiquidity() internal returns (uint256 ethUsed, uint256 mdogUsed) {
        uint256 ethIn = liquidityPending;
        if (ethIn == 0) revert NothingPending();
        // Effects first; any revert below restores this automatically.
        liquidityPending = 0;

        // The MDOG/ETH pool must exist; otherwise the mint would revert deep
        // inside the periphery with no clear reason.
        (uint160 mdogEthSqrtP,,,) = _slot0(mdogEthPoolKey);
        if (mdogEthSqrtP == 0) revert PoolNotInitialized(_poolId(mdogEthPoolKey));

        // Split the leg: half stays native ETH, half is swapped to MDOG.
        uint256 half = ethIn / 2;
        if (half > 0) {
            _swapEthForTokenViaMeta(half, metaMdogPoolKey, mdogToken);
        }
        // The leg's exact native-ETH entitlement from here on. The mint below
        // is capped at this, so it can never eat the other bucket's escrow.
        uint256 legEth = ethIn - half;

        (ethUsed, mdogUsed) = _mintFullRangeLiquidity(ethIn, legEth, mdogEthSqrtP);
    }

    /// @dev Full-range MDOG/ETH mint for the liquidity leg, split out of
    ///      _executeLiquidity to keep the stack shallow.
    /// @param sqrtP The pool's current sqrt price (X96), read from slot0.
    function _mintFullRangeLiquidity(uint256 ethIn, uint256 legEth, uint160 sqrtP)
        internal
        returns (uint256 ethUsed, uint256 mdogUsed)
    {
        // Full-range ticks aligned to the pool's tick spacing so the mint can
        // never revert on an invalid tick.
        int24 ts = mdogEthPoolKey.tickSpacing;
        int24 tickLower = (MIN_TICK / ts) * ts;
        int24 tickUpper = (MAX_TICK / ts) * ts;
        uint160 sqrtA = _getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = _getSqrtRatioAtTick(tickUpper);

        uint256 mdogBal = IERC20(mdogToken).balanceOf(address(this));

        // v4-core LiquidityAmounts.getLiquidityForAmounts: in-range, amount0
        // only covers [current price, upper tick] and amount1 only covers
        // [lower tick, current price]. Using the full range for both would
        // understate liquidity to ~zero (the range is astronomically wide).
        uint256 liquidity = _getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, legEth, mdogBal);
        if (liquidity == 0 || liquidity > type(uint128).max) revert ZeroLiquidity();

        // Exact amounts the mint will consume, rounding UP to match v4-core's
        // SqrtPriceMath (roundUp = true), so the amountMax caps below never
        // bind incorrectly.
        (ethUsed, mdogUsed) = _getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
        // Never consume more than this leg's entitlement (1-wei rounding edge
        // included). If the pool truly needs a wei more, the mint reverts and
        // the leg is skipped (fail-safe, funds stay escrowed).
        if (ethUsed > legEth) ethUsed = legEth;
        if (mdogUsed > mdogBal) mdogUsed = mdogBal;

        bool mdogApproved = _approveErc20ForMint(mdogToken, mdogUsed);

        // Exact msg.value: the PositionManager does not refund excess native
        // currency, so overpaying would strand ETH in the periphery.
        positionManager.modifyLiquidities{value: ethUsed}(
            _mintCalldata(tickLower, tickUpper, liquidity, ethUsed, mdogUsed), block.timestamp
        );

        _revokeErc20ForMint(mdogToken, mdogApproved);

        emit LiquidityExecuted(ethIn, ethUsed, mdogUsed, tickLower, tickUpper);
    }

    /// @dev Approve an ERC20 for the mint through Permit2: token -> Permit2,
    ///      then Permit2 -> PositionManager as spender.
    /// @dev The PositionManager pulls ERC20s through Permit2 (verified on the
    ///      fork: a direct token approval to the PositionManager fails with
    ///      AllowanceExpired).
    /// @dev Some tokens (e.g. musebook) hardcode an infinite token-level
    ///      approval to Permit2 and REVERT any finite approve() to it — so the
    ///      token-level approve is skipped whenever the existing allowance
    ///      already covers the amount. Returns whether the token-level
    ///      approval was (re)set, so the revoke step knows whether a
    ///      zero-approve is safe.
    /// @return tokenApproved True if the token-level approval was set by this call.
    function _approveErc20ForMint(address token, uint256 amount) internal returns (bool tokenApproved) {
        address permit2 = positionManager.permit2();
        if (IERC20(token).allowance(address(this), permit2) < amount) {
            IERC20(token).forceApprove(permit2, amount);
            tokenApproved = true;
        }
        IPermit2(permit2).approve(token, address(positionManager), uint160(amount), uint48(block.timestamp + 1 days));
    }

    /// @dev Revoke the mint's ERC20 approvals. Split out to keep the stack shallow.
    /// @dev The token-level zero-approve only runs when _approveErc20ForMint
    ///      actually set an approval — some tokens revert finite approve()
    ///      calls to Permit2. The Permit2-level revoke always runs.
    /// @param tokenApproved Return value of _approveErc20ForMint: whether the
    ///      token-level approval was set and therefore needs zeroing.
    function _revokeErc20ForMint(address token, bool tokenApproved) internal {
        address permit2 = positionManager.permit2();
        if (tokenApproved) {
            IERC20(token).forceApprove(permit2, 0);
        }
        IPermit2(permit2).approve(token, address(positionManager), 0, 0);
    }

    /// @dev Mirrors v4-core LiquidityAmounts.getLiquidityForAmounts
    ///      (rounds down). `amount0` is currency0 of the pool,
    ///      `amount1` is currency1.
    function _getLiquidityForAmounts(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint256 liquidity)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) {
            liquidity = _getLiquidityForAmount0(sqrtA, sqrtB, amount0);
        } else if (sqrtP < sqrtB) {
            uint256 l0 = _getLiquidityForAmount0(sqrtP, sqrtB, amount0);
            uint256 l1 = _getLiquidityForAmount1(sqrtA, sqrtP, amount1);
            liquidity = l0 < l1 ? l0 : l1;
        } else {
            liquidity = _getLiquidityForAmount1(sqrtA, sqrtB, amount1);
        }
    }

    /// @dev Mirrors the amount side of v4-core's liquidity math (rounds up,
    ///      matching SqrtPriceMath.getAmount0Delta/getAmount1Delta with
    ///      roundUp = true).
    function _getAmountsForLiquidity(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) {
            amount0 = _getAmount0ForLiquidity(sqrtA, sqrtB, liquidity);
        } else if (sqrtP < sqrtB) {
            amount0 = _getAmount0ForLiquidity(sqrtP, sqrtB, liquidity);
            amount1 = _getAmount1ForLiquidity(sqrtA, sqrtP, liquidity);
        } else {
            amount1 = _getAmount1ForLiquidity(sqrtA, sqrtB, liquidity);
        }
    }

    /// @dev Encodes the PositionManager.unlockData for the full-range
    ///      MDOG/ETH mint: actions = [MINT_POSITION, SETTLE_PAIR, SWEEP].
    ///      Split out to keep the stack shallow.
    /// @dev Robinhood's PositionManager uses PACKED BYTES for actions (not
    ///      uint256[]), verified by reconstructing real mint tx 0x703a79a3:
    ///      MINT_POSITION=2, SETTLE_PAIR=13 (0x0d), SWEEP=20 (0x14).
    ///      The SWEEP sends any leftover native ETH back to the splitter
    ///      (which sweeps it as new funds next process()).
    function _mintCalldata(int24 tickLower, int24 tickUpper, uint256 liquidity, uint256 ethUsed, uint256 mdogUsed)
        internal
        view
        returns (bytes memory)
    {
        bytes memory actions = hex"020d14";
        bytes[] memory params = new bytes[](3);
        params[0] =
            abi.encode(mdogEthPoolKey, tickLower, tickUpper, uint128(liquidity), ethUsed, mdogUsed, DEAD, bytes(""));
        params[1] = abi.encode(mdogEthPoolKey.currency0, mdogEthPoolKey.currency1);
        params[2] = abi.encode(address(0), address(this)); // sweep leftover ETH to splitter
        return abi.encode(actions, params);
    }

    /// @dev Encodes the PositionManager.unlockData for the full-range
    ///      MDOG/musebook mint (two ERC20s, no native value):
    ///      actions = [MINT_POSITION, SETTLE_PAIR]. Both currencies settle
    ///      through Permit2, which the splitter approved just before the call.
    function _mintErc20Calldata(
        PoolKey memory key,
        int24 tickLower,
        int24 tickUpper,
        uint256 liquidity,
        uint256 amount0Max,
        uint256 amount1Max
    ) internal view returns (bytes memory) {
        bytes memory actions = hex"020d";
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(key, tickLower, tickUpper, uint128(liquidity), amount0Max, amount1Max, DEAD, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        return abi.encode(actions, params);
    }

    // -----------------------------------------------------------------------
    // v4 routing (the splitter is its own router via unlock)
    // -----------------------------------------------------------------------

    /// @notice Two-hop exact-input swap: native ETH -> META -> outToken.
    /// @dev Reads both pools' spot prices, derives per-hop guards, then runs
    ///      the hops atomically inside poolManager.unlock(). Either hop
    ///      reverting reverts the whole call (bucket restored by the caller).
    /// @param hop2Key The META/outToken pool key (META must be one of its
    ///        currencies; the swap direction is derived from the key layout).
    /// @param outToken The token bought in hop 2 (MDOG or musebook).
    function _swapEthForTokenViaMeta(uint256 ethIn, PoolKey memory hop2Key, address outToken)
        internal
        returns (uint256 tokenOut)
    {
        (uint256 minOut1, uint160 limit1) = _hop1Guard(ethIn);
        (uint256 minOut2, uint160 limit2) = _hop2Guard(hop2Key, minOut1);
        bytes memory result = poolManager.unlock(
            abi.encode(ethIn, minOut1, minOut2, limit1, limit2, hop2Key, outToken)
        );
        tokenOut = abi.decode(result, (uint256));
    }

    /// @dev Hop 1 guard: ETH -> META (currency0 -> currency1). Split out so
    ///      the caller's stack stays shallow at the unlock-result decode.
    function _hop1Guard(uint256 ethIn) internal view returns (uint256 minOut1, uint160 limit1) {
        (uint160 sqrtP1,,,) = _slot0(metaEthPoolKey);
        if (sqrtP1 == 0) revert PoolNotInitialized(_poolId(metaEthPoolKey));
        uint256 price1X96 = Math.mulDiv(sqrtP1, sqrtP1, Q96); // META per ETH, Q96
        uint256 quote1 = Math.mulDiv(ethIn, price1X96, Q96);
        minOut1 = (quote1 * (SLIPPAGE_BPS - maxSlippageBps)) / SLIPPAGE_BPS;
        limit1 = _sqrtPriceLimit(price1X96, false); // price may only fall
    }

    /// @dev Hop 2 guard: META -> outToken, chained off hop 1's worst case so
    ///      the combined tolerance stays bounded. The direction is derived
    ///      from the key layout: META as currency0 means zeroForOne, as
    ///      currency1 means oneForZero. (Constructor pinning guarantees META
    ///      is one of the two.)
    function _hop2Guard(PoolKey memory hop2Key, uint256 minOut1)
        internal
        view
        returns (uint256 minOut2, uint160 limit2)
    {
        (uint160 sqrtP2,,,) = _slot0(hop2Key);
        if (sqrtP2 == 0) revert PoolNotInitialized(_poolId(hop2Key));
        bool hop2ZeroForOne = hop2Key.currency0 == metaToken;
        uint256 price2X96 = Math.mulDiv(sqrtP2, sqrtP2, Q96); // token1 per token0, Q96
        uint256 quote2 = hop2ZeroForOne
            ? Math.mulDiv(minOut1, price2X96, Q96) // META(token0) -> token1
            : Math.mulDiv(minOut1, Q96, price2X96); // META(token1) -> token0
        minOut2 = (quote2 * (SLIPPAGE_BPS - maxSlippageBps)) / SLIPPAGE_BPS;
        limit2 = _sqrtPriceLimit(price2X96, !hop2ZeroForOne); // price may only rise on oneForZero
    }

    /// @notice PoolManager.unlock callback. Only the PoolManager can invoke
    ///         this, and only during OUR unlock (an attacker calling unlock()
    ///         themselves reaches their own callback, not this one).
    /// @dev Split into hop helpers to keep each function's stack shallow.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager(msg.sender);
        (
            uint256 ethIn,
            uint256 minOut1,
            uint256 minOut2,
            uint160 limit1,
            uint160 limit2,
            PoolKey memory hop2Key,
            address outToken
        ) = abi.decode(data, (uint256, uint256, uint256, uint160, uint160, PoolKey, address));

        uint256 metaOut = _unlockHop1(ethIn, minOut1, limit1);
        uint256 tokenOut = _unlockHop2(metaOut, minOut2, limit2, hop2Key, outToken);
        return abi.encode(tokenOut);
    }

    /// @dev Hop 1: native ETH -> META (currency0 -> currency1), exact input.
    ///      amountSpecified is NEGATIVE for exact input (canonical v4 sign).
    function _unlockHop1(uint256 ethIn, uint256 minOut1, uint160 limit1) internal returns (uint256 metaOut) {
        BalanceDelta d1 = poolManager.swap(
            metaEthPoolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: limit1}),
            ""
        );
        int128 d1a0 = d1.amount0();
        int128 d1a1 = d1.amount1();
        if (d1a0 >= 0 || d1a1 <= 0) revert InvalidSwapDelta();
        uint256 ethConsumed = uint256(int256(-d1a0));
        if (ethConsumed != ethIn) revert SwapPartialFill(ethConsumed, ethIn);
        metaOut = uint256(int256(d1a1));
        if (metaOut < minOut1) revert SlippageExceeded(metaOut, minOut1);
        poolManager.settle{value: ethIn}();
        poolManager.take(metaToken, address(this), metaOut);
    }

    /// @dev Hop 2: META -> outToken, exact input. The direction follows the
    ///      key layout (see _swapEthForTokenViaMeta). The Pons hook takes ~2%
    ///      total (1% creator tax + 1% hook fee) on the unspecified leg via
    ///      afterSwap; exact-input still works and leaves no META dust when the
    ///      full metaOut is specified.
    function _unlockHop2(
        uint256 metaOut,
        uint256 minOut2,
        uint160 limit2,
        PoolKey memory hop2Key,
        address outToken
    ) internal returns (uint256 tokenOut) {
        bool zeroForOne = hop2Key.currency0 == metaToken;
        BalanceDelta d2 = poolManager.swap(
            hop2Key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(metaOut), sqrtPriceLimitX96: limit2}), ""
        );
        int128 d2a0 = d2.amount0();
        int128 d2a1 = d2.amount1();
        uint256 metaConsumed;
        if (zeroForOne) {
            // META is currency0: amount0 = -META in, amount1 = +token out.
            if (d2a0 >= 0 || d2a1 <= 0) revert InvalidSwapDelta();
            metaConsumed = uint256(int256(-d2a0));
            tokenOut = uint256(int256(d2a1));
        } else {
            // META is currency1: amount1 = -META in, amount0 = +token out.
            if (d2a1 >= 0 || d2a0 <= 0) revert InvalidSwapDelta();
            metaConsumed = uint256(int256(-d2a1));
            tokenOut = uint256(int256(d2a0));
        }
        if (metaConsumed != metaOut) revert SwapPartialFill(metaConsumed, metaOut);
        if (tokenOut < minOut2) revert SlippageExceeded(tokenOut, minOut2);
        // Pay the exact META owed: sync, transfer, then the no-args settle().
        // NOTE: settle(address) does NOT exist on this chain's PoolManager.
        poolManager.sync(metaToken);
        IERC20(metaToken).safeTransfer(address(poolManager), metaOut);
        poolManager.settle();
        poolManager.take(outToken, address(this), tokenOut);
    }

    /// @notice sqrtPriceLimitX96 for a hop: spot price moved by the slippage
    ///         tolerance, against the direction the swap pushes the price.
    /// @param priceX96 Spot price (token1 per token0), Q96.
    /// @param upper True when the swap pushes the price UP (oneForZero).
    function _sqrtPriceLimit(uint256 priceX96, bool upper) internal view returns (uint160) {
        uint256 limited = upper
            ? (priceX96 * (SLIPPAGE_BPS + maxSlippageBps)) / SLIPPAGE_BPS
            : (priceX96 * (SLIPPAGE_BPS - maxSlippageBps)) / SLIPPAGE_BPS;
        uint256 limit = Math.sqrt(Math.mulDiv(limited, Q96, 1));
        if (limit == 0 || limit > type(uint160).max) revert PriceLimitOverflow();
        return uint160(limit);
    }

    function _poolId(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice Read a pool's slot0 via extsload. `getSlot0(bytes32)` does not
    ///         exist on this chain's PoolManager; the pools mapping lives at
    ///         storage slot 6 and slot0 packs (sqrtPriceX96 | tick | protocolFee | lpFee).
    function _slot0(PoolKey memory key)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        bytes32 loc = keccak256(abi.encode(_poolId(key), POOLS_SLOT));
        uint256 w = uint256(poolManager.extsload(loc));
        sqrtPriceX96 = uint160(w);
        uint256 tickU = (w >> 160) & 0xFFFFFF;
        tick = tickU >= (uint256(1) << 23)
            ? int24(int256(tickU) - int256(uint256(1) << 24))
            : int24(int256(tickU));
        protocolFee = uint24((w >> 184) & 0xFFFFFF);
        lpFee = uint24((w >> 208) & 0xFFFFFF);
    }

    // -----------------------------------------------------------------------
    // Liquidity math (canonical Uniswap formulas; rounding matches v4-core)
    // -----------------------------------------------------------------------

    /// @notice Liquidity obtainable from amount0 over [sqrtA, sqrtB], rounded down.
    function _getLiquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) internal pure returns (uint256) {
        return Math.mulDiv(amount0, Math.mulDiv(sqrtA, sqrtB, Q96), sqrtB - sqrtA);
    }

    /// @notice Liquidity obtainable from amount1 over [sqrtA, sqrtB], rounded down.
    function _getLiquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) internal pure returns (uint256) {
        return Math.mulDiv(amount1, Q96, sqrtB - sqrtA);
    }

    /// @notice amount0 required for `liquidity` over [sqrtA, sqrtB], rounding
    ///         UP (matches v4-core SqrtPriceMath.getAmount0Delta roundUp=true).
    function _getAmount0ForLiquidity(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256) {
        uint256 intermediate = Math.mulDiv(liquidity << 96, sqrtB - sqrtA, sqrtB, Math.Rounding.Ceil);
        return Math.ceilDiv(intermediate, sqrtA);
    }

    /// @notice amount1 required for `liquidity` over [sqrtA, sqrtB], rounding
    ///         UP (matches v4-core SqrtPriceMath.getAmount1Delta roundUp=true).
    function _getAmount1ForLiquidity(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256) {
        return Math.mulDiv(liquidity, sqrtB - sqrtA, Q96, Math.Rounding.Ceil);
    }

    // -----------------------------------------------------------------------
    // Tick math (clean-room implementation, vector-pinned)
    // -----------------------------------------------------------------------
    // Uniswap prices follow price(tick) = 1.0001^tick, stored on-chain as
    // sqrtPriceX96 = sqrt(price) * 2^96. Computing sqrt(1.0001^tick) * 2^96 is
    // done here by binary expansion over the bits of |tick|. Each constant
    // below is the pure mathematical value floor(2^128 / sqrt(1.0001^(2^i)))
    // — a fixed-point encoding of a power of the tick base, derivable by hand
    // from the definition of the price curve (mathematical facts, like digits
    // of pi, not copied code).
    // Correctness is pinned by canonical vectors asserted in
    // test_TickMathVectors: tick 0 -> 2^96, MIN_TICK -> 4295128739,
    // MAX_TICK -> 1461446703485210103287273052203988822378723970342.

    /// @dev Returns sqrt(1.0001^tick) * 2^96.
    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        if (absTick > uint256(uint24(MAX_TICK))) revert TickOutOfRange(tick);

        // Binary expansion of 1/sqrt(1.0001^|tick|) in Q128.128.
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) {
            // Invert: sqrt(1.0001^tick) = 1 / (1/sqrt(1.0001^tick)).
            ratio = type(uint256).max / ratio;
        }
        // Q128.128 -> Q96, rounding up like the pools themselves do.
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    // -----------------------------------------------------------------------
    // Owner configuration
    // -----------------------------------------------------------------------

    /// @notice Retune how much new royalty value process() requires.
    function setProcessThreshold(uint256 _threshold) external onlyOwner {
        if (_threshold == 0) revert ZeroThreshold();
        uint256 old = processThreshold;
        processThreshold = _threshold;
        emit ThresholdUpdated(old, _threshold);
    }

    /// @notice Change the max slippage per multihop hop (0 .. 20%).
    function setMaxSlippageBps(uint256 _bps) external onlyOwner {
        if (_bps > MAX_SLIPPAGE_BPS) revert SlippageBpsTooHigh(_bps);
        uint256 old = maxSlippageBps;
        maxSlippageBps = _bps;
        emit MaxSlippageBpsUpdated(old, _bps);
    }

    // -----------------------------------------------------------------------
    // Push legs + permissionless retries + manual emergency hatches
    // -----------------------------------------------------------------------

    /// @notice Retry a failed Mikey push. Permissionless; funds can only ever
    ///         go to the immutable mikeyBankr address.
    function claimMikey() external nonReentrant {
        uint256 amount = mikeyPending;
        if (amount == 0) revert NothingPending();
        mikeyPending = 0; // effects before interaction
        (bool ok,) = mikeyBankr.call{value: amount}("");
        if (!ok) {
            // Restore on failure so the funds are not lost.
            mikeyPending = amount;
            revert TransferFailed();
        }
        emit MikeyPaid(amount);
    }

    /// @notice Retry a failed rewards-vault push. Permissionless; funds can
    ///         only ever go to the immutable rewardsVault address.
    function claimRewards() external nonReentrant {
        uint256 amount = rewardsPending;
        if (amount == 0) revert NothingPending();
        rewardsPending = 0; // effects before interaction
        (bool ok,) = rewardsVault.call{value: amount}("");
        if (!ok) {
            rewardsPending = amount;
            revert TransferFailed();
        }
        emit RewardsPaid(amount);
    }

    /// @dev Low-level push that FAILS OPEN: returns false instead of
    ///      reverting, so one reverting recipient can never block process().
    function _tryPush(address payable to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        (bool ok,) = to.call{value: amount}("");
        return ok;
    }

    /// @notice Emergency/manual path: forward escrowed MDOG/musebook-LP ETH to
    ///         an executor (e.g. a multisig-run swap) instead of the
    ///         autonomous engine.
    /// @dev Reverts (rather than escrowing) on transfer failure so the owner
    ///      can retry with a corrected destination — no funds move on failure.
    function forwardMusebookLiquidity(address payable destination, uint256 amount) external onlyOwner nonReentrant {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingPending();
        if (amount > musebookLiquidityPending) {
            revert InsufficientPending(amount, musebookLiquidityPending);
        }
        musebookLiquidityPending -= amount; // effects before interaction
        (bool ok,) = destination.call{value: amount}("");
        if (!ok) {
            musebookLiquidityPending += amount;
            revert TransferFailed();
        }
        emit MusebookLiquidityForwarded(destination, amount);
    }

    /// @notice Emergency/manual path: forward escrowed MDOG/ETH-LP ETH to an executor.
    /// @dev Same safety shape as forwardMusebookLiquidity.
    function forwardLiquidity(address payable destination, uint256 amount) external onlyOwner nonReentrant {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingPending();
        if (amount > liquidityPending) {
            revert InsufficientPending(amount, liquidityPending);
        }
        liquidityPending -= amount; // effects before interaction
        (bool ok,) = destination.call{value: amount}("");
        if (!ok) {
            liquidityPending += amount;
            revert TransferFailed();
        }
        emit LiquidityForwarded(destination, amount);
    }
}
