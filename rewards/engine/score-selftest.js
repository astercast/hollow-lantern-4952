/* Engine scoring edge cases on SYNTHETIC snapshots (no chain needed).
 *
 * Verifies, with exact bigint math:
 *   1. PORCH-only wallet gets exactly 50/80 of the pot; MDOG-only gets 30/80.
 *   2. Empty snapshots -> zero root, zero claims (publish.js refuses these).
 *   3. Dust-only wallets (below MIN_PAYOUT) -> zero claims, nothing allocated.
 *   4. One wallet per muse id: two wallets, same muse_id -> only the latest
 *      linked wallet scores.
 *   5. Below-floor wallets are excluded.
 *   6. LP fields are IGNORED: snapshots carrying s.lp balances (or wallets
 *      with LP-only positions) score zero — LP was removed from rewards
 *      2026-09-27. Spot-only.
 */
'use strict';
const { ethers } = require('ethers');
const cfg = require('./config');
const { scoreEpoch } = require('./score');

const E18 = 10n ** 18n;
const W_PORCH = '0x0000000000000000000000000000000000000a01';
const W_MDOG = '0x0000000000000000000000000000000000000b02';
const W_BOTH = '0x0000000000000000000000000000000000000c03';
const W_DUST = '0x0000000000000000000000000000000000000d04';
const W_SMALL = '0x0000000000000000000000000000000000000e05';

function snapsFor(balances, n = 7) {
  // balances: {wallet: {porch: bigintStr, mdog: bigintStr, lpPorch, lpMdog}} — same all 7 days.
  // lpPorch/lpMdog optionally inject a STALE s.lp field to prove it is ignored.
  const out = [];
  for (let i = 0; i < n; i++) {
    const spot = {}, lp = {};
    for (const [w, b] of Object.entries(balances)) {
      spot[w] = { porch: b.porch || '0', mdog: b.mdog || '0' };
      if (b.lpPorch || b.lpMdog) lp[w] = { porch: b.lpPorch || '0', mdog: b.lpMdog || '0' };
    }
    const snap = { date: `2026-01-0${i + 1}`, ts: i, block: 1000 + i, spot };
    if (Object.keys(lp).length) snap.lp = lp; // stale field must be ignored
    out.push(snap);
  }
  return out;
}

const base = {
  epochId: 1, startTs: 0, endTs: 7,
  treasuryMusebook: 800n * E18, // pot = 100 MUSEBOOK
  carryover: 0n,
  supplies: { porch: 100_000_000_000n * E18, mdog: 1_000_000_000n * E18 },
  distributor: null,
};

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' | ' + detail : ''));
  if (!cond) failures++;
}

// ---- 1. single-sided wallets ----
{
  const snaps = snapsFor({
    [W_PORCH]: { porch: (2_000_000n * E18).toString() },           // clears 1M floor
    [W_MDOG]: { mdog: (2_000n * E18).toString() },                 // clears 1K floor
  });
  const registry = { [W_PORCH]: { muse_id: 'm1', linked_at: 1 }, [W_MDOG]: { muse_id: 'm2', linked_at: 1 } };
  const { epochConfig, claims } = scoreEpoch({ ...base, snapshots: snaps, registryJson: registry });
  const pot = 100n * E18;
  const byAcct = Object.fromEntries(claims.map((c) => [c.account, BigInt(c.amount)]));
  // Each is the sole scorer of its class: classPots split exactly 50/80 and 30/80.
  check('porch-only gets 50/80 of pot', byAcct[W_PORCH] === (pot * 50n) / 80n,
    `got ${byAcct[W_PORCH]}, want ${(pot * 50n) / 80n}`);
  check('mdog-only gets 30/80 of pot', byAcct[W_MDOG] === (pot * 30n) / 80n,
    `got ${byAcct[W_MDOG]}, want ${(pot * 30n) / 80n}`);
  check('allocated == pot when sole scorers', BigInt(epochConfig.totalAllocated) === pot);
}

// ---- 2. empty snapshots ----
{
  const snaps = snapsFor({});
  const { epochConfig, claims } = scoreEpoch({ ...base, snapshots: snaps, registryJson: {} });
  check('empty scoring: zero claims', claims.length === 0);
  check('empty scoring: zero root', /^0x0+$/.test(epochConfig.merkleRoot));
  check('empty scoring: zero allocated', BigInt(epochConfig.totalAllocated) === 0n);
}

