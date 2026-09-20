#!/usr/bin/env node
// rewards-snapshot.js — daily holder-balance snapshot for Muse Dogs holder rewards.
//
// Reconstructs every holder's ERC-721 balance at a day's 00:00 UTC boundary by
// replaying Transfer events from a start block up to the boundary block, and
// writes api/data/rewards/snapshots/<YYYY-MM-DD>.json.
//
//   node scripts/rewards-snapshot.js --nft <0x nft address> --rpc <rpc url> --day YYYY-MM-DD \
//       [--from-block <n>] [--data-dir <dir>]
//
//   --nft         Muse Dogs ERC-721 contract address (0x…).
//   --rpc         Robinhood Chain (4663) JSON-RPC URL.
//   --day         UTC day to snapshot; the boundary is that day at 00:00 UTC.
//   --from-block  First block to scan logs from (defaults to 0; set it to the
//                 NFT deployment block in production so replays start there).
//   --data-dir    Defaults to ../data relative to this script.
//
// APPROACH
//   1. Compute the boundary unix timestamp: Date.UTC(day, 00:00:00).
//   2. Find the boundary block with a binary search over block timestamps:
//      the lowest block number whose timestamp is >= the boundary. (~log2 N
//      getBlock calls — cheap, works on any full node; see LIMITATIONS.)
//   3. Pull ERC-721 Transfer events with eth_getLogs in chunks (default
//      100,000 blocks per call; retry 4x with backoff because RPC log
//      endpoints flap). Chunk size is overrideable via REWARDS_LOG_CHUNK.
//   4. Replay the events into a balance map: 0x0 -> X is a mint, X -> 0x0 is
//      a burn, everything else is a transfer. Only balances > 0 are kept.
//   5. Write the JSON snapshot. Addresses are EIP-55 CHECKSUMMED (never
//      lowercase) — matching the API's checksumAddress convention — and the
//      map is sorted by lowercase address for a stable file.
//
// LIMITATIONS (read before trusting a snapshot)
//   - FULL/NON-PRUNED NODE REQUIRED. eth_getLogs from block 0 (or the
//     deployment block) needs a node that retains historical logs; a pruned
//     node answers with errors or gaps, which this script cannot detect.
//   - REORG RISK NEAR THE BOUNDARY. The boundary block is "latest minus
//     search" at run time; a shallow reorg can move it. Mitigation: run the
//     snapshot a few minutes after 00:00 UTC (or re-run after finality) and
//     treat the recorded blockNumber+blockHash as the canonical pin. Two
//     runs that land on different blocks will disagree — compare the file's
//     blockHash before publishing.
//   - APPROVAL EVENTS ARE IGNORED. Only Transfer moves balances, so only
//     Transfer is replayed. Non-standard token contracts that move balances
//     without emitting Transfer would be misread — Muse Dogs is a standard
//     ERC-721, so this is not expected.
//   - CHEAP BECAUSE THE SUPPLY IS 500. Replaying from genesis is a handful
//     of log pages; if the collection ever grew past 500 the scan still
//     works but costs more RPC calls.
//   - No private keys, no transactions, no spending — read-only.

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ZERO = '0x0000000000000000000000000000000000000000';
const CHAIN_ID = 4663;

