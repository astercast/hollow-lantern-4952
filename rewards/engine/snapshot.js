/* Daily holder snapshots for the rewards engine.
 *
 * For each snapshot day (00:00 UTC):
 *   1. Find the block closest to that timestamp (binary search).
 *   2. Enumerate every holder from Transfer logs (spot) and V4 position
 *      ownership (LP), then read balanceOf / position value AT that block.
 *   3. LP-held PORCH/MDOG are valued with concentrated-liquidity math
 *      (tickmath.js) from StateView.getSlot0 at the same block.
 *
 * Read-only. Never signs, never sends.
 */
'use strict';

const { ethers } = require('ethers');
const cfg = require('./config');
const { getAmountsForLiquidity } = require('./tickmath');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const POSM_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const STATEVIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
];

const ZERO = '0x0000000000000000000000000000000000000000';

async function mapPool(items, fn, n) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

/* Closest block at or before ts (binary search on timestamps). */
async function blockAtTimestamp(provider, ts, lo, hi) {
  if (hi === undefined) hi = await provider.getBlockNumber();
  if (lo === undefined) {
    lo = hi;
    // walk back until we're under ts (chain is young; ~2s blocks)
    while ((await provider.getBlock(lo)).timestamp > ts && lo > 0) lo = Math.max(0, lo - 500000);
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const b = await provider.getBlock(mid);
    if (b.timestamp <= ts) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/* All addresses that ever sent or received `token` in [fromBlock, toBlock]. */
async function transferAddresses(provider, token, fromBlock, toBlock) {
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  const addrs = new Set();
  const chunks = Math.ceil((toBlock - fromBlock + 1) / cfg.LOG_CHUNK);
  for (let i = 0, s = fromBlock; s <= toBlock; i++, s += cfg.LOG_CHUNK) {
    const e = Math.min(s + cfg.LOG_CHUNK - 1, toBlock);
    if (i % 25 === 0) console.log(`  spot ${token.slice(0, 10)}… chunk ${i + 1}/${chunks}`);
    const logs = await c.queryFilter(c.filters.Transfer(), s, e);
    for (const l of logs) { addrs.add(l.args.from); addrs.add(l.args.to); }
  }
  addrs.delete(ZERO);
  console.log(`  spot ${token.slice(0, 10)}… done: ${addrs.size} addrs`);
  return [...addrs].map((a) => a.toLowerCase());
}

async function balancesAt(provider, token, holders, blockTag) {
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  const out = {};
  await mapPool(holders, async (h) => {
    try { out[h] = (await c.balanceOf(h, { blockTag })).toString(); }
    catch { out[h] = '0'; }
  }, cfg.CALL_CONCURRENCY);
  return out;
}

/* Full POSM Transfer timeline: tokenId -> [{block, from, to}] sorted. */
async function positionTimeline(provider, fromBlock, toBlock) {
  const c = new ethers.Contract(cfg.POSM, POSM_ABI, provider);
  const tl = new Map();
  const chunks = Math.ceil((toBlock - fromBlock + 1) / cfg.LOG_CHUNK);
  for (let i = 0, s = fromBlock; s <= toBlock; i++, s += cfg.LOG_CHUNK) {
    const e = Math.min(s + cfg.LOG_CHUNK - 1, toBlock);
    if (i % 25 === 0) console.log(`  posm chunk ${i + 1}/${chunks}`);
    const logs = await c.queryFilter(c.filters.Transfer(), s, e);
    for (const l of logs) {
      const id = l.args.tokenId.toString();
      if (!tl.has(id)) tl.set(id, []);
      tl.get(id).push({ block: l.blockNumber, from: l.args.from.toLowerCase(), to: l.args.to.toLowerCase() });
    }
  }
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

function decodeInfo(info) {
  const v = BigInt(info);
  const mask24 = (1n << 24n) - 1n;
  const tu = Number((v >> 32n) & mask24);
  const tl = Number((v >> 8n) & mask24);
  const s24 = (x) => (x & 0x800000) ? x - 0x1000000 : x;
  return { tickLower: s24(tl), tickUpper: s24(tu) };
}

const coder = ethers.AbiCoder.defaultAbiCoder();
function poolIdOf(key) {
  return ethers.keccak256(coder.encode(
    ['tuple(address,address,uint24,int24,address)'],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
  ));
}

const SYM = {};
SYM[cfg.TOKENS.porch.toLowerCase()] = 'porch';
SYM[cfg.TOKENS.mdog.toLowerCase()] = 'mdog';
SYM[cfg.TOKENS.musebook.toLowerCase()] = 'musebook';

/* LP-held PORCH/MDOG per owner at blockTag. */
async function lpBalancesAt(provider, timeline, blockTag) {
  const posm = new ethers.Contract(cfg.POSM, POSM_ABI, provider);
  const sv = new ethers.Contract(cfg.STATEVIEW, STATEVIEW_ABI, provider);
  const out = {}; // owner -> {porch: bigint, mdog: bigint}
  const add = (o, sym, amt) => {
    if (amt === 0n || (sym !== 'porch' && sym !== 'mdog')) return;
    if (!out[o]) out[o] = { porch: 0n, mdog: 0n };
    out[o][sym] += amt;
  };
  const ids = [...timeline.keys()];
  const slotCache = {};
  await mapPool(ids, async (id) => {
    const owner = ownerAt(timeline.get(id), blockTag);
    if (!owner) return;
    let key, info, liq;
    try {
      [key, info] = await posm.getPoolAndPositionInfo(id, { blockTag });
      liq = await posm.getPositionLiquidity(id, { blockTag });
    } catch { return; }
    if (liq === 0n) return;
    const pid = poolIdOf(key).toLowerCase();
    if (!cfg.POOLS[pid]) return; // not a reward-relevant pool
    const { tickLower, tickUpper } = decodeInfo(info);
    if (!(tickLower < tickUpper)) return;
    try {
      if (!slotCache[pid]) slotCache[pid] = await sv.getSlot0(pid, { blockTag });
      const sqrtP = slotCache[pid][0];
      const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, tickLower, tickUpper, liq);
      add(owner, SYM[key.currency0.toLowerCase()], amount0);
      add(owner, SYM[key.currency1.toLowerCase()], amount1);
    } catch { /* skip unreadable positions */ }
  }, cfg.CALL_CONCURRENCY);
  const str = {};
  for (const [o, v] of Object.entries(out)) str[o] = { porch: v.porch.toString(), mdog: v.mdog.toString() };
  return str;
}

/* days: [{date: 'YYYY-MM-DD', ts}] -> snapshots written to outDir. */
async function runSnapshots(provider, days, outDir) {
  const fs = require('fs');
  const nowBlock = await provider.getBlockNumber();
  const startBlock = await blockAtTimestamp(provider, cfg.SCAN_START_TS, 0, nowBlock);

  console.log('enumerating spot holders + V4 positions (parallel)…');
  const [porchAddrs, mdogAddrs, timeline] = await Promise.all([
    transferAddresses(provider, cfg.TOKENS.porch, startBlock, nowBlock),
    transferAddresses(provider, cfg.TOKENS.mdog, startBlock, nowBlock),
    positionTimeline(provider, startBlock, nowBlock),
  ]);
  const holders = new Set([...porchAddrs, ...mdogAddrs]);
  const holderList = [...holders];
  console.log('spot holders:', holderList.length);
  console.log('position NFTs seen:', timeline.size);

  const snaps = [];
  for (const d of days) {
    const block = await blockAtTimestamp(provider, d.ts, 0, nowBlock);
    console.log(d.date, '-> block', block);
    const [porchBal, mdogBal] = await Promise.all([
      balancesAt(provider, cfg.TOKENS.porch, holderList, block),
      balancesAt(provider, cfg.TOKENS.mdog, holderList, block),
    ]);
    const lp = await lpBalancesAt(provider, timeline, block);
    const spot = {};
    for (const h of holderList) {
      const p = porchBal[h] || '0', m = mdogBal[h] || '0';
      if (p !== '0' || m !== '0') spot[h] = { porch: p, mdog: m };
    }
    const snap = { date: d.date, ts: d.ts, block, spot, lp };
    snaps.push(snap);
    if (outDir) fs.writeFileSync(`${outDir}/day-${d.date}.json`, JSON.stringify(snap));
  }
  return snaps;
}

module.exports = { blockAtTimestamp, runSnapshots, decodeInfo, poolIdOf };
