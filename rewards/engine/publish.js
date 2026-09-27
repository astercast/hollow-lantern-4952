/* Builds the Safe transaction bundle that launches an epoch.
 *
 * One or two txs, executed by the treasury Safe in order:
 *   1. MUSEBOOK.transfer(distributor, pot - carryover) — tops up the epoch pot
 *      (skipped when carryover already covers the pot; carryover sits in the
 *      distributor as free balance from finalized prior epochs)
 *   2. distributor.publishRoot(epochId, root, totalAllocated)
 *
 * Output: safe-bundle-epoch-<id>.json — paste into the Safe "Transaction Builder".
 * (As of 2026-09-27 the treasury MUSEBOOK sits in Andrew's EOA
 * 0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25, not the 1-of-2 Safe — the
 * funding/publish txs are signed by whoever controls that wallet.)
 * This script never signs or sends anything.
 *
 * Usage: node publish.js --epoch 1 --api ../api
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./config');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const epochId = arg('epoch', '1');
  const apiDir = arg('api', path.join(__dirname, '..', 'api'));
  const epoch = JSON.parse(fs.readFileSync(path.join(apiDir, `epoch-${epochId}.json`), 'utf8'));

  if (!epoch.distributor) throw new Error('epoch has no distributor address — set it before publishing');
  if (epoch.publishedTx) throw new Error('epoch already published: ' + epoch.publishedTx);
  if (!epoch.merkleRoot || /^0x0+$/.test(epoch.merkleRoot))
    throw new Error('epoch has zero merkle root — nothing to publish (empty tree)');
  if (BigInt(epoch.totalAllocated) <= 0n)
    throw new Error('epoch totalAllocated is zero — the distributor would revert');

  const pot = BigInt(epoch.potMusebook);
  const carryover = BigInt(epoch.carryover || '0');
  if (carryover > pot) throw new Error('carryover exceeds pot — bad epoch math');
  // Carryover funds already sit in the distributor as free balance (they were
  // finalized from a prior epoch). The Safe only tops up the remainder.
  const topUp = pot - carryover;

  const erc20Iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  const distIface = new ethers.Interface([
    'function publishRoot(uint256 epochId, bytes32 root, uint256 totalAllocated)',
  ]);

  const txs = [];
  if (topUp > 0n) {
    txs.push({
      to: ethers.getAddress(cfg.TOKENS.musebook),
      value: '0',
      data: erc20Iface.encodeFunctionData('transfer', [epoch.distributor, topUp.toString()]),
      description: `Send epoch top-up (${ethers.formatUnits(topUp, 18)} MUSEBOOK) to the distributor`,
    });
  }
  txs.push({
    to: ethers.getAddress(epoch.distributor),
    value: '0',
    data: distIface.encodeFunctionData('publishRoot', [epoch.epochId, epoch.merkleRoot, epoch.totalAllocated]),
    description: `Publish merkle root for epoch ${epochId}`,
  });

  const bundle = {
    version: '1.0',
    chainId: String(cfg.CHAIN_ID),
    createdAt: new Date().toISOString(),
    meta: {
      name: `MuseDogs rewards — epoch ${epochId}`,
      description: `Fund + publish epoch ${epochId}. Pot ${ethers.formatUnits(pot, 18)} MUSEBOOK ` +
        `(carryover already in distributor: ${ethers.formatUnits(carryover, 18)}; ` +
        `Safe tops up ${ethers.formatUnits(topUp, 18)}), ` +
        `allocated ${ethers.formatUnits(epoch.totalAllocated, 18)}, root ${epoch.merkleRoot}. ` +
        `Claims stay open 30 days after publish; unclaimed then finalizes to carryover.`,
    },
    transactions: txs,
  };

  const out = path.join(apiDir, `safe-bundle-epoch-${epochId}.json`);
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2));
  console.log('wrote', out);
  console.log(bundle.meta.description);
  console.log('Execute both txs from the treasury Safe, in order. Then record publishedTx in epoch json.');
}

main().catch((e) => { console.error(e); process.exit(1); });
