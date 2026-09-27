/* Log-replay snapshots for the rewards engine dry run.
 *
 * The public Robinhood Chain RPC is a PRUNED node: eth_call / balanceOf at
 * historical blocks fails ("historical state is not available"). eth_getLogs
 * and eth_getBlock DO work historically. So instead of reading state at old
 * blocks, we replay events:
 *
 *   spot balances:  ERC20 Transfer logs -> per-address running balance.
 *                   Exact for standard ERC20s (PORCH, MDOG).
 *   LP liquidity:   V4 PoolManager ModifyLiquidity logs -> per-position
 *                   liquidity at any block (salt == POSM tokenId).
 *   LP price:       V4 Swap logs -> last sqrtPriceX96 at or before each
 *                   snapshot block, per pool (falls back to the earliest
 *                   known price when a snapshot predates the first swap).
 *   LP ownership:   POSM Transfer logs -> owner of each position NFT.
 *   LP ticks:       from ModifyLiquidity args (immutable per position);
 *                   falls back to getPoolAndPositionInfo at latest.
 *
 * NOTE (2026-09-27): this chain's PoolManager does NOT emit Initialize —
 * verified on-chain: the pool-creation tx contains only ModifyLiquidity.
 * Pool liveness/birth is therefore discovered from the first
 * ModifyLiquidity event, never from Initialize. Do not re-add an
 * Initialize gate: it finds zero pools and silently drops all LP balances.
 *
 * Read-only. Never signs, never sends.
 */
'use strict';

const { ethers } = require('ethers');
const cfg = require('./config');
const { getAmountsForLiquidity } = require('./tickmath');

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const MODLIQ = ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
const SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

const PM_ABI = [
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 protocolFee)',
];
const POSM_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

const ZERO = '0x0000000000000000000000000000000000000000';
const CHUNK = cfg.LOG_CHUNK;

async function getLogsChunked(provider, args, label) {
  const { fromBlock, toBlock } = args;
  const chunks = Math.ceil((toBlock - fromBlock + 1) / CHUNK);
  const out = [];
  for (let i = 0; i < chunks; i++) {
    const s = fromBlock + i * CHUNK;
    const e = Math.min(toBlock, s + CHUNK - 1);
    if (i % 40 === 0) console.log(`  ${label} chunk ${i + 1}/${chunks}`);
    let tries = 0;
    for (;;) {
      try { out.push(...await provider.getLogs({ ...args, fromBlock: s, toBlock: e })); break; }
      catch (err) {
        if (++tries >= 5) throw err;
        await new Promise((r) => setTimeout(r, 1500 * tries));
      }
    }
  }
  return out;
}

/* ---- spot: address -> sorted [[block, delta]] (delta signed bigint) ---- */
async function transferReplay(provider, token, fromBlock, toBlock) {
  const logs = await getLogsChunked(provider,
    { address: token, topics: [TRANSFER], fromBlock, toBlock }, `spot ${token.slice(0, 10)}`);
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const deltas = new Map();
  const bump = (a, d) => {
    a = a.toLowerCase();
    if (a === ZERO) return;
    if (!deltas.has(a)) deltas.set(a, []);
    deltas.get(a).push(d);
  };
  for (const l of logs) {
    const ev = iface.parseLog(l);
    const v = ev.args.value;
    bump(ev.args.from, [l.blockNumber, -v]);
    bump(ev.args.to, [l.blockNumber, v]);
  }
  for (const arr of deltas.values()) arr.sort((x, y) => x[0] - y[0]);
  console.log(`  spot ${token.slice(0, 10)}: ${logs.length} transfers, ${deltas.size} addrs`);
  return deltas;
}

/* balance of addr at block (inclusive) from replay deltas */
function balanceAt(deltas, addr, block) {
  const arr = deltas.get(addr.toLowerCase());
  if (!arr) return 0n;
  let bal = 0n;
  for (const [b, d] of arr) { if (b > block) break; bal += d; }
  return bal;
}

