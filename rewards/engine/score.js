/* Epoch scoring for the rewards engine.
 *
 * Locked rules (Andrew 2026-09-27 — persistent daily scoring; replaces the
 * old weekly-reset / 4-of-7 model):
 *   - Daily wallet snapshots of PORCH + MDOG spot balances (00:00 UTC).
 *   - ONE live score per wallet per day:
 *       dailyWeighted_t = 50 * cappedPorch_t + 30 * cappedMdog_t
 *       liveScore_t     = min(dailyWeighted_t,
 *                             mean(dailyWeighted over the trailing 7 days incl. today))
 *     so PORCH counts ~1.67x more than MDOG. No weekly reset: the score
 *     rises and falls with what the wallet holds.
 *   - Hold steady -> score stays high. Buy more -> score climbs toward full
 *     weight over ~7 days (the trailing average caps it). Sell everything ->
 *     score is 0 the next day, so the wallet earns nothing for that day's
 *     slice. Amounts earned on prior days stay accrued — selling stops
 *     future daily earnings, it never erases past ones.
 *   - Each day's 1/7 of the weekly pot is divided by that day's live scores.
 *     The weekly Merkle output is the sum of the 7 daily allocations.
 *   - Scoring uses SPOT wallet balances only. No LP tracking, no LP
 *     multiplier, no replay (Andrew 2026-09-27).
 *   - claimed by holders, never airdropped; one wallet per verified muse ID;
 *     unlinked wallets earn nothing
 * Guards (decided by Andrew 2026-09-27; locked in config.js):
 *   - floors (1M PORCH / 1K MDOG) are a daily dust filter: a token class
 *     below its floor contributes 0 to that day's weighted value
 *   - whale cap: each day's raw balance is capped at 2% of that token's
 *     total supply BEFORE weighting
 *   - 1 MUSEBOOK minimum on the WEEKLY total: dust stays as carryover
 */
'use strict';

const { buildTree } = require('./merkle');
const cfg = require('./config');

const CLASSES = ['porch', 'mdog'];
const TRAIL_DAYS = 7;

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

/* One day's weighted snapshot value for one wallet (bigint, raw wei units):
 * 50 * cappedPorch + 30 * cappedMdog. A class below its floor contributes 0
 * (daily dust filter); each class is whale-capped at 2% of its total supply
 * before weighting. */
function dailyWeighted(spotW, supplies) {
  let v = 0n;
  for (const cls of CLASSES) {
    const raw = BigInt((spotW && spotW[cls]) || '0');
    if (raw < cfg.FLOOR[cls]) continue; // dust filter
    const cap = (supplies[cls] * BigInt(cfg.WHALE_CAP_BP)) / 10000n;
    const capped = raw > cap ? cap : raw;
    v += BigInt(cfg.WEIGHTS[cls]) * capped;
  }
  return v;
}

/* Live scores, one Map per epoch day. epochDays = the epoch's own snapshots
 * (ordered), historyDays = preceding snapshots (ordered, up to 6 used). */
function liveScoresPerDay(epochDays, historyDays, linked, supplies) {
  const history = (historyDays || []).slice(-(TRAIL_DAYS - 1));
  const all = [...history, ...epochDays];
  const base = history.length;
  const weighted = all.map((s) => {
    const m = new Map();
    for (const w of linked.keys()) {
      const v = dailyWeighted((s.spot && s.spot[w]) || {}, supplies);
      if (v > 0n) m.set(w, v);
    }
    return m;
  });
  const out = [];
  for (let d = 0; d < epochDays.length; d++) {
    const todayIdx = base + d;
    const lo = Math.max(0, todayIdx - (TRAIL_DAYS - 1));
    const m = new Map();
    for (const w of linked.keys()) {
      const today = weighted[todayIdx].get(w) || 0n;
      let sum = 0n, cnt = 0;
      for (let k = lo; k <= todayIdx; k++) { sum += weighted[k].get(w) || 0n; cnt++; }
      const avg = sum / BigInt(cnt);
      const score = today < avg ? today : avg;
      if (score > 0n) m.set(w, score);
    }
    out.push(m);
  }
  return out;
}

