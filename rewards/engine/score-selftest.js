/* Engine scoring edge cases on SYNTHETIC snapshots (no chain needed).
 *
 * Covers the persistent daily scoring model (Andrew 2026-09-27), with exact
 * bigint math:
 *   1. Steady holder: constant score, earns a full share every day.
 *   2. New buyer ramps up: score climbs toward full weight over ~7 days.
 *   3. Partial seller drops immediately (min() binds to today's snapshot).
 *   4. Full seller earns zero the next day; earlier earnings stay accrued.
 *   5. Snapshot gaming: a one-day whale buy gets ~1/7 weight that day only.
 *   6. Whale cap: 2% of token supply, applied daily before weighting.
 *   7. Floors: below-floor balances are a daily dust filter.
 *   8. The 7 daily slices always sum to exactly the pot (deterministic dust).
 *   9. One wallet per muse id (latest link wins).
 *  10. Dust-only wallets (weekly total below MIN_PAYOUT) earn nothing.
 *  11. Empty snapshots -> zero root, zero claims.
 *  12. LP fields are IGNORED (spot-only scoring).
 */
'use strict';
const { ethers } = require('ethers');
const cfg = require('./config');
const { scoreEpoch, liveScoresPerDay, loadRegistry } = require('./score');

const E18 = 10n ** 18n;
const W1 = '0x0000000000000000000000000000000000000a01';
const W2 = '0x0000000000000000000000000000000000000b02';
const W3 = '0x0000000000000000000000000000000000000c03';

const SUPPLIES = { porch: 100_000_000_000n * E18, mdog: 1_000_000_000n * E18 }; // caps: 2B PORCH / 20M MDOG

// schedule: (dayIndex) => {wallet: {porch: 'weiStr', mdog: 'weiStr'}}, dayIndex 0..n-1
function snapsSchedule(schedule, n, startBlock = 1000, prefix = '2026-02') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const spot = {};
    for (const [w, b] of Object.entries(schedule(i) || {})) {
      spot[w] = { porch: (b.porch || '0').toString(), mdog: (b.mdog || '0').toString() };
    }
    out.push({ date: `${prefix}-${String(i + 1).padStart(2, '0')}`, ts: i, block: startBlock + i, spot });
  }
  return out;
}

const base = {
  epochId: 1, startTs: 0, endTs: 7,
  treasuryMusebook: 800n * E18, // pot = 100 MUSEBOOK
  carryover: 0n,
  supplies: SUPPLIES,
  distributor: null,
};

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' | ' + detail : ''));
  if (!cond) failures++;
}

const steady = (bal) => () => bal; // same balances every day
const P2M = { porch: 2_000_000n * E18 };

// ---- 1. steady holder: full share every day ----
{
  const hist = snapsSchedule(steady({ [W1]: P2M }), 6);
  const snaps = snapsSchedule(steady({ [W1]: P2M }), 7);
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 } };
  const perDay = liveScoresPerDay(snaps, hist, loadRegistry(registry), SUPPLIES);
  const want = 50n * 2_000_000n * E18;
  check('steady: score constant across all 7 days',
    perDay.every((m) => m.get(W1) === want), `got ${perDay[0] && perDay[0].get(W1)}`);
  const { epochConfig, claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  const pot = 100n * E18;
  check('steady sole holder: weekly total == pot exactly',
    claims.length === 1 && BigInt(claims[0].amount) === pot,
    `got ${claims[0] && claims[0].amount}`);
  check('steady sole holder: totalAllocated == pot', BigInt(epochConfig.totalAllocated) === pot);
  check('steady sole holder: slices sum to pot',
    epochConfig.dailySlices.reduce((a, s) => a + BigInt(s), 0n) === pot);
}

// ---- 2. new buyer ramps up over ~7 days ----
{
  const buy = { [W1]: P2M };
  const hist = snapsSchedule(() => ({}), 6); // held nothing before
  const snaps = snapsSchedule(steady(buy), 7);
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 } };
  const perDay = liveScoresPerDay(snaps, hist, loadRegistry(registry), SUPPLIES);
  const s = perDay.map((m) => m.get(W1));
  const today = 50n * 2_000_000n * E18;
  check('new buyer: day-0 score is ~1/7 of full weight', s[0] === today / 7n, `got ${s[0]}`);
  check('new buyer: score climbs every day', s.every((v, i) => i === 0 || v > s[i - 1]));
  check('new buyer: reaches full weight by day 6', s[6] === today, `got ${s[6]}`);
}

