/* FULL PIPELINE DRY RUN on real Robinhood Chain data (last 7 days).
 *
 * The public RPC is a PRUNED node (no historical eth_call), so snapshots are
 * built by ERC20 Transfer LOG REPLAY (see replay.js): exact for spot wallet
 * balances. LP tracking was REMOVED from rewards 2026-09-27 — no V4 replay,
 * no LP balances, no multiplier. Read-only. Never signs.
 *
 * TEST ONLY: identity registry is synthesized from discovered holders
 * (muse_id "test-muse-<n>") — the production run uses the real registration
 * export. Writes to rewards/api/dryrun/.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./config');
const { blockAtTimestamp } = require('./snapshot');
const { transferReplay, balanceAt } = require('./replay');
const { scoreEpoch } = require('./score');

// first-Transfer blocks measured 2026-09-27 (binary search on getLogs)
const MDOG_BIRTH = 65186314;  // 2026-09-17T07:25:31Z
const PORCH_BIRTH = 70382066; // 2026-09-23T08:47:53Z
const SCAN_FROM = MDOG_BIRTH - 1000;

async function main() {
  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  const outDir = path.join(__dirname, '..', 'api', 'dryrun');
  const snapDir = path.join(outDir, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const ts = Math.floor(today.getTime() / 1000) - (6 - i) * 86400;
    return { date: new Date(ts * 1000).toISOString().slice(0, 10), ts };
  });
  console.log('days:', days.map((d) => d.date).join(', '));

  const nowBlock = await provider.getBlockNumber();
  console.log('nowBlock:', nowBlock);

  console.log('replaying ERC20 transfers (spot balances only; serialized: public RPC 429s under parallel load)…');
  const porchTx = await transferReplay(provider, cfg.TOKENS.porch, PORCH_BIRTH - 1000, nowBlock);
  const mdogTx = await transferReplay(provider, cfg.TOKENS.mdog, SCAN_FROM, nowBlock);

  const holders = new Set([...porchTx.keys(), ...mdogTx.keys()]);
  console.log('holder addrs:', holders.size);

  const snaps = [];
  for (const d of days) {
    const block = await blockAtTimestamp(provider, d.ts, 0, nowBlock);
    console.log(d.date, '-> block', block);
    const spot = {};
    for (const h of holders) {
      const p = balanceAt(porchTx, h, block);
      const m = balanceAt(mdogTx, h, block);
      if (p !== 0n || m !== 0n) spot[h] = { porch: p.toString(), mdog: m.toString() };
    }
    // Spot only — no LP field (removed 2026-09-27).
    const snap = { date: d.date, ts: d.ts, block, spot, replay: true };
    snaps.push(snap);
    fs.writeFileSync(`${snapDir}/day-${d.date}.json`, JSON.stringify(snap));
    console.log(`  spot nonzero: ${Object.keys(spot).length}`);
  }

  // TEST registry: every discovered holder linked to a synthetic muse id.
  const registry = {};
  let n = 0;
  for (const h of holders) registry[h] = { muse_id: `test-muse-${++n}`, linked_at: 1 };
  fs.writeFileSync(path.join(outDir, 'identity-registry.TEST.json'), JSON.stringify(registry, null, 2));
  console.log('test registry wallets:', n);

  const startBlock = snaps[0].block;
  const erc20 = (a) => new ethers.Contract(a, ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)'], provider);
  const treasuryMusebook = await erc20(cfg.TOKENS.musebook).balanceOf(cfg.TREASURY);
  const supplies = {
    porch: await erc20(cfg.TOKENS.porch).totalSupply(),
    mdog: await erc20(cfg.TOKENS.mdog).totalSupply(),
  };

  const { epochConfig, claims, board } = scoreEpoch({
    epochId: 999, startTs: days[0].ts, endTs: days[6].ts + 86400,
    snapshots: snaps, registryJson: registry, treasuryMusebook, carryover: 0n, supplies, distributor: null,
  });

  fs.writeFileSync(path.join(outDir, 'epoch-999.json'), JSON.stringify(epochConfig, null, 2));
  fs.writeFileSync(path.join(outDir, 'claims-999.json'), JSON.stringify({
    epochId: 999, root: epochConfig.merkleRoot, totalAllocated: epochConfig.totalAllocated, claims,
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'board-999.json'), JSON.stringify(board, null, 2));

  console.log('---');
  console.log('pot:', ethers.formatUnits(epochConfig.potMusebook, 18), 'MUSEBOOK');
  console.log('allocated:', ethers.formatUnits(epochConfig.totalAllocated, 18));
  console.log('claims:', claims.length, '| board rows:', board.length);
  console.log('top 5 (one combined score per wallet):');
  for (const b of board.slice(0, 5))
    console.log(`  ${b.wallet.slice(0, 10)}… score ${b.score.toFixed(2)} bps | ` +
      `PORCH ${ethers.formatUnits(b.porch, 18)} | MDOG ${ethers.formatUnits(b.mdog, 18)} | ` +
      `${ethers.formatUnits(b.amount, 18)} MUSEBOOK`);
}
main().catch((e) => { console.error(e); process.exit(1); });