function usage(exitCode) {
  console.log([
    'Usage: node scripts/rewards-snapshot.js --nft <address> --rpc <url> --day YYYY-MM-DD [--from-block N] [--data-dir DIR]',
    '',
    '  --nft         Muse Dogs ERC-721 contract address',
    '  --rpc         Robinhood Chain JSON-RPC URL (chain 4663)',
    '  --day         UTC day to snapshot (boundary = that day 00:00 UTC)',
    '  --from-block  first block to scan (default 0; use the deployment block in production)',
    '  --data-dir    rewards data dir (default: <api>/data)',
    '',
    'Writes <data>/rewards/snapshots/<YYYY-MM-DD>.json',
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// eth_getLogs with retries (RPC log endpoints flap; post.js uses the same
// 4x-backoff pattern).
async function getLogsWithRetry(provider, filter, tries = 4) {
  let last;
  for (let t = 0; t < tries; t++) {
    try {
      return await provider.send('eth_getLogs', [filter]);
    } catch (e) {
      last = e;
      await sleep(1000 * 2 ** t);
    }
  }
  throw last;
}

// Lowest block number with timestamp >= targetTs, searched in [lo, hi].
// Returns { number, timestamp, hash }.
async function findBoundaryBlock(provider, targetTs, lo, hi) {
  const cache = new Map();
  async function ts(n) {
    if (!cache.has(n)) {
      const b = await provider.getBlock(n);
      if (!b) throw new Error('getBlock(' + n + ') returned null — node may be pruned.');
      cache.set(n, { timestamp: Number(b.timestamp), hash: b.hash });
    }
    return cache.get(n);
  }
  const latest = await ts(hi);
  if (latest.timestamp < targetTs) {
    throw new Error('The day is in the future relative to this node (latest block ts ' +
      latest.timestamp + ' < boundary ' + targetTs + ').');
  }
  let left = lo, right = hi, ans = hi;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const { timestamp } = await ts(mid);
    if (timestamp >= targetTs) {
      ans = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }
  const meta = await ts(ans);
  return { number: ans, timestamp: meta.timestamp, hash: meta.hash };
}

function addrFromTopic(topic) {
  // 32-byte topic -> last 20 bytes, checksummed.
  return ethers.getAddress('0x' + topic.slice(-40));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.nft || !args.rpc || !args.day) {
    console.error('Missing required args.');
    usage(2);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.day)) {
    throw new Error('--day must be YYYY-MM-DD, got: ' + args.day);
  }
  let nft;
  try {
    nft = ethers.getAddress(args.nft);
  } catch {
    throw new Error('--nft is not a valid 0x address: ' + args.nft);
  }
  const [y, m, d] = args.day.split('-').map(Number);
  const boundaryTs = Date.UTC(y, m - 1, d) / 1000;
  const boundaryIso = new Date(boundaryTs * 1000).toISOString();
  const fromBlock = args.from_block !== undefined ? Number(args.from_block) : 0;
  if (!Number.isInteger(fromBlock) || fromBlock < 0) {
    throw new Error('--from-block must be a non-negative integer.');
  }
  const dataDir = args.data_dir || path.join(__dirname, '..', 'data');
  const chunk = Number(process.env.REWARDS_LOG_CHUNK || 100000);
  if (!Number.isInteger(chunk) || chunk <= 0) {
    throw new Error('REWARDS_LOG_CHUNK must be a positive integer.');
  }

  const provider = new ethers.JsonRpcProvider(args.rpc, CHAIN_ID, { staticNetwork: true });
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error('Provider reported chain ' + Number(net.chainId) + ', expected ' + CHAIN_ID + '.');
  }

  const latestNum = await provider.getBlockNumber();
  if (fromBlock > latestNum) {
    throw new Error('--from-block ' + fromBlock + ' is above the chain head ' + latestNum + '.');
  }
  const boundary = await findBoundaryBlock(provider, boundaryTs, fromBlock, latestNum);
  console.log('boundary: block ' + boundary.number + ' @ ' + new Date(boundary.timestamp * 1000).toISOString() +
    ' (target ' + boundaryIso + ')');

  // Replay Transfer events.
  const balances = new Map(); // lowercase addr -> count
  const add = (addr, delta) => {
    const next = (balances.get(addr) || 0) + delta;
    if (next <= 0) balances.delete(addr);
    else balances.set(addr, next);
  };
  let events = 0, malformed = 0;
  for (let start = fromBlock; start <= boundary.number; start += chunk) {
    const end = Math.min(start + chunk - 1, boundary.number);
    const logs = await getLogsWithRetry(provider, {
      address: nft,
      topics: [TRANSFER_TOPIC],
      fromBlock: ethers.toBeHex(start),
      toBlock: ethers.toBeHex(end),
    });
    for (const log of logs) {
      const topics = log.topics || [];
      if (topics.length < 3) { malformed++; continue; }
      const from = addrFromTopic(topics[1]).toLowerCase();
      const to = addrFromTopic(topics[2]).toLowerCase();
      events++;
      if (from !== ZERO) add(from, -1);
      if (to !== ZERO) add(to, 1);
    }
    if (events % 1000 === 0 || end === boundary.number) {
      process.stdout.write('\rscanned to block ' + end + ' (' + events + ' transfers)   ');
    }
  }
  process.stdout.write('\n');

  // Checksummed output map, sorted for a stable file.
  const out = {};
  const sorted = [...balances.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [addr, count] of sorted) out[ethers.getAddress(addr)] = count;
  const totalSupply = sorted.reduce((s, [, c]) => s + c, 0);

  const doc = {
    date: args.day,
    boundaryUtc: boundaryIso,
    blockNumber: boundary.number,
    blockHash: boundary.hash,
    blockTimestamp: boundary.timestamp,
    nft,
    chainId: CHAIN_ID,
    fromBlock,
    toBlock: boundary.number,
    transferEvents: events,
    malformedLogsSkipped: malformed,
    totalSupply,
    holderCount: sorted.length,
    balances: out,
    addressEncoding: 'EIP-55 checksummed',
    generatedAt: new Date().toISOString(),
  };

  const dir = path.join(dataDir, 'rewards', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, args.day + '.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log('wrote ' + file);
  console.log('holders: ' + sorted.length + ', supply: ' + totalSupply + ', events: ' + events);
  if (malformed > 0) console.log('WARNING: skipped ' + malformed + ' malformed logs.');
}

main().catch((e) => {
  console.error('rewards-snapshot FAILED: ' + (e.message || e));
  process.exit(1);
});