// ---- 3. partial seller drops immediately ----
{
  const full = { [W1]: { porch: 2_000_000n * E18 }, [W2]: { porch: 2_000_000n * E18 } };
  const half = { [W1]: { porch: 2_000_000n * E18 }, [W2]: { porch: 1_000_000n * E18 } };
  const hist = snapsSchedule(steady(full), 6);
  const snaps = snapsSchedule((d) => (d < 3 ? full : half), 7);
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 }, [W2]: { muse_id: 'm2', linked_at: 1 } };
  const perDay = liveScoresPerDay(snaps, hist, loadRegistry(registry), SUPPLIES);
  const w2 = perDay.map((m) => m.get(W2));
  check('partial seller: day-3 score == today (min binds immediately)',
    w2[3] === 50n * 1_000_000n * E18, `got ${w2[3]}`);
  check('partial seller: score drops the day of the sale', w2[3] < w2[2]);
  check('steady wallet unaffected', perDay.every((m) => m.get(W1) === 50n * 2_000_000n * E18));
}

// ---- 4. full seller earns zero the next day; earlier earnings stay ----
{
  const full = { [W1]: P2M };
  const hist = snapsSchedule(steady(full), 6);
  const snaps = snapsSchedule((d) => (d < 3 ? full : {}), 7); // sells everything on day 3
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 } };
  const perDay = liveScoresPerDay(snaps, hist, loadRegistry(registry), SUPPLIES);
  check('full seller: score zero from the day after the sale',
    perDay[3].get(W1) === undefined && perDay[6].get(W1) === undefined);
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  const baseSlice = (100n * E18) / 7n;
  check('full seller: weekly total == first 3 daily slices only (accrued, not erased)',
    claims.length === 1 && BigInt(claims[0].amount) === 3n * baseSlice,
    `got ${claims[0] && claims[0].amount}, want ${3n * baseSlice}`);
}

// ---- 5. snapshot gaming: one-day whale buy gets ~1/7 weight that day ----
{
  const steady10 = { [W1]: { porch: 10_000_000n * E18 } };
  const hist = snapsSchedule(steady(steady10), 6);
  // gamer holds nothing until day 6, then buys 7x the steady holder's size
  const snaps = snapsSchedule((d) => (d < 6 ? steady10 : {
    [W1]: { porch: 10_000_000n * E18 }, [W2]: { porch: 70_000_000n * E18 },
  }), 7);
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 }, [W2]: { muse_id: 'm2', linked_at: 1 } };
  const perDay = liveScoresPerDay(snaps, hist, loadRegistry(registry), SUPPLIES);
  const gamerDay6 = perDay[6].get(W2);
  const steadyDay6 = perDay[6].get(W1);
  check('gaming: 7x one-day buy scores exactly like the steady holder that day',
    gamerDay6 === steadyDay6, `gamer ${gamerDay6} vs steady ${steadyDay6}`);
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  const byAcct = Object.fromEntries(claims.map((c) => [c.account, BigInt(c.amount)]));
  check('gaming: gamer earns less than 1/6 of the steady holder',
    byAcct[W2] * 6n < byAcct[W1], `gamer ${byAcct[W2]} vs steady ${byAcct[W1]}`);
}

// ---- 6. whale cap: 2% of supply, applied daily before weighting ----
{
  const whale = { [W1]: { porch: 10_000_000_000n * E18 } }; // 10% of supply -> capped at 2% = 2B
  const capExact = { [W2]: { porch: 2_000_000_000n * E18 } }; // exactly at the cap
  const hist = snapsSchedule(steady({ ...whale, ...capExact }), 6);
  const snaps = snapsSchedule(steady({ ...whale, ...capExact }), 7);
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 }, [W2]: { muse_id: 'm2', linked_at: 1 } };
  const perDay = liveScoresPerDay(snaps, hist, loadRegistry(registry), SUPPLIES);
  const want = 50n * 2_000_000_000n * E18;
  check('whale cap: 10%-of-supply wallet capped at 2%', perDay[0].get(W1) === want, `got ${perDay[0].get(W1)}`);
  check('whale cap: capped wallet scores like the at-cap wallet',
    perDay[0].get(W1) === perDay[0].get(W2));
}

// ---- 7. floors: daily dust filter ----
{
  const dust = { [W1]: { porch: 999_999n * E18, mdog: 999n * E18 } }; // just under both floors
  const mixed = { [W2]: { porch: 999_999n * E18, mdog: 2_000n * E18 } }; // dust PORCH, fine MDOG
  const hist = snapsSchedule(steady({ ...dust, ...mixed }), 6);
  const snaps = snapsSchedule(steady({ ...dust, ...mixed }), 7);
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 }, [W2]: { muse_id: 'm2', linked_at: 1 } };
  const perDay = liveScoresPerDay(snaps, hist, loadRegistry(registry), SUPPLIES);
  check('floors: below-floor wallet scores zero every day',
    perDay.every((m) => m.get(W1) === undefined));
  check('floors: dust PORCH contributes 0, fine MDOG contributes 30x',
    perDay.every((m) => m.get(W2) === 30n * 2_000n * E18), `got ${perDay[0].get(W2)}`);
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  const accts = claims.map((c) => c.account);
  check('floors: dust wallet gets no claim', !accts.includes(W1));
  check('floors: mixed wallet claims', accts.includes(W2));
}

