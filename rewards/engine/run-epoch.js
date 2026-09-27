/* Orchestrates one rewards epoch end-to-end:
 *   snapshots (7 days, 00:00 UTC) -> scoring -> merkle tree -> epoch + claims JSON
 *
 * Usage:
 *   node run-epoch.js --start 2026-09-21 --epoch-id 1 --registry identity-registry.json \
 *     --carryover 0 --distributor 0x... --out ../api
 *
 * Read-only against the public RPC. Writes epoch-<id>.json and claims-<id>.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./config');
const { runSnapshots } = require('./snapshot');
const { scoreEpoch } = require('./score');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const startStr = arg('start');
  const epochId = Number(arg('epoch-id', '1'));
  const registryPath = arg('registry', './identity-registry.json');
  const carryover = BigInt(arg('carryover', '0'));
  const distributor = arg('distributor', null);
  const outDir = arg('out', path.join(__dirname, '..', 'api'));
  if (!startStr) throw new Error('--start YYYY-MM-DD (a Monday) required');

  const startTs = Math.floor(new Date(startStr + 'T00:00:00Z').getTime() / 1000);
  const days = Array.from({ length: 7 }, (_, i) => {
    const ts = startTs + i * 86400;
    return { date: new Date(ts * 1000).toISOString().slice(0, 10), ts };
  });

  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  fs.mkdirSync(outDir, { recursive: true });
  const snapDir = path.join(outDir, `snapshots-${epochId}`);
  fs.mkdirSync(snapDir, { recursive: true });

  const snapshots = await runSnapshots(provider, days, snapDir);

  // Epoch-start state reads (at the first snapshot block).
  const startBlock = snapshots[0].block;
  const erc20 = (a) => new ethers.Contract(a, [
    'function balanceOf(address) view returns (uint256)',
    'function totalSupply() view returns (uint256)',
  ], provider);
  const musebook = erc20(cfg.TOKENS.musebook);
  const treasuryMusebook = await musebook.balanceOf(cfg.TREASURY, { blockTag: startBlock });
  const supplies = {
    porch: await erc20(cfg.TOKENS.porch).totalSupply({ blockTag: startBlock }),
    mdog: await erc20(cfg.TOKENS.mdog).totalSupply({ blockTag: startBlock }),
  };
  console.log('treasury MUSEBOOK @ epoch start:', ethers.formatUnits(treasuryMusebook, 18));
  console.log('supplies:', ethers.formatUnits(supplies.porch, 18), 'PORCH /', ethers.formatUnits(supplies.mdog, 18), 'MDOG');

  const registryJson = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const { epochConfig, claims, board } = scoreEpoch({
    epochId, startTs, endTs: startTs + 7 * 86400,
    snapshots, registryJson, treasuryMusebook, carryover, supplies, distributor,
  });

  fs.writeFileSync(path.join(outDir, `epoch-${epochId}.json`), JSON.stringify(epochConfig, null, 2));
  fs.writeFileSync(path.join(outDir, `claims-${epochId}.json`), JSON.stringify({
    epochId, root: epochConfig.merkleRoot, totalAllocated: epochConfig.totalAllocated, claims,
  }));
  fs.writeFileSync(path.join(outDir, `board-${epochId}.json`), JSON.stringify(board, null, 2));
  console.log(`epoch ${epochId}: pot=${ethers.formatUnits(epochConfig.potMusebook, 18)} MUSEBOOK, ` +
    `allocated=${ethers.formatUnits(epochConfig.totalAllocated, 18)}, claims=${claims.length}`);
  console.log('root:', epochConfig.merkleRoot);
}

main().catch((e) => { console.error(e); process.exit(1); });
