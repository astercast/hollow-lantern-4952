#!/usr/bin/env node
/* Epoch pipeline orchestrator — everything automatic except the human's signing.
 *
 * The user signs fund + publishRoot himself every week. NOTHING here signs,
 * sends, or touches any key. This script prepares, verifies, and activates.
 *
 *   node epoch-pipeline.js prepare --epoch 1
 *     1. Verifies all 7 daily snapshots exist for the epoch (fail-closed).
 *     2. Runs the scoring engine in DRY-RUN (never publishes, never signs).
 *     3. Builds the signing bundle (fund top-up + publishRoot, exact wei).
 *     4. Checks on-chain for expired-but-unfinalized earlier epochs and
 *        prepends their permissionless finalizeEpoch calls to the bundle.
 *     5. Writes SIGNING-PACKAGE-epoch-<N>.md — the human's plain-English
 *        checklist: what each tx does, exact amounts, calldata, order.
 *
 *   node epoch-pipeline.js activate --epoch 1
 *     1. Reads the expected root from rewards/api/epoch-<N>.json.
 *     2. Verifies the root is actually published on-chain (epochs(N).exists
 *        and root matches). If not, stops — nothing goes live early.
 *     3. Finds the RootPublished tx hash from event logs.
 *     4. Writes the LIVE manifest (published:true) and deploys proofs:
 *        site/api/v1/rewards/* -> docs/api/v1/rewards/* (GitHub Pages),
 *        rewards/api/claims-<N>.json -> api/data/rewards/ (Render API),
 *        then pushes via gh-push.py (Render auto-deploys on push).
 *     The claim page reads the manifest — no manual address flip, ever.
 *
 * Usage: node epoch-pipeline.js <prepare|activate> --epoch N
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ethers } = require('ethers');

const ENGINE = __dirname;
const REWARDS = path.join(ENGINE, '..');
const API_DIR = path.join(REWARDS, 'api');
const SITE_REWARDS = path.join(REWARDS, '..', 'site', 'api', 'v1', 'rewards');
const DOCS_REWARDS = path.join(REWARDS, '..', 'docs', 'api', 'v1', 'rewards');
const API_DATA_REWARDS = path.join(REWARDS, '..', 'api', 'data', 'rewards');
const SNAP_DIR = path.join(REWARDS, 'snapshots');
const REPO = path.join(REWARDS, '..');

const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;
const DISTRIBUTOR = '0xc050c5d452a9733a2d951c97166eb3ca7b78e90b';
const TREASURY_EOA = '0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25';
const MUSEBOOK = '0x91A2DAe9699f0B82540B5886b0d8759C22820bA3';
// Re-anchored first published epoch (user's 2026-10-04 decision).
const EPOCH_1_START = '2026-10-12';

const DIST_ABI = [
  'function epochs(uint256) view returns (bytes32 root,uint256 totalAllocated,uint256 totalClaimed,uint64 publishTime,uint64 claimDeadline,bool finalized,bool exists)',
  'function latestEpoch() view returns (uint256)',
  'function finalizeEpoch(uint256 epochId)',
  'function publishRoot(uint256 epochId, bytes32 root, uint256 totalAllocated)',
  'event RootPublished(uint256 indexed epochId, bytes32 indexed root, uint256 totalAllocated, uint64 claimDeadline)',
];
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];

function arg(name, def = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  return process.argv[i + 1] || def;
}
function fail(msg) { console.error('FAIL: ' + msg); process.exit(1); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function epochDates(epochId) {
  const start = new Date(EPOCH_1_START + 'T00:00:00Z').getTime() + (epochId - 1) * 7 * 86400000;
  const out = [];
  for (let d = 0; d < 7; d++) out.push(new Date(start + d * 86400000).toISOString().slice(0, 10));
  return out;
}

function rpcCall(to, data) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
  const out = execFileSync('curl', ['-s', '-X', 'POST', RPC_URL, '-H', 'Content-Type: application/json', '-d', body],
    { encoding: 'utf8', timeout: 30000 });
  const j = JSON.parse(out);
  if (j.error) throw new Error('RPC: ' + JSON.stringify(j.error));
  return j.result;
}

// ---------------------------------------------------------------- prepare ---
async function prepare(epochId) {
  console.log('=== PREPARE epoch ' + epochId + ' ===');

  // 1. Snapshot check (fail-closed — never reconstruct).
  const dates = epochDates(epochId);
  const snapDir = path.join(SNAP_DIR, 'epoch-' + epochId);
  for (const dt of dates) {
    const p = path.join(snapDir, 'day-' + dt + '.json');
    if (!fs.existsSync(p)) fail('missing snapshot ' + p + ' — never hand-reconstruct; fix the snapshot job first');
    try {
      const s = readJson(p);
      if (s.treasuryMusebook === undefined && dt === dates[0]) fail(p + ' missing treasuryMusebook field');
    } catch (e) { fail('unreadable snapshot ' + p + ': ' + e.message); }
  }
  console.log('snapshots: 7/7 present (' + dates[0] + ' .. ' + dates[6] + ')');

  // 2. Scoring in DRY-RUN (validates the whole off-chain pipeline, signs nothing).
  console.log('running scoring engine (dry-run)…');
  const r = spawnSync('node', [path.join(ENGINE, 'weekly-epoch.js'), '--epoch-id', String(epochId), '--dry-run'],
    { encoding: 'utf8', timeout: 600000 });
  process.stdout.write(r.stdout || '');
  if (r.status !== 0) { process.stderr.write(r.stderr || ''); fail('scoring dry-run failed'); }

  // 3. Signing bundle (exact wei amounts + calldata; human signs from the EOA).
  console.log('building signing bundle…');
  const pb = spawnSync('node', [path.join(ENGINE, 'publish.js'), '--epoch', String(epochId), '--api', API_DIR],
    { encoding: 'utf8' });
  process.stdout.write(pb.stdout || '');
  if (pb.status !== 0) { process.stderr.write(pb.stderr || ''); fail('publish.js failed'); }
  const bundlePath = path.join(API_DIR, 'safe-bundle-epoch-' + epochId + '.json');
  const bundle = readJson(bundlePath);

  // 4. Expired-but-unfinalized earlier epochs -> permissionless finalizeEpoch calls.
  const iface = new ethers.Interface(DIST_ABI);
  const finalizeTxs = [];
  try {
    const latestHex = rpcCall(DISTRIBUTOR, iface.encodeFunctionData('latestEpoch'));
    const latest = Number(iface.decodeFunctionResult('latestEpoch', latestHex)[0]);
    for (let e = 1; e <= latest; e++) {
      if (e === Number(epochId)) continue;
      const epHex = rpcCall(DISTRIBUTOR, iface.encodeFunctionData('epochs', [e]));
      const ep = iface.decodeFunctionResult('epochs', epHex);
      const now = Math.floor(Date.now() / 1000);
      if (ep.exists && !ep.finalized && Number(ep.claimDeadline) < now) {
        finalizeTxs.push({
          to: DISTRIBUTOR, value: '0',
          data: iface.encodeFunctionData('finalizeEpoch', [e]),
          description: `Finalize expired epoch ${e} (permissionless — releases its unclaimed to carryover)`,
        });
        console.log('epoch ' + e + ' is expired and unfinalized — finalizeEpoch added to the bundle');
      }
    }
  } catch (e) {
    console.log('note: could not check prior epochs on-chain (' + e.message + ') — continuing without finalize steps');
  }
  const txs = [...finalizeTxs, ...bundle.transactions];
  bundle.transactions = txs;
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

  // 5. Plain-English signing checklist.
  const epochFile = readJson(path.join(API_DIR, 'epoch-' + epochId + '.json'));
  const lines = [];
  lines.push('# Signing package — Muse Dogs rewards, epoch ' + epochId);
  lines.push('');
  lines.push('Generated ' + new Date().toISOString() + '. Everything below was computed');
  lines.push('automatically; your ONLY job is signing these transactions from the treasury');
  lines.push('wallet `' + TREASURY_EOA + '` on Robinhood Chain (id 4663), in order.');
  lines.push('');
  lines.push('## What you are signing and why');
  txs.forEach((t, i) => {
    lines.push('');
    lines.push('### ' + (i + 1) + '. ' + t.description);
    lines.push('- To: `' + t.to + '`');
    lines.push('- Value: ' + t.value + ' (no ETH moves — token/contract calls only)');
    lines.push('- Calldata: `' + t.data + '`');
  });
  lines.push('');
  lines.push('## Amounts');
  lines.push('- Epoch pot: ' + ethers.formatUnits(epochFile.pot, 18) + ' $MUSEBOOK');
  lines.push('- Total allocated to claimants: ' + ethers.formatUnits(epochFile.totalAllocated, 18) + ' $MUSEBOOK');
  lines.push('- Merkle root: `' + epochFile.root + '`');
  lines.push('- Claimants in this epoch: ' + epochFile.claimCount);
  lines.push('- Claim window: 30 days from publish. Vesting: 1/7 per day over 7 days.');
  lines.push('- Unclaimed after the window rolls forward to future epochs (nothing is lost).');
  lines.push('');
  lines.push('## After you sign');
  lines.push('Run: `node epoch-pipeline.js activate --epoch ' + epochId + '`');
  lines.push('That verifies the root on-chain and publishes the claim proofs — no further');
  lines.push('action needed from you.');
  lines.push('');
  lines.push('## Safety notes');
  lines.push('- These calls move $MUSEBOOK INTO the distributor and publish the root.');
  lines.push('- Nothing here grants token approvals or moves funds anywhere else.');
  lines.push('- If anything in your wallet preview differs from the amounts above, STOP');
  lines.push('  and do not sign.');
  const mdPath = path.join(API_DIR, 'SIGNING-PACKAGE-epoch-' + epochId + '.md');
  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log('wrote ' + mdPath);
  console.log('=== PREPARE done — waiting on human signing ===');
}

// ---------------------------------------------------------------- activate ---
async function activate(epochId) {
  console.log('=== ACTIVATE epoch ' + epochId + ' ===');
  const epochFile = readJson(path.join(API_DIR, 'epoch-' + epochId + '.json'));
  const expectedRoot = String(epochFile.root).toLowerCase();

  // 1+2. On-chain verification: the root must actually be published.
  const iface = new ethers.Interface(DIST_ABI);
  let ep;
  try {
    const epHex = rpcCall(DISTRIBUTOR, iface.encodeFunctionData('epochs', [epochId]));
    ep = iface.decodeFunctionResult('epochs', epHex);
  } catch (e) { fail('could not read on-chain epoch state: ' + e.message); }
  if (!ep.exists) fail('epoch ' + epochId + ' is not published on-chain yet — sign first, then re-run activate');
  if (String(ep.root).toLowerCase() !== expectedRoot) {
    fail('on-chain root ' + ep.root + ' does not match scored root ' + expectedRoot + ' — STOP, investigate');
  }
  console.log('on-chain root verified for epoch ' + epochId);

  // 3. Find the RootPublished tx hash from event logs.
  let publishedTx = null;
  try {
    const topic0 = iface.getEvent('RootPublished').topicHash;
    const epTopic = ethers.zeroPadValue(ethers.toBeHex(epochId), 32);
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
      params: [{ address: DISTRIBUTOR, topics: [topic0, epTopic], fromBlock: '0x0', toBlock: 'latest' }],
    });
    const out = execFileSync('curl', ['-s', '-X', 'POST', RPC_URL, '-H', 'Content-Type: application/json', '-d', body],
      { encoding: 'utf8', timeout: 60000 });
    const logs = JSON.parse(out).result || [];
    if (logs.length) publishedTx = logs[logs.length - 1].transactionHash;
  } catch (e) { console.log('note: could not fetch publish tx hash (' + e.message + ')'); }
  console.log('publish tx: ' + (publishedTx || '(unknown — verified by root match)'));

  // 4. Live manifest + proof deploy.
  fs.mkdirSync(SITE_REWARDS, { recursive: true });
  const manifest = {
    latestEpochId: Number(epochId),
    distributor: DISTRIBUTOR,
    published: true,
    publishedTx,
    root: epochFile.root,
    totalAllocated: epochFile.totalAllocated,
    claimDeadline: Number(ep.claimDeadline),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(SITE_REWARDS, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('live manifest written');

  // Site proofs -> docs/ (GitHub Pages serves the claim panel from here).
  fs.mkdirSync(DOCS_REWARDS, { recursive: true });
  for (const f of ['epoch-' + epochId + '.json', 'claims-' + epochId + '.json', 'manifest.json']) {
    fs.copyFileSync(path.join(SITE_REWARDS, f), path.join(DOCS_REWARDS, f));
  }
  // Keep docs/claim.js in sync with site/claim.js (they must stay identical).
  fs.copyFileSync(path.join(REPO, 'site', 'claim.js'), path.join(REPO, 'docs', 'claim.js'));
  console.log('site proofs staged in docs/');

  // API proofs -> api/data/rewards/ (Render serves agents from here).
  fs.mkdirSync(API_DATA_REWARDS, { recursive: true });
  fs.copyFileSync(path.join(API_DIR, 'claims-' + epochId + '.json'), path.join(API_DATA_REWARDS, 'claims-' + epochId + '.json'));
  console.log('API proofs staged in api/data/rewards/');

  // Push (tracked files only) — Render auto-deploys the API on push.
  console.log('pushing…');
  const pr = spawnSync('python3', [path.join(process.env.HOME || '/home/hatch', 'workspace/skills/github/bin/gh-push.py'), REPO],
    { encoding: 'utf8', timeout: 600000 });
  process.stdout.write(pr.stdout || '');
  if (pr.status !== 0) { process.stderr.write(pr.stderr || ''); fail('gh-push failed — proofs are staged locally but NOT live; re-run activate after fixing'); }

  console.log('=== ACTIVATE done — epoch ' + epochId + ' is live ===');
}

// ----------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2];
  const epochId = arg('epoch');
  if (!epochId || !/^\d+$/.test(epochId)) fail('usage: node epoch-pipeline.js <prepare|activate> --epoch N');
  if (cmd === 'prepare') await prepare(epochId);
  else if (cmd === 'activate') await activate(epochId);
  else fail('unknown command ' + cmd + ' — use prepare or activate');
}
main().catch((e) => { console.error('fatal: ' + (e && e.message || e)); process.exit(1); });
