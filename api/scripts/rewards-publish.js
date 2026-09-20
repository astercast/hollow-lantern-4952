#!/usr/bin/env node
// rewards-publish.js — weekly rewards epoch builder for Muse Dogs holder rewards.
//
// Reads the 7 daily snapshots for a Monday-starting week, computes each
// holder's time-weighted pro-rata share of the weekly pot, builds the
// sorted-pair merkle tree, writes api/data/rewards/epochs/<epochId>.json,
// and prints the exact publishRoot(uint256,bytes32,uint256) calldata for the
// project multisig to sign.
//
//   node scripts/rewards-publish.js --week YYYY-MM-DD --pot <wei> [--data-dir <dir>]
//
//   --week      Monday (UTC) that starts the week, YYYY-MM-DD.
//   --pot       weekly pot in wei (integer, as a decimal string).
//   --data-dir  rewards data dir (default: <api>/data).
//
// MATH (integer wei, no floats anywhere)
//   weight(h)   = sum of h's daily balances across the 7 snapshots
//   totalWeight = sum of all holders' weights
//   share(h)    = floor(weight(h) * pot / totalWeight)
//   dust        = pot - sum(shares)
//   DUST RULE: the dust goes to the largest shareholder (highest weight);
//   on a weight tie, the lexicographically smallest lowercase address wins.
//   This is fully deterministic — the same inputs always produce the same
//   file, which the multisig can re-run to verify the published root.
//
// MERKLE TREE (hand-rolled; must match the Solidity contract exactly)
//   leaf        = keccak256(abi.encode(address holder, uint256 amount))
//   hashPair    = OpenZeppelin MerkleProof sorted-pair convention:
//                 sort the two child hashes as bytes, keccak256(min || max)
//   leaves      = sorted ascending by leaf hash (bytes) before building
//   odd layer   = duplicate the last node, then pair (0,1),(2,3),…
//   root        = single hash left at the top
//   proof(leaf) = sibling at each level up (empty proof for a single leaf —
//                 OZ MerkleProof.verify([]) checks leaf == root, which holds)
//   The script self-verifies every emitted proof before writing the file.
//
// FAIL-CLOSED: exits non-zero if the week is not a Monday, any of the 7
// snapshots is missing, snapshots disagree on the NFT contract, the pot is
// not a positive integer, or the total weight is zero. Nothing is published
// by this script — it only writes the file and prints calldata.
//
// LIMITATIONS
//   - The 7 snapshots must all exist; backfilling a missed day is a manual
//     re-run of rewards-snapshot.js for that date.
//   - Time-weighting is per-day granularity (7 balance samples), exactly as
//     the locked mechanics specify — not per-block.
//   - The dust rule is a convention, documented above; it is deterministic
//     and auditable, but the contract cannot check it (it only checks roots).

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

