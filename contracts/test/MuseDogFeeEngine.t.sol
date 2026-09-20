// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MuseDogFeeEngine} from "../src/MuseDogFeeEngine.sol";

/// @notice Unit tests for the MuseDogFeeEngine rewrite (50/50 burn/LP, no
///         Mikey logic, no caller-supplied minimums). Mocks stand in for the
///         Universal Router, PositionManager, StateView, and Permit2; the
///         canonical addresses are etched with mock code so the engine's
///         hardcoded constants resolve. A fork test at the bottom exercises
///         the real swap math on Robinhood Chain when --fork-url is given.
contract MuseDogFeeEngineTest is Test {
    // -------------------------------------------------------------------------
    // Mocks
    // -------------------------------------------------------------------------

    MockERC20 mdog;
    MockWETH weth;
    MockUniversalRouter router;
    MockPositionManager pm;

    MuseDogFeeEngine engine;
    MuseDogFeeEngine.PoolKey key;

    // 1 ETH = 1024 MDOG at the mocked spot (perfect square -> clean math).
    uint160 constant SPOT_SQRT = uint160(2 ** 101); // sqrt(1024) * 2^96
    uint256 constant RATE = 1024e18; // mock router: MDOG per ETH, 1e18-scaled
    uint256 constant MIN_PROCESS = 0.01 ether; // per-run cap = 1 ether

    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        mdog = new MockERC20();
        weth = new MockWETH();

        // Etch mocks at the canonical addresses the engine hardcodes.
        MockStateView sv = new MockStateView();
        vm.etch(STATE_VIEW_ADDR, address(sv).code);
        MockStateView(STATE_VIEW_ADDR).setSlot0(SPOT_SQRT, 69318);

        MockPermit2 p2 = new MockPermit2();
        vm.etch(PERMIT2_ADDR, address(p2).code);

        router = new MockUniversalRouter(mdog, RATE);
        pm = new MockPositionManager();

        key = MuseDogFeeEngine.PoolKey({
            currency0: address(0), // native ETH leg, like the real MDOG/ETH pool
            currency1: address(mdog),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        engine = new MuseDogFeeEngine(
            address(mdog),
            address(weth),
            address(router),
            address(pm),
            key,
            MIN_PROCESS
        );
    }

    // -------------------------------------------------------------------------
    // Constructor validation
    // -------------------------------------------------------------------------

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert("FeeEngine: zero token");
        new MuseDogFeeEngine(
            address(0), address(weth), address(router), address(pm), key, MIN_PROCESS
        );
    }

    function test_ConstructorRejectsZeroMinProcessAmount() public {
        vm.expectRevert("FeeEngine: zero minProcessAmount");
        new MuseDogFeeEngine(
            address(mdog), address(weth), address(router), address(pm), key, 0
        );
    }

    function test_ConstructorRejectsOverflowMinProcessAmount() public {
        uint256 tooLarge = type(uint256).max / 100 + 1;
        vm.expectRevert("FeeEngine: minProcessAmount too large");
        new MuseDogFeeEngine(
            address(mdog), address(weth), address(router), address(pm), key, tooLarge
        );
    }

    function test_ConstructorRejectsPoolWithoutMdog() public {
        MuseDogFeeEngine.PoolKey memory bad = MuseDogFeeEngine.PoolKey({
            currency0: address(0),
            currency1: address(weth),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        vm.expectRevert("FeeEngine: MDOG not in pool");
        new MuseDogFeeEngine(
            address(mdog), address(weth), address(router), address(pm), bad, MIN_PROCESS
        );
    }

    function test_ConstructorRejectsPoolWithoutEthLeg() public {
        address mdogLow = address(uint160(0x4D06));
        address other = address(uint160(0xBEEF));
        MuseDogFeeEngine.PoolKey memory bad = MuseDogFeeEngine.PoolKey({
            currency0: mdogLow,
            currency1: other, // not native, not WETH
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        vm.expectRevert("FeeEngine: pool has no ETH leg");
        new MuseDogFeeEngine(
            mdogLow, address(weth), address(router), address(pm), bad, MIN_PROCESS
        );
    }

    function test_ConstructorRejectsBadOrdering() public {
        address mdogLow = address(uint160(0x4D06));
        // currency0 (weth, high address) > currency1 (mdogLow): bad ordering,
        // but MDOG is in the pool and the ETH leg (weth) is present.
        MuseDogFeeEngine.PoolKey memory bad = MuseDogFeeEngine.PoolKey({
            currency0: address(weth),
            currency1: mdogLow,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        vm.expectRevert("FeeEngine: bad currency ordering");
        new MuseDogFeeEngine(
            mdogLow, address(weth), address(router), address(pm), bad, MIN_PROCESS
        );
    }

    function test_ConstructorRejectsUninitializedPool() public {
        MockStateView(STATE_VIEW_ADDR).setSlot0(0, 0);
        vm.expectRevert("FeeEngine: pool not initialized");
        new MuseDogFeeEngine(
            address(mdog), address(weth), address(router), address(pm), key, MIN_PROCESS
        );
    }

    function test_ConstructorSetsFullRangeTicks() public view {
        // Snapped to tick spacing 60: -887272 -> -887220, 887272 -> 887220.
        assertEq(engine.TICK_LOWER(), -887220);
        assertEq(engine.TICK_UPPER(), 887220);
        assertFalse(engine.MDOG_IS_CURRENCY0());
        assertTrue(engine.NATIVE_POOL());
    }

    /// @dev The test etches mocks at local copies of the engine's canonical
    ///      addresses; this guards against drift between the two.
    function test_CanonicalAddressesMatchEngine() public view {
        assertEq(engine.STATE_VIEW(), STATE_VIEW_ADDR);
        assertEq(engine.PERMIT2(), PERMIT2_ADDR);
    }

    // -------------------------------------------------------------------------
    // process(): the 50/50 loop
    // -------------------------------------------------------------------------

    /// @dev 1 ETH in: 0.5 ETH buys 512 MDOG and burns it; 0.25 ETH stays,
    ///      0.25 ETH buys 256 MDOG, all minted as LP to the dead address.
    function test_ProcessSplitsFiftyFifty() public {
        vm.deal(address(engine), 1 ether);

        vm.expectEmit(address(engine));
        emit MuseDogFeeEngine.Processed(1 ether, 512 ether, 0.25 ether, 256 ether);
        engine.process();

        // Burn leg: all 512 MDOG went to the dead address, none left behind.
        assertEq(mdog.balanceOf(DEAD), 512 ether);
        assertEq(mdog.balanceOf(address(engine)), 0);
        // LP leg: the mock PositionManager saw the right shape.
        assertEq(pm.calls(), 1);
        assertEq(pm.lastRecipient(), DEAD);
        assertEq(pm.lastTickLower(), -887220);
        assertEq(pm.lastTickUpper(), 887220);
        assertEq(pm.lastAmount0Max(), 0.25 ether); // ETH leg (currency0)
        assertEq(pm.lastAmount1Max(), 256 ether); // MDOG leg (currency1)
        assertEq(pm.lastNativeValue(), 0.25 ether);
        // Two router swaps happened (burn leg + LP leg).
        assertEq(router.calls(), 2);
        // Engine kept nothing.
        assertEq(address(engine).balance, 0);
    }

    function test_ProcessRevertsBelowThreshold() public {
        vm.deal(address(engine), MIN_PROCESS - 1);
        vm.expectRevert("FeeEngine: below threshold");
        engine.process();
    }

    function test_ProcessRevertsOnZeroBalance() public {
        vm.expectRevert("FeeEngine: below threshold");
        engine.process();
    }

    function test_ProcessWorksAtExactThreshold() public {
        vm.deal(address(engine), MIN_PROCESS);
        engine.process(); // must not revert
        assertEq(address(engine).balance, 0);
    }

    /// @dev Per-run cap: 5 ETH funded, only 1 ETH (100x min) processed.
    function test_ProcessCapsAtMaxPerRun() public {
        vm.deal(address(engine), 5 ether);
        engine.process();
        assertEq(address(engine).balance, 4 ether, "surplus must wait for next run");
        assertEq(mdog.balanceOf(DEAD), 512 ether, "only 0.5 ETH worth burned");
    }

    /// @dev Approvals target the PositionManager as Permit2 spender — the
    ///      historical bug topped up the PoolManager instead.
    function test_Permit2SpenderIsPositionManager() public {
        vm.deal(address(engine), 1 ether);
        engine.process();

        MockPermit2 p2 = MockPermit2(PERMIT2_ADDR);
        // The mock PositionManager simulates the real pull: it draws the MDOG
        // through Permit2 as the approved spender, consuming the allowance.
        // That the PM received exactly the LP amount proves the spender the
        // engine approved was the PositionManager (not the PoolManager).
        assertEq(
            mdog.balanceOf(address(pm)),
            256 ether,
            "PositionManager pulled the MDOG via Permit2"
        );
        (uint160 amt,,) = p2.allowance(address(engine), address(mdog), address(pm));
        assertEq(amt, 0, "PM consumed its Permit2 allowance via the pull");
        // Nothing was ever approved for a random other spender (e.g. a pool
        // manager) — the AGENTS.md gotcha stays fixed.
        (uint160 wrongAmt,,) = p2.allowance(
            address(engine), address(mdog), address(uint160(0x1234))
        );
        assertEq(wrongAmt, 0);
    }

    // -------------------------------------------------------------------------
    // Slippage: on-chain minimums, no caller input
    // -------------------------------------------------------------------------

    /// @dev Spot implies 1024 MDOG/ETH; the 10% haircut sets minOut at 921.6.
    ///      A router rate of 800 (worse than the haircut) must revert.
    function test_ProcessRevertsWhenRouterWorseThanHaircut() public {
        router.setRate(800e18);
        vm.deal(address(engine), 1 ether);
        vm.expectRevert("MockRouter: below minOut");
        engine.process();
    }

    /// @dev Rate 950 (inside the 10% haircut) succeeds.
    function test_ProcessSucceedsWithinHaircut() public {
        router.setRate(950e18);
        vm.deal(address(engine), 1 ether);
        engine.process();
        assertEq(mdog.balanceOf(DEAD), 475 ether); // 0.5 ETH * 950
    }

    /// @dev Boundary: rate exactly at the haircut edge (921.6) succeeds.
    function test_ProcessSucceedsAtHaircutBoundary() public {
        router.setRate(921.6e18);
        vm.deal(address(engine), 1 ether);
        engine.process(); // must not revert
        assertEq(mdog.balanceOf(DEAD), 460.8 ether);
    }

    function test_ReceiveEmitsRoyaltyReceived() public {
        vm.deal(address(this), 0.5 ether);
        vm.expectEmit(true, false, false, true, address(engine));
        emit MuseDogFeeEngine.RoyaltyReceived(address(this), 0.5 ether);
        (bool ok,) = address(engine).call{value: 0.5 ether}("");
        assertTrue(ok);
    }

    // -------------------------------------------------------------------------
    // WETH pool variant
    // -------------------------------------------------------------------------

    function test_ProcessWethPoolVariant() public {
        // Etch the token mocks at ordered addresses: WETH < MDOG.
        MockERC20 mdog2 = new MockERC20();
        MockWETH weth2 = new MockWETH();
        address WETH_LOW = address(uint160(0x0A11));
        address MDOG_HIGH = address(uint160(0x0B22));
        vm.etch(WETH_LOW, address(weth2).code);
        vm.etch(MDOG_HIGH, address(mdog2).code);

        MockUniversalRouter router2 = new MockUniversalRouter(MockERC20(MDOG_HIGH), RATE);
        MockPositionManager pm2 = new MockPositionManager();
        MuseDogFeeEngine.PoolKey memory wethKey = MuseDogFeeEngine.PoolKey({
            currency0: WETH_LOW,
            currency1: MDOG_HIGH,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        MuseDogFeeEngine engine2 = new MuseDogFeeEngine(
            MDOG_HIGH, WETH_LOW, address(router2), address(pm2), wethKey, MIN_PROCESS
        );
        assertFalse(engine2.NATIVE_POOL());

        vm.deal(address(engine2), 1 ether);
        engine2.process();

        // Burn leg identical; LP leg wrapped ETH into WETH (no native value).
        assertEq(MockERC20(MDOG_HIGH).balanceOf(DEAD), 512 ether);
        assertEq(pm2.calls(), 1);
        assertEq(pm2.lastRecipient(), DEAD);
        assertEq(pm2.lastNativeValue(), 0, "WETH variant sends no native value");
        assertEq(pm2.lastAmount0Max(), 0.25 ether); // WETH leg (currency0)
        assertEq(pm2.lastAmount1Max(), 256 ether); // MDOG leg (currency1)
        // WETH was wrapped then pulled by the PositionManager (engine ends at 0).
        assertEq(MockERC20(WETH_LOW).balanceOf(address(engine2)), 0);
        // Permit2 WETH allowance targeted the PositionManager (consumed by the pull).
        MockPermit2 p2 = MockPermit2(PERMIT2_ADDR);
        (uint160 wethAmt,,) = p2.allowance(address(engine2), WETH_LOW, address(pm2));
        assertEq(wethAmt, 0, "allowance consumed by PM pull");
    }

    // -------------------------------------------------------------------------
    // Fork test: real swap math on Robinhood Chain (needs --fork-url)
    // -------------------------------------------------------------------------

    /// @dev Exercises the real Universal Router + PositionManager + pool on a
    ///      4663 fork. Skips silently without --fork-url (chainid != 4663).
    function testFork_ProcessAgainstRealPool() public {
        if (block.chainid != 4663) return;

        address MDOG = 0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC;
        address WETH9 = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
        address UR = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
        address POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
        MuseDogFeeEngine.PoolKey memory realKey = MuseDogFeeEngine.PoolKey({
            currency0: address(0),
            currency1: MDOG,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        MuseDogFeeEngine real = new MuseDogFeeEngine(
            MDOG, WETH9, UR, POSM, realKey, 0.005 ether
        );

        vm.deal(address(real), 0.02 ether);
        uint256 deadMdogBefore = IERC20(MDOG).balanceOf(DEAD);
        uint256 deadNftsBefore = IERC721Minimal(POSM).balanceOf(DEAD);

        real.process();

        uint256 burned = IERC20(MDOG).balanceOf(DEAD) - deadMdogBefore;
        assertGt(burned, 0, "fork: nothing burned to the dead address");
        assertEq(
            IERC721Minimal(POSM).balanceOf(DEAD) - deadNftsBefore,
            1,
            "fork: LP NFT not minted to the dead address"
        );
        assertLt(address(real).balance, 0.02 ether, "fork: no ETH consumed");
        assertEq(IERC20(MDOG).balanceOf(address(real)), 0, "fork: MDOG left behind");
    }
}

// Canonical addresses mirrored from the engine (single source of truth is the
// engine; test_CanonicalAddressesMatchEngine guards against drift).
address constant STATE_VIEW_ADDR =
    0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
address constant PERMIT2_ADDR =
    0x000000000022D473030F116dDEE9F6B43aC78BA3;

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

/// @dev Mirrors the engine's PoolKey for decoding its calldata in mocks.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external
        returns (bool)
    {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockWETH is MockERC20 {
    function deposit() external payable {
        this.mint(msg.sender, msg.value);
    }

    receive() external payable {
        this.mint(msg.sender, msg.value);
    }
}

/// @dev Etched at the engine's STATE_VIEW constant. Returns a fixed slot0.
contract MockStateView {
    uint160 public sqrtPriceX96;
    int24 public tick;

    function setSlot0(uint160 s, int24 t) external {
        sqrtPriceX96 = s;
        tick = t;
    }

    function getSlot0(bytes32)
        external
        view
        returns (uint160, int24, uint24, uint24)
    {
        return (sqrtPriceX96, tick, 0, 0);
    }
}

/// @dev Etched at the engine's PERMIT2 constant. Records approvals.
contract MockPermit2 {
    mapping(address => mapping(address => mapping(address => uint256)))
        public amounts;

    function approve(
        address token,
        address spender,
        uint160 amount,
        uint48
    ) external {
        amounts[msg.sender][token][spender] = amount;
    }

    /// @dev Simulates the real Permit2 pull: the PositionManager (msg.sender
    ///      here) draws ERC20s up to its allowance; Permit2 itself moves the
    ///      tokens using the owner's classic approval to Permit2.
    function pullFrom(address owner, address token, address to, uint160 amount)
        external
    {
        require(
            amounts[owner][token][msg.sender] >= amount,
            "MockPermit2: insufficient allowance"
        );
        amounts[owner][token][msg.sender] -= amount;
        MockERC20(token).transferFrom(owner, to, amount);
    }

    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce)
    {
        return (uint160(amounts[owner][token][spender]), 0, 0);
    }
}

/// @dev Simulates the Universal Router V4 swap at a fixed MDOG/ETH rate and
///      enforces the amountOutMinimum the engine passes — this is what makes
///      the slippage tests meaningful.
contract MockUniversalRouter {
    MockERC20 public mdog;
    uint256 public rate; // MDOG per ETH, 1e18-scaled
    uint256 public calls;
    bytes public lastCommands;

    constructor(MockERC20 _mdog, uint256 _rate) {
        mdog = _mdog;
        rate = _rate;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256
    ) external payable {
        calls++;
        lastCommands = commands;
        // Find the V4_SWAP (0x10) input — index 0 for native, 1 for WETH variant.
        uint256 swapIdx = 0;
        for (uint256 i = 0; i < commands.length; i++) {
            if (commands[i] == 0x10) {
                swapIdx = i;
                break;
            }
        }
        (, bytes[] memory params) = abi.decode(inputs[swapIdx], (bytes, bytes[]));
        // Decode to the engine's struct type (the engine abi.encodes the
        // struct, which adds a leading tuple offset).
        MuseDogFeeEngine.ExactInputSingleParams memory p = abi.decode(
            params[0],
            (MuseDogFeeEngine.ExactInputSingleParams)
        );
        uint128 amountIn = p.amountIn;
        uint128 amountOutMinimum = p.amountOutMinimum;
        require(msg.value == amountIn, "MockRouter: value != amountIn");
        uint256 mdogOut = (msg.value * rate) / 1e18;
        require(mdogOut >= amountOutMinimum, "MockRouter: below minOut");
        mdog.mint(msg.sender, mdogOut); // simulates TAKE_ALL delivering to the engine
    }
}

/// @dev Records the mint call so tests can assert recipient/ticks/amounts.
contract MockPositionManager {
    uint256 public calls;
    address public lastRecipient;
    int24 public lastTickLower;
    int24 public lastTickUpper;
    uint256 public lastAmount0Max;
    uint256 public lastAmount1Max;
    uint256 public lastNativeValue;
    bytes public lastActions;

    function modifyLiquidities(bytes calldata unlockData, uint256)
        external
        payable
    {
        calls++;
        lastNativeValue = msg.value;
        (bytes memory actions, bytes[] memory params) =
            abi.decode(unlockData, (bytes, bytes[]));
        lastActions = actions;
        // Decode flattened fields (the engine encodes without the struct
        // wrapper to match the real PositionManager). MINT_POSITION (0x02)
        // params: (PoolKey, tickLower, tickUpper, liquidity, amount0Max,
        // amount1Max, recipient, hookData) — 8 fields with explicit liquidity.
        (
            MuseDogFeeEngine.PoolKey memory pk,
            int24 tickLower,
            int24 tickUpper,
            uint256 liquidity,
            uint256 amount0Max,
            uint256 amount1Max,
            address recipient,

        ) = abi.decode(
            params[0],
            (MuseDogFeeEngine.PoolKey, int24, int24, uint256, uint256, uint256, address, bytes)
        );
        require(liquidity > 0, "mock: zero liquidity");
        lastRecipient = recipient;
        lastTickLower = tickLower;
        lastTickUpper = tickUpper;
        lastAmount0Max = amount0Max;
        lastAmount1Max = amount1Max;
        // Simulate the real PositionManager pulling the ERC20 deltas through
        // Permit2 (msg.sender is the engine, the token owner here).
        if (pk.currency0 != address(0)) {
            MockPermit2(PERMIT2_ADDR).pullFrom(
                msg.sender,
                pk.currency0,
                address(this),
                uint160(amount0Max)
            );
        }
        if (pk.currency1 != address(0)) {
            MockPermit2(PERMIT2_ADDR).pullFrom(
                msg.sender,
                pk.currency1,
                address(this),
                uint160(amount1Max)
            );
        }
    }
}

interface IERC721Minimal {
    function balanceOf(address owner) external view returns (uint256);
}