function scoreEpoch({ epochId, startTs, endTs, snapshots, registryJson, treasuryMusebook, carryover, supplies, distributor, historySnapshots }) {
  const linked = loadRegistry(registryJson);
  const pot = treasuryMusebook / BigInt(cfg.POT_DIVISOR) + carryover;
  const nDays = snapshots.length;

  // The persistent live score, one Map per epoch day.
  const perDay = liveScoresPerDay(snapshots, historySnapshots || [], linked, supplies);

  // Split the pot into nDays daily slices (integer division; the remainder
  // lands on the final day so the slices always sum to exactly the pot).
  const slices = [];
  if (nDays > 0) {
    const baseSlice = pot / BigInt(nDays);
    for (let d = 0; d < nDays; d++) slices.push(baseSlice);
    slices[nDays - 1] += pot - baseSlice * BigInt(nDays);
  }

  // Each day's slice is divided by that day's live scores. A day with no
  // scorers leaves its whole slice unallocated (rolls to carryover).
  const weekly = new Map(); // wallet -> summed daily wei
  for (let d = 0; d < nDays; d++) {
    const scores = perDay[d];
    let total = 0n;
    for (const s of scores.values()) total += s;
    if (total === 0n) continue;
    const slice = slices[d];
    for (const [w, sc] of scores) {
      const amt = (sc * slice) / total;
      if (amt > 0n) weekly.set(w, (weekly.get(w) || 0n) + amt);
    }
  }

  // The weekly Merkle output is the sum of the daily allocations.
  // 1 MUSEBOOK minimum on the weekly total: dust stays as carryover.
  const leaves = [];
  const board = [];
  const finalScores = nDays > 0 ? perDay[nDays - 1] : new Map();
  let maxScore = 0n;
  for (const s of finalScores.values()) if (s > maxScore) maxScore = s;

  const finalDay = nDays > 0 ? snapshots[nDays - 1] : { spot: {} };
  let totalAllocated = 0n;
  for (const [w, amount] of weekly) {
    if (amount < cfg.MIN_PAYOUT_WEI) continue; // dust stays as carryover
    leaves.push({ epochId, index: leaves.length, account: w, amount: amount.toString() });
    totalAllocated += amount;
    // Board ranks the LIVE persistent score (final epoch day). Displayed on
    // the familiar /80 scale: the top live scorer reads 80.
    const live = finalScores.get(w) || 0n;
    const disp = maxScore === 0n ? 0 : Number((live * 8000n) / maxScore) / 100;
    const spotW = (finalDay.spot && finalDay.spot[w]) || {};
    board.push({
      wallet: w,
      porch: (spotW.porch || '0').toString(),
      mdog: (spotW.mdog || '0').toString(),
      score: disp,
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
    scoring: 'daily-persistent', // live score = min(today's weighted snapshot, 7-day trailing avg); 1/7 of the pot per day split by that day's scores; no weekly reset
    weights: cfg.WEIGHTS,
    potMusebook: pot.toString(),
    dailySlices: slices.map((s) => s.toString()),
    historyDays: Math.min((historySnapshots || []).length, TRAIL_DAYS - 1),
    carryover: carryover.toString(),
    merkleRoot: root,
    totalAllocated: totalAllocated.toString(),
    claimCount: claims.length,
    distributor: distributor || null,
    guards: {
      floorPorch: cfg.FLOOR.porch.toString(), floorMdog: cfg.FLOOR.mdog.toString(),
      floorMode: 'daily dust filter — a token below its floor contributes 0 to that day',
      whaleCapBps: cfg.WHALE_CAP_BP,
      whaleCapMode: '2% of each token total supply, applied to each daily balance before weighting',
      minPayout: '1 MUSEBOOK on the weekly total (dust rolls to carryover)',
      lp: 'removed 2026-09-27 — spot balances only, no multiplier, no replay',
      note: 'persistent daily scoring locked by Andrew 2026-09-27: no weekly reset',
    },
    publishedTx: null,
  };

  return { epochConfig, claims, board };
}

module.exports = { scoreEpoch, loadRegistry, liveScoresPerDay, dailyWeighted };