/* ---- POSM position NFT ownership timeline: tokenId -> [{block, to}] ---- */
async function positionTimeline(provider, fromBlock, toBlock) {
  const logs = await getLogsChunked(provider,
    { address: cfg.POSM, topics: [TRANSFER], fromBlock, toBlock }, 'posm');
  const iface = new ethers.Interface(POSM_ABI);
  const tl = new Map();
  for (const l of logs) {
    const ev = iface.parseLog(l);
    const id = ev.args.tokenId.toString();
    if (!tl.has(id)) tl.set(id, []);
    tl.get(id).push({ block: l.blockNumber, to: ev.args.to.toLowerCase() });
  }
  console.log(`  posm: ${logs.length} transfers, ${tl.size} position NFTs`);
  return tl;
}

function ownerAt(transfers, block) {
  let owner = null;
  for (const t of transfers) {
    if (t.block > block) break;
    owner = t.to === ZERO ? null : t.to;
  }
  return owner;
}

/* pool birth block: first ModifyLiquidity event (ascending probe from scanFrom).
 * This chain's PoolManager never emits Initialize (verified on-chain), so
 * probing for Initialize always returns null and would drop every pool.
 * The probe MUST run oldest-window-first: returning the minimum of the
 * newest non-empty window silently drops earlier mints. */
async function poolFirstActivityBlock(provider, poolManager, pid, scanFrom, nowBlock) {
  const W = 500000;
  for (let from = scanFrom; from <= nowBlock; from += W) {
    const to = Math.min(nowBlock, from + W - 1);
    let tries = 0, logs = null;
    for (;;) {
      try { logs = await provider.getLogs({ address: poolManager, topics: [MODLIQ, pid], fromBlock: from, toBlock: to }); break; }
      catch (e) { if (++tries >= 5) throw e; await new Promise((r) => setTimeout(r, 1500 * tries)); }
    }
    if (logs.length > 0) return Math.min(...logs.map((l) => l.blockNumber));
  }
  return null;
}

/* ---- V4 liquidity + price replay per pool ---- */
async function v4Replay(provider, poolManager, poolIds, fromBlock, toBlock) {
  const pm = new ethers.Interface(PM_ABI);
  const topicsFor = (sig, pid) => [sig, pid];
  const birthFrom = {};
  await Promise.all(poolIds.map(async (pid) => {
    birthFrom[pid] = await poolFirstActivityBlock(provider, poolManager, pid, fromBlock, toBlock);
    console.log(`  pool ${pid.slice(0, 10)}… first activity block: ${birthFrom[pid]}`);
  }));
  const livePools = poolIds.filter((pid) => birthFrom[pid] !== null);
  const [modLogs, swapLogs] = await Promise.all([
    (async () => { const o = []; for (const pid of livePools) o.push(...await getLogsChunked(provider, { address: poolManager, topics: topicsFor(MODLIQ, pid), fromBlock: birthFrom[pid], toBlock }, `modliq ${pid.slice(0, 10)}`)); return o; })(),
    (async () => { const o = []; for (const pid of livePools) o.push(...await getLogsChunked(provider, { address: poolManager, topics: topicsFor(SWAP, pid), fromBlock: birthFrom[pid], toBlock }, `swap ${pid.slice(0, 10)}`)); return o; })(),
  ]);

  // liquidity: key `${poolId}:${tokenId}` -> {tickLower, tickUpper, deltas: [[block, delta]]}
  const liq = new Map();
  for (const l of modLogs) {
    const ev = pm.parseLog(l);
    const pid = l.topics[1].toLowerCase();
    const tokenId = BigInt(ev.args.salt).toString();
    const k = `${pid}:${tokenId}`;
    if (!liq.has(k)) {
      liq.set(k, {
        tickLower: Number(ev.args.tickLower), tickUpper: Number(ev.args.tickUpper),
        deltas: [],
      });
    }
    liq.get(k).deltas.push([l.blockNumber, ev.args.liquidityDelta]);
  }
  for (const v of liq.values()) v.deltas.sort((a, b) => a[0] - b[0]);

  // price: poolId -> sorted [[block, sqrtP]] (Swap events only — no Initialize on this chain)
  const prices = new Map();
  const pushPrice = (pid, b, sqrtP) => {
    pid = pid.toLowerCase();
    if (!prices.has(pid)) prices.set(pid, []);
    prices.get(pid).push([b, sqrtP]);
  };
  for (const l of swapLogs) pushPrice(l.topics[1], l.blockNumber, pm.parseLog(l).args.sqrtPriceX96);
  for (const arr of prices.values()) arr.sort((a, b) => a[0] - b[0]);

  console.log(`  v4: ${modLogs.length} modliq, ${swapLogs.length} swaps, ${liq.size} positions`);
  return { liq, prices };
}