// ---- 3. dust-only: wallet clears floor but earns < 1 MUSEBOOK ----
{
  // Floor is 1M PORCH; give exactly the floor. With a whale also scoring,
  // the small wallet's share rounds below 1 MUSEBOOK.
  const snaps = snapsFor({
    [W_SMALL]: { porch: (1_000_000n * E18).toString() },
    [W_BOTH]: { porch: (50_000_000_000n * E18).toString(), mdog: (500_000_000n * E18).toString() },
  });
  const registry = {
    [W_SMALL]: { muse_id: 'm1', linked_at: 1 },
    [W_BOTH]: { muse_id: 'm2', linked_at: 1 },
  };
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, registryJson: registry });
  const accts = claims.map((c) => c.account);
  check('dust wallet excluded', !accts.includes(W_SMALL), `claims: ${claims.length}`);
  check('whale still claims', accts.includes(W_BOTH));
}

// ---- 4. one wallet per muse id (latest link wins) ----
{
  const snaps = snapsFor({
    [W_PORCH]: { porch: (2_000_000n * E18).toString() },
    [W_MDOG]: { porch: (2_000_000n * E18).toString() },
  });
  const registry = {
    [W_PORCH]: { muse_id: 'same-muse', linked_at: 1 },
    [W_MDOG]: { muse_id: 'same-muse', linked_at: 2 }, // later link wins
  };
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, registryJson: registry });
  check('dedup: exactly one claim', claims.length === 1, `got ${claims.length}`);
  check('dedup: latest wallet wins', claims[0] && claims[0].account === W_MDOG);
}

// ---- 5. below-floor wallets excluded ----
{
  const snaps = snapsFor({
    [W_DUST]: { porch: (999_999n * E18).toString(), mdog: (999n * E18).toString() }, // just under floors
    [W_BOTH]: { porch: (2_000_000n * E18).toString(), mdog: (2_000n * E18).toString() },
  });
  const registry = {
    [W_DUST]: { muse_id: 'm1', linked_at: 1 },
    [W_BOTH]: { muse_id: 'm2', linked_at: 1 },
  };
  const { claims } = scoreEpoch({ ...base, snapshots: snaps, registryJson: registry });
  const accts = claims.map((c) => c.account);
  check('below-floor excluded', !accts.includes(W_DUST));
  check('above-floor included', accts.includes(W_BOTH));
}

// ---- 6. LP fields ignored (spot-only scoring) ----
{
  const W_LP = '0x0000000000000000000000000000000000000f06';
  // Wallet with huge LP balances but zero spot: must score NOTHING.
  const snaps = snapsFor({
    [W_LP]: { lpPorch: (50_000_000_000n * E18).toString(), lpMdog: (500_000_000n * E18).toString() },
    [W_BOTH]: { porch: (2_000_000n * E18).toString(), mdog: (2_000n * E18).toString() },
  });
  const registry = {
    [W_LP]: { muse_id: 'm1', linked_at: 1 },
    [W_BOTH]: { muse_id: 'm2', linked_at: 1 },
  };
  const { claims, board } = scoreEpoch({ ...base, snapshots: snaps, registryJson: registry });
  const accts = claims.map((c) => c.account);
  check('LP-only wallet scores zero (excluded)', !accts.includes(W_LP), `claims: ${claims.length}`);
  check('spot wallet still claims', accts.includes(W_BOTH));
  // And: a wallet whose spot is identical but carries a stale s.lp field must
  // get EXACTLY the same payout as without the lp field (no 1.5x multiplier).
  const snapsNoLp = snapsFor({ [W_PORCH]: { porch: (2_000_000n * E18).toString() } });
  const snapsWithLp = snapsFor({ [W_PORCH]: { porch: (2_000_000n * E18).toString(), lpPorch: (99_000_000n * E18).toString() } });
  const reg1 = { [W_PORCH]: { muse_id: 'm1', linked_at: 1 } };
  const r1 = scoreEpoch({ ...base, snapshots: snapsNoLp, registryJson: reg1 });
  const r2 = scoreEpoch({ ...base, snapshots: snapsWithLp, registryJson: reg1 });
  check('stale s.lp field changes nothing',
    r1.claims.length === 1 && r2.claims.length === 1 &&
    r1.claims[0].amount === r2.claims[0].amount,
    `no-lp ${r1.claims[0] && r1.claims[0].amount} vs with-lp ${r2.claims[0] && r2.claims[0].amount}`);
}

console.log(failures === 0 ? 'SCORE SELFTEST (LP CHECKS): ALL PASSED' : `SCORE SELFTEST (LP CHECKS): ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
