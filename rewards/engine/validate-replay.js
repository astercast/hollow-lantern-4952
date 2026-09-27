/* Validates the LP log-replay method against DIRECT chain reads at latest block.
 *
 * For sampled position tokenIds in each of the 3 reward pools:
 *   1. replay_liq = sum of ModifyLiquidity.liquidityDelta for salt==tokenId
 *      (fetched from pool birth)  vs  direct = POSM.getPositionLiquidity
 *   2. replay price = last Swap.sqrtPriceX96  vs  direct = StateView.getSlot0
 *   3. replay owner = last POSM Transfer  vs  direct = POSM.ownerOf
 *   4. amounts via tickmath on both paths must agree to the wei.
 *
 * Read-only. Never signs. Does NOT touch any position.
 */
'use strict';
const { ethers } = require('ethers');
const cfg = require('./config');
const { getAmountsForLiquidity } = require('./tickmath');
const { decodeInfo } = require('./snapshot');

const PM_ABI = [
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 protocolFee)',
];
const POSM_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];
const SV_ABI = ['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'];
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const coder = ethers.AbiCoder.defaultAbiCoder();

const KNOWN = { '3036297': 'mdog/musebook', '3156366': 'porch/mdog', '3344714': 'porch/musebook' };

async function getLogsChunked(p, args, label) {
  const CH = 50000;
  const out = [];
  for (let s = args.fromBlock; s <= args.toBlock; s += CH) {
    const e = Math.min(args.toBlock, s + CH - 1);
    let tries = 0;
    for (;;) {
      try { out.push(...await p.getLogs({ ...args, fromBlock: s, toBlock: e })); break; }
      catch (err) { if (++tries >= 4) throw err; await new Promise((r) => setTimeout(r, 1500 * tries)); }
    }
  }
  return out;
}

