/* Re-runs ONLY the LP leg of the dry run with the fixed replay.js, then
 * rewrites the saved snapshots' `lp` fields. The spot replay is untouched.
 *
 * Efficient ownership: instead of scanning all 869k POSM transfers, we fetch
 * Transfer logs per position tokenId (topic3 filter) for just the tokenIds
 * that ever had liquidity in our pools.
 *
 * Usage: node relp.js   (reads api/dryrun/snapshots/day-*.json, rewrites them)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./config');
const { v4Replay, liquidityAt, sqrtPAt, ownerAt, getLogsChunked } = require('./replay');
const { getAmountsForLiquidity } = require('./tickmath');

const SCAN_FROM = 65186314 - 1000;
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ZERO = '0x0000000000000000000000000000000000000000';
const posmIface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);

async function main() {
  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  const outDir = path.join(__dirname, '..', 'api', 'dryrun');
  const snapDir = path.join(outDir, 'snapshots');
  const days = fs.readdirSync(snapDir).filter((f) => f.startsWith('day-')).sort();
  const snaps = days.map((f) => ({ f, ...JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')) }));
  const nowBlock = await provider.getBlockNumber();
  console.log('snapshots:', days.join(','), '| nowBlock:', nowBlock);

  const poolManager = await new ethers.Contract(
    cfg.POSM, ['function poolManager() view returns (address)'], provider).poolManager();
  const poolIds = Object.keys(cfg.POOLS);
  const v4 = await v4Replay(provider, poolManager, poolIds, SCAN_FROM, nowBlock);

  // Distinct position tokenIds with liquidity events in our pools.
  const tokenIds = new Set();
  for (const k of v4.liq.keys()) tokenIds.add(k.split(':')[1]);
  console.log('position tokenIds in our pools:', tokenIds.size);

  // Per-token ownership timelines (topic3-filtered, chunked: a full-range
  // Transfer query times out on the public RPC).
  const timelines = new Map();
  let done = 0;
  for (const tid of tokenIds) {
    if (tid === '0') continue; // salt 0 is not a real position NFT; RPC chokes on it
    const topic3 = '0x' + BigInt(tid).toString(16).padStart(64, '0');
    let logs;
    try {
      logs = await getLogsChunked(provider, {
        address: cfg.POSM, topics: [TRANSFER, null, null, topic3],
        fromBlock: SCAN_FROM, toBlock: nowBlock,
      }, `tl-${tid}`, 500000);
    } catch (err) {
      console.log(`  tl-${tid}: FAILED after retries (${err.shortMessage || err.message}) — skipping token`);
      continue;
    }
    const tl = logs.map((l) => {
      const ev = posmIface.parseLog(l);
      return { block: l.blockNumber, to: ev.args.to.toLowerCase() };
    }).sort((a, b) => a.block - b.block);
    timelines.set(tid, tl);
    if (++done % 50 === 0) console.log(`  timelines ${done}/${tokenIds.size}`);
  }

  // currency0 symbol per pool (lower address).
  const c0sym = {};
  for (const pid of poolIds) {
    const p = cfg.POOLS[pid.toLowerCase()];
    const a0 = cfg.TOKENS[p.a].toLowerCase(), a1 = cfg.TOKENS[p.b].toLowerCase();
    c0sym[pid.toLowerCase()] = a0 < a1 ? p.a : p.b;
  }

  for (const snap of snaps) {
    const out = {};
    const add = (o, sym, amt) => {
      if (amt === 0n || (sym !== 'porch' && sym !== 'mdog')) return;
      if (!out[o]) out[o] = { porch: 0n, mdog: 0n };
      out[o][sym] += amt;
    };
    for (const pid of poolIds) {
      const pidL = pid.toLowerCase();
      let sqrtP = sqrtPAt(v4.prices, pidL, snap.block);
      if (sqrtP === null) {
        const arr = v4.prices.get(pidL);
        if (!arr || !arr.length) continue;
        sqrtP = arr[0][1];
      }
      const sym0 = c0sym[pidL];
      const p = cfg.POOLS[pidL];
      const sym1 = sym0 === p.a ? p.b : p.a;
      for (const tid of tokenIds) {
        const owner = ownerAt(timelines.get(tid), snap.block);
        if (!owner) continue;
        const entry = v4.liq.get(`${pidL}:${tid}`);
        if (!entry) continue;
        const l = liquidityAt(entry, snap.block);
        if (l === 0n || !(entry.tickLower < entry.tickUpper)) continue;
        const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, entry.tickLower, entry.tickUpper, l);
        add(owner, sym0, amount0);
        add(owner, sym1, amount1);
      }
    }
    const str = {};
    for (const [o, v] of Object.entries(out)) str[o] = { porch: v.porch.toString(), mdog: v.mdog.toString() };
    snap.lp = str;
    const { f, ...rest } = snap;
    fs.writeFileSync(path.join(snapDir, f), JSON.stringify(rest));
    console.log(`${snap.date}: lp owners ${Object.keys(str).length}`);
  }
  console.log('done — snapshots rewritten with fixed LP data');
}
main().catch((e) => { console.error(e); process.exit(1); });
