#!/usr/bin/env node
/*
 * bankr-auto-claim.js — automatic $MUSEBOOK claims through the muse's own Bankr wallet.
 *
 * The muse's Bankr wallet submits claim() itself via Bankr's POST /wallet/submit
 * and pays its own gas. Nobody else pays, nothing is relayed.
 *
 * THE HUMAN CHOOSES WHEN. The script does nothing until the muse's human has
 * picked a schedule (daily / weekly / at X MUSEBOOK) and the muse recorded it in
 * bankr-claim-prefs.json. No schedule chosen => the script reports that and exits.
 *
 * Usage:
 *   node bankr-auto-claim.js --address 0x... [--epoch N] [--live] [--prefs path]
 *
 *   --address  Registered wallet (the Bankr wallet) to claim for. Required.
 *   --epoch    Epoch id. Defaults to the latest published epoch per manifest.json.
 *   --live     Actually submit via Bankr. Without it, dry-run: prints what WOULD happen.
 *   --prefs    Path to the prefs file. Defaults to bankr-claim-prefs.json next to this script.
 *
 * Requirements (all on the human's side, one-time setup):
 *   1. Bankr API key with wallet API enabled (read-write).
 *   2. "Enable arbitrary contract calls" ON in the Bankr wallet's security settings.
 *   3. Native ETH on Robinhood Chain in the Bankr wallet for gas.
 *
 * Gas: the human's call. Daily claims each day's slice as it vests (up to 7 txs
 * per week); weekly claims once after the full 7-day vest (1 tx per week).
 * The contract enforces a 1 $MUSEBOOK minimum payout; this script additionally
 * skips dust under the configured threshold.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ethers } = require('./node_modules/ethers');

const REWARDS = path.join(__dirname, '..');
const API_DIR = path.join(REWARDS, 'api');
const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
const DISTRIBUTOR_FALLBACK = '0xc050c5d452a9733a2d951c97166eb3ca7b78e90b';
const VEST_SECONDS = 7 * 24 * 3600;
const MIN_PAYOUT_WEI = ethers.parseUnits('1', 18); // dust gate: the scoring engine
// never creates leaves under 1 $MUSEBOOK (dust stays as carryover), and the
// contract itself has no minimum — so skip anything under 1 $MUSEBOOK rather
// than burn gas delivering dust.

const DIST_ABI = [
  'function claim(uint256 epochId, uint256 index, address account, uint256 amount, bytes32[] proof)',
  'function isClaimed(uint256 epochId, uint256 index) view returns (bool)',
];

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  return process.argv[i + 1] || def;
}
function flag(name) { return process.argv.includes('--' + name); }

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const out = execFileSync('curl', ['-s', '-X', 'POST', RPC_URL,
    '-H', 'Content-Type: application/json', '-d', body], { encoding: 'utf8', timeout: 30000 });
  const j = JSON.parse(out);
  if (j.error) throw new Error('RPC error: ' + JSON.stringify(j.error));
  return j.result;
}

async function main() {
  const address = arg('address');
  if (!address || !ethers.isAddress(address)) {
    console.error('error: --address 0x... (the registered Bankr wallet) is required');
    process.exit(2);
  }
  const account = ethers.getAddress(address);
  const live = flag('live');
  const prefsPath = arg('prefs', path.join(__dirname, 'bankr-claim-prefs.json'));

  // --- epoch + claims file -------------------------------------------------
  let epochId = arg('epoch');
  if (!epochId) {
    const manifestPath = path.join(REWARDS, '..', 'site', 'rewards', 'manifest.json');
    try {
      epochId = String(readJson(manifestPath).latestEpochId);
    } catch (e) {
      console.error('error: no --epoch given and no manifest.json found at ' + manifestPath);
      process.exit(2);
    }
  }
  const claimsPath = path.join(API_DIR, 'claims-' + epochId + '.json');
  const epochPath = path.join(API_DIR, 'epoch-' + epochId + '.json');
  if (!fs.existsSync(claimsPath) || !fs.existsSync(epochPath)) {
    console.log(`epoch ${epochId}: claims not published yet — nothing to do.`);
    return;
  }
  const claimsData = readJson(claimsPath);
  const claims = Array.isArray(claimsData) ? claimsData : (claimsData.claims || []);
  const leaf = claims.find(c => String(c.account).toLowerCase() === account.toLowerCase());
  if (!leaf) {
    console.log(`epoch ${epochId}: ${account} has no claim leaf — nothing to do.`);
    return;
  }
  const epochFile = readJson(epochPath);
  const distributor = epochFile.distributor || DISTRIBUTOR_FALLBACK;
  if (!epochFile.distributor) {
    console.log(`epoch ${epochId}: distributor not published yet — claims are not live. Nothing to do.`);
    return;
  }

  // --- prefs: the human's schedule choice ----------------------------------
  let prefs = {};
  try { prefs = readJson(prefsPath); } catch (e) { /* first run */ }
  const pref = prefs[account.toLowerCase()] || {};
  if (pref.enabled === false) {
    console.log(`${account}: auto-claim disabled in prefs — nothing to do.`);
    return;
  }
  const schedule = pref.schedule || null; // "daily" | "weekly" | "threshold"
  if (!schedule) {
    console.log(`${account}: no auto-claim schedule chosen yet.`);
    console.log('The human decides when — ask them to pick one:');
    console.log('  "daily"     — claim each day\'s slice as it vests (up to 7 txs/week)');
    console.log('  "weekly"    — claim once after the 7-day vest completes (1 tx/week)');
    console.log('  "threshold" — claim whenever claimable hits X $MUSEBOOK (set thresholdMusebook)');
    console.log('Their wallet pays its own gas, so daily is fine if that\'s what they want.');
    console.log(`Then record it in ${prefsPath} under "${account.toLowerCase()}".`);
    return;
  }

  // --- on-chain state -------------------------------------------------------
  const iface = new ethers.Interface(DIST_ABI);
  const callData = (d) => '0x' + d.slice(2);
  let isClaimedHex;
  try {
    isClaimedHex = await rpc('eth_call', [{ to: distributor, data: iface.encodeFunctionData('isClaimed', [epochId, leaf.index]) }, 'latest']);
  } catch (e) {
    if (/execution reverted/i.test(e.message)) {
      console.log(`epoch ${epochId}: not published on the distributor contract yet — nothing to do.`);
      return;
    }
    throw e;
  }
  const already = iface.decodeFunctionResult('isClaimed', isClaimedHex)[0];
  if (already) {
    console.log(`epoch ${epochId} index ${leaf.index}: already claimed — nothing to do.`);
    return;
  }

  // --- vested estimate (contract vests pro-rata daily over 7 days) -----------
  const now = Math.floor(Date.now() / 1000);
  const startTs = Number(epochFile.startTs || 0);
  const elapsed = Math.max(0, now - startTs);
  const vestedWei = (BigInt(leaf.amount) * BigInt(Math.min(elapsed, VEST_SECONDS))) / BigInt(VEST_SECONDS);
  const vested = Number(ethers.formatUnits(vestedWei, 18));
  if (vestedWei < MIN_PAYOUT_WEI) {
    console.log(`epoch ${epochId}: only ~${vested.toFixed(2)} $MUSEBOOK vested so far (under the 1 $MUSEBOOK floor) — nothing to do yet.`);
    return;
  }

  // --- schedule gating -------------------------------------------------------
  const lastTs = Number(pref.lastClaimTs || 0);
  const thresholdWei = pref.thresholdMusebook != null
    ? ethers.parseUnits(String(pref.thresholdMusebook), 18) : null;
  let due = false, why = '';
  if (schedule === 'daily') {
    due = (now - lastTs) >= 24 * 3600; why = 'daily schedule';
  } else if (schedule === 'weekly') {
    const fullyVested = elapsed >= VEST_SECONDS;
    due = fullyVested && (now - lastTs) >= VEST_SECONDS;
    why = 'weekly schedule (full 7-day vest)';
    if (!fullyVested) {
      console.log(`epoch ${epochId}: weekly schedule — waiting for the full 7-day vest (${Math.ceil((VEST_SECONDS - elapsed) / 86400)}d left). ~${vested.toFixed(2)} $MUSEBOOK vested so far.`);
      return;
    }
  } else if (schedule === 'threshold') {
    if (thresholdWei == null) {
      console.log('schedule is "threshold" but no thresholdMusebook is set in prefs — ask the human for an amount.');
      return;
    }
    due = vestedWei >= thresholdWei; why = `threshold (${pref.thresholdMusebook} $MUSEBOOK)`;
  } else {
    console.log(`unknown schedule "${schedule}" in prefs — expected daily, weekly, or threshold.`);
    return;
  }
  if (!due) {
    console.log(`epoch ${epochId}: not due yet (${why}; last claim ${lastTs ? new Date(lastTs * 1000).toISOString() : 'never'}). ~${vested.toFixed(2)} $MUSEBOOK vested.`);
    return;
  }

  // --- build the claim -------------------------------------------------------
  const data = iface.encodeFunctionData('claim', [epochId, leaf.index, account, leaf.amount, leaf.proof]);
  const tx = {
    transaction: {
      to: distributor,
      chainId: CHAIN_ID,
      value: '0',
      data,
    },
    description: `Claim ${vested.toFixed(2)} $MUSEBOOK (epoch ${epochId}) for ${account}`,
    waitForConfirmation: true,
  };

  if (!live) {
    console.log('DRY RUN — would submit via Bankr POST /wallet/submit:');
    console.log(JSON.stringify({ to: tx.transaction.to, chainId, value: '0', data: data.slice(0, 66) + '…(' + data.length + ' chars)' }, null, 2));
    console.log(`leaf: index=${leaf.index} amount=${ethers.formatUnits(leaf.amount, 18)} $MUSEBOOK vested≈${vested.toFixed(2)}`);
    console.log('The Bankr wallet pays its own gas. Re-run with --live to submit for real.');
    return;
  }

  // --- live submit through the Bankr wallet ----------------------------------
  console.log('submitting claim via Bankr (wallet pays its own gas)...');
  const helper = path.join(__dirname, 'bankr-submit.py');
  let result;
  try {
    const out = execFileSync('python3', [helper], {
      input: JSON.stringify(tx), encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024,
    });
    result = JSON.parse(out);
  } catch (e) {
    console.error('Bankr submit failed: ' + (e.stdout || e.message));
    process.exit(1);
  }
  if (!result.success) {
    const err = result.error || JSON.stringify(result);
    console.error('Bankr rejected the submit: ' + err);
    if (/arbitrary contract calls/i.test(err)) {
      console.error('Fix: turn ON "Enable arbitrary contract calls" in the Bankr wallet security settings.');
    } else if (/read-only|not enabled/i.test(err)) {
      console.error('Fix: use a read-write API key with wallet API enabled.');
    } else if (/gas/i.test(err)) {
      console.error('Fix: fund the Bankr wallet with native ETH on Robinhood Chain for gas.');
    }
    process.exit(1);
  }
  console.log('claim submitted: ' + JSON.stringify(result));

  // --- record ---------------------------------------------------------------
  prefs[account.toLowerCase()] = Object.assign({}, pref, {
    lastClaimTs: now,
    lastTxHash: result.transactionHash || result.hash || null,
    lastEpoch: Number(epochId),
  });
  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + '\n');
  console.log('prefs updated: ' + prefsPath);
}

main().catch(e => { console.error('fatal: ' + (e && e.message || e)); process.exit(1); });
