/* Engine scoring edge cases on SYNTHETIC snapshots (no chain needed).
 *
 * Verifies, with exact bigint math:
 *   1. PORCH-only wallet gets exactly 50/80 of the pot; MDOG-only gets 30/80.
 *   2. Empty snapshots -> zero root, zero claims (publish.js refuses these).
 *   3. Dust-only wallets (below MIN_PAYOUT) -> zero claims, nothing allocated.
 *   4. One wallet per muse id: two wallets, same muse_id -> only the latest
 *      linked wallet scores.
 *   5. Below-floor wallets are excluded.
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
  // balances: {wallet: {porch: bigintStr, mdog: bigintStr}} — same all 7 days
  const out = [];
  for (let i = 0; i < n; i++) {
    const spot = {}, lp = {};
    for (const [w, b] of Object.entries(balances)) {
      spot[w] = { porch: b.porch || '0', mdog: b.mdog || '0' };
      lp[w] = { porch: '0', mdog: '0' };
    }
    out.push({ date: `2026-01-0${i + 1}`, ts: i, block: 1000 + i, spot, lp });
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

console.log(failures === 0 ? 'SCORE SELFTEST: ALL PASSED' : `SCORE SELFTEST: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
