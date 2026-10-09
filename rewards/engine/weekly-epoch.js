/* Weekly epoch automation: score -> fail-closed sanity checks -> publishRoot.
 *
 * Scoring is the persistent daily model (Andrew 2026-09-27): each day's
 * live score = min(today's whale-capped weighted snapshot, 7-day trailing
 * average), 1/7 of the pot per day split by that day's scores, no weekly
 * reset. The trailing average needs the 6 days BEFORE the epoch start —
 * loaded from the previous epoch dir (or pre-epoch/) below; missing days
 * are treated as zero holdings.
 *
 * Runs every Sunday ~01:30 UTC, after the 7th daily snapshot of the epoch.
 * The automation key owns RewardsDistributor v2 and calls publishRoot().
 * Andrew pre-funds the distributor with runway (plain MUSEBOOK transfers);
 * this script NEVER moves treasury funds and never publishes unless:
 *   - all 7 snapshot files exist
 *   - every sanity check below passes
 *   - the distributor already holds >= the full epoch pot (funding check)
 * Any failure -> non-zero exit, clear reason, NOTHING goes on-chain.
 *
 * Usage:
 *   node weekly-epoch.js              # epoch = on-chain latestEpoch + 1
 *   node weekly-epoch.js --epoch-id 1 --dry-run   # full pipeline, no txs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./config');
const { scoreEpoch } = require('./score');
const { buildTree, leafHash, pairHash } = require('./merkle');

const REWARDS = path.join(__dirname, '..');
const SNAP_DIR = path.join(REWARDS, 'snapshots');
const API_DIR = path.join(REWARDS, 'api');
const SITE_REWARDS = path.join(REWARDS, '..', 'site', 'api', 'v1', 'rewards');
const KEY_PATH = path.join(REWARDS, '.secrets', 'automation-key.json');
const STATE_PATH = path.join(SNAP_DIR, 'epoch-state.json');

const DISTRIBUTOR = '0xc050c5d452a9733a2d951c97166eb3ca7b78e90b';
const TREASURY = '0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25';
const MUSEBOOK_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];
const DIST_ABI = [
  'function owner() view returns (address)',
  'function latestEpoch() view returns (uint256)',
  'function epochs(uint256) view returns (bytes32 root,uint256 totalAllocated,uint256 totalClaimed,uint64 publishTime,uint64 claimDeadline,bool finalized,bool exists)',
  'function allocatedUnclaimed() view returns (uint256)',
  'function publishRoot(uint256 epochId, bytes32 root, uint256 totalAllocated)',
  'function finalizeEpoch(uint256 epochId)',
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const DRY_RUN = process.argv.includes('--dry-run');

function fail(reason) {
  console.error('WEEKLY_EPOCH_ABORT: ' + reason);
  process.exit(1);
}
function check(cond, reason) {
  if (!cond) fail(reason);
}

async function main() {
  // HUMAN-SIGNS MODEL (user's standing order 2026-10-08): the automation key
  // must never sign publishRoot on its own. Live (non-dry-run) mode refuses
  // to run unless ALLOW_AUTOMATION_SIGNING=1 is explicitly set in the
  // environment. Normal operation is --dry-run scoring via epoch-pipeline.js
  // prepare; the human signs fund + publishRoot; epoch-pipeline.js activate
  // verifies and publishes.
  if (!DRY_RUN && process.env.ALLOW_AUTOMATION_SIGNING !== '1') {
    fail('refusing live publishRoot: automation signing is disabled by the user\'s standing order. ' +
      'Run with --dry-run (scoring only), then let the human sign via epoch-pipeline.js prepare. ' +
      'Set ALLOW_AUTOMATION_SIGNING=1 only for an explicitly authorized exception.');
  }
  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL);
  const keyData = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const wallet = new ethers.Wallet(keyData.privateKey, provider);
  check(wallet.address.toLowerCase() === keyData.address.toLowerCase(), 'key file address mismatch');

  const musebook = new ethers.Contract(cfg.TOKENS.musebook, MUSEBOOK_ABI, provider);
  const dist = new ethers.Contract(DISTRIBUTOR, DIST_ABI, provider);

  // --- 1. Epoch selection: next unpublished on-chain epoch -------------------
  const onchainLatest = Number(await dist.latestEpoch());
  const epochId = arg('epoch-id') ? Number(arg('epoch-id')) : onchainLatest + 1;
  check(Number.isInteger(epochId) && epochId >= 1, 'bad epoch id');
  if (!arg('epoch-id')) {
    console.log('on-chain latestEpoch=' + onchainLatest + ' -> scoring epoch ' + epochId);
  }

  // --- 2. All 7 snapshots must exist -----------------------------------------
  const startMs = Date.parse(cfg.EPOCH_1_START) + (epochId - 1) * 7 * 86400000;
  const snapDates = [];
  for (let d = 0; d < 7; d++) {
    snapDates.push(new Date(startMs + d * 86400000).toISOString().slice(0, 10));
  }
  const snapDir = path.join(SNAP_DIR, 'epoch-' + epochId);
  const snapshots = snapDates.map((dt) => {
    const p = path.join(snapDir, 'day-' + dt + '.json');
    if (!fs.existsSync(p)) {
      fail('missing snapshot ' + p + ' — fail closed; never backfill or reconstruct a missed snapshot');
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  });
  console.log('snapshots: 7/7 present for epoch ' + epochId);

  // --- 2b. Trailing history for the persistent score: up to 6 days before
  // the epoch start, from the previous epoch dir or pre-epoch/. Missing
  // days are simply absent — score.js treats missing history as zero
  // holdings (the average runs over the days that exist).
  const historySnapshots = [];
  for (let back = 6; back >= 1; back--) {
    const dt = new Date(Date.parse(snapDates[0] + 'T00:00:00Z') - back * 86400000)
      .toISOString().slice(0, 10);
    for (const dir of [path.join(SNAP_DIR, 'epoch-' + (epochId - 1)), path.join(SNAP_DIR, 'pre-epoch')]) {
      const p = path.join(dir, 'day-' + dt + '.json');
      if (fs.existsSync(p)) { historySnapshots.push(JSON.parse(fs.readFileSync(p, 'utf8'))); break; }
    }
  }
  console.log('trailing history: ' + historySnapshots.length + '/6 days before ' + snapDates[0]);

  // --- 3. Registry ------------------------------------------------------------
  const regPath = path.join(API_DIR, 'identity-registry.json');
  // Registry format: { walletAddress: { muse_id, linked_at } } (see score.js loadRegistry).
  let registry = {};
  if (fs.existsSync(regPath)) registry = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  const linkedCount = Object.keys(registry).length;

  // --- 4. Pot: treasury/8 at epoch start + carryover --------------------------
  let state = { lastCompletedEpoch: 0, carryoverWei: '0' };
  if (fs.existsSync(STATE_PATH)) state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const carryover = BigInt(state.carryoverWei || '0');
  // Epoch economics come from the epoch-START daily snapshot file, which
  // recorded treasury MUSEBOOK + token supplies AT the start block while it
  // was still inside the RPC's history window. Never re-read them via a
  // historical blockTag here: the public RPC only keeps ~5k-20k blocks of
  // state, so a 6-day-old blockTag reverts (found 2026-09-27).
  const startSnap = snapshots[0];
  const startBlock = startSnap.block;
  check(startSnap.treasuryMusebook != null,
    'epoch-start snapshot ' + snapDates[0] + ' is missing treasuryMusebook — re-run daily snapshots with the fixed engine');
  check(startSnap.treasury && startSnap.treasury.toLowerCase() === TREASURY.toLowerCase(),
    'epoch-start snapshot treasury ' + startSnap.treasury + ' != ' + TREASURY);
  const treasuryBal = BigInt(startSnap.treasuryMusebook);
  const eighth = treasuryBal / 8n;
  const pot = eighth + carryover;
  console.log('treasury@start(block ' + startBlock + ')=' + ethers.formatEther(treasuryBal) + ' pot=' + ethers.formatEther(pot) +
    ' (1/8=' + ethers.formatEther(eighth) + ' carryover=' + ethers.formatEther(carryover) + ')');

  if (linkedCount === 0) {
    // Zero-claim epoch: valid state, nothing to publish. Pot rolls forward.
    const epochFile = {
      epochId, distributor: DISTRIBUTOR, published: false,
      reason: 'zero-claim epoch: no verified muse wallets in registry',
      pot: pot.toString(), totalAllocated: '0',
      carryoverNext: pot.toString(),
      snapshotDates: snapDates, generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(API_DIR, 'epoch-' + epochId + '.json'), JSON.stringify(epochFile, null, 2));
    if (!DRY_RUN) {
      fs.writeFileSync(STATE_PATH, JSON.stringify({ lastCompletedEpoch: epochId, carryoverWei: pot.toString() }, null, 2));
    }
    console.log('ZERO_CLAIM_EPOCH epoch=' + epochId + ' pot=' + ethers.formatEther(pot) + ' rolls forward as carryover' + (DRY_RUN ? ' DRY_RUN' : ''));
    return;
  }

  // --- 5. Score ---------------------------------------------------------------
  check(startSnap.supplies && startSnap.supplies.porch != null && startSnap.supplies.mdog != null,
    'epoch-start snapshot ' + snapDates[0] + ' is missing token supplies — re-run daily snapshots with the fixed engine');
  const porchSupply = BigInt(startSnap.supplies.porch);
  const mdogSupply = BigInt(startSnap.supplies.mdog);
  const { epochConfig, claims, board } = scoreEpoch({
    epochId,
    startTs: snapshots[0].ts,
    endTs: snapshots[6].ts + 86400,
    snapshots,
    historySnapshots,
    registryJson: registry,
    treasuryMusebook: treasuryBal,
    carryover,
    supplies: { porch: porchSupply, mdog: mdogSupply },
    distributor: DISTRIBUTOR,
  });
  const totalAllocated = BigInt(epochConfig.totalAllocated);
  console.log('scored: ' + claims.length + ' claims, totalAllocated=' + ethers.formatEther(totalAllocated));

  // --- 6. Fail-closed sanity checks (off-chain) --------------------------------
  const sum = claims.reduce((a, c) => a + BigInt(c.amount), 0n);
  check(sum === totalAllocated, 'amounts sum ' + sum + ' != totalAllocated ' + totalAllocated);
  check(totalAllocated <= pot, 'totalAllocated exceeds pot');
  const carryoverNext = pot - totalAllocated;
  check(carryoverNext >= 0n, 'negative carryover');

  const MIN = 10n ** 18n;
  const seen = new Set();
  let topShare = 0n;
  claims.forEach((c, i) => {
    const amt = BigInt(c.amount);
    check(amt >= MIN, 'claim ' + i + ' below 1 MUSEBOOK floor');
    const share = (amt * 10000n) / totalAllocated; // basis points of pot
    if (share > topShare) topShare = share;
    check(c.index === i, 'claim index out of order at ' + i);
    const a = ethers.getAddress(c.account);
    check(!seen.has(a.toLowerCase()), 'duplicate account ' + a);
    seen.add(a.toLowerCase());
  });
  // Concentration is a WARNING, not an abort: the real whale guard is the
  // score-level 2%-of-supply cap inside score.js (tested). A high share here
  // just means a few big holders dominate — legitimate, but worth flagging.
  if (topShare > 2500n) {
    console.log('CONCENTRATION_WARNING: top claim is ' + (Number(topShare) / 100).toFixed(2) + '% of the pot');
  }

  // Rebuild the tree independently and compare the root.
  const leaves = claims.map((c) => ({ epochId, index: c.index, account: c.account, amount: c.amount }));
  const rebuilt = buildTree(leaves);
  check(rebuilt.root.toLowerCase() === epochConfig.merkleRoot.toLowerCase(),
    'rebuilt root ' + rebuilt.root + ' != scored root ' + epochConfig.merkleRoot);

  // Spot-verify 5 random proofs against the rebuilt root.
  for (let k = 0; k < Math.min(5, claims.length); k++) {
    const c = claims[Math.floor(Math.random() * claims.length)];
    let h = leafHash(epochId, c.index, c.account, c.amount);
    for (const p of rebuilt.proofs.get(c.index)) h = pairHash(h, p);
    check(h.toLowerCase() === rebuilt.root.toLowerCase(), 'proof failed for claim index ' + c.index);
  }

  // Count sanity vs previous epoch (or absolute bound for epoch 1).
  const prevPath = path.join(API_DIR, 'epoch-' + (epochId - 1) + '.json');
  if (fs.existsSync(prevPath)) {
    const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    const prevCount = prev.claimCount || 0;
    if (prevCount > 0) {
      check(claims.length >= Math.max(1, Math.floor(prevCount / 10)) && claims.length <= prevCount * 10,
        'claim count ' + claims.length + ' outside 10x band of previous epoch ' + prevCount);
    }
  } else {
    check(claims.length <= 100000, 'absurd claim count for first epoch: ' + claims.length);
  }
  console.log('off-chain checks passed');

  // --- 7. On-chain preconditions ----------------------------------------------
  // (skipped in DRY_RUN: dry-run validates the off-chain pipeline only)
  if (DRY_RUN) {
    console.log('DRY_RUN: skipping on-chain precondition checks (owner, epoch-exists, funding)');
  } else {
    const owner = await dist.owner();
    check(owner.toLowerCase() === wallet.address.toLowerCase(),
      'distributor owner is ' + owner + ', not the automation key ' + wallet.address +
      ' — transferOwnership has not happened yet');
    const ep = await dist.epochs(epochId);
    check(!ep.exists, 'epoch ' + epochId + ' already published on-chain');

  // Finalize any expired-but-unfinalized earlier epochs (permissionless, frees carryover).
  const now = Math.floor(Date.now() / 1000);
  const gasBal = await provider.getBalance(wallet.address);
  check(gasBal >= ethers.parseEther('0.002'), 'automation key has no gas ETH');
  const distW = new ethers.Contract(DISTRIBUTOR, DIST_ABI, wallet);
  for (let id = 1; id < epochId; id++) {
    const e = await dist.epochs(id);
    if (e.exists && !e.finalized && Number(e.claimDeadline) < now) {
      const tx = await distW.finalizeEpoch(id);
      await tx.wait(1);
      console.log('finalized expired epoch ' + id + ' tx=' + tx.hash);
    }
  }

  // Funding: free funds must cover the FULL pot (fail closed -> top-up notice).
  const bal = await musebook.balanceOf(DISTRIBUTOR);
  const locked = await dist.allocatedUnclaimed();
  const free = bal - locked;
  check(free >= pot, 'distributor underfunded: free=' + ethers.formatEther(free) +
    ' pot=' + ethers.formatEther(pot) + ' — top up ' + ethers.formatEther(pot - free) + ' MUSEBOOK to ' + DISTRIBUTOR);
  } // end else (not DRY_RUN)

  // --- 8. Publish --------------------------------------------------------------
  let txHash = null;
  if (DRY_RUN) {
    console.log('DRY_RUN: would publishRoot(' + epochId + ', ' + epochConfig.merkleRoot + ', ' +
      ethers.formatEther(totalAllocated) + ')');
  } else {
    const distW = new ethers.Contract(DISTRIBUTOR, DIST_ABI, wallet);
    const tx = await distW.publishRoot(epochId, epochConfig.merkleRoot, totalAllocated);
    console.log('publishRoot sent: ' + tx.hash);
    const rc = await tx.wait(1);
    check(rc.status === 1, 'publishRoot tx reverted: ' + tx.hash);
    txHash = tx.hash;
    const onchain = await dist.epochs(epochId);
    check(onchain.exists && onchain.root.toLowerCase() === epochConfig.merkleRoot.toLowerCase(),
      'on-chain root mismatch after publish');
    check(onchain.totalAllocated === totalAllocated, 'on-chain totalAllocated mismatch');
    console.log('PUBLISHED epoch=' + epochId + ' tx=' + txHash);
  }

  // --- 9. Write artifacts -------------------------------------------------------
  const claimsFile = claims.map((c) => ({
    index: c.index, account: ethers.getAddress(c.account), amount: c.amount,
    proof: rebuilt.proofs.get(c.index), root: epochConfig.merkleRoot,
    totalAllocated: epochConfig.totalAllocated,
  }));
  const epochFile = {
    epochId, distributor: DISTRIBUTOR, published: !DRY_RUN,
    publishedTx: txHash, root: epochConfig.merkleRoot,
    pot: pot.toString(), totalAllocated: epochConfig.totalAllocated,
    claimCount: claims.length, carryoverNext: carryoverNext.toString(),
    claimDeadline: DRY_RUN ? null : Number((await dist.epochs(epochId)).claimDeadline),
    snapshotDates: snapDates, generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(API_DIR, 'epoch-' + epochId + '.json'), JSON.stringify(epochFile, null, 2));
  fs.writeFileSync(path.join(API_DIR, 'claims-' + epochId + '.json'), JSON.stringify(claimsFile, null, 2));
  fs.writeFileSync(path.join(API_DIR, 'board-' + epochId + '.json'), JSON.stringify(board, null, 2));

  // Site files (GitHub Pages serves the claim panel from here).
  fs.mkdirSync(SITE_REWARDS, { recursive: true });
  fs.copyFileSync(path.join(API_DIR, 'epoch-' + epochId + '.json'), path.join(SITE_REWARDS, 'epoch-' + epochId + '.json'));
  fs.copyFileSync(path.join(API_DIR, 'claims-' + epochId + '.json'), path.join(SITE_REWARDS, 'claims-' + epochId + '.json'));
  // Manifest is the claim page's single source of truth for live-ness.
  // published:false until a human signs and epoch-pipeline.js activate confirms
  // the root on-chain and flips it. claim.js never needs a manual address flip.
  const manifest = { latestEpochId: epochId, distributor: DISTRIBUTOR, published: !DRY_RUN, publishedTx: txHash, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(SITE_REWARDS, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (!DRY_RUN) {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ lastCompletedEpoch: epochId, carryoverWei: carryoverNext.toString() }, null, 2));
  }
  console.log('SUMMARY epoch=' + epochId + ' claims=' + claims.length +
    ' pot=' + ethers.formatEther(pot) + ' allocated=' + ethers.formatEther(totalAllocated) +
    ' carryoverNext=' + ethers.formatEther(carryoverNext) +
    (txHash ? ' tx=' + txHash : ' DRY_RUN'));
}

main().catch((e) => fail(e.message || String(e)));
