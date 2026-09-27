/* Re-score finished dry-run snapshots with the CURRENT score.js.
 * The long replay run loads score.js once at startup; if score.js changed
 * mid-run, its epoch-999/claims-999/board-999 outputs use the stale code.
 * This script re-runs ONLY the scoring step on the saved snapshots.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./config');
const { scoreEpoch } = require('./score');

async function main() {
  const outDir = path.join(__dirname, '..', 'api', 'dryrun');
  const snapDir = path.join(outDir, 'snapshots');
  const days = fs.readdirSync(snapDir).filter((f) => f.startsWith('day-')).sort();
  if (days.length !== 7) throw new Error(`expected 7 snapshots, found ${days.length}`);
  const snaps = days.map((f) => JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')));
  const registry = JSON.parse(fs.readFileSync(path.join(outDir, 'identity-registry.TEST.json'), 'utf8'));
  console.log('snapshots:', days.join(', '));

  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  const erc20 = (a) => new ethers.Contract(a,
    ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)'], provider);
  const treasuryMusebook = await erc20(cfg.TOKENS.musebook).balanceOf(cfg.TREASURY);
  const supplies = {
    porch: await erc20(cfg.TOKENS.porch).totalSupply(),
    mdog: await erc20(cfg.TOKENS.mdog).totalSupply(),
  };

  const { epochConfig, claims, board } = scoreEpoch({
    epochId: 999, startTs: snaps[0].ts, endTs: snaps[6].ts + 86400,
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
    console.log(`  ${b.wallet.slice(0, 10)}… score ${b.score.toFixed(2)}/80 | ` +
      `PORCH ${ethers.formatUnits(b.porch, 18)} | MDOG ${ethers.formatUnits(b.mdog, 18)} | ` +
      `${ethers.formatUnits(b.amount, 18)} MUSEBOOK`);
}
main().catch((e) => { console.error(e); process.exit(1); });