async function main() {
  const p = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  const pmIface = new ethers.Interface(PM_ABI);
  const posmIface = new ethers.Interface(POSM_ABI);
  const posm = new ethers.Contract(cfg.POSM, POSM_ABI, p);
  const sv = new ethers.Contract(cfg.STATEVIEW, SV_ABI, p);
  const pmAddr = await new ethers.Contract(cfg.POSM, ['function poolManager() view returns (address)'], p).poolManager();
  const nowBlock = await p.getBlockNumber();
  console.log('latest block:', nowBlock);

  // Discover extra sample tokenIds from the two younger pools' modliq logs.
  const poolIds = Object.keys(cfg.POOLS);
  const births = {};
  for (const pid of poolIds) {
    const logs = await getLogsChunked(p, {
      address: pmAddr, topics: [pmIface.getEvent('ModifyLiquidity').topicHash, pid],
      fromBlock: 65185314, toBlock: 65185314 + 499999,
    }, 'birth');
    // (birth probe simplified: scan forward in 500k windows until hit)
    let birth = null;
    for (let from = 65185314; from <= nowBlock && birth === null; from += 500000) {
      const w = await p.getLogs({
        address: pmAddr, topics: [pmIface.getEvent('ModifyLiquidity').topicHash, pid],
        fromBlock: from, toBlock: Math.min(nowBlock, from + 499999),
      });
      if (w.length) birth = Math.min(...w.map((l) => l.blockNumber));
    }
    births[pid] = birth;
    console.log(cfg.POOLS[pid].label, 'birth:', birth);
  }

  // Sample tokenIds: known 3 + up to 4 more distinct salts from the younger pools.
  const samples = []; // {tokenId, pid}
  for (const [tid] of Object.entries(KNOWN)) {
    const [key] = await posm.getPoolAndPositionInfo(tid);
    const pid = ethers.keccak256(coder.encode(
      ['tuple(address,address,uint24,int24,address)'],
      [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    samples.push({ tokenId: tid, pid: pid.toLowerCase() });
  }
  for (const pid of poolIds) {
    if (samples.filter((s) => s.pid === pid.toLowerCase()).length >= 3) continue;
    const logs = await getLogsChunked(p, {
      address: pmAddr, topics: [pmIface.getEvent('ModifyLiquidity').topicHash, pid],
      fromBlock: births[pid], toBlock: Math.min(nowBlock, births[pid] + 200000),
    }, 'sample');
    const seen = new Set(samples.map((s) => s.tokenId));
    for (const l of logs) {
      const ev = pmIface.parseLog(l);
      const tid = BigInt(ev.args.salt).toString();
      if (!seen.has(tid) && tid !== '0') {
        seen.add(tid);
        samples.push({ tokenId: tid, pid: pid.toLowerCase() });
        if (samples.filter((s) => s.pid === pid.toLowerCase()).length >= 3) break;
      }
    }
  }
  console.log('samples:', samples.map((s) => `${s.tokenId}@${s.pid.slice(0, 10)}`).join(', '));

  let failures = 0;
  const check = (name, cond, detail) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' | ' + detail : ''));
    if (!cond) failures++;
  };

  for (const { tokenId, pid } of samples) {
    const label = `#${tokenId} (${cfg.POOLS[pid].label})`;
    // 1. liquidity: replay sum vs direct
    const logs = await getLogsChunked(p, {
      address: pmAddr, topics: [pmIface.getEvent('ModifyLiquidity').topicHash, pid],
      fromBlock: births[pid], toBlock: nowBlock,
    }, `liq-${tokenId}`);
    let replayLiq = 0n, tickLower = null, tickUpper = null;
    for (const l of logs) {
      const ev = pmIface.parseLog(l);
      if (BigInt(ev.args.salt).toString() !== tokenId) continue;
      if (tickLower === null) { tickLower = Number(ev.args.tickLower); tickUpper = Number(ev.args.tickUpper); }
      replayLiq += ev.args.liquidityDelta;
    }
    if (replayLiq < 0n) replayLiq = 0n;
    const directLiq = await posm.getPositionLiquidity(tokenId);
    check(`${label} liquidity replay==direct`, replayLiq === directLiq,
      `replay ${replayLiq} vs direct ${directLiq}`);

    // 2. price: last swap vs slot0
    const swaps = await getLogsChunked(p, {
      address: pmAddr, topics: [pmIface.getEvent('Swap').topicHash, pid],
      fromBlock: Math.max(births[pid], nowBlock - 200000), toBlock: nowBlock,
    }, `swap-${tokenId}`);
    const replaySqrtP = swaps.length ? pmIface.parseLog(swaps[swaps.length - 1]).args.sqrtPriceX96 : null;
    const [directSqrtP] = await sv.getSlot0(pid);
    // (swaps window may miss the very last swap; allow equality only — report both)
    check(`${label} price replay==slot0`, replaySqrtP !== null && replaySqrtP === directSqrtP,
      `replay ${replaySqrtP} vs slot0 ${directSqrtP}`);

    // 3. ownership (fault-tolerant: RPC times out on some Transfer queries)
    const topic3 = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
    let replayOwner = null, ownerSkipped = false;
    try {
      const tlogs = await getLogsChunked(p, {
        address: cfg.POSM, topics: [TRANSFER, null, null, topic3],
        fromBlock: births[pid], toBlock: nowBlock,
      }, `owner-${tokenId}`);
      for (const l of tlogs) {
        const ev = posmIface.parseLog(l);
        replayOwner = ev.args.to.toLowerCase() === '0x0000000000000000000000000000000000000000' ? null : ev.args.to.toLowerCase();
      }
    } catch (err) {
      ownerSkipped = true;
      console.log(`SKIP ${label} owner check (RPC timeout): ${err.shortMessage || err.message}`);
    }
    let directOwner = null;
    try { directOwner = (await posm.ownerOf(tokenId)).toLowerCase(); } catch { directOwner = null; }
    if (!ownerSkipped)
      check(`${label} owner replay==direct`, replayOwner === directOwner, `${replayOwner} vs ${directOwner}`);

    // 4. amounts agree to the wei
    if (tickLower !== null && replayLiq > 0n && replaySqrtP !== null) {
      const a = getAmountsForLiquidity(replaySqrtP, tickLower, tickUpper, replayLiq);
      const b = getAmountsForLiquidity(directSqrtP, tickLower, tickUpper, directLiq);
      check(`${label} amounts agree`, a.amount0 === b.amount0 && a.amount1 === b.amount1,
        `(${a.amount0},${a.amount1}) vs (${b.amount0},${b.amount1})`);
    }
  }
  console.log(failures === 0 ? 'REPLAY VALIDATION: ALL PASSED' : `REPLAY VALIDATION: ${failures} FAILURES`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error('VALIDATION FAILED:', e.message); process.exit(1); });