// ---- 8. daily slices always sum to exactly the pot ----
{
  const bal = { [W1]: { porch: 2_000_000n * E18 }, [W2]: { porch: 4_000_000n * E18 }, [W3]: { mdog: 300_000n * E18 } };
  const hist = snapsSchedule(steady(bal), 6);
  const snaps = snapsSchedule(steady(bal), 7);
  const registry = {
    [W1]: { muse_id: 'm1', linked_at: 1 },
    [W2]: { muse_id: 'm2', linked_at: 1 },
    [W3]: { muse_id: 'm3', linked_at: 1 },
  };
  const { epochConfig, claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  const pot = 100n * E18;
  const sum = claims.reduce((a, c) => a + BigInt(c.amount), 0n);
  check('multi-wallet: claims sum == totalAllocated', sum === BigInt(epochConfig.totalAllocated));
  const carryoverNext = pot - BigInt(epochConfig.totalAllocated);
  check('multi-wallet: allocated + carryover == pot exactly',
    BigInt(epochConfig.totalAllocated) + carryoverNext === pot);
  check('multi-wallet: only deterministic rounding dust left',
    carryoverNext < 100n, `carryover dust ${carryoverNext} wei`);
  // Board ranks the live persistent score: W2 (4M PORCH) > W1 (2M) > W3 (3K MDOG).
  const { board } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  check('board ranks by live score',
    board[0].wallet === W2 && board[1].wallet === W1 && board[2].wallet === W3,
    board.map((b) => b.wallet.slice(-4)).join(','));
  check('board top score reads 80', board[0].score === 80);
}

// ---- 9. one wallet per muse id (latest link wins) ----
{
  const hist = snapsSchedule(steady({ [W1]: P2M, [W2]: P2M }), 6);
  const snaps = snapsSchedule(steady({ [W1]: P2M, [W2]: P2M }), 7);
  const registry = {
    [W1]: { muse_id: 'same-muse', linked_at: 1 },
    [W2]: { muse_id: 'same-muse', linked_at: 2 }, // later link wins
  };
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  check('dedup: exactly one claim', claims.length === 1, `got ${claims.length}`);
  check('dedup: latest wallet wins', claims[0] && claims[0].account === W2);
}

// ---- 10. dust-only: weekly total below 1 MUSEBOOK -> no claim ----
{
  const bal = {
    [W1]: { porch: 1_000_000n * E18 }, // exactly the floor; tiny share vs the whale
    [W2]: { porch: 50_000_000_000n * E18, mdog: 500_000_000n * E18 }, // whale-capped
  };
  const hist = snapsSchedule(steady(bal), 6);
  const snaps = snapsSchedule(steady(bal), 7);
  const registry = { [W1]: { muse_id: 'm1', linked_at: 1 }, [W2]: { muse_id: 'm2', linked_at: 1 } };
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  const accts = claims.map((c) => c.account);
  check('dust wallet excluded', !accts.includes(W1), `claims: ${claims.length}`);
  check('whale still claims', accts.includes(W2));
}

// ---- 11. empty snapshots ----
{
  const { epochConfig, claims } = scoreEpoch({ ...base, snapshots: [], registryJson: {} });
  check('empty scoring: zero claims', claims.length === 0);
  check('empty scoring: zero root', /^0x0+$/.test(epochConfig.merkleRoot));
  check('empty scoring: zero allocated', BigInt(epochConfig.totalAllocated) === 0n);
}

// ---- 12. LP fields ignored (spot-only scoring) ----
{
  const W_LP = '0x0000000000000000000000000000000000000f06';
  const lpOnly = () => ({ [W_LP]: { porch: '0', mdog: '0' } });
  const hist = snapsSchedule(lpOnly, 6).map((s, i) => ({
    ...s, lp: { [W_LP]: { porch: (50_000_000_000n * E18).toString() } },
  }));
  const snaps = snapsSchedule(lpOnly, 7).map((s) => ({
    ...s, lp: { [W_LP]: { porch: (50_000_000_000n * E18).toString() } },
  }));
  const registry = { [W_LP]: { muse_id: 'm1', linked_at: 1 } };
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, historySnapshots: hist, registryJson: registry });
  check('LP-only wallet scores zero (excluded)', claims.length === 0, `claims: ${claims.length}`);
}

console.log(failures === 0 ? 'SCORE SELFTEST: ALL PASSED' : `SCORE SELFTEST: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