function usage(exitCode) {
  console.log([
    'Usage: node scripts/rewards-publish.js --week YYYY-MM-DD --pot <wei> [--data-dir DIR]',
    '',
    '  --week      Monday (UTC) starting the week',
    '  --pot       weekly pot in wei (positive integer, decimal string)',
    '  --data-dir  rewards data dir (default: <api>/data)',
    '',
    'Writes <data>/rewards/epochs/<epochId>.json and prints publishRoot calldata.',
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

// --- merkle tree (sorted pairs, OZ MerkleProof convention) -----------------

function leafHash(address, amountWei) {
  return ethers.solidityPackedKeccak256(['address', 'uint256'], [address, BigInt(amountWei)]);
}

function hashPair(a, b) {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

// leaves: array of leaf hashes sorted ascending. Returns { root, layers }.
function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('Cannot build a tree with no leaves.');
  const layers = [leaves.slice()];
  let layer = layers[0];
  while (layer.length > 1) {
    const padded = layer.length % 2 === 1 ? layer.concat([layer[layer.length - 1]]) : layer;
    const next = [];
    for (let i = 0; i < padded.length; i += 2) next.push(hashPair(padded[i], padded[i + 1]));
    layers.push(next);
    layer = next;
  }
  return { root: layers[layers.length - 1][0], layers };
}

function proofFor(layers, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const padded = layer.length % 2 === 1 ? layer.concat([layer[layer.length - 1]]) : layer;
    proof.push(padded[idx ^ 1]);
    idx = idx >> 1;
  }
  return proof;
}

// Mirrors what the Solidity contract does with OZ MerkleProof.verify.
function verifyLeaf(leaf, proof, root) {
  let h = leaf;
  for (const sib of proof) h = hashPair(h, sib);
  return h.toLowerCase() === root.toLowerCase();
}

// --- week math --------------------------------------------------------------

function mondayDates(weekStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStr)) {
    throw new Error('--week must be YYYY-MM-DD, got: ' + weekStr);
  }
  const [y, m, d] = weekStr.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d);
  if (new Date(start).getUTCDay() !== 1) {
    throw new Error('--week must be a Monday (UTC); ' + weekStr + ' is a ' +
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(start).getUTCDay()] + '.');
  }
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(start + i * 86400_000).toISOString().slice(0, 10));
  }
  return { days, epochId: start / 1000, start };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.week || !args.pot) {
    console.error('Missing required args.');
    usage(2);
  }
  if (!/^\d+$/.test(args.pot) || BigInt(args.pot) <= 0n) {
    throw new Error('--pot must be a positive integer in wei, got: ' + args.pot);
  }
  const pot = BigInt(args.pot);
  const { days, epochId, start } = mondayDates(args.week);
  const dataDir = args.data_dir || path.join(__dirname, '..', 'data');
  const snapDir = path.join(dataDir, 'rewards', 'snapshots');

  // Load the 7 snapshots — fail closed on any gap.
  const missing = days.filter((day) => !fs.existsSync(path.join(snapDir, day + '.json')));
  if (missing.length > 0) {
    throw new Error('Missing snapshots for ' + missing.join(', ') +
      '. Run rewards-snapshot.js --day <each> first; refusing to publish a partial week.');
  }
  const snaps = days.map((day) => JSON.parse(fs.readFileSync(path.join(snapDir, day + '.json'), 'utf8')));
  const nft = snaps[0].nft;
  for (const s of snaps) {
    if (String(s.nft).toLowerCase() !== String(nft).toLowerCase()) {
      throw new Error('Snapshot ' + s.date + ' is for a different NFT contract (' + s.nft + ' vs ' + nft + '). Refusing.');
    }
  }

  // Time-weighted pro-rata: weight = sum of daily balances.
  const weights = new Map(); // checksummed addr -> BigInt weight
  for (const s of snaps) {
    for (const [addr, count] of Object.entries(s.balances || {})) {
      const c = ethers.getAddress(addr);
      const n = Number(count);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error('Snapshot ' + s.date + ' has a bad balance for ' + addr + ': ' + count);
      }
      weights.set(c, (weights.get(c) || 0n) + BigInt(n));
    }
  }
  for (const [addr, w] of [...weights]) if (w === 0n) weights.delete(addr);
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0n);
  if (totalWeight === 0n) {
    throw new Error('Total holder weight for the week is zero — nothing to publish.');
  }

  // Integer shares; dust to the largest shareholder (ties: lowest address).
  const shares = new Map();
  let dustRecipient = null;
  for (const [addr, w] of weights) {
    shares.set(addr, (w * pot) / totalWeight);
    if (!dustRecipient ||
        w > weights.get(dustRecipient) ||
        (w === weights.get(dustRecipient) && addr.toLowerCase() < dustRecipient.toLowerCase())) {
      dustRecipient = addr;
    }
  }
  const paid = [...shares.values()].reduce((a, b) => a + b, 0n);
  const dust = pot - paid;
  shares.set(dustRecipient, shares.get(dustRecipient) + dust);

  // Build the tree.
  const addrs = [...shares.keys()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const leaves = addrs.map((addr) => ({ addr, leaf: leafHash(addr, shares.get(addr)) }));
  leaves.sort((a, b) => (BigInt(a.leaf) < BigInt(b.leaf) ? -1 : 1));
  const { root, layers } = buildTree(leaves.map((l) => l.leaf));

  // Emit claims and self-verify every proof (cheap for a 500-supply tree).
  const claims = {};
  for (let i = 0; i < leaves.length; i++) {
    const proof = proofFor(layers, i);
    if (!verifyLeaf(leaves[i].leaf, proof, root)) {
      throw new Error('Self-verification failed for ' + leaves[i].addr + ' — tree is inconsistent. Refusing to write.');
    }
    claims[leaves[i].addr] = {
      amount: shares.get(leaves[i].addr).toString(10),
      proof,
    };
  }

  const totalAmount = [...shares.values()].reduce((a, b) => a + b, 0n);
  if (totalAmount !== pot) {
    throw new Error('Internal error: shares sum to ' + totalAmount + ', pot is ' + pot + '.');
  }

  const doc = {
    epochId,
    weekStart: days[0],
    weekEnd: days[6],
    boundaryUtc: new Date(start).toISOString(),
    nft,
    chainId: 4663,
    root,
    totalAmount: totalAmount.toString(10),
    potWei: pot.toString(10),
    holderCount: addrs.length,
    totalWeight: totalWeight.toString(10),
    dustWei: dust.toString(10),
    dustRecipient,
    dustRule: 'remainder to the largest shareholder by weight; ties broken by lowest address',
    leafScheme: 'keccak256(abi.encode(address,uint256)), sorted pairs (OpenZeppelin MerkleProof convention)',
    addressEncoding: 'EIP-55 checksummed',
    claimAbi: 'claim(uint256 epochId, uint256 amount, bytes32[] proof)',
    publishAbi: 'publishRoot(uint256 epochId, bytes32 root, uint256 totalAmount)',
    claims,
    generatedAt: new Date().toISOString(),
  };

  const dir = path.join(dataDir, 'rewards', 'epochs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, String(epochId) + '.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');

  // Exact calldata for the multisig: publishRoot(uint256,bytes32,uint256).
  const iface = new ethers.Interface(['function publishRoot(uint256 epochId, bytes32 root, uint256 totalAmount)']);
  const calldata = iface.encodeFunctionData('publishRoot', [epochId, root, totalAmount.toString(10)]);

  console.log('epochId:      ' + epochId + '  (week of ' + days[0] + ' -> ' + days[6] + ', Monday 00:00 UTC)');
  console.log('holders:      ' + addrs.length);
  console.log('totalWeight:  ' + totalWeight.toString(10) + ' (sum of daily balances)');
  console.log('pot:          ' + pot.toString(10) + ' wei');
  console.log('dust:         ' + dust.toString(10) + ' wei -> ' + dustRecipient);
  console.log('root:         ' + root);
  console.log('totalAmount:  ' + totalAmount.toString(10));
  console.log('wrote:        ' + file);
  console.log('');
  console.log('publishRoot calldata for the multisig (verify by re-running this script):');
  console.log(calldata);
}

main().catch((e) => {
  console.error('rewards-publish FAILED: ' + (e.message || e));
  process.exit(1);
});
