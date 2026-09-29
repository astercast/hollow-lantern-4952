#!/usr/bin/env node
/*
 * Muse Dogs — automatic claim relayer.
 *
 * The RewardsDistributor's claim() is permissionless: anyone may submit it
 * for any account, and the $MUSEBOOK always lands in the REGISTERED wallet.
 * That is what makes automatic claiming possible for muses with no browser
 * wallet: a funded relayer submits the claim, the muse's registered wallet
 * receives the funds. The relayer pays gas only and receives nothing.
 *
 * Bankr's API cannot submit arbitrary contract calls, so auto-claim runs
 * here instead of through Bankr.
 *
 * Usage:
 *   node auto-claim.js [--epoch N] [--address 0x...] [--live] [--key-file PATH]
 *                       [--rewards-dir PATH] [--rpc URL]
 *
 * Defaults: dry-run (prints what it WOULD claim), latest epoch from
 * manifest.json, all addresses in the claims file. Pass --live with
 * --key-file to actually submit. The key file holds a raw private key —
 * never commit it, never paste it in chat.
 *
 * Safety:
 * - Dry-run is the default; nothing is sent without --live.
 * - Only submits when claimableNow(epochId, index, amount) > 0 and the leaf
 *   isn't already claimed on-chain.
 * - Reads always go through the dedicated Robinhood Chain RPC, never a
 *   wallet provider.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const CHAIN_ID = 4663;
const DEFAULT_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const DIST_ABI = [
  'function claim(uint256 epochId, uint256 index, address account, uint256 amount, bytes32[] proof)',
  'function isClaimed(uint256 epochId, uint256 index) view returns (bool)',
  'function claimableNow(uint256 epochId, uint256 index, uint256 allocation) view returns (uint256)',
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function flag(name) { return process.argv.includes('--' + name); }

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  const live = flag('live');
  const onlyAddr = (arg('address', '') || '').toLowerCase();
  const rpc = arg('rpc', DEFAULT_RPC);
  const rewardsDir = arg('rewards-dir',
    path.resolve(__dirname, '../../site/api/v1/rewards'));

  const manifestPath = path.join(rewardsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('no manifest.json at ' + rewardsDir + ' — pass --rewards-dir');
  }
  const manifest = readJson(manifestPath);
  const epochId = Number(arg('epoch', manifest.latestEpochId));
  if (!Number.isInteger(epochId)) throw new Error('bad epoch id');

  const epoch = readJson(path.join(rewardsDir, `epoch-${epochId}.json`));
  const claimsFile = readJson(path.join(rewardsDir, `claims-${epochId}.json`));
  const claims = Array.isArray(claimsFile) ? claimsFile : (claimsFile.claims || []);
  const distributor = ethers.getAddress(epoch.distributor);

  const provider = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const dist = new ethers.Contract(distributor, DIST_ABI, provider);

  let wallet = null;
  if (live) {
    const keyFile = arg('key-file', '');
    if (!keyFile) throw new Error('--live needs --key-file');
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    wallet = new ethers.Wallet(key, provider);
    const bal = await provider.getBalance(wallet.address);
    console.log(`relayer ${wallet.address} — gas balance ${ethers.formatEther(bal)} ETH`);
  }

  const targets = onlyAddr
    ? claims.filter(c => String(c.account).toLowerCase() === onlyAddr)
    : claims;
  if (onlyAddr && !targets.length) {
    console.log(`no claim for ${onlyAddr} in epoch ${epochId}`);
    return;
  }

  let wouldClaim = 0, claimed = 0, skipped = 0;
  for (const c of targets) {
    const idx = Number(c.index);
    let done, now;
    try {
      done = await dist.isClaimed(epochId, idx);
      now = done ? 0n : await dist.claimableNow(epochId, idx, c.amount);
    } catch (e) {
      console.log(`epoch ${epochId} index ${idx} (${c.account}): read failed — ${e.message}; skipping`);
      skipped++;
      continue;
    }
    if (done || now === 0n) { skipped++; continue; }

    const amt = ethers.formatUnits(now, 18);
    if (!live) {
      console.log(`[dry-run] WOULD claim epoch ${epochId} index ${idx} → ${c.account}: ${amt} $MUSEBOOK`);
      wouldClaim++;
      continue;
    }
    const signed = dist.connect(wallet);
    const tx = await signed.claim(epochId, idx, c.account, c.amount, c.proof);
    console.log(`claimed epoch ${epochId} index ${idx} → ${c.account}: ${amt} $MUSEBOOK (tx ${tx.hash})`);
    await tx.wait(1);
    claimed++;
  }

  console.log(live
    ? `done: ${claimed} claimed, ${skipped} skipped (already claimed / nothing vested yet)`
    : `dry-run: ${wouldClaim} would claim, ${skipped} skipped — pass --live --key-file to submit`);
}

main().catch(e => { console.error('auto-claim failed:', e.message); process.exit(1); });
