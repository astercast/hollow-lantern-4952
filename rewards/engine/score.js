/* Epoch scoring for the rewards engine.
 *
 * Locked rules (Andrew 2026-09-26; simplified 2026-09-27; LP removed 2026-09-27):
 *   - 7 daily snapshots -> time-weighted average per token per wallet
 *   - pot = treasury MUSEBOOK / 8 + carryover (unclaimed from prior epochs)
 *   - ONE score per wallet: PORCH holdings weigh 50, MDOG holdings weigh 30,
 *     so PORCH counts ~1.67x more than MDOG. 100% of the pot is distributed
 *     to holders — no reserve, no treasury cut, no separate categories.
 *   - Scoring uses SPOT wallet balances only. No LP tracking, no LP
 *     multiplier, no replay, no LP eligibility (Andrew 2026-09-27).
 *   - claimed by holders, never airdropped; one wallet per verified muse ID;
 *     unlinked wallets earn nothing
 * Proposed guards (defaults; change in config.js before epoch 1):
 *   - floor on >= 4/7 snapshots (1M PORCH / 1K MDOG); a wallet earns from a
 *     token only if it clears that token's floor
 *   - whale cap: score <= 2% of class total supply
 */
'use strict';

const { buildTree } = require('./merkle');
const cfg = require('./config');

/* registry: {wallet: {muse_id, linked_at}} -> Map(wallet -> muse_id), deduped by muse_id (latest wins) */
function loadRegistry(json) {
  const entries = Object.entries(json)
    .map(([w, r]) => ({ w: w.toLowerCase(), muse: r.muse_id, at: r.linked_at || 0 }))
    .sort((a, b) => a.at - b.at);
  const byMuse = new Map();
  for (const e of entries) byMuse.set(e.muse, e.w);
  const wallets = new Map();
  for (const w of byMuse.values()) wallets.set(w, true);
  return wallets;
}

function scoreEpoch({ epochId, startTs, endTs, snapshots, registryJson, treasuryMusebook, carryover, supplies, distributor }) {
  const linked = loadRegistry(registryJson);
  const pot = treasuryMusebook / BigInt(cfg.POT_DIVISOR) + carryover;

  const classes = ['porch', 'mdog'];
  const scores = { porch: new Map(), mdog: new Map() }; // wallet -> score (spot wei, time-averaged)
  const cleared = new Map(); // wallet -> Set of classes whose floor it cleared
  const floors = { porch: 0, mdog: 0 };

  for (const cls of classes) {
    const floor = cfg.FLOOR[cls];
    // whale cap: 2% of class total supply, in spot wei — pure bigint math
    const cap = (supplies[cls] * BigInt(cfg.WHALE_CAP_BP)) / 10000n;
    for (const w of linked.keys()) {
      let spotSum = 0n, floorDays = 0;
      for (const s of snapshots) {
        // SPOT ONLY — s.lp is ignored entirely (LP removed from rewards 2026-09-27).
        const sp = BigInt((s.spot[w] && s.spot[w][cls]) || '0');
        if (sp >= floor) floorDays++;
        spotSum += sp;
      }
      if (floorDays < cfg.FLOOR_DAYS) continue;
      let score = spotSum / BigInt(snapshots.length);
      if (score > cap) score = cap;
      if (score > 0n) {
        scores[cls].set(w, score);
        if (!cleared.has(w)) cleared.set(w, new Set());
        cleared.get(w).add(cls);
      } else floors[cls]++;
    }
  }

  // Class totals over wallets that cleared that class's floor.
  // Weights are relative (50 + 30 = 80); each class pot is its weight's share
  // of the full pot, so 100% of the pot is distributed to holders.
  const totals = {};
  const classPots = {};
  const weightSum = BigInt(cfg.WEIGHTS.porch + cfg.WEIGHTS.mdog);
  for (const cls of classes) {
    let total = 0n;
    for (const s of scores[cls].values()) total += s;
    totals[cls] = total;
    classPots[cls] = (pot * BigInt(cfg.WEIGHTS[cls])) / weightSum;
  }

  // ONE combined leaf per wallet: amount(w) = sum over classes of
  // weight[cls]/weightSum * pot * (score(w,cls)/total(cls)).
  // PORCH weighs 50, MDOG weighs 30 — one claim per wallet.
  const leaves = [];
  const board = [];
  let totalAllocated = 0n;
  for (const w of cleared.keys()) {
    const clsSet = cleared.get(w);
    let amount = 0n;
    const parts = {};
    for (const cls of classes) {
      if (!clsSet.has(cls) || totals[cls] === 0n) continue;
      const part = (scores[cls].get(w) * classPots[cls]) / totals[cls];
      parts[cls] = part;
      amount += part;
    }
    if (amount < cfg.MIN_PAYOUT_WEI) continue; // dust stays as carryover
    leaves.push({ epochId, index: leaves.length, account: w, amount: amount.toString() });
    totalAllocated += amount;
    // Display score: combined weight (50 + 30 = 80 max).
    // amount = score/80 * pot, exactly.
    let wNum = 0n, wDen = 1n;
    for (const cls of classes) {
      if (!clsSet.has(cls) || totals[cls] === 0n) continue;
      // term = WEIGHTS[cls] * score/total ; sum as a single rational
      wNum = wNum * totals[cls] + BigInt(cfg.WEIGHTS[cls]) * scores[cls].get(w) * wDen;
      wDen = wDen * totals[cls];
    }
    const score = wDen === 0n ? 0 : Number(wNum) / Number(wDen);
    board.push({
      wallet: w,
      porch: (scores.porch.get(w) || 0n).toString(),
      mdog: (scores.mdog.get(w) || 0n).toString(),
      score: score,
      amount: amount.toString(),
    });
  }
  board.sort((a, b) => b.score - a.score);

  const { root, proofs } = leaves.length
    ? buildTree(leaves)
    : { root: '0x' + '00'.repeat(32), proofs: new Map() };
  const claims = leaves.map((l) => ({ ...l, proof: proofs.get(l.index) }));

  const epochConfig = {
    epochId, startTs, endTs,
    enabled: { porch: true, mdog: true },
    scoring: 'combined-spot', // one score per wallet: PORCH weight 50 + MDOG weight 30, spot only, 100% of pot
    weights: cfg.WEIGHTS,
    potMusebook: pot.toString(),
    carryover: carryover.toString(),
    merkleRoot: root,
    totalAllocated: totalAllocated.toString(),
    claimCount: claims.length,
    distributor: distributor || null,
    guards: {
      floorPorch: cfg.FLOOR.porch.toString(), floorMdog: cfg.FLOOR.mdog.toString(),
      floorDays: cfg.FLOOR_DAYS, whaleCapBps: cfg.WHALE_CAP_BP,
      lp: 'removed 2026-09-27 — spot balances only, no multiplier, no replay',
      note: 'guard values are PROPOSED until Andrew rules',
    },
    publishedTx: null,
  };

  return { epochConfig, claims, board };
}

module.exports = { scoreEpoch, loadRegistry };
