# MuseDogs Holder Rewards — build + operator runbook

**Status: BUILT AND TESTED. NOT DEPLOYED.** The claim contract is written,
unit-tested (22/22 forge tests), cross-checked against the JS tree builder,
LP math validated against the keeper's proven Python math, and exercised
end-to-end on an anvil fork of Robinhood Chain with real chain data.
Deployment is BLOCKED: the Bankr CLI cannot sign or submit contract-creation
transactions (403 on `wallet sign`, `submit` requires a `to` address) and no
EOA key is available — Andrew deploys from his machine in the morning
(`forge script script/Deploy.s.sol`, or the prepared init bytecode in the
launch checkpoint). Treasury funding + epoch-1 publication also wait for him.

## What this is

Weekly MUSEBOOK holder rewards (Andrew's locked design, 2026-09-26):

- Epoch = Monday 00:00 UTC → Monday 00:00 UTC.
- Pot = 1/8 of the treasury's MUSEBOOK at epoch start + unclaimed carryover.
- One combined score per wallet: PORCH weighs 50, MDOG weighs 30 (normalized
  by 80) — 100% of every epoch pot goes to eligible holders. No reserve,
  no treasury cut.
- 7 daily snapshots → time-weighted scores; LP-held tokens count 1.5x
  (proposed — Andrew rules).
- Claims stay open 30 days after each epoch's root is published; unclaimed
  then finalizes back to free funds and rolls into the next epoch's pot.
- Pull claims via merkle root published by the treasury Safe. No airdrops.
- Only wallets linked to a verified muse ID earn (one wallet per muse).

## Layout

| Path | What |
|---|---|
| `contracts/RewardsDistributor.sol` | The claim contract. No dependencies. |
| `test/RewardsDistributor.t.sol` | 16 forge tests incl. JS-engine cross-check + claim-window/finalize. |
| `script/Deploy.s.sol` | Deploy script (**do not run without Andrew's order**). |
| `engine/config.js` | All addresses + tunable params (floors, caps, LP mult marked PROPOSED). |
| `engine/snapshot.js` | Holder enumeration + daily snapshots + LP valuation. Read-only. |
| `engine/score.js` | Time-weighted scoring, floors, whale cap, splits, merkle input. |
| `engine/merkle.js` | Tree builder — must match the contract (proven by test). |
| `engine/tickmath.js` | V3/V4 concentrated-liquidity math (validated vs keeper). |
| `engine/run-epoch.js` | Orchestrates one epoch: snapshots → scores → `api/epoch-N.json` + `api/claims-N.json`. |
| `engine/publish.js` | Builds the 2-tx Safe bundle (fund + publishRoot). Never signs. |
| `engine/dry-run.js` | Full pipeline on real data with a TEST registry. |
| `engine/relp.js` | Re-runs ONLY the LP leg on saved snapshots (fixed replay). |
| `engine/score-selftest.js` | 12 synthetic scoring checks: 50/30 split exactness, empty/dust scoring, identity dedup, floors. |
| `engine/validate-replay.js` | Validates LP log-replay vs direct chain reads (liquidity, price, owner, amounts). Read-only. |
| `engine/fork-e2e.js` | Fork end-to-end: deploy, fund, publish, claim, revert checks. |
| `api/` | Per-epoch outputs (gitignored until a real epoch runs — see below). |

## Running a real epoch (operator checklist)

1. **Export the identity registry** from the registration backend:
   `{"0xabc…": {"muse_id": "muse_…", "linked_at": 1695…}, …}` — one wallet per muse.
2. **Run the epoch** (the Monday after the epoch ends):
   `node engine/run-epoch.js --start 2026-10-05 --epoch-id 1 --registry /path/to/registry.json --carryover 0 --distributor 0x… --out ./api`
3. **Review** `api/epoch-1.json` (pot, split, root, guard values) and `api/board-1.json`.
4. **Build the Safe bundle**: `node engine/publish.js --epoch 1 --api ./api` →
   `api/safe-bundle-epoch-1.json`. Execute both txs from the treasury Safe, in order.
5. **Publish to the site**: copy `epoch-1.json`, `claims-1.json` to
   `site/api/v1/rewards/` and set `manifest.json` → `{"latestEpochId": 1}`.
6. **Set `DISTRIBUTOR`** in `site/claim.js` to the deployed address and redeploy the site.
7. Record `publishedTx` in `api/epoch-1.json`.

Next epoch's `--carryover` = distributor's free balance
(`balanceOf(distributor) - allocatedUnclaimed`) — unclaimed rolls forward.

## Verification performed (2026-09-27)

- `forge test`: 22/22 pass — all of the 16 plus: ownership transfer (old
  owner locked out, new owner works, zero-address reverts), non-owner
  withdraw reverts even on free funds, claim reverts when the token returns
  false or reverts (liability untouched), and a future-asset-class test
  proving a new scoring class needs NO distributor change.
- `test_js_engine_fixture`: JS-built tree verifies on-chain — builder and
  contract agree on leaves, sorting, root.
- `node engine/score-selftest.js`: 12/12 — PORCH-only wallet gets exactly
  50/80 of pot, MDOG-only exactly 30/80; empty snapshots → zero root/claims
  (publish.js refuses these); dust-only wallets excluded; one wallet per
  muse id (latest link wins); below-floor wallets excluded.
- LP discovery fix (2026-09-27): this chain's PoolManager emits NO
  `Initialize` event (verified: pool-creation tx contains only
  `ModifyLiquidity`). Pool birth is now discovered from the first
  `ModifyLiquidity` log via an oldest-window-first probe; price comes from
  `Swap` logs with earliest-known fallback. Birth blocks verified:
  MDOG/MUSEBOOK 67856790, PORCH/MDOG 70387195, PORCH/MUSEBOOK 70382066.
- `node engine/validate-replay.js` (PENDING — runs after the LP re-replay
  lands): checks replayed liquidity == `getPositionLiquidity`, replayed
  price == `getSlot0`, replayed owner == `ownerOf`, and tickmath amounts
  agree to the wei — on sampled positions incl. #3036297, #3156366,
  #3344714 (read-only; positions never touched).
- LP math: JS `getAmountsForLiquidity` on live position #3344714 =
  77263397.06691882 PORCH / 310064.3558220185 MUSEBOOK — matches the keeper's
  independent Python math to 8+ decimals.
- Fork E2E on real chain data: deploy → fund from impersonated treasury →
  publish dry-run root → real `claim()` paid the exact MUSEBOOK → double-claim
  reverted → forged amount reverted → post-deadline claim reverted →
  `finalizeEpoch()` released the remainder → owner withdrew it.
- Claim economics: 30-day claim window per epoch (`CLAIM_WINDOW` constant);
  anyone may finalize an expired epoch; unclaimed rolls into the next
  epoch's pot as carryover. No treasury reserve, no treasury cut.

## What is NOT done

- Contract is **not deployed**; no real epoch has run; no funds moved.
  Deploy attempt 2026-09-27: Bankr CLI `wallet sign -t eth_signTransaction`
  → API 403 Forbidden; `agent prompt` → Forbidden; `wallet submit`
  requires a `to` address (no contract-creation path). No EOA key exists on
  this machine. Andrew runs `forge script script/Deploy.s.sol` (or the
  init bytecode in the launch checkpoint) from his own wallet in the morning.
- Guard params (1M PORCH / 1K MDOG floors, 2% whale cap, 1.5x LP mult) are
  **proposed** — Andrew rules before epoch 1.
- Identity registry export from the registration backend is still TODO
  (registration must accept any EVM address — Spellbook included). Without
  it, a real epoch cannot exclude unlinked wallets per the locked model.
- Epoch-1 funding moves MUSEBOOK out of Andrew's EOA 0xEac12759… — only he
  holds that key.
- The old `site/claim.js` three-token stub is replaced by the real claim engine;
  it activates when `DISTRIBUTOR` is set.
