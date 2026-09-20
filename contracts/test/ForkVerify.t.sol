// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// TEMPORARY verification harness — run with:
//   forge test --fork-url https://rpc.mainnet.chain.robinhood.com --match-contract ForkVerify -vvv
// Verifies, against live Robinhood Chain state:
//   1. slot0 is readable via extsload at pools-mapping slot 6 (getSlot0 does NOT exist)
//   2. the splitter's exact-input two-hop swap flow works through the hooked MDOG/META pool,
//      with the exact-equality delta assumptions the splitter relies on
//   3. POSM.modifyLiquidities with actions [MINT_POSITION=2, SETTLE_PAIR=9] and the
//      canonical mint params encoding mints a full-range MDOG/ETH position to the dead address
//
// CRITICAL (2026-09-20): This chain's PoolManager is MODIFIED. It does NOT have
// settle(address)/settle(Currency) — selector 0x6a256b29 is ABSENT from PM bytecode.
// The no-args settle() handles BOTH:
//   - Native ETH: settle{value: amount}()
//   - ERC20: sync(currency) + transfer + settle() (no value, no args)
// Using settle(currency) WILL REVERT. This was the root cause of all Pons route failures.

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPM {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (bytes32 delta);
    // NOTE: This chain's PoolManager is MODIFIED. It does NOT have settle(address)/settle(Currency).
    // The no-args settle() handles BOTH native (with msg.value) and ERC20 (after sync+transfer, no value).
    // Verified 2026-09-20: settle(address) selector 0x6a256b29 is ABSENT from PM bytecode.
    function settle() external payable returns (uint256);
    function sync(address currency) external;
    function take(address currency, address recipient, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IPOSM {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function balanceOf(address owner) external view returns (uint256);
    function permit2() external view returns (address);
}
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

contract ForkVerify is Test {
    IPM constant PM = IPM(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IPOSM constant POSM = IPOSM(0x58daec3116aae6D93017bAAea7749052E8a04fA7);
    address constant MDOG = 0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC;
    address constant META = 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant POOLS_SLOT = 6;

    // Verified live pool keys (from Initialize events)
    function _metaEthKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: META, fee: 9000, tickSpacing: 90, hooks: address(0)});
    }

    function _metaMdogKey() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: MDOG,
            currency1: META,
            fee: 0,
            tickSpacing: 200,
            hooks: 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
        });
    }

    function _mdogEthKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: MDOG, fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    function _poolId(PoolKey memory k) internal pure returns (bytes32) {
        return keccak256(abi.encode(k));
    }

    function _slot0(PoolKey memory k)
        internal
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        bytes32 loc = keccak256(abi.encode(_poolId(k), POOLS_SLOT));
        uint256 w = uint256(PM.extsload(loc));
        sqrtPriceX96 = uint160(w);
        tick = int24(int256((w >> 160) & 0xFFFFFF) >= int256(2 ** 23) ? int256((w >> 160) & 0xFFFFFF) - int256(2 ** 24) : int256((w >> 160) & 0xFFFFFF));
        protocolFee = uint24((w >> 184) & 0xFFFFFF);
        lpFee = uint24((w >> 208) & 0xFFFFFF);
    }

    uint160 constant MIN_SQRT_PRICE = 4295128739;
    uint160 constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    receive() external payable {}

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(PM), "not pm");
        (PoolKey memory k1, PoolKey memory k2, uint256 ethIn) = abi.decode(data, (PoolKey, PoolKey, uint256));

        // Hop 1: ETH -> META (zeroForOne), exact INPUT.
        // LIVE SEMANTICS (verified on fork): amountSpecified NEGATIVE = exact
        // input (flipped vs canonical v4). BalanceDelta packing is canonical:
        // amount0 = HIGH 128 bits, amount1 = LOW 128 bits.
        bytes32 d1 = PM.swap(k1, SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_SQRT_PRICE + 1}), "");
        int128 d1a0 = int128(int256(uint256(d1) >> 128));
        int128 d1a1 = int128(int256(uint256(d1)));
        require(d1a0 < 0 && d1a1 > 0, "bad d1 signs");
        require(uint256(int256(-d1a0)) == ethIn, "hop1 partial fill");
        uint256 metaOut = uint256(int256(d1a1));
        PM.settle{value: ethIn}();
        PM.take(META, address(this), metaOut);

        // Hop 2: META -> MDOG (oneForZero). The Pons hook supports BOTH exact-input
        // (negative amountSpecified) and exact-output (positive), per verified source.
        // The hook takes ~2% total (1% creator tax + 1% hook fee) on the unspecified leg.
        // We use exact-INPUT here: specify META in (negative), receive MDOG out.
        // Using the full metaOut from hop 1.
        bytes32 d2 = PM.swap(k2, SwapParams({zeroForOne: false, amountSpecified: -int256(metaOut), sqrtPriceLimitX96: MAX_SQRT_PRICE - 1}), "");
        int128 d2a0 = int128(int256(uint256(d2) >> 128));
        int128 d2a1 = int128(int256(uint256(d2)));
        // For exact-input (negative specified): a1 should be -metaOut (META in, negative),
        // a0 should be positive (MDOG out).
        require(d2a1 < 0 && d2a0 > 0, "bad d2 signs");
        require(uint256(int256(-d2a1)) == metaOut, "hop2 partial fill");
        uint256 mdogOut = uint256(int256(d2a0));
        // Settle META debt: sync + transfer + settle() (NO ARGS - the address version doesn't exist).
        PM.sync(META);
        IERC20(META).transfer(address(PM), metaOut);
        PM.settle();
        // Take MDOG.
        PM.take(MDOG, address(this), mdogOut);

        return abi.encode(mdogOut);
    }

    function test_slot0ViaExtsload() public view {
        (uint160 s1, int24 t1,,) = _slot0(_metaEthKey());
        (uint160 s2, int24 t2,,) = _slot0(_metaMdogKey());
        (uint160 s3, int24 t3,,) = _slot0(_mdogEthKey());
        assertTrue(s1 != 0 && t1 != 0, "metaEth slot0 empty");
        assertTrue(s2 != 0 && t2 != 0, "metaMdog slot0 empty");
        assertTrue(s3 != 0 && t3 != 0, "mdogEth slot0 empty");
    }

    function test_swapFlowThroughHookedPool() public {
        uint256 ethIn = 0.3 ether;
        vm.deal(address(this), ethIn + 0.1 ether);
        bytes memory res = PM.unlock(abi.encode(_metaEthKey(), _metaMdogKey(), ethIn));
        uint256 mdogOut = abi.decode(res, (uint256));
        assertTrue(mdogOut > 0, "no mdog out");
        assertTrue(IERC20(MDOG).balanceOf(address(this)) == mdogOut, "mdog not taken");
        assertTrue(IERC20(META).balanceOf(address(this)) == 0, "meta dust left");
    }

    function test_mintFullRangeToDead() public {
        // Fund MDOG directly via deal (swap flow is covered in the other test).
        uint256 amount1Max = 5266000000000000000000000; // ~5.266e24, +3% buffer over 5.1118e24
        deal(MDOG, address(this), amount1Max);
        vm.deal(address(this), 0.06 ether);

        PoolKey memory key = _mdogEthKey();
        int24 tickLower = -887220;
        int24 tickUpper = 887220;
        // Precomputed off-chain for ~0.05 ETH balanced at current price.
        uint256 liquidity = 505561568950805672551;
        uint256 amount0Max = 50000000000000000 + 1000;

        // Actions are PACKED BYTES (not uint256[]) on this deployment, verified
        // by reconstructing real mint tx 0x703a79a3...: MINT_POSITION=2,
        // SETTLE_PAIR=13 (0x0d), SWEEP=20 (0x14).
        bytes memory actions = hex"020d14";
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, DEAD, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(address(0), address(this)); // sweep leftover ETH to us

        uint256 deadBefore = POSM.balanceOf(DEAD);
        // POSM pulls MDOG via Permit2 (spender = POSM itself).
        address permit2 = POSM.permit2();
        IERC20(MDOG).approve(permit2, amount1Max);
        IPermit2(permit2).approve(MDOG, address(POSM), uint160(amount1Max), uint48(block.timestamp + 1 days));
        POSM.modifyLiquidities{value: 50000000000000000}(abi.encode(actions, params), block.timestamp);
        uint256 deadAfter = POSM.balanceOf(DEAD);
        assertTrue(deadAfter == deadBefore + 1, "dead did not receive exactly 1 NFT");
    }
}
