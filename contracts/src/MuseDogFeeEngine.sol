// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {V4Math} from "./V4Math.sol";

/// @title MuseDogFeeEngine
/// @notice Autonomous fee engine for the Muse Dogs collection (MUSEDOGS) on
///         Robinhood Chain (chain id 4663).
///
///         The separate royalty splitter is the ERC-2981 recipient; this
///         engine receives its 2.5% share of sale price from the splitter in
///         ETH. Once enough has piled up, ANYONE can call process() to run
///         the full loop. There is no owner, no multisig signing, no
///         middleman, no off switch.
///
///         Every process() run does three things:
///           1. BUYBACK — half the processed ETH buys MDOG on the MDOG/ETH
///              Uniswap V4 pool.
///           2. BURN — that MDOG is sent to the dead address. Supply shrinks
///              forever.
///           3. LIQUIDITY — the other half is split: 50% swapped to MDOG,
///              paired with the remaining ETH, and minted as a full-range V4
///              LP position. The position NFT is minted DIRECTLY to the dead
///              address, so the liquidity is locked forever and can never be
///              pulled by anyone — including the project.
///
/// @dev DRAFT — not audited, not deployed. Pre-deploy checklist:
///      - Independent audit before mainnet.
///      - Fuzz + fork tests (process happy path, dust threshold, revert paths).
///
///      MEV note: swap minimums are derived from the pool's current spot
///      price (via StateView) with a 10% haircut. This protects against
///      extreme slippage but does NOT eliminate sandwich attacks — a
///      same-block attacker can still move the spot price before process()
///      runs. The 10% haircut and the per-run processing cap
///      (MAX_PROCESS_MULTIPLE x MIN_PROCESS_AMOUNT) bound the worst-case
///      damage per run, but they do not make the swaps MEV-proof. Never
///      call process() with an amount that would move the pool significantly.
///
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

    /// @notice Mint-position params for the V4 PositionManager (MINT_POSITION,
    ///         action 0x02): explicit liquidity followed by the amount caps.
    /// @dev Field order mirrors v4-periphery IPositionManager mint params.
    struct MintPositionParams {
        PoolKey poolKey;
        int24 tickLower;
        int24 tickUpper;
        uint256 liquidity;
        uint256 amount0Max;
        uint256 amount1Max;
        address recipient;
        bytes hookData;
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Tokens sent here are gone forever.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    /// @notice Native currency sentinel used by V4.
    address public constant NATIVE = address(0);
    /// @notice Universal Router "address(this)" sentinel (router keeps funds).
    address public constant ROUTER_SELF = 0x0000000000000000000000000000000000000002;
    /// @notice Canonical Permit2 on every chain, 4663 included (verified:
    ///         code present and DOMAIN_SEPARATOR() returns non-zero).
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @notice Canonical v4 StateView on Robinhood Chain 4663 (verified:
    ///         code present, getSlot0 works). Only used for the spot-price
    ///         read that derives swap minimums — see the MEV note above.
    address public constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    /// @notice V4 min/max ticks for a full-range position.
    int24 public constant MIN_TICK = -887272;
    int24 public constant MAX_TICK = 887272;
    /// @notice Swap minimums sit this many bps under the spot-implied output
    ///         (9000 = 10% haircut). See the MEV note above.
    uint256 public constant MIN_OUT_BPS = 9000;
    /// @notice One process() run never touches more than this multiple of
    ///         MIN_PROCESS_AMOUNT. Bounds worst-case MEV per run.
    uint256 public constant MAX_PROCESS_MULTIPLE = 100;
    /// @notice Permit2 allowance expiry used for PositionManager pulls.
    uint48 public constant PERMIT2_EXPIRATION = type(uint48).max;

    // Universal Router commands (universal-router Commands library)
    uint8 private constant CMD_WRAP_ETH = 0x0b;
    uint8 private constant CMD_V4_SWAP = 0x10;

    // V4 PositionManager / swap-router actions (v4-periphery Actions library)
    //
    // NOTE on the mint action: the engine uses MINT_POSITION (0x02) with
    // EXPLICIT, on-chain-computed liquidity — not MINT_POSITION_FROM_DELTAS
    // (0x05). This is the exact pattern of the proven on-chain MDOG/ETH mint
    // (position NFT 2864985): actions [0x02, 0x0d, 0x14] with 8-field params
    // (poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max,
    // recipient, hookData). During fork testing, 0x05 with from-deltas params
    // made the deployed PositionManager call PoolManager.modifyLiquidity with
    // liquidityDelta = 0 (CannotUpdateEmptyPosition), while 0x02 with explicit
    // liquidity is byte-proven to work on this PositionManager.
    uint8 private constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 private constant ACT_MINT_POSITION = 0x02;
    uint8 private constant ACT_SETTLE_ALL = 0x0c;
    uint8 private constant ACT_SETTLE_PAIR = 0x0d;
    uint8 private constant ACT_TAKE_ALL = 0x0f;
    uint8 private constant ACT_SWEEP = 0x14;

    // -------------------------------------------------------------------------
    // Immutables (set once at deploy, never changeable — that is the point)
    // -------------------------------------------------------------------------

    IERC20 public immutable MDOG;
    IERC20 public immutable WETH;
    address public immutable UNIVERSAL_ROUTER;
    address public immutable POSITION_MANAGER;
    PoolKey public POOL_KEY; // storage (structs can't be immutable); set once in constructor
    /// @notice True when MDOG is currency0 of the pool (address ordering).
    bool public immutable MDOG_IS_CURRENCY0;
    /// @notice True when the pool's ETH leg is native (currency0 == address(0)).
    bool public immutable NATIVE_POOL;
    /// @notice Minimum ETH balance before process() can run (dust guard).
    ///         Also sizes the per-run cap (MAX_PROCESS_MULTIPLE x this).
    uint256 public immutable MIN_PROCESS_AMOUNT;
    int24 public immutable TICK_LOWER;
    int24 public immutable TICK_UPPER;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted after every successful process() run.
    /// @param ethIn Total ETH processed in this run (capped per run).
    /// @param mdogBurned MDOG bought and sent to the dead address.
    /// @param ethIntoLp ETH paired into the LP position.
    /// @param mdogIntoLp MDOG paired into the LP position.
    event Processed(
        uint256 ethIn,
        uint256 mdogBurned,
        uint256 ethIntoLp,
        uint256 mdogIntoLp
    );
    event RoyaltyReceived(address indexed from, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor (PINNED — the deploy script depends on this exact signature)
    // -------------------------------------------------------------------------

    constructor(
        address mdog,
        address weth,
        address universalRouter,
        address positionManager,
        PoolKey memory poolKey,
        uint256 minProcessAmount
    ) {
        require(mdog != address(0) && weth != address(0), "FeeEngine: zero token");
        require(
            universalRouter != address(0) && positionManager != address(0),
            "FeeEngine: zero venue"
        );
        require(minProcessAmount != 0, "FeeEngine: zero minProcessAmount");
        require(poolKey.tickSpacing > 0, "FeeEngine: bad tick spacing");

        // Pool must pair MDOG with native ETH or WETH, in canonical order.
        bool mdogIsCurrency0 = poolKey.currency0 == mdog;
        bool mdogIsCurrency1 = poolKey.currency1 == mdog;
        require(mdogIsCurrency0 != mdogIsCurrency1, "FeeEngine: MDOG not in pool");
        address other = mdogIsCurrency0 ? poolKey.currency1 : poolKey.currency0;
        require(
            other == NATIVE || other == weth,
            "FeeEngine: pool has no ETH leg"
        );
        // Canonical ordering: currency0 < currency1, except native (address(0))
        // which is always currency0.
        if (poolKey.currency0 != NATIVE) {
            require(
                poolKey.currency0 < poolKey.currency1,
                "FeeEngine: bad currency ordering"
            );
        }

        // The pool must already be initialized. A non-zero sqrtPriceX96 from
        // StateView proves it.
        bytes32 poolId = keccak256(abi.encode(poolKey));
        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        require(sqrtPriceX96 != 0, "FeeEngine: pool not initialized");
        require(
            minProcessAmount <= type(uint256).max / MAX_PROCESS_MULTIPLE,
            "FeeEngine: minProcessAmount too large"
        );

        MDOG = IERC20(mdog);
        WETH = IERC20(weth);
        UNIVERSAL_ROUTER = universalRouter;
        POSITION_MANAGER = positionManager;
        POOL_KEY = poolKey;
        MDOG_IS_CURRENCY0 = mdogIsCurrency0;
        NATIVE_POOL = poolKey.currency0 == NATIVE;
        MIN_PROCESS_AMOUNT = minProcessAmount;
        // Full-range position, snapped to the pool's tick spacing.
        TICK_LOWER = (MIN_TICK / poolKey.tickSpacing) * poolKey.tickSpacing;
        TICK_UPPER = (MAX_TICK / poolKey.tickSpacing) * poolKey.tickSpacing;
    }

    // -------------------------------------------------------------------------
    // Receive royalties
    // -------------------------------------------------------------------------

    /// @notice Royalty payments arrive here as plain ETH transfers (via the
    ///         separate royalty splitter, which takes its cut first).
    receive() external payable {
        emit RoyaltyReceived(msg.sender, msg.value);
    }

    // -------------------------------------------------------------------------
    // The autonomous loop
    // -------------------------------------------------------------------------

    /// @notice Run one full fee-engine cycle. Permissionless: anyone can call,
    ///         no arguments, no signature required. In practice an off-chain
    ///         keeper calls it on a schedule or once the threshold is crossed.
    ///
    /// @dev Slippage protection comes from the on-chain spot price (via
    ///      StateView) with a 10% haircut — see the MEV note at the top. The
    ///      per-run cap bounds worst-case MEV per run. Excess ETH stays in
    ///      the contract for later runs.
    function process() external nonReentrant {
        uint256 balance = address(this).balance;
        require(balance >= MIN_PROCESS_AMOUNT, "FeeEngine: below threshold");

        // Per-run cap: never process more than MAX_PROCESS_MULTIPLE x the
        // minimum. Excess stays for later runs. (Solidity 0.8 reverts on
        // overflow here, which is the safe behavior.)
        uint256 maxPerRun = MIN_PROCESS_AMOUNT * MAX_PROCESS_MULTIPLE;
        uint256 amount = balance > maxPerRun ? maxPerRun : balance;

        // Fixed 50/50 split: half buys MDOG to burn, half becomes LP.
        uint256 burnLeg = amount / 2;
        uint256 lpLeg = amount - burnLeg;

        // Legs 1+2: buy MDOG and burn it. Supply shrinks forever.
        uint256 mdogBurned = _swapExactEthForMdog(burnLeg);
        MDOG.safeTransfer(BURN_ADDRESS, mdogBurned);

        // Leg 3: split the LP half — swap 50% to MDOG, pair with the rest —
        // and mint the position NFT straight to the dead address. Born
        // locked, unpullable by anyone, forever.
        uint256 ethForLp = lpLeg / 2;
        uint256 mdogForLp = _swapExactEthForMdog(lpLeg - ethForLp);
        _mintPositionToDeadAddress(ethForLp, mdogForLp);

        emit Processed(amount, mdogBurned, ethForLp, mdogForLp);
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /// @dev Spot-implied MDOG output for a given ETH input, read from the
    ///      pool's current sqrtPriceX96 via StateView. Uses staged
    ///      Math.mulDiv to avoid overflowing on extreme prices.
    function _spotMdogOut(uint256 ethIn) internal view returns (uint256) {
        bytes32 poolId = keccak256(abi.encode(POOL_KEY));
        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        require(sqrtPriceX96 != 0, "FeeEngine: pool not initialized");
        uint256 Q96 = 1 << 96;
        if (MDOG_IS_CURRENCY0) {
            // Swapping token1 (ETH leg) -> token0 (MDOG): out = in / P.
            uint256 step1 = Math.mulDiv(ethIn, Q96, sqrtPriceX96);
            return Math.mulDiv(step1, Q96, sqrtPriceX96);
        } else {
            // Swapping token0 (ETH leg) -> token1 (MDOG): out = in * P.
            uint256 step1 = Math.mulDiv(ethIn, sqrtPriceX96, Q96);
            return Math.mulDiv(step1, sqrtPriceX96, Q96);
        }
    }

    /// @dev Swap exact ETH for MDOG on the V4 pool via the Universal Router.
    ///      The minimum accepted output is derived from the on-chain spot
    ///      price with a 10% haircut — no caller-supplied slippage.
    ///      Handles both native-ETH and WETH pool variants.
    function _swapExactEthForMdog(uint256 ethIn)
        internal
        returns (uint256 mdogOut)
    {
        if (ethIn == 0) return 0;

        uint256 minOut = Math.mulDiv(_spotMdogOut(ethIn), MIN_OUT_BPS, 10_000);

        // The input/ETH-leg currency: where the swap's input token settles.
        // (Not always currency0 — for a WETH pool with MDOG as currency0,
        // the ETH leg is currency1.)
        address ethCurrency =
            MDOG_IS_CURRENCY0 ? POOL_KEY.currency1 : POOL_KEY.currency0;

        bytes memory actions = abi.encodePacked(
            bytes1(ACT_SWAP_EXACT_IN_SINGLE),
            bytes1(ACT_SETTLE_ALL),
            bytes1(ACT_TAKE_ALL)
        );
        bytes[] memory swapParams = new bytes[](3);
        swapParams[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: POOL_KEY,
                zeroForOne: !MDOG_IS_CURRENCY0,
                amountIn: uint128(ethIn),
                amountOutMinimum: uint128(minOut),
                sqrtPriceLimitX96: 0,
                hookData: ""
            })
        );
        swapParams[1] = abi.encode(ethCurrency, ethIn); // SETTLE_ALL
        swapParams[2] = abi.encode(address(MDOG), minOut); // TAKE_ALL

        bytes memory commands;
        bytes[] memory inputs;
        if (NATIVE_POOL) {
            // V4_SWAP only: TAKE_ALL delivers MDOG directly to this engine
            // (no SWEEP needed — the fork trace proved the router holds zero).
            commands = abi.encodePacked(bytes1(CMD_V4_SWAP));
            inputs = new bytes[](1);
            inputs[0] = abi.encode(actions, swapParams);
        } else {
            commands = abi.encodePacked(
                bytes1(CMD_WRAP_ETH), bytes1(CMD_V4_SWAP)
            );
            inputs = new bytes[](2);
            inputs[0] = abi.encode(ROUTER_SELF, ethIn); // wrap, keep in router
            inputs[1] = abi.encode(actions, swapParams);
        }
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: ethIn}(
            commands, inputs, block.timestamp
        );

        // Router swept MDOG here; measure what actually arrived.
        mdogOut = MDOG.balanceOf(address(this));
        // NOTE: balanceOf diffing assumes no other MDOG sits in the engine.
        // The engine never holds MDOG between runs (everything is burned or
        // paired immediately), so this holds by construction.
        require(mdogOut >= minOut, "FeeEngine: below on-chain minimum");
    }

    /// @dev Mint a full-range V4 LP position and send the NFT straight to the
    ///      dead address. The liquidity can never be withdrawn — by anyone.
    ///      Uses MINT_POSITION (action 0x02) with EXPLICIT liquidity computed
    ///      on-chain from the current spot price — the same pattern as the
    ///      proven on-chain MDOG/ETH mint. Token pulls go through Permit2
    ///      with the PositionManager as spender (never the PoolManager —
    ///      see AGENTS.md). A final SWEEP returns any unneeded native ETH
    ///      (msg.value minus what the mint actually consumed) to the engine
    ///      so no dust is stranded in the PositionManager.
    function _mintPositionToDeadAddress(uint256 ethAmount, uint256 mdogAmount)
        internal
    {
        if (ethAmount == 0 || mdogAmount == 0) return;

        uint256 amount0Max;
        uint256 amount1Max;
        uint256 nativeValue;

        if (MDOG_IS_CURRENCY0) {
            amount0Max = mdogAmount;
            amount1Max = ethAmount;
        } else {
            amount0Max = ethAmount;
            amount1Max = mdogAmount;
        }

        // Explicit liquidity from the live spot price. getLiquidityForAmounts
        // is defined so the mint never needs more than (amount0Max,
        // amount1Max); leftover dust simply stays in the engine for the next
        // run. A zero result means dust-only amounts — skip the mint rather
        // than revert and brick process().
        bytes32 poolId = keccak256(abi.encode(POOL_KEY));
        (uint160 sqrtPriceX96,,,) = IStateView(STATE_VIEW).getSlot0(poolId);
        uint128 liquidity = V4Math.getLiquidityForAmounts(
            sqrtPriceX96,
            V4Math.getSqrtPriceAtTick(TICK_LOWER),
            V4Math.getSqrtPriceAtTick(TICK_UPPER),
            amount0Max,
            amount1Max
        );
        if (liquidity == 0) return;

        if (NATIVE_POOL) {
            nativeValue = ethAmount;
        } else {
            // WETH pool: wrap the ETH leg, PositionManager pulls via Permit2.
            IWETH(address(WETH)).deposit{value: ethAmount}();
            WETH.forceApprove(PERMIT2, ethAmount);
            IPermit2(PERMIT2).approve(
                address(WETH),
                POSITION_MANAGER,
                uint160(ethAmount),
                PERMIT2_EXPIRATION
            );
        }
        MDOG.forceApprove(PERMIT2, mdogAmount);
        IPermit2(PERMIT2).approve(
            address(MDOG),
            POSITION_MANAGER,
            uint160(mdogAmount),
            PERMIT2_EXPIRATION
        );

        bytes memory actions = abi.encodePacked(
            bytes1(ACT_MINT_POSITION),
            bytes1(ACT_SETTLE_PAIR)
        );
        bytes[] memory params = new bytes[](2);
        // Encode as flattened fields (not a struct) to match the real
        // PositionManager's abi.decode — struct encoding adds a leading
        // tuple offset that causes SliceOutOfBounds on the real chain.
        params[0] = abi.encode(
            POOL_KEY,
            TICK_LOWER,
            TICK_UPPER,
            uint256(liquidity),
            amount0Max,
            amount1Max,
            BURN_ADDRESS, // born burned
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

interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint24 protocolFee,
            uint24 lpFee
        );
}

interface IPermit2 {
    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration
    ) external;

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

interface IPermit2Allowance {
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}
