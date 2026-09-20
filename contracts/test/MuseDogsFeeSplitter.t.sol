// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MuseDogsFeeSplitter, PoolKey, SwapParams, BalanceDelta, IUnlockCallback} from "../src/MuseDogsFeeSplitter.sol";
import {MuseDogRewards} from "../src/MuseDogRewards.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

/// @notice Minimal mintable ERC-20 (standard returns-bool flavor).
contract MockToken {
    string public name = "Mock Token";
    string public symbol = "MCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Mimics the real musebook token (verified on-chain 2026-09-20):
///         it hardcodes an infinite token-level approval to Permit2, and any
///         finite approve() to Permit2 reverts with 0x3f68539a.
contract MockMusebookToken {
    string public name = "musebook";
    string public symbol = "musebook";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) private _allowance;
    address public permit2Addr;

    /// @dev The test etches this template's code onto the musebook address
    ///      (etched code has fresh storage, so no constructor runs); init
    ///      wires the Permit2 address afterwards.
    function init(address _permit2) external {
        permit2Addr = _permit2;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function allowance(address, address spender) external view returns (uint256) {
        if (spender == permit2Addr) return type(uint256).max;
        return 0;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == permit2Addr && amount < type(uint256).max) {
            assembly {
                mstore(0x00, shl(224, 0x3f68539a))
                revert(0x00, 0x04)
            }
        }
        _allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        // Pulls routed through Permit2 rely on the hardcoded infinite
        // token-level approval, exactly like the real token.
        if (msg.sender != permit2Addr) {
            uint256 allowed = _allowance[from][msg.sender];
            require(allowed >= amount, "mock musebook: allowance too low");
            if (allowed != type(uint256).max) {
                _allowance[from][msg.sender] = allowed - amount;
            }
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Mock Uniswap v4 PoolManager: executes the caller's unlock callback
///         and settles swaps against configurable spot prices, with failure
///         modes for slippage / revert / partial-fill / settle-failure tests.
contract MockPoolManager {
    uint256 internal constant Q96 = 2 ** 96;

    struct PoolCfg {
        uint160 sqrtPriceX96; // spot sqrt price, Q96 (0 = uninitialized)
        uint256 priceX96; // token1 per token0, Q96 (test keeps consistent)
        uint256 outBps; // payout vs the spot quote (10_000 = honest)
        bool initialized;
        bool revertSwap;
        uint256 partialBps; // share of input actually consumed (10_000 = full)
    }

    mapping(bytes32 => PoolCfg) public pools;
    mapping(address => MockToken) public tokens; // currency -> token
    mapping(address => uint256) public debt; // what the unlock caller owes
    mapping(address => uint256) public credit; // what the unlock caller may take
    mapping(address => uint256) public syncSnap;
    mapping(bytes32 => bytes32) internal slotValues; // extsload slot -> packed slot0
    address[] internal syncedCurrencies;
    mapping(address => bool) internal isSynced;
    bool public unlockReverts;
    bool public revertSettle;

    uint256 internal constant POOLS_SLOT = 6;

    receive() external payable {}

    function setToken(address currency, MockToken t) external {
        tokens[currency] = t;
    }

    function setPool(bytes32 id, uint160 sqrtPriceX96, uint256 priceX96) external {
        pools[id] = PoolCfg(sqrtPriceX96, priceX96, 10_000, true, false, 10_000);
        // Pack slot0 the way the real PoolManager lays it out:
        // sqrtPriceX96 | tick(0) | protocolFee(0) | lpFee(0).
        uint256 packed = uint256(sqrtPriceX96);
        slotValues[keccak256(abi.encode(id, POOLS_SLOT))] = bytes32(packed);
    }

    function setOutBps(bytes32 id, uint256 bps) external {
        pools[id].outBps = bps;
    }

    function setRevertSwap(bytes32 id, bool v) external {
        pools[id].revertSwap = v;
    }

    function setPartialBps(bytes32 id, uint256 bps) external {
        pools[id].partialBps = bps;
    }

    function setUninitialized(bytes32 id) external {
        pools[id].initialized = false;
        pools[id].sqrtPriceX96 = 0;
        slotValues[keccak256(abi.encode(id, POOLS_SLOT))] = bytes32(0);
    }

    function setUnlockReverts(bool v) external {
        unlockReverts = v;
    }

    function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24) {
        revert("mock: getSlot0 does not exist on this chain");
    }

    /// @notice Raw storage read. The mock packs each pool's slot0 at
    ///         keccak256(abi.encode(poolId, uint256(6))), mirroring the real
    ///         PoolManager's pools-mapping layout (slot 6).
    function extsload(bytes32 slot) external view returns (bytes32) {
        return slotValues[slot];
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        require(!unlockReverts, "mock: unlock exploded");
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (BalanceDelta delta) {
        bytes32 id = keccak256(abi.encode(key));
        PoolCfg memory c = pools[id];
        require(c.initialized, "mock: pool not initialized");
        require(!c.revertSwap, "mock: swap exploded");
        // Exact input only, canonical v4 sign: NEGATIVE amountSpecified.
        require(params.amountSpecified < 0, "mock: only exact input");

        uint256 amountIn = uint256(-params.amountSpecified);
        uint256 consumed = (amountIn * c.partialBps) / 10_000;
        address inCur = params.zeroForOne ? key.currency0 : key.currency1;
        address outCur = params.zeroForOne ? key.currency1 : key.currency0;

        uint256 quote = params.zeroForOne ? (consumed * c.priceX96) / Q96 : (consumed * Q96) / c.priceX96;
        uint256 amountOut = (quote * c.outBps) / 10_000;

        debt[inCur] += consumed;
        credit[outCur] += amountOut;
        if (outCur == address(0)) {
            require(address(this).balance >= amountOut, "mock: pm broke");
        } else {
            tokens[outCur].mint(address(this), amountOut);
        }

        int128 a0 = params.zeroForOne ? -int128(int256(consumed)) : int128(int256(amountOut));
        int128 a1 = params.zeroForOne ? int128(int256(amountOut)) : -int128(int256(consumed));
        delta = _pack(a0, a1);
    }

    /// @notice Settle debts: native via msg.value, ERC20 via prior sync+transfer.
    ///         Mirrors this chain's modified PoolManager, where the no-args
    ///         settle() covers both cases and settle(address) does NOT exist.
    function settle() external payable returns (uint256 paid) {
        require(!revertSettle, "mock: settle exploded");
        if (debt[address(0)] > 0) {
            require(msg.value == debt[address(0)], "mock: settle amount mismatch");
            paid = msg.value;
            debt[address(0)] = 0;
        } else {
            require(msg.value == 0, "mock: unexpected native value");
        }
        for (uint256 i = 0; i < syncedCurrencies.length; i++) {
            address c = syncedCurrencies[i];
            if (debt[c] > 0) {
                uint256 got = tokens[c].balanceOf(address(this)) - syncSnap[c];
                require(got >= debt[c], "mock: underpaid settle");
                debt[c] = 0;
            }
            isSynced[c] = false;
        }
        delete syncedCurrencies;
    }

    function sync(address currency) external {
        syncSnap[currency] = tokens[currency].balanceOf(address(this));
        if (!isSynced[currency]) {
            isSynced[currency] = true;
            syncedCurrencies.push(currency);
        }
    }

    function take(address currency, address recipient, uint256 amount) external {
        require(amount <= credit[currency], "mock: take exceeds credit");
        credit[currency] -= amount;
        if (currency == address(0)) {
            (bool ok,) = recipient.call{value: amount}("");
            require(ok, "mock: native take failed");
        } else {
            tokens[currency].transfer(recipient, amount);
        }
    }

    function setRevertSettle(bool v) external {
        revertSettle = v;
    }

    /// @dev Pack (amount0, amount1) the way this chain's modified PoolManager
    ///      does: amount0 in the HIGH 128 bits, amount1 in the LOW 128 bits
    ///      (flipped vs canonical v4-core). Verified against the live fork.
    function _pack(int128 a0, int128 a1) internal pure returns (BalanceDelta) {
        uint256 packed = (uint256(uint128(a0)) << 128) | uint256(uint128(a1));
        return BalanceDelta.wrap(bytes32(packed));
    }
}

/// @notice Mock Permit2: records token->spender approvals; the mock
///         PositionManager pulls through it, mirroring the real periphery.
contract MockPermit2 {
    mapping(address => mapping(address => uint256)) public allowance; // token -> spender -> amount

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowance[token][spender] = amount;
    }

    /// @notice Pull tokens through the Permit2 allowance. The token sees
    ///         Permit2 as msg.sender, so it checks allowance[user][permit2].
    function transferFrom(address token, address from, address to, uint256 amount) external {
        require(allowance[token][msg.sender] >= amount, "mock permit2: allowance too low");
        allowance[token][msg.sender] -= amount;
        MockToken(token).transferFrom(from, to, amount);
    }
}

/// @notice Mock v4 PositionManager: pulls the max amounts (scaled by pullBps),
///         records the mint, and issues the NFT to the recipient.
contract MockPositionManager {
    uint256 public nextId = 1;
    uint256 public pullBps = 10_000; // share of the max amounts actually pulled
    bool public revertMint;
    address public lastRecipient;
    int24 public lastTickLower;
    int24 public lastTickUpper;
    uint128 public lastLiquidity;
    uint256 public lastAmount0Max;
    uint256 public lastAmount1Max;
    uint256 public lastAmount0;
    uint256 public lastAmount1;
    uint256 public lastMsgValue;
    mapping(uint256 => address) public ownerOf;

    MockToken public mdog; // ERC20 pulled via Permit2 (currency1 in the native pair)
    MockToken public musebook; // ERC20 pulled via Permit2 (currency1 in the MDOG/musebook pair)
    MockPermit2 public permit2Contract;

    constructor(MockToken _mdog, MockToken _musebook) {
        mdog = _mdog;
        musebook = _musebook;
        permit2Contract = new MockPermit2();
    }

    function permit2() external view returns (address) {
        return address(permit2Contract);
    }

    function setPullBps(uint256 bps) external {
        pullBps = bps;
    }

    function setRevertMint(bool v) external {
        revertMint = v;
    }

    /// @dev Expects unlockData = abi.encode(bytes actions, bytes[] params)
    ///      with actions = [MINT_POSITION (2), SETTLE_PAIR (13)] for an
    ///      ERC20/ERC20 mint, or [MINT_POSITION, SETTLE_PAIR, SWEEP (20)] for
    ///      the native+ERC20 mint. Robinhood's POSM uses packed bytes for
    ///      actions (not uint256[]).
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        require(!revertMint, "mock: mint exploded");
        require(deadline >= block.timestamp, "mock: expired");
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        require(actions.length >= 2 && uint8(actions[0]) == 2 && uint8(actions[1]) == 13, "mock: bad actions");
        require(params.length >= 2, "mock: bad params");
        (
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 amount0Max,
            uint256 amount1Max,
            address recipient,
        ) = abi.decode(params[0], (PoolKey, int24, int24, uint128, uint256, uint256, address, bytes));
        (address c0, address c1) = abi.decode(params[1], (address, address));
        require(c0 == key.currency0 && c1 == key.currency1, "mock: bad settle pair");

        if (key.currency0 == address(0)) {
            // Native + ERC20 mint: 3 actions with a trailing SWEEP.
            require(actions.length == 3 && uint8(actions[2]) == 20, "mock: bad actions");
            require(params.length == 3, "mock: bad params");
            uint256 pull0 = (amount0Max * pullBps) / 10_000;
            uint256 pull1 = (amount1Max * pullBps) / 10_000;
            require(msg.value >= pull0, "mock: insufficient native");
            lastMsgValue = msg.value;
            if (pull1 > 0) {
                _pullErc20(key.currency1, pull1);
            }
            // Refund unpulled native: models a periphery that consumed less than
            // the max (the splitter's dust accounting sees funds never leave).
            // NOTE: the real PositionManager does NOT refund excess msg.value —
            // the splitter therefore always sends the exact computed need.
            uint256 refund = msg.value - pull0;
            if (refund > 0) {
                (bool ok,) = msg.sender.call{value: refund}("");
                require(ok, "mock: refund failed");
            }
            lastAmount0 = pull0;
            lastAmount1 = pull1;
        } else {
            // ERC20/ERC20 mint: no native value; both sides pulled via Permit2.
            require(msg.value == 0, "mock: unexpected native");
            lastMsgValue = 0;
            uint256 pull0 = (amount0Max * pullBps) / 10_000;
            uint256 pull1 = (amount1Max * pullBps) / 10_000;
            if (pull0 > 0) {
                _pullErc20(key.currency0, pull0);
            }
            if (pull1 > 0) {
                _pullErc20(key.currency1, pull1);
            }
            lastAmount0 = pull0;
            lastAmount1 = pull1;
        }

        uint256 tokenId = nextId++;
        ownerOf[tokenId] = recipient;
        lastRecipient = recipient;
        lastTickLower = tickLower;
        lastTickUpper = tickUpper;
        lastLiquidity = liquidity;
        lastAmount0Max = amount0Max;
        lastAmount1Max = amount1Max;
    }

    /// @dev Pull an ERC20 through Permit2, like the real PositionManager: the
    ///      caller must have approved token->Permit2 and Permit2->(this) as
    ///      spender. Permit2 is the msg.sender to the token, so the token
    ///      checks allowance[caller][permit2].
    function _pullErc20(address currency, uint256 amount) internal {
        MockToken t;
        if (currency == address(mdog)) {
            t = mdog;
        } else if (currency == address(musebook)) {
            t = musebook;
        } else {
            revert("mock: unknown erc20");
        }
        require(t.allowance(msg.sender, address(permit2Contract)) >= amount, "mock: no token->permit2 approval");
        permit2Contract.transferFrom(address(t), msg.sender, address(this), amount);
    }
}

/// @notice Receiver whose fallback reverts while the flag is set.
contract RevertingReceiver {
    bool public reverting = true;

    function setReverting(bool v) external {
        reverting = v;
    }

    receive() external payable {
        require(!reverting, "nope");
    }
}

/// @notice Malicious mikey: re-enters process() from receive().
contract ReentrantMikey {
    MuseDogsFeeSplitter internal s;
    bool public attacked;

    function setSplitter(MuseDogsFeeSplitter _s) external {
        s = _s;
    }

    receive() external payable {
        attacked = true;
        // Attempt reentry: the inner process() hits the OZ nonReentrant
        // guard (or the DexLegReentrant flag) and reverts; _tryPush treats
        // the push as delivered (it was).
        try s.process() {} catch {}
    }
}

/// @notice Malicious MDOG: tries to re-enter the splitter from the Permit2
///         pull (transferFrom) during a mint.
contract ReentrantMdog is MockToken {
    MuseDogsFeeSplitter public splitter;
    bool public attacked;
    bool public legBlocked; // reentrant executeMusebookLiquidity() was rejected
    bool public processBlocked; // reentrant process() was rejected

    function setSplitter(MuseDogsFeeSplitter _s) external {
        splitter = _s;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (address(splitter) != address(0) && from == address(splitter)) {
            attacked = true;
            // The bucket is already zeroed and the leg flag is held: both
            // must revert.
            try splitter.executeMusebookLiquidity() {}
            catch {
                legBlocked = true;
            }
            try splitter.process() {}
            catch {
                processBlocked = true;
            }
        }
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Exposes internal math for vector tests.
contract TickMathHarness is MuseDogsFeeSplitter {
    constructor(
        address payable _mikey,
        address payable _vault,
        address _owner,
        uint256 _threshold,
        address _pm,
        address _posm,
        address _meta,
        address _mdog,
        address _musebook,
        PoolKey memory _metaEthKey,
        PoolKey memory _metaMdogKey,
        PoolKey memory _metaMusebookKey,
        PoolKey memory _mdogEthKey,
        PoolKey memory _mdogMusebookKey
    )
        MuseDogsFeeSplitter(
            _mikey,
            _vault,
            _owner,
            _threshold,
            _pm,
            _posm,
            _meta,
            _mdog,
            _musebook,
            _metaEthKey,
            _metaMdogKey,
            _metaMusebookKey,
            _mdogEthKey,
            _mdogMusebookKey
        )
    {}

    function sqrtRatioAtTick(int24 tick) external pure returns (uint160) {
        return _getSqrtRatioAtTick(tick);
    }

    function sqrtPriceLimit(uint256 priceX96, bool upper) external view returns (uint160) {
        return _sqrtPriceLimit(priceX96, upper);
    }
}

/// @notice Attacker that calls poolManager.unlock() itself, then tries to
///         pivot into the splitter's unlockCallback from its own callback.
contract UnlockAttacker is IUnlockCallback {
    MuseDogsFeeSplitter internal splitter;
    MockPoolManager internal pm;

    constructor(MuseDogsFeeSplitter _s, MockPoolManager _pm) {
        splitter = _s;
        pm = _pm;
    }

    function attack() external {
        pm.unlock(abi.encode(uint256(0), uint256(0), uint256(0), uint160(0), uint160(0)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        // Pivot attempt: the splitter must reject this — msg.sender here is
        // the attacker, not the PoolManager.
        try splitter.unlockCallback(data) {} catch {}
        return "";
    }
}

// -----------------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------------

/// @notice Test suite for MuseDogsFeeSplitter (Uniswap v4, META-routed):
///         split math, threshold gating, the no-re-split accounting invariant,
///         fail-open pushes, owner forwarding, the autonomous META-routed DEX
///         engine (happy path, slippage/partial-fill/revert fail-safes),
///         PoolKey validation, callback auth, tick-math vectors, and
///         reentrancy.
contract MuseDogsFeeSplitterTest is Test {
    uint256 internal constant Q96 = 2 ** 96;
    uint160 internal constant SQRT_1 = 79228162514264337593543950336; // 2^96

    MuseDogsFeeSplitter splitter;

    ReentrantMdog internal evilMdog; // deployed first: lowest address
    MockToken internal mdog;
    MockToken internal musebook;
    MockToken internal meta;
    MockPoolManager internal pm;
    MockPositionManager internal posm;

    address payable internal mikey = payable(address(0xD06));
    address payable internal vault; // real MuseDogRewards, deployed in setUp
    address internal owner = address(0xBEEF);
    uint256 internal threshold = 0.1 ether;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    PoolKey internal metaEthKey;
    PoolKey internal metaMdogKey;
    PoolKey internal metaMusebookKey;
    PoolKey internal mdogEthKey;
    PoolKey internal mdogMusebookKey;
    bytes32 internal metaEthId;
    bytes32 internal metaMdogId;
    bytes32 internal metaMusebookId;
    bytes32 internal mdogEthId;
    bytes32 internal mdogMusebookId;

    function setUp() public {
        vm.chainId(4663); // constructor pins the splitter to Robinhood Chain
        vault = payable(address(new MuseDogRewards(owner)));
        // Token addresses are etched deterministically: the splitter's pool
        // keys require currency0 < currency1 (MDOG < musebook < META), and
        // CREATE addresses are hashes, so deployment order cannot guarantee
        // that. The templates carry no immutables, so their runtime code
        // works at any address with fresh storage.
        ReentrantMdog evilTemplate = new ReentrantMdog();
        MockToken tokenTemplate = new MockToken();
        vm.etch(address(uint160(0xF001)), address(evilTemplate).code);
        vm.etch(address(uint160(0xF002)), address(tokenTemplate).code);
        vm.etch(address(uint160(0xF003)), address(tokenTemplate).code);
        vm.etch(address(uint160(0xF004)), address(tokenTemplate).code);
        evilMdog = ReentrantMdog(address(uint160(0xF001)));
        mdog = MockToken(address(uint160(0xF002)));
        musebook = MockToken(address(uint160(0xF003)));
        meta = MockToken(address(uint160(0xF004)));
        pm = new MockPoolManager();
        posm = new MockPositionManager(mdog, musebook);
        pm.setToken(address(meta), meta);
        pm.setToken(address(mdog), mdog);
        pm.setToken(address(musebook), musebook);

        (metaEthKey, metaMdogKey, metaMusebookKey, mdogEthKey, mdogMusebookKey) = _standardKeys(address(mdog));
        metaEthId = keccak256(abi.encode(metaEthKey));
        metaMdogId = keccak256(abi.encode(metaMdogKey));
        metaMusebookId = keccak256(abi.encode(metaMusebookKey));
        mdogEthId = keccak256(abi.encode(mdogEthKey));
        mdogMusebookId = keccak256(abi.encode(mdogMusebookKey));

        // Honest 1:1 pools everywhere by default.
        _setPoolPrice(metaEthId, Q96);
        _setPoolPrice(metaMdogId, Q96);
        _setPoolPrice(metaMusebookId, Q96);
        _setPoolPrice(mdogEthId, Q96);
        _setPoolPrice(mdogMusebookId, Q96);

        splitter = new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
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
    }

    function _standardKeys(address _mdogTok)
        internal
        view
        returns (PoolKey memory e, PoolKey memory m, PoolKey memory mb, PoolKey memory d, PoolKey memory dm)
    {
        e = PoolKey({currency0: address(0), currency1: address(meta), fee: 3000, tickSpacing: 60, hooks: address(0)});
        m = PoolKey({currency0: _mdogTok, currency1: address(meta), fee: 3000, tickSpacing: 60, hooks: address(0)});
        mb = PoolKey({currency0: address(musebook), currency1: address(meta), fee: 3000, tickSpacing: 60, hooks: address(0)});
        d = PoolKey({currency0: address(0), currency1: _mdogTok, fee: 3000, tickSpacing: 60, hooks: address(0)});
        dm = PoolKey({currency0: _mdogTok, currency1: address(musebook), fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    /// @dev priceX96 = token1 per token0, Q96. Sets a consistent (sqrtP, price).
    function _setPoolPrice(bytes32 id, uint256 priceX96) internal {
        uint160 sqrtP = uint160(Math.sqrt(priceX96 * Q96));
        pm.setPool(id, sqrtP, priceX96);
    }

    /// @dev Splitter wired to the evil MDOG (for reentrancy tests).
    function _deployEvil() internal returns (MuseDogsFeeSplitter s, MockPositionManager evilPosm) {
        (PoolKey memory e, PoolKey memory m, PoolKey memory mb, PoolKey memory d, PoolKey memory dm) =
            _standardKeys(address(evilMdog));
        _setPoolPrice(keccak256(abi.encode(m)), Q96);
        _setPoolPrice(keccak256(abi.encode(mb)), Q96);
        _setPoolPrice(keccak256(abi.encode(dm)), Q96);
        pm.setToken(address(evilMdog), evilMdog);
        evilPosm = new MockPositionManager(evilMdog, musebook);
        s = new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(evilPosm),
            address(meta),
            address(evilMdog),
            address(musebook),
            e,
            m,
            mb,
            d,
            dm
        );
        evilMdog.setSplitter(s);
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    function test_ConstructorSetsImmutables() public view {
        assertEq(splitter.mikeyBankr(), mikey);
        assertEq(splitter.rewardsVault(), vault);
        assertEq(splitter.processThreshold(), threshold);
        assertEq(address(splitter.poolManager()), address(pm));
        assertEq(address(splitter.positionManager()), address(posm));
        assertEq(splitter.metaToken(), address(meta));
        assertEq(splitter.mdogToken(), address(mdog));
        assertEq(splitter.owner(), owner);
        assertEq(splitter.maxSlippageBps(), 300);
        PoolKey memory k = splitter.getMetaEthPoolKey();
        assertEq(k.currency0, address(0));
        assertEq(k.currency1, address(meta));
        assertEq(k.fee, 3000);
        PoolKey memory d = splitter.defaultMdogEthPoolKey();
        assertEq(d.currency0, address(0));
        assertEq(d.currency1, address(mdog));
        assertEq(d.fee, 3000);
        assertEq(d.tickSpacing, 60);
    }

    function test_ConstructorRejectsZeroAddresses() public {
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(
            payable(address(0)),
            vault,
            owner,
            threshold,
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
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(
            mikey,
            payable(address(0)),
            owner,
            threshold,
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
        // Zero owner: OZ's Ownable constructor reverts before our own checks.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            address(0),
            threshold,
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
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(0),
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
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(0),
            address(mdog),
            address(musebook),
            metaEthKey,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
        // meta == mdog is also rejected.
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(mdog),
            address(mdog),
            address(musebook),
            metaEthKey,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
    }

    function test_ConstructorRejectsZeroThreshold() public {
        vm.expectRevert(MuseDogsFeeSplitter.ZeroThreshold.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            0,
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
    }

    function test_ConstructorRejectsEoaContracts() public {
        // Vault must be a contract (it is called without a guard).
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.NotAContract.selector, address(0xE0A)));
        new MuseDogsFeeSplitter(
            mikey,
            payable(address(0xE0A)),
            owner,
            threshold,
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
        // ... as must the PoolManager ...
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.NotAContract.selector, address(0xE0B)));
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(0xE0B),
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
        // ... and the tokens.
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.NotAContract.selector, address(0xE0C)));
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(0xE0C),
            address(mdog),
            address(musebook),
            metaEthKey,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
    }

    function test_ConstructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.WrongChainId.selector, 4663, 1));
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
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
    }

    function test_ConstructorRejectsBadPoolKeys() public {
        // Swapped META/MDOG currencies.
        PoolKey memory swapped = PoolKey({
            currency0: address(meta), currency1: address(mdog), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        vm.expectRevert(MuseDogsFeeSplitter.InvalidPoolKey.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            metaEthKey,
            swapped,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
        // Zero fee.
        PoolKey memory noFee =
            PoolKey({currency0: address(mdog), currency1: address(meta), fee: 0, tickSpacing: 60, hooks: address(0)});
        vm.expectRevert(MuseDogsFeeSplitter.InvalidPoolKey.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            metaEthKey,
            noFee,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
        // Zero tick spacing.
        PoolKey memory noSpacing =
            PoolKey({currency0: address(mdog), currency1: address(meta), fee: 3000, tickSpacing: 0, hooks: address(0)});
        vm.expectRevert(MuseDogsFeeSplitter.InvalidPoolKey.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            metaEthKey,
            noSpacing,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
        // Wrong token in the ETH/META key (MDOG instead of META).
        PoolKey memory wrongToken =
            PoolKey({currency0: address(0), currency1: address(mdog), fee: 3000, tickSpacing: 60, hooks: address(0)});
        vm.expectRevert(MuseDogsFeeSplitter.InvalidPoolKey.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            wrongToken,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            mdogMusebookKey
        );
        // Swapped musebook/META currencies in the musebook routing key.
        PoolKey memory swappedMb = PoolKey({
            currency0: address(meta), currency1: address(musebook), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        vm.expectRevert(MuseDogsFeeSplitter.InvalidPoolKey.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            metaEthKey,
            metaMdogKey,
            swappedMb,
            mdogEthKey,
            mdogMusebookKey
        );
        // Swapped MDOG/musebook currencies in the LP key.
        PoolKey memory swappedDm = PoolKey({
            currency0: address(musebook), currency1: address(mdog), fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        vm.expectRevert(MuseDogsFeeSplitter.InvalidPoolKey.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            metaEthKey,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            swappedDm
        );
        // Zero fee on the unhooked MDOG/musebook LP key.
        PoolKey memory noFeeDm =
            PoolKey({currency0: address(mdog), currency1: address(musebook), fee: 0, tickSpacing: 60, hooks: address(0)});
        vm.expectRevert(MuseDogsFeeSplitter.InvalidPoolKey.selector);
        new MuseDogsFeeSplitter(
            mikey,
            vault,
            owner,
            threshold,
            address(pm),
            address(posm),
            address(meta),
            address(mdog),
            address(musebook),
            metaEthKey,
            metaMdogKey,
            metaMusebookKey,
            mdogEthKey,
            noFeeDm
        );
    }

    function test_RoyaltyReceivedEvent() public {
        vm.expectEmit(true, false, false, true);
        emit MuseDogsFeeSplitter.RoyaltyReceived(address(this), 0.5 ether);
        (bool ok,) = address(splitter).call{value: 0.5 ether}("");
        assertTrue(ok);
    }

    // -------------------------------------------------------------------------
    // Split math + threshold
    // -------------------------------------------------------------------------

    function test_ProcessSplitsTenFortyTwentyFiveTwentyFive() public {
        vm.deal(address(splitter), 1 ether);
        uint256 mikeyBefore = mikey.balance;
        uint256 vaultBefore = vault.balance;

        vm.prank(address(0xEE1)); // anyone can call
        splitter.process();

        assertEq(mikey.balance - mikeyBefore, 0.1 ether, "mikey 10%");
        assertEq(vault.balance - vaultBefore, 0.4 ether, "vault 40%");
        // Musebook-liquidity leg: 0.25 ETH -> 0.125 ETH routed to MDOG and
        // 0.125 ETH routed to musebook, then an MDOG/musebook LP NFT minted
        // directly to DEAD. The mint math rounds, so token leftovers are
        // asserted approximately.
        assertEq(splitter.musebookLiquidityPending(), 0, "musebook-liquidity bucket drained");
        assertEq(posm.ownerOf(1), DEAD, "musebook LP NFT owned by dead");
        assertApproxEqAbs(mdog.balanceOf(address(splitter)), 0, 1_000, "no mdog dust left");
        assertApproxEqAbs(musebook.balanceOf(address(splitter)), 0, 1_000, "no musebook dust left");
        assertEq(meta.balanceOf(address(splitter)), 0, "no meta dust left");
        // Liquidity leg: half routed, half native, LP NFT to DEAD.
        assertEq(splitter.liquidityPending(), 0, "liquidity bucket drained");
        assertEq(posm.lastRecipient(), DEAD, "LP minted to dead");
        assertEq(posm.ownerOf(2), DEAD, "MDOG/ETH NFT owned by dead");
        assertEq(posm.lastTickLower(), -887220, "full range lower");
        assertEq(posm.lastTickUpper(), 887220, "full range upper");
        assertEq(posm.lastLiquidity() > 0, true, "liquidity minted");
        // The whole 1 ETH is accounted for: nothing stranded, nothing pending.
        // Rounding dust from the mint math (a few wei at most) is swept as new
        // funds on the next process().
        assertApproxEqAbs(address(splitter).balance, 0, 1_000, "no ETH stranded");
        assertEq(splitter.totalPending(), 0, "nothing pending");
        assertEq(pm.debt(address(0)), 0, "no unsettled native debt");
        assertEq(pm.debt(address(meta)), 0, "no unsettled meta debt");
    }

    function test_ProcessEmitsProcessed() public {
        vm.deal(address(splitter), 1 ether);
        vm.expectEmit(false, false, false, true);
        emit MuseDogsFeeSplitter.Processed(1 ether, 0.1 ether, 0.4 ether, 0.25 ether, 0.25 ether, true, true);
        splitter.process();
    }

    function test_ProcessRemainderGoesToLiquidity() public {
        // 0.1 ether + 1 wei: floor divisions leave 1 wei, which must land in
        // the liquidity leg so the four legs sum to EXACTLY newFunds.
        pm.setRevertSwap(metaEthId, true); // keep the DEX legs escrowed
        vm.deal(address(splitter), 0.1 ether + 1);
        splitter.process();

        assertEq(mikey.balance, 0.01 ether, "mikey floor");
        assertEq(splitter.musebookLiquidityPending(), 0.025 ether, "musebook-liquidity floor");
        assertEq(splitter.liquidityPending(), 0.025 ether + 1, "liquidity gets the remainder wei");
        assertEq(address(splitter).balance, splitter.totalPending(), "balance == pending");
    }

    function test_ProcessExactlyAtThreshold() public {
        vm.deal(address(splitter), threshold);
        splitter.process(); // must not revert at exactly the threshold
        assertEq(splitter.totalPending(), 0);
    }

    function test_ProcessBelowThresholdReverts() public {
        vm.deal(address(splitter), 0.05 ether);
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.BelowThreshold.selector, threshold, 0.05 ether));
        splitter.process();
    }

    function test_ProcessNeverReSplitsEscrowedFunds() public {
        pm.setRevertSwap(metaEthId, true); // DEX legs stay escrowed
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether);
        assertEq(splitter.liquidityPending(), 0.25 ether);
        assertEq(address(splitter).balance, splitter.totalPending(), "no unaccounted ETH");

        // A second process() over the SAME escrowed balance must revert:
        // there are no NEW funds.
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.BelowThreshold.selector, threshold, 0));
        splitter.process();

        // New funds are split on their own; old buckets are untouched.
        vm.deal(address(splitter), address(splitter).balance + 0.1 ether);
        splitter.process();
        assertEq(splitter.musebookLiquidityPending(), 0.275 ether, "old + new musebook-liquidity");
        assertEq(splitter.liquidityPending(), 0.275 ether, "old + new liquidity");
        assertEq(splitter.mikeyPending(), 0, "mikey pushed");
        assertEq(address(splitter).balance, splitter.totalPending(), "invariant holds");
    }

    // -------------------------------------------------------------------------
    // Fail-open direct legs
    // -------------------------------------------------------------------------

    function test_FailedMikeyPushStaysPending() public {
        RevertingReceiver rr = new RevertingReceiver();
        MuseDogsFeeSplitter s = new MuseDogsFeeSplitter(
            payable(address(rr)),
            vault,
            owner,
            threshold,
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
        vm.deal(address(s), 1 ether);

        s.process(); // must NOT revert; mikey leg fails open
        assertEq(s.mikeyPending(), 0.1 ether, "mikey share escrowed");
        assertEq(vault.balance, 0.4 ether, "vault leg unaffected");
        assertEq(address(rr).balance, 0, "reverting receiver got nothing");

        // Permissionless retry once the receiver is fixed.
        rr.setReverting(false);
        vm.prank(address(0xEE2));
        s.claimMikey();
        assertEq(address(rr).balance, 0.1 ether, "retry delivered");
        assertEq(s.mikeyPending(), 0, "bucket cleared");
    }

    function test_FailedVaultPushStaysPending() public {
        RevertingReceiver rr = new RevertingReceiver();
        MuseDogsFeeSplitter s = new MuseDogsFeeSplitter(
            mikey,
            payable(address(rr)),
            owner,
            threshold,
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
        vm.deal(address(s), 1 ether);

        s.process();
        assertEq(s.rewardsPending(), 0.4 ether, "vault share escrowed");
        assertEq(mikey.balance, 0.1 ether, "mikey leg unaffected");

        rr.setReverting(false);
        vm.prank(address(0xEE3));
        s.claimRewards();
        assertEq(address(rr).balance, 0.4 ether, "retry delivered");
        assertEq(s.rewardsPending(), 0, "bucket cleared");
    }

    function test_ClaimNothingPendingReverts() public {
        vm.expectRevert(MuseDogsFeeSplitter.NothingPending.selector);
        splitter.claimMikey();
        vm.expectRevert(MuseDogsFeeSplitter.NothingPending.selector);
        splitter.claimRewards();
    }

    // -------------------------------------------------------------------------
    // Owner forwarding (partial, with rollback)
    // -------------------------------------------------------------------------

    function test_ForwardBuybackPartial() public {
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        address payable dest = payable(address(0xF01));
        vm.expectEmit(true, false, false, true);
        emit MuseDogsFeeSplitter.MusebookLiquidityForwarded(dest, 0.1 ether);
        vm.prank(owner);
        splitter.forwardMusebookLiquidity(dest, 0.1 ether);

        assertEq(dest.balance, 0.1 ether, "partial forward delivered");
        assertEq(splitter.musebookLiquidityPending(), 0.15 ether, "rest stays escrowed");
        assertEq(address(splitter).balance, splitter.totalPending(), "invariant holds");
    }

    function test_ForwardBuybackValidations() public {
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        vm.prank(owner);
        vm.expectRevert(MuseDogsFeeSplitter.ZeroAddress.selector);
        splitter.forwardMusebookLiquidity(payable(address(0)), 0.1 ether);

        vm.prank(owner);
        vm.expectRevert(MuseDogsFeeSplitter.NothingPending.selector);
        splitter.forwardMusebookLiquidity(payable(address(0xF01)), 0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.InsufficientPending.selector, 1 ether, 0.25 ether));
        splitter.forwardMusebookLiquidity(payable(address(0xF01)), 1 ether);

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        splitter.forwardMusebookLiquidity(payable(address(0xF01)), 0.1 ether);

        // Failed transfer rolls the bucket back.
        RevertingReceiver rr = new RevertingReceiver();
        vm.prank(owner);
        vm.expectRevert(MuseDogsFeeSplitter.TransferFailed.selector);
        splitter.forwardMusebookLiquidity(payable(address(rr)), 0.1 ether);
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "bucket restored");
    }

    function test_ForwardLiquidityPartial() public {
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        address payable dest = payable(address(0xF02));
        vm.prank(owner);
        splitter.forwardLiquidity(dest, 0.2 ether);

        assertEq(dest.balance, 0.2 ether);
        assertEq(splitter.liquidityPending(), 0.05 ether, "rest stays escrowed");

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(MuseDogsFeeSplitter.InsufficientPending.selector, 0.06 ether, 0.05 ether)
        );
        splitter.forwardLiquidity(dest, 0.06 ether);
    }

    // -------------------------------------------------------------------------
    // Musebook-liquidity leg: ETH -> META -> {MDOG, musebook}, then an
    // MDOG/musebook LP NFT minted straight to DEAD
    // -------------------------------------------------------------------------

    function test_MusebookLiquidityTwoHopMath() public {
        // Non-1:1 prices: 1 ETH = 2 META, 1 META = 2 MDOG, 1 META = 2 musebook.
        _setPoolPrice(metaEthId, 2 * Q96);
        _setPoolPrice(metaMdogId, Q96 / 2);
        _setPoolPrice(metaMusebookId, Q96 / 2);
        // Disable the MDOG/ETH leg so the mock's last-mint getters reflect
        // the musebook leg's mint (it runs first).
        pm.setUninitialized(mdogEthId);
        vm.deal(address(splitter), 1 ether);

        splitter.process();

        // 0.125 ETH -> 0.25 META -> 0.5 MDOG and 0.125 ETH -> 0.25 META ->
        // 0.5 musebook, all deposited as an LP NFT owned by DEAD. The mint
        // math rounds, so the deposited amounts are exact only to the wei.
        assertEq(posm.ownerOf(1), DEAD, "musebook LP NFT owned by dead");
        assertApproxEqAbs(posm.lastAmount0(), 0.5 ether, 1_000, "MDOG side deposited");
        assertApproxEqAbs(posm.lastAmount1(), 0.5 ether, 1_000, "musebook side deposited");
        assertEq(posm.lastTickLower(), -887220, "full range lower");
        assertEq(posm.lastTickUpper(), 887220, "full range upper");
        assertEq(posm.lastLiquidity() > 0, true, "liquidity minted");
        assertEq(splitter.musebookLiquidityPending(), 0, "bucket drained");
        assertEq(meta.balanceOf(address(splitter)), 0, "no META stranded");
        assertApproxEqAbs(mdog.balanceOf(address(splitter)), 0, 1_000, "no MDOG stranded");
        assertApproxEqAbs(musebook.balanceOf(address(splitter)), 0, 1_000, "no musebook stranded");
    }

    function test_MusebookLiquiditySweepsPreExistingDust() public {
        // Seed balanced dust from "previous legs": it must be swept INTO the
        // mint, not ignored.
        mdog.mint(address(splitter), 0.1 ether);
        musebook.mint(address(splitter), 0.1 ether);
        // Disable the MDOG/ETH leg so the mock's last-mint getters reflect
        // the musebook leg's mint (it runs first).
        pm.setUninitialized(mdogEthId);
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        // The leg's routed 0.125 + pre-existing 0.1 of each side: the mint
        // sees the full 0.225 balances (rounded in the math).
        assertEq(posm.ownerOf(1), DEAD, "musebook LP NFT owned by dead");
        assertApproxEqAbs(posm.lastAmount0(), 0.225 ether, 1_000, "MDOG dust swept in");
        assertApproxEqAbs(posm.lastAmount1(), 0.225 ether, 1_000, "musebook dust swept in");
        assertApproxEqAbs(mdog.balanceOf(address(splitter)), 0, 1_000, "no MDOG dust left");
        assertApproxEqAbs(musebook.balanceOf(address(splitter)), 0, 1_000, "no musebook dust left");
    }

    /// @dev The real musebook token hardcodes an infinite token->Permit2
    ///      approval and reverts any finite approve() to Permit2 with
    ///      0x3f68539a (verified on-chain 2026-09-20). The pre-fix splitter
    ///      called forceApprove(permit2, amount) unconditionally and would
    ///      revert on both the approve and the revoke of the musebook leg.
    function test_MusebookLegWithPermit2LockedToken() public {
        // Swap the musebook mock for the permit2-locked behavior.
        MockMusebookToken mbTemplate = new MockMusebookToken();
        vm.etch(address(musebook), address(mbTemplate).code);
        address permit2Addr = address(posm.permit2Contract());
        MockMusebookToken(address(musebook)).init(permit2Addr);

        // Sanity: the mock really does revert finite Permit2 approvals.
        vm.expectRevert(bytes4(0x3f68539a));
        MockMusebookToken(address(musebook)).approve(permit2Addr, 1_000);

        // Disable the MDOG/ETH leg so the mock's last-mint getters reflect
        // the musebook leg's mint (it runs first).
        pm.setUninitialized(mdogEthId);
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        assertEq(posm.ownerOf(1), DEAD, "musebook LP NFT owned by dead");
        assertEq(posm.lastLiquidity() > 0, true, "liquidity minted");
        assertEq(splitter.musebookLiquidityPending(), 0, "bucket drained");
    }

    /// @dev Decodes and asserts a MusebookLiquidityExecuted log. Kept as a
    ///      helper so the recordLogs loop stays shallow (stack-too-deep).
    function _assertMusebookLiquidityLog(Vm.Log memory log) internal {
        (uint256 ethIn, uint256 mdogUsed, uint256 mbUsed, int24 tl, int24 tu) =
            abi.decode(log.data, (uint256, uint256, uint256, int24, int24));
        assertEq(ethIn, 0.25 ether, "event ethIn");
        assertApproxEqAbs(mdogUsed, 0.125 ether, 1_000, "event mdogUsed");
        assertApproxEqAbs(mbUsed, 0.125 ether, 1_000, "event musebookUsed");
        assertEq(tl, -887220, "event tickLower");
        assertEq(tu, 887220, "event tickUpper");
    }

    function test_MusebookLiquidityEmitsEvent() public {
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        pm.setRevertSwap(metaEthId, false);

        // The deposited amounts come out of rounding math, so the event args
        // are read back from the recorded log: ethIn and the ticks are exact,
        // the token amounts are asserted approximately.
        vm.recordLogs();
        splitter.executeMusebookLiquidity();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("MusebookLiquidityExecuted(uint256,uint256,uint256,int24,int24)");
        uint256 matches;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) {
                matches++;
                _assertMusebookLiquidityLog(logs[i]);
            }
        }
        assertEq(matches, 1, "MusebookLiquidityExecuted emitted exactly once");
    }

    function test_MusebookLiquidityDustStaysAsTokens() public {
        posm.setPullBps(5_000); // periphery pulls only half of each side
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        assertEq(splitter.musebookLiquidityPending(), 0, "leg completed");
        // Unpulled halves stay as their tokens for the next DEX leg.
        assertGt(mdog.balanceOf(address(splitter)), 0, "mdog dust stays");
        assertGt(musebook.balanceOf(address(splitter)), 0, "musebook dust stays");
        assertEq(splitter.totalPending(), 0, "nothing pending");
    }

    function test_MusebookLiquidityMintRevertKeepsFundsEscrowed() public {
        posm.setRevertMint(true);
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert: the leg is skipped

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "musebook-liquidity stays escrowed");
        assertEq(splitter.liquidityPending(), 0.25 ether, "MDOG/ETH leg unaffected");
        assertEq(address(splitter).balance, splitter.totalPending(), "invariant holds");

        // Standalone retry surfaces the revert and restores the bucket...
        vm.expectRevert("mock: mint exploded");
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "bucket restored by revert");

        // ...and a later keeper call succeeds once the periphery is healthy.
        posm.setRevertMint(false);
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0, "retry drained the bucket");
        assertEq(posm.ownerOf(1), DEAD, "musebook LP to dead");
    }

    // -------------------------------------------------------------------------
    // Liquidity leg: half routed, half native, LP NFT to DEAD
    // -------------------------------------------------------------------------

    function test_LiquidityHappyPath() public {
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        // Half the leg (0.125 ETH) was routed to MDOG; half stayed native.
        // The mint math rounds, so amounts are exact only to the wei.
        assertApproxEqAbs(posm.lastAmount1(), 0.125 ether, 1_000, "mdog side came from the routed half");
        assertEq(posm.lastMsgValue() <= 0.125 ether, true, "native side never exceeds the retained half");
        assertApproxEqAbs(posm.lastAmount0() + posm.lastAmount1(), 0.25 ether, 1_000, "whole leg deposited");
        // Full-range position minted DIRECTLY to the dead address. The
        // musebook leg minted id 1 first; this leg minted id 2.
        assertEq(posm.lastRecipient(), DEAD, "LP minted to dead");
        assertEq(posm.ownerOf(2), DEAD, "MDOG/ETH NFT owned by dead");
        assertEq(posm.lastTickLower(), -887220, "full range lower");
        assertEq(posm.lastTickUpper(), 887220, "full range upper");
        assertEq(posm.lastLiquidity() > 0, true, "liquidity minted");
        // Exact native msg.value: the periphery never sees excess.
        assertEq(posm.lastMsgValue(), posm.lastAmount0Max(), "exact native forwarded");
        // Approval hygiene: token->Permit2 and Permit2->PositionManager are
        // both pulled back to zero after the mint.
        assertEq(mdog.allowance(address(splitter), address(posm.permit2Contract())), 0, "token->permit2 reset");
        assertEq(
            posm.permit2Contract().allowance(address(mdog), address(posm)), 0, "permit2->positionManager reset"
        );
        // Nothing stranded.
        assertEq(splitter.liquidityPending(), 0, "bucket drained");
        assertApproxEqAbs(address(splitter).balance, 0, 1_000, "no ETH stranded");
        assertApproxEqAbs(mdog.balanceOf(address(splitter)), 0, 1_000, "no MDOG stranded");
    }

    function test_LiquidityDustStaysNative() public {
        posm.setPullBps(5_000); // periphery pulls only half of each side
        vm.deal(address(splitter), 1 ether);
        splitter.process();

        assertEq(splitter.liquidityPending(), 0, "leg completed");
        assertEq(splitter.musebookLiquidityPending(), 0, "musebook leg completed");
        // Native dust stays NATIVE (no wrapping in v4): swept next process().
        // The mock refunds the unpulled half of the exact native sent.
        assertGt(address(splitter).balance, 0, "native dust stays as ETH");
        // Token dust stays as tokens for the next DEX leg.
        assertGt(mdog.balanceOf(address(splitter)), 0, "mdog dust stays");
        assertGt(musebook.balanceOf(address(splitter)), 0, "musebook dust stays");
        assertEq(splitter.totalPending(), 0, "nothing pending");
        assertGe(address(splitter).balance, splitter.totalPending(), "invariant holds");
    }

    function test_LiquidityDustSweptNextProcess() public {
        posm.setPullBps(5_000);
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        uint256 dustEth = address(splitter).balance;
        assertGt(dustEth, 0, "dust from leg 1");

        // Next royalty payment: the dust is swept in as new funds.
        posm.setPullBps(10_000);
        vm.deal(address(splitter), address(splitter).balance + 1 ether);
        uint256 mikeyBefore = mikey.balance;
        splitter.process();

        // newFunds was exactly 1 ether + dustEth; mikey's 10% is exact math.
        uint256 expectedMikey = ((1 ether + dustEth) * 1000) / 10_000;
        assertEq(mikey.balance - mikeyBefore, expectedMikey, "dust included in mikey share");
        assertEq(splitter.totalPending(), 0, "all legs drained");
        assertApproxEqAbs(address(splitter).balance, 0, 1_000, "no ETH stranded");
    }

    function test_LiquidityMintRevertKeepsFundsEscrowed() public {
        posm.setRevertMint(true);
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert: the legs are skipped

        // The mock's revert flag hits every mint, so BOTH legs stay escrowed.
        assertEq(splitter.liquidityPending(), 0.25 ether, "liquidity stays escrowed");
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "musebook-liquidity stays escrowed");
        assertEq(address(splitter).balance, splitter.totalPending(), "invariant holds");

        // Standalone retry surfaces the revert and restores the bucket...
        vm.expectRevert("mock: mint exploded");
        splitter.executeLiquidity();
        assertEq(splitter.liquidityPending(), 0.25 ether, "bucket restored by revert");

        // ...and a later keeper call succeeds once the periphery is healthy.
        posm.setRevertMint(false);
        splitter.executeLiquidity();
        assertEq(splitter.liquidityPending(), 0, "retry drained the bucket");
        assertEq(posm.ownerOf(1), DEAD, "LP to dead");
    }

    function test_LiquidityUninitializedPoolReverts() public {
        pm.setUninitialized(mdogEthId);
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // skipped, not reverted

        assertEq(splitter.liquidityPending(), 0.25 ether, "liquidity stays escrowed");
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.PoolNotInitialized.selector, mdogEthId));
        splitter.executeLiquidity();
        assertEq(splitter.liquidityPending(), 0.25 ether, "bucket restored");
    }

    function test_ExecuteNothingPendingReverts() public {
        vm.expectRevert(MuseDogsFeeSplitter.NothingPending.selector);
        splitter.executeMusebookLiquidity();
        vm.expectRevert(MuseDogsFeeSplitter.NothingPending.selector);
        splitter.executeLiquidity();
    }

    // -------------------------------------------------------------------------
    // Fail-safe escrow: slippage, partial fills, reverts
    // -------------------------------------------------------------------------

    function test_DexLegsSkipWhenPoolUninitialized() public {
        pm.setUninitialized(metaMdogId);
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "musebook-liquidity stays escrowed");
        assertEq(splitter.liquidityPending(), 0.25 ether, "liquidity stays escrowed");
        assertEq(mikey.balance, 0.1 ether, "mikey leg unaffected");
        assertEq(address(splitter).balance, splitter.totalPending(), "nothing leaked");

        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.PoolNotInitialized.selector, metaMdogId));
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "bucket restored by revert");
    }

    function test_FirstHopSlippageSkipsLeg() public {
        pm.setOutBps(metaEthId, 5_000); // hop 1 pays half the spot quote
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert: both legs skip

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "musebook-liquidity stays escrowed");
        assertEq(splitter.liquidityPending(), 0.25 ether, "liquidity stays escrowed");
        assertEq(meta.balanceOf(address(splitter)), 0, "no META stranded");
        assertEq(address(splitter).balance, splitter.totalPending(), "nothing leaked");

        // Standalone retry surfaces the exact slippage error:
        // received 0.0625 META vs minOut 0.125 * 0.97 = 0.12125.
        vm.expectRevert(
            abi.encodeWithSelector(MuseDogsFeeSplitter.SlippageExceeded.selector, 0.0625 ether, 0.12125 ether)
        );
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "bucket restored by revert");
    }

    function test_SecondHopSlippageSkipsLeg() public {
        pm.setOutBps(metaMdogId, 5_000); // hop 2 pays half the spot quote
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "musebook-liquidity stays escrowed");
        assertEq(splitter.liquidityPending(), 0.25 ether, "liquidity stays escrowed");
        // The failed multihop leaves NO intermediate token behind: hop 1's
        // META never escapes the reverted callback.
        assertEq(meta.balanceOf(address(splitter)), 0, "no META stranded");
        assertEq(mdog.balanceOf(address(splitter)), 0, "no MDOG stranded");

        // received 0.0625 MDOG vs minOut2 0.12125 * 0.97 = 0.1176125.
        vm.expectRevert(
            abi.encodeWithSelector(MuseDogsFeeSplitter.SlippageExceeded.selector, 0.0625 ether, 0.1176125 ether)
        );
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "bucket restored by revert");
    }

    function test_PartialFillRevertsLeg() public {
        // Seed a bucket first via a skipped process.
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        pm.setRevertSwap(metaEthId, false);

        // Now the price limit binds mid-swap: only half the input is consumed.
        pm.setPartialBps(metaEthId, 5_000);

        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.SwapPartialFill.selector, 0.0625 ether, 0.125 ether));
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "whole bucket restored, no half-spent funds");
        assertEq(meta.balanceOf(address(splitter)), 0, "no META stranded");
    }

    function test_SwapRevertKeepsFundsEscrowed() public {
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "musebook-liquidity stays escrowed");
        assertEq(splitter.liquidityPending(), 0.25 ether, "liquidity stays escrowed");
        assertEq(address(splitter).balance, 0.5 ether, "only push legs left");

        // A later keeper retry works once the pool is healthy again.
        pm.setRevertSwap(metaEthId, false);
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0, "retry drained the bucket");
        assertEq(posm.ownerOf(1), DEAD, "musebook LP NFT owned by dead");
    }

    function test_SettleRevertKeepsFundsEscrowed() public {
        pm.setRevertSettle(true);
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether, "musebook-liquidity stays escrowed");
        assertEq(address(splitter).balance, splitter.totalPending(), "nothing leaked");

        pm.setRevertSettle(false);
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0, "retry drained the bucket");
    }

    function test_UnlockRevertKeepsFundsEscrowed() public {
        pm.setUnlockReverts(true);
        vm.deal(address(splitter), 1 ether);
        splitter.process(); // must NOT revert

        assertEq(splitter.musebookLiquidityPending(), 0.25 ether);
        assertEq(splitter.liquidityPending(), 0.25 ether);
        pm.setUnlockReverts(false);
        splitter.executeMusebookLiquidity();
        assertEq(splitter.musebookLiquidityPending(), 0);
    }

    function test_DexLegSkippedEvents() public {
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        vm.expectEmit(false, false, false, true);
        emit MuseDogsFeeSplitter.DexLegSkipped("musebook-liquidity");
        vm.expectEmit(false, false, false, true);
        emit MuseDogsFeeSplitter.DexLegSkipped("liquidity");
        splitter.process();
    }

    // -------------------------------------------------------------------------
    // Callback auth
    // -------------------------------------------------------------------------

    function test_UnlockCallbackRejectsNonManager() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.NotPoolManager.selector, address(0xBAD)));
        splitter.unlockCallback("");
    }

    function test_AttackerUnlockCannotPivotIntoSplitter() public {
        // Escrow the DEX buckets first.
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        pm.setRevertSwap(metaEthId, false);
        uint256 pendingBefore = splitter.totalPending();

        // The attacker calls unlock() itself; the PoolManager calls back the
        // ATTACKER, whose pivot into the splitter's callback must fail.
        UnlockAttacker attacker = new UnlockAttacker(splitter, pm);
        attacker.attack();

        assertEq(splitter.totalPending(), pendingBefore, "splitter untouched");
        assertEq(splitter.musebookLiquidityPending(), 0.25 ether);
        assertEq(splitter.liquidityPending(), 0.25 ether);
    }

    // -------------------------------------------------------------------------
    // Reentrancy
    // -------------------------------------------------------------------------

    function test_ReentrantMikeyCannotDrain() public {
        ReentrantMikey evil = new ReentrantMikey();
        MuseDogsFeeSplitter s = new MuseDogsFeeSplitter(
            payable(address(evil)),
            vault,
            owner,
            threshold,
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
        evil.setSplitter(s);
        vm.deal(address(s), 1 ether);

        s.process(); // evil's receive() tries to re-enter process()

        assertTrue(evil.attacked(), "attacker did try to re-enter");
        // The reentrant inner process() found no new funds and reverted, so
        // the attacker got EXACTLY its legitimate 10% share, once — no more.
        assertEq(address(evil).balance, 0.1 ether, "attacker paid exactly once");
        assertEq(s.mikeyPending(), 0, "mikey leg settled");
        assertEq(vault.balance, 0.4 ether, "vault leg unaffected");
        assertEq(s.musebookLiquidityPending(), 0, "musebook-liquidity leg ran");
        assertEq(s.liquidityPending(), 0, "liquidity leg ran");
        assertEq(posm.ownerOf(1), DEAD, "musebook LP minted to dead once");
        // And there is nothing left to double-dip: no new funds, so process()
        // reverts.
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.BelowThreshold.selector, threshold, 0));
        s.process();
    }

    function test_ReentrantMdogCannotDrain() public {
        (MuseDogsFeeSplitter s, MockPositionManager evilPosm) = _deployEvil();
        vm.deal(address(s), 1 ether);

        s.process(); // evil hook fires during the Permit2 pull in the mint

        assertTrue(evilMdog.attacked(), "attacker did try to re-enter");
        assertTrue(evilMdog.processBlocked(), "reentrant process() rejected");
        assertTrue(evilMdog.legBlocked(), "reentrant leg rejected");
        // The LP NFT still minted exactly once to DEAD; the reentrant calls
        // changed nothing.
        assertEq(evilPosm.ownerOf(1), DEAD, "musebook LP minted exactly once");
        assertEq(s.musebookLiquidityPending(), 0, "musebook-liquidity bucket drained");
        assertApproxEqAbs(evilMdog.balanceOf(address(s)), 0, 1_000, "no mdog left beyond rounding");
        assertGe(address(s).balance, s.totalPending(), "invariant holds");
    }

    /// @notice The pathological case: a standalone leg (no process() guard
    ///         held) plus a malicious token callback that tries process().
    ///         The leg flag must reject it, or the zeroed bucket's in-flight
    ///         ETH would look "unaccounted" to the reentrant process.
    function test_StandaloneLegBlocksReentrantProcess() public {
        (MuseDogsFeeSplitter s, MockPositionManager evilPosm) = _deployEvil();

        // Escrow the buckets with the swaps disabled, then restore them.
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(s), 1 ether);
        s.process();
        assertEq(s.musebookLiquidityPending(), 0.25 ether);
        pm.setRevertSwap(metaEthId, false);

        // Standalone leg: the Permit2-pull hook tries process() and the leg
        // itself. The reentrant process() must revert (it would otherwise see
        // the zeroed bucket's in-flight ETH as new funds).
        s.executeMusebookLiquidity();

        assertTrue(evilMdog.attacked(), "hook fired");
        assertTrue(evilMdog.processBlocked(), "reentrant process() rejected");
        assertTrue(evilMdog.legBlocked(), "reentrant leg rejected");
        assertEq(evilPosm.ownerOf(1), DEAD, "musebook LP minted exactly once");
        assertEq(s.musebookLiquidityPending(), 0, "bucket drained");
        assertEq(address(s).balance, s.totalPending(), "invariant holds");
    }

    // -------------------------------------------------------------------------
    // Tick math + price-limit math: canonical vectors
    // -------------------------------------------------------------------------

    function _harness() internal returns (TickMathHarness h) {
        h = new TickMathHarness(
            mikey,
            vault,
            owner,
            threshold,
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
    }

    function test_TickMathVectors() public {
        TickMathHarness h = _harness();
        assertEq(h.sqrtRatioAtTick(0), 79228162514264337593543950336, "tick 0 = 2^96");
        assertEq(h.sqrtRatioAtTick(1), 79232123823359799118286999568, "tick 1");
        assertEq(h.sqrtRatioAtTick(-887272), 4295128739, "MIN_TICK");
        assertEq(h.sqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342, "MAX_TICK");
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.TickOutOfRange.selector, int24(887273)));
        h.sqrtRatioAtTick(887273);
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.TickOutOfRange.selector, int24(-887273)));
        h.sqrtRatioAtTick(-887273);
    }

    function test_SqrtPriceLimitDirection() public {
        TickMathHarness h = _harness();
        uint160 down = h.sqrtPriceLimit(Q96, false);
        uint160 up = h.sqrtPriceLimit(Q96, true);
        assertLt(down, SQRT_1, "zeroForOne limit sits below spot");
        assertGt(up, SQRT_1, "oneForZero limit sits above spot");
        assertGt(down, 0, "limit never zero");

        // Zero slippage tolerance pins the limit exactly at spot.
        vm.prank(owner);
        h.setMaxSlippageBps(0);
        assertEq(h.sqrtPriceLimit(Q96, false), SQRT_1, "0 bps: limit == spot");
        assertEq(h.sqrtPriceLimit(Q96, true), SQRT_1, "0 bps: limit == spot");
    }

    // -------------------------------------------------------------------------
    // Owner configuration
    // -------------------------------------------------------------------------

    function test_SetProcessThreshold() public {
        vm.prank(owner);
        splitter.setProcessThreshold(0.5 ether);
        assertEq(splitter.processThreshold(), 0.5 ether);

        vm.deal(address(splitter), 0.2 ether);
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.BelowThreshold.selector, 0.5 ether, 0.2 ether));
        splitter.process();

        vm.prank(owner);
        vm.expectRevert(MuseDogsFeeSplitter.ZeroThreshold.selector);
        splitter.setProcessThreshold(0);

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        splitter.setProcessThreshold(1 ether);
    }

    function test_SetMaxSlippageBps() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(MuseDogsFeeSplitter.SlippageBpsTooHigh.selector, 2001));
        splitter.setMaxSlippageBps(2001);

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        splitter.setMaxSlippageBps(500);

        vm.prank(owner);
        splitter.setMaxSlippageBps(500);
        assertEq(splitter.maxSlippageBps(), 500);
    }

    function test_OwnershipTwoStep() public {
        address newOwner = address(0xCAFE);
        vm.prank(owner);
        splitter.transferOwnership(newOwner);
        assertEq(splitter.owner(), owner, "still old owner until accepted");

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        splitter.acceptOwnership();

        vm.prank(newOwner);
        splitter.acceptOwnership();
        assertEq(splitter.owner(), newOwner, "ownership moved");
    }

    // -------------------------------------------------------------------------
    // Accounting invariant across a mixed operation sequence
    // -------------------------------------------------------------------------

    function test_BalanceAlwaysCoversPending() public {
        pm.setRevertSwap(metaEthId, true);
        vm.deal(address(splitter), 1 ether);
        splitter.process();
        assertGe(address(splitter).balance, splitter.totalPending(), "after process");

        vm.prank(owner);
        splitter.forwardMusebookLiquidity(payable(address(0xF01)), 0.1 ether);
        assertGe(address(splitter).balance, splitter.totalPending(), "after forward");

        vm.deal(address(splitter), address(splitter).balance + 0.3 ether);
        splitter.process();
        assertGe(address(splitter).balance, splitter.totalPending(), "after second process");

        pm.setRevertSwap(metaEthId, false);
        splitter.executeMusebookLiquidity();
        assertGe(address(splitter).balance, splitter.totalPending(), "after musebook-liquidity leg");
        splitter.executeLiquidity();
        assertGe(address(splitter).balance, splitter.totalPending(), "after liquidity");
        assertEq(splitter.totalPending(), 0, "all drained");
    }
}
