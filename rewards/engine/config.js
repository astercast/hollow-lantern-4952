/* Rewards engine config — Robinhood Chain (id 4663).
 * Guard params were decided by Andrew on 2026-09-27 and are locked here.
 * Changing them later requires Andrew's word + a rescore; no contract
 * redeploy is ever needed (guards live in the engine, not the contract). */
'use strict';

module.exports = {
  CHAIN_ID: 4663,
  RPC_URL: 'https://rpc.mainnet.chain.robinhood.com',

  TOKENS: {
    porch:    '0x4B434541873f171aB70D7d2F3a48b0f0b0f13ba3',
    mdog:     '0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC',
    musebook: '0x91A2DAe9699f0B82540B5886b0d8759C22820bA3',
  },
  TOKEN_DECIMALS: 18,

  TREASURY: '0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25',

  // Uniswap V4 on Robinhood Chain
  POSM: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  STATEVIEW: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',

  // Known reward-relevant pools (poolId -> {token0sym, token1sym})
  POOLS: {
    '0x7edc541fce494a314d0eb46410581208b1ca24d8e8e20bd3b7d666e1258fa1b0': { a: 'mdog', b: 'musebook', label: 'MDOG/MUSEBOOK' },
    '0x3fb159d5ab470476e4a2e3f6b364fc452b0af3c785d8bb2d677af41dea6f8557': { a: 'porch', b: 'mdog', label: 'PORCH/MDOG' },
    '0x44af9238ec58bf1dadbe205bfd7d7f164870c309afe96849811190e0c8de0b87': { a: 'porch', b: 'musebook', label: 'PORCH/MUSEBOOK' },
  },

  // ---- Epoch economics (locked by Andrew 2026-09-26; simplified 2026-09-27) ----
  POT_DIVISOR: 8,            // epoch pot = treasury MUSEBOOK / 8 + carryover
  // Relative holder weights: PORCH counts 50, MDOG counts 30, so PORCH weighs
  // ~1.67x more than MDOG. The weights are normalized by their sum (80), so
  // 100% of every epoch pot goes to holders. No reserve, no treasury cut.
  WEIGHTS: { porch: 50, mdog: 30 },

  // ---- Scoring guards (DECIDED by Andrew 2026-09-27; locked) ----
  // Floors are a DAILY dust filter: on each snapshot day, a token class
  // below its floor contributes 0 to that day's weighted value. There is no
  // weekly eligibility count anymore — the persistent live score handles it:
  // score = min(today's whale-capped weighted snapshot,
  //             7-day trailing average of daily snapshots).
  FLOOR: { porch: 1000000n * 10n ** 18n, mdog: 1000n * 10n ** 18n }, // 1M PORCH / 1K MDOG
  WHALE_CAP_BP: 200,         // no wallet's score may exceed 2% of its class total
  MIN_PAYOUT_WEI: 10n ** 18n, // dust threshold: payouts below 1 MUSEBOOK stay as carryover
  // NOTE (2026-09-27): LP tracking REMOVED from rewards by Andrew's order.
  // Scoring uses PORCH/MDOG spot wallet balances only. No LP multiplier,
  // no replay, no LP eligibility. POOLS/POSM/STATEVIEW kept for reference
  // (other tooling) but are not consulted by the rewards engine.

  // ---- Epoch calendar ----
  // Epochs begin Monday 00:00 UTC. Epochs 1–2 were voided by the user's
  // 2026-10-04 decision after unrecoverable snapshot gaps, so the first
  // published epoch is re-anchored to 2026-10-12 .. 2026-10-18
  // (funding + root publication on 2026-10-19; 30-day claim window).
  EPOCH_1_START: '2026-10-12',
  EPOCH_SECONDS: 7 * 86400,
  // PORCH launched 2026-09-23; MDOG earlier. Conservative scan starts:
  SCAN_START_TS: Math.floor(new Date('2026-09-01T00:00:00Z').getTime() / 1000),
  LOG_CHUNK: 10000,          // blocks per getLogs chunk
  CALL_CONCURRENCY: 25,
};
