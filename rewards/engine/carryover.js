/* Reads the distributor's free (carryover) balance for the next epoch.
 *
 *   carryover = balanceOf(distributor) - allocatedUnclaimed
 *
 * Run this right before run-epoch.js and pass the result as --carryover.
 * Read-only. Uses the latest block (the public RPC is pruned, so historical
 * reads are unavailable — run it at epoch-start time).
 *
 * Usage: node carryover.js --distributor 0x…
 */
'use strict';

const { ethers } = require('ethers');
const cfg = require('./config');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const distributor = arg('distributor');
  if (!distributor) throw new Error('--distributor 0x… required');
  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  const dist = new ethers.Contract(ethers.getAddress(distributor), [
    'function allocatedUnclaimed() view returns (uint256)',
  ], provider);
  const mb = new ethers.Contract(cfg.TOKENS.musebook, [
    'function balanceOf(address) view returns (uint256)',
  ], provider);
  const [bal, liab] = await Promise.all([
    mb.balanceOf(distributor),
    dist.allocatedUnclaimed(),
  ]);
  const free = bal - liab;
  if (free < 0n) throw new Error('negative free balance — distributor accounting broken');
  console.log('distributor balance:  ', ethers.formatUnits(bal, 18), 'MUSEBOOK');
  console.log('allocated unclaimed:  ', ethers.formatUnits(liab, 18), 'MUSEBOOK');
  console.log('CARRYOVER (free):     ', ethers.formatUnits(free, 18), 'MUSEBOOK');
  console.log('raw wei:', free.toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
