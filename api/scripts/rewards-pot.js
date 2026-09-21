#!/usr/bin/env node
// rewards-pot.js — weekly pot sizer for Muse Dogs holder rewards.
//
// Reads the MuseDogRewards vault's on-chain ETH balance and prints the
// recommended weekly epoch pot under the MAKE-IT-LAST policy:
//
//   pot = floor(vaultBalance / divisor)   (default divisor: 8)
//
// WHY THIS EXISTS
//   The MuseDogRewards contract does NOT decide how much is paid out each
//   week — it only pays exactly what each published merkle root allocates.
//   The weekly amount is chosen off-chain, by whoever runs rewards-publish.js
//   --pot <wei>. Without a policy, week 1 could allocate the entire vault
//   balance and leave nothing for later weeks if trading dries up.
//
//   The locked policy (2026-09-21, Andrew): every weekly epoch allocates
//   1/8 of the vault's current balance. The remaining 7/8 stays in the
//   vault for future weeks. New royalties (50% of every process()) refill
//   the vault, so payouts rise when trading is hot and decay gracefully —
//   never to zero — when it cools off. The pot can never exceed the vault
//   balance, so claims can never brick for lack of funds.
//
//   No contract change is needed for this: the vault already holds whatever
//   isn't allocated, and only published roots can move funds.
//
// USAGE
//   node scripts/rewards-pot.js --vault 0x... --rpc <url> [--divisor 8]
//
//   --vault    MuseDogRewards vault contract address (0x…)
//   --rpc      Robinhood Chain (4663) JSON-RPC URL
//   --divisor  pot = balance / divisor (default 8; must be >= 1)
//
//   Prints the recommended --pot value in wei for rewards-publish.js.
//   If the computed pot is dust (< 0.001 ETH), it recommends rolling the
//   week over (skip publishing; let the vault accumulate) instead of
//   spending multisig gas on a dust epoch. The multisig makes the final call.
//
// MATH: integer wei only, no floats. pot = balance / divisor (floor).
// FAIL-CLOSED: exits non-zero on bad args, RPC failure, or wrong chain.

const { ethers } = require('ethers');

const CHAIN_ID = 4663;
const DUST_WEI = 1000000000000000n; // 0.001 ETH — below this, recommend rollover

function usage(exitCode) {
  console.log([
    'Usage: node scripts/rewards-pot.js --vault 0x... --rpc <url> [--divisor 8]',
    '',
    '  --vault    MuseDogRewards vault address',
    '  --rpc      Robinhood Chain JSON-RPC URL (chain 4663)',
    '  --divisor  pot = floor(balance / divisor), default 8',
    '',
    'Prints the recommended weekly --pot in wei (make-it-last policy).',
  ].join('\n'));
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error('Missing value for ' + a);
      }
      args[key] = val;
      i++;
    } else {
      throw new Error('Unexpected argument: ' + a);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vault || !args.rpc) {
    console.error('Missing required args.');
    usage(2);
  }
  let vault;
  try {
    vault = ethers.getAddress(args.vault);
  } catch {
    throw new Error('--vault is not a valid 0x address: ' + args.vault);
  }
  const divisor = args.divisor !== undefined ? Number(args.divisor) : 8;
  if (!Number.isInteger(divisor) || divisor < 1) {
    throw new Error('--divisor must be a positive integer, got: ' + args.divisor);
  }

  const provider = new ethers.JsonRpcProvider(args.rpc, CHAIN_ID, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error('Provider reported chain ' + Number(net.chainId) + ', expected ' + CHAIN_ID + '.');
  }

  const balance = await provider.getBalance(vault);
  const pot = balance / BigInt(divisor);
  const remainder = balance - pot;

  console.log('vault:        ' + vault);
  console.log('balance:      ' + balance.toString(10) + ' wei');
  console.log('divisor:      ' + divisor + '  (make-it-last policy: 1/' + divisor + ' of balance per week)');
  console.log('pot:          ' + pot.toString(10) + ' wei');
  console.log('stays in vault: ' + remainder.toString(10) + ' wei');
  console.log('');
  if (pot === 0n) {
    console.log('RECOMMENDATION: pot is 0 — do NOT publish this week. Roll over; let the vault accumulate.');
  } else if (pot < DUST_WEI) {
    console.log('RECOMMENDATION: pot is dust (< 0.001 ETH). Consider rolling this week over');
    console.log('instead of spending multisig gas on a dust epoch. Multisig decides.');
    console.log('');
    console.log('rewards-publish.js --pot value (if publishing anyway): ' + pot.toString(10));
  } else {
    console.log('rewards-publish.js --pot value: ' + pot.toString(10));
  }
}

main().catch((e) => {
  console.error('rewards-pot FAILED: ' + (e.message || e));
  process.exit(1);
});