function liquidityAt(entry, block) {
  let l = 0n;
  for (const [b, d] of entry.deltas) { if (b > block) break; l += d; }
  return l < 0n ? 0n : l;
}

function sqrtPAt(prices, poolId, block) {
  const arr = prices.get(poolId.toLowerCase());
  if (!arr || arr.length === 0) return null;
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid][0] <= block) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : arr[ans][1];
}

/* LP-held PORCH/MDOG per owner at block, from replays.
 * amount0/amount1 map to currency0/currency1 = tokens sorted by address. */
async function lpBalancesAtReplay(provider, timeline, v4, poolIds, block) {
  const out = {};
  const add = (o, sym, amt) => {
    if (amt === 0n || (sym !== 'porch' && sym !== 'mdog')) return;
    if (!out[o]) out[o] = { porch: 0n, mdog: 0n };
    out[o][sym] += amt;
  };
  // per pool: which reward token is currency0 (lower address)
  const c0sym = {};
  for (const pid of poolIds) {
    const p = cfg.POOLS[pid.toLowerCase()];
    if (!p) continue;
    const a0 = cfg.TOKENS[p.a].toLowerCase(), a1 = cfg.TOKENS[p.b].toLowerCase();
    c0sym[pid.toLowerCase()] = a0 < a1 ? p.a : p.b;
  }

  for (const pid of poolIds) {
    const pidL = pid.toLowerCase();
    if (!cfg.POOLS[pidL]) continue;
    let sqrtP = sqrtPAt(v4.prices, pidL, block);
    if (sqrtP === null) {
      // Snapshot predates the pool's first swap: fall back to the earliest
      // known price (a mint always precedes swaps, so liquidity exists).
      const arr = v4.prices.get(pidL);
      if (!arr || arr.length === 0) continue;
      sqrtP = arr[0][1];
    }
    const sym0 = c0sym[pidL];
    const sym1 = sym0 === cfg.POOLS[pidL].a ? cfg.POOLS[pidL].b : cfg.POOLS[pidL].a;
    for (const [tokenId, transfers] of timeline) {
      const owner = ownerAt(transfers, block);
      if (!owner) continue;
      const entry = v4.liq.get(`${pidL}:${tokenId}`);
      if (!entry) continue; // no liquidity events for this position in this pool
      const liqVal = liquidityAt(entry, block);
      if (liqVal === 0n || !(entry.tickLower < entry.tickUpper)) continue;
      const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, entry.tickLower, entry.tickUpper, liqVal);
      add(owner, sym0, amount0);
      add(owner, sym1, amount1);
    }
  }
  const str = {};
  for (const [o, v] of Object.entries(out)) str[o] = { porch: v.porch.toString(), mdog: v.mdog.toString() };
  return str;
}

module.exports = {
  transferReplay, balanceAt, positionTimeline, ownerAt,
  v4Replay, liquidityAt, sqrtPAt, lpBalancesAtReplay,
};
