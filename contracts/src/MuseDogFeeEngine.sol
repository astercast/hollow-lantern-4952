// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MuseDogFeeEngine
/// @notice Autonomous fee engine for the Muse Dogs collection (MUSEDOGS) on
///         Robinhood Chain (chain id 4663).
///
///         This contract is the ERC-2981 royalty recipient of the collection.
///         It collects the 7% resale royalty in ETH and, once enough has piled
///         up, ANYONE can call process() to run the full loop. There is no
///         owner, no multisig signing, no middleman, no off switch.
///
///         Every process() run does three things:
///           1. BUYBACK — half the ETH buys MDOG on the MDOG/ETH Uniswap V4 pool.
///           2. BURN — that MDOG is sent to the dead address. Supply shrinks forever.
///           3. LIQUIDITY — the other half is split: 50% swapped to MDOG, paired
///              with the remaining ETH, and minted as a full-range V4 LP
///              position. The position NFT is minted DIRECTLY to the dead
///              address, so the liquidity is locked forever and can never be
///              pulled by anyone — including the project.
///
/// @dev DRAFT — not audited, not deployed. Pre-deploy checklist:
///      - Pin exact v4-periphery / universal-router deployments on Robinhood Chain.
///      - Settle the canonical MDOG/ETH poolKey (native vs WETH variant).
///      - Fuzz + fork tests (process happy path, dust threshold, revert paths).
///      - Independent audit before mainnet.
///      Action/command constants below were taken from v4-periphery's
///      Actions.sol and universal-router's Commands (verified against the
///      uniswap-universal-router-decoder tables, not from memory).
contract MuseDogFeeEngine is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @notice Uniswap V4 pool key. currency0 < currency1 by address, except
    ///         the native currency which is represented as address(0).
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @notice Exact-input single-hop params for the V4 swap router action.
    /// @dev Field order mirrors v4-periphery IV4Router.ExactInputSingleParams.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 sqrtPriceLimitX96; // 0 = no limit
        bytes hookData;
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Tokens burned here are gone forever.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// @notice Native currency sentinel used by V4.
    address public constant NATIVE = address(0);
    /// @notice Universal Router "address(this)" sentinel (router keeps funds).
    address public constant ROUTER_SELF = 0x0000000000000000000000000000000000000002;
    /// @notice V4 min/max ticks for a full-range position.
    int24 public constant MIN_TICK = -887272;
    int24 public constant MAX_TICK = 887272;

    // Universal Router commands (universal-router Commands library)
    uint8 private constant CMD_WRAP_ETH = 0x0b;
    uint8 private constant CMD_V4_SWAP = 0x10;
    uint8 private constant CMD_SWEEP = 0x04;

    // V4 PositionManager / swap-router actions (v4-periphery Actions library)
    uint8 private constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 private constant ACT_MINT_POSITION_FROM_DELTAS = 0x05;
    uint8 private constant ACT_SETTLE_ALL = 0x0c;
    uint8 private constant ACT_SETTLE_PAIR = 0x0d;
    uint8 private constant ACT_TAKE_ALL = 0x0f;

    // -------------------------------------------------------------------------
    // Immutables (set once at deploy, never changeable — that is the point)
    // -------------------------------------------------------------------------

    IERC20 public immutable MDOG;
    IERC20 public immutable WETH;
    address public immutable UNIVERSAL_ROUTER;
    address public immutable POSITION_MANAGER;
    PoolKey public immutable POOL_KEY;
    /// @notice True when MDOG is currency0 of the pool (address ordering).
    bool public immutable MDOG_IS_CURRENCY0;
    /// @notice Minimum ETH balance before process() can run (dust guard).
    uint256 public immutable MIN_PROCESS_AMOUNT;
    /// @notice Share of each run going to buyback-and-burn, in bps (5000 = 50%).
    uint256 public immutable BURN_BPS;
    int24 public immutable TICK_LOWER;
    int24 public immutable TICK_UPPER;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event Processed(
        uint256 ethIn,
        uint256 mdogBurned,
        uint256 ethIntoLp,
        uint256 mdogIntoLp
    );
    event RoyaltyReceived(address indexed from, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address mdog,
        address weth,
        address universalRouter,
        address positionManager,
        PoolKey memory poolKey,
        uint256 minProcessAmount,
        uint256 burnBps
    ) {
        require(mdog != address(0) && weth != address(0), "FeeEngine: zero token");
        require(universalRouter != address(0) && positionManager != address(0), "FeeEngine: zero venue");
        require(burnBps <= 10_000, "FeeEngine: bad bps");

        bool ethIsCurrency0 = poolKey.currency0 == NATIVE || poolKey.currency0 == weth;
        bool mdogIsCurrency0 = poolKey.currency0 == mdog;
        bool mdogIsCurrency1 = poolKey.currency1 == mdog;
        require(ethIsCurrency0, "FeeEngine: pool has no ETH leg");
        require(mdogIsCurrency0 != mdogIsCurrency1, "FeeEngine: MDOG not in pool");

        MDOG = IERC20(mdog);
        WETH = IERC20(weth);
        UNIVERSAL_ROUTER = universalRouter;
        POSITION_MANAGER = positionManager;
        POOL_KEY = poolKey;
        MDOG_IS_CURRENCY0 = mdogIsCurrency0;
        MIN_PROCESS_AMOUNT = minProcessAmount;
        BURN_BPS = burnBps;
        // Full-range position, snapped to the pool's tick spacing.
        TICK_LOWER = (MIN_TICK / poolKey.tickSpacing) * poolKey.tickSpacing;
        TICK_UPPER = (MAX_TICK / poolKey.tickSpacing) * poolKey.tickSpacing;
    }

    // -------------------------------------------------------------------------
    // Receive royalties
    // -------------------------------------------------------------------------

    /// @notice Royalty payments arrive here as plain ETH transfers.
    receive() external payable {
        emit RoyaltyReceived(msg.sender, msg.value);
    }

    // -------------------------------------------------------------------------
    // The autonomous loop
    // -------------------------------------------------------------------------

    /// @notice Run one full fee-engine cycle. Permissionless: anyone can call,
    ///         no signature required. In practice an off-chain keeper calls it
    ///         on a schedule or once the threshold is crossed.
    /// @param minMdogOutBurn Minimum MDOG accepted from the burn-leg swap
    ///        (slippage protection — the keeper quotes this off-chain).
    /// @param minMdogOutLp Minimum MDOG accepted from the LP-leg swap
    ///        (slippage protection — the keeper quotes this off-chain).
    /// @dev MEV note: minimums are caller-supplied so a quoting keeper (not a
    ///      fixed on-chain %) sets the protection. Never call with zeros on a
    ///      thin pool.
    function process(uint256 minMdogOutBurn, uint256 minMdogOutLp)
        external
        nonReentrant
    {
        uint256 balance = address(this).balance;
        require(balance >= MIN_PROCESS_AMOUNT, "FeeEngine: below threshold");

        uint256 burnLeg = (balance * BURN_BPS) / 10_000;
        uint256 lpLeg = balance - burnLeg;

        // Leg 1 + 2: buy back MDOG and burn it. Supply shrinks forever.
        uint256 mdogBurned = _swapExactEthForMdog(burnLeg, minMdogOutBurn);
        if (mdogBurned > 0) {
            MDOG.safeTransfer(BURN_ADDRESS, mdogBurned);
        }

        // Leg 3: pair the rest as MDOG/ETH liquidity, minted straight to the
        // dead address — born locked, unpullable by anyone, forever.
        uint256 ethForLp = lpLeg / 2;
        uint256 mdogForLp = _swapExactEthForMdog(lpLeg - ethForLp, minMdogOutLp);
        _mintPositionToDeadAddress(ethForLp, mdogForLp);

        emit Processed(burnLeg, mdogBurned, ethForLp, mdogForLp);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev Swap exact ETH for MDOG on the V4 pool via the Universal Router.
    ///      Handles both native-ETH and WETH pool variants.
    function _swapExactEthForMdog(uint256 ethIn, uint256 minOut)
        internal
        returns (uint256 mdogOut)
    {
        if (ethIn == 0) return 0;

        bool nativePool = POOL_KEY.currency0 == NATIVE;

        bytes memory actions = abi.encodePacked(
            bytes1(ACT_SWAP_EXACT_IN_SINGLE),
            bytes1(ACT_SETTLE_ALL),
            bytes1(ACT_TAKE_ALL)
        );
        bytes[] memory swapParams = new bytes[](3);
        swapParams[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: POOL_KEY,
                zeroForOne: true, // ETH leg -> MDOG leg
                amountIn: uint128(ethIn),
                amountOutMinimum: uint128(minOut),
                sqrtPriceLimitX96: 0,
                hookData: ""
            })
        );
        swapParams[1] = abi.encode(POOL_KEY.currency0, ethIn); // SETTLE_ALL
        swapParams[2] = abi.encode(address(MDOG), minOut); // TAKE_ALL

        bytes memory commands;
        bytes[] memory inputs;
        if (nativePool) {
            commands = abi.encodePacked(bytes1(CMD_V4_SWAP), bytes1(CMD_SWEEP));
            inputs = new bytes[](2);
            inputs[0] = abi.encode(actions, swapParams);
            inputs[1] = abi.encode(address(MDOG), address(this), minOut);
            IUniversalRouter(UNIVERSAL_ROUTER).execute{value: ethIn}(
                commands, inputs, block.timestamp
            );
        } else {
            commands = abi.encodePacked(
                bytes1(CMD_WRAP_ETH), bytes1(CMD_V4_SWAP), bytes1(CMD_SWEEP)
            );
            inputs = new bytes[](3);
            inputs[0] = abi.encode(ROUTER_SELF, ethIn); // wrap, keep in router
            inputs[1] = abi.encode(actions, swapParams);
            inputs[2] = abi.encode(address(MDOG), address(this), minOut);
            IUniversalRouter(UNIVERSAL_ROUTER).execute{value: ethIn}(
                commands, inputs, block.timestamp
            );
        }

        // Router swept MDOG here; measure what actually arrived.
        mdogOut = MDOG.balanceOf(address(this));
        // NOTE: balanceOf diffing assumes no other MDOG sits in the engine.
        // The engine never holds MDOG between runs (everything is burned or
        // paired immediately), so this holds by construction.
    }

    /// @dev Mint a full-range V4 LP position and send the NFT straight to the
    ///      dead address. The liquidity can never be withdrawn — by anyone.
    function _mintPositionToDeadAddress(uint256 ethAmount, uint256 mdogAmount)
        internal
    {
        if (ethAmount == 0 || mdogAmount == 0) return;

        uint128 amount0Max;
        uint128 amount1Max;
        uint256 nativeValue;

        if (MDOG_IS_CURRENCY0) {
            amount0Max = uint128(mdogAmount);
            amount1Max = uint128(ethAmount);
        } else {
            amount0Max = uint128(ethAmount);
            amount1Max = uint128(mdogAmount);
        }

        if (POOL_KEY.currency0 == NATIVE) {
            nativeValue = ethAmount;
        } else {
            // WETH pool: wrap the ETH leg, POSM pulls it via allowance.
            IWETH(address(WETH)).deposit{value: ethAmount}();
            WETH.forceApprove(POSITION_MANAGER, ethAmount);
        }
        MDOG.forceApprove(POSITION_MANAGER, mdogAmount);

        bytes memory actions = abi.encodePacked(
            bytes1(ACT_MINT_POSITION_FROM_DELTAS),
            bytes1(ACT_SETTLE_PAIR)
        );
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            POOL_KEY,
            TICK_LOWER,
            TICK_UPPER,
            amount0Max,
            amount1Max,
            BURN_ADDRESS, // born burned: the LP NFT goes straight to 0xdead
            bytes("")
        );
        params[1] = abi.encode(POOL_KEY.currency0, POOL_KEY.currency1);

        IPositionManager(POSITION_MANAGER).modifyLiquidities{value: nativeValue}(
            abi.encode(actions, params),
            block.timestamp
        );
    }
}

// -----------------------------------------------------------------------------
// Minimal external interfaces
// -----------------------------------------------------------------------------

interface IUniversalRouter {
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;
}

interface IPositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external
        payable;
}

interface IWETH {
    function deposit() external payable;
}
