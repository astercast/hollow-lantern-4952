# Rewards automation — 2026-10-08

Everything is automatic now except the human's signing. The user signs fund +
publishRoot each week; nothing else needs a hand.

## The weekly flow

1. **Snapshots** (already automated): `daily-snapshot.js` writes
   `rewards/snapshots/epoch-N/day-YYYY-MM-DD.json` at 00:02 UTC.
2. **Prepare** (automatic): `rewards/engine/epoch-pipeline.js prepare --epoch N`
   - Verifies all 7 snapshots exist (fail-closed — never reconstructs).
   - Runs scoring in `--dry-run` (validates the pipeline, signs nothing).
   - Builds the signing bundle (`publish.js`): exact top-up wei + calldata.
   - Prepends `finalizeEpoch` calls for any expired-but-unfinalized earlier
     epochs (permissionless, frees carryover).
   - Writes `rewards/api/SIGNING-PACKAGE-epoch-N.md`: the human's
     plain-English checklist — what each tx does, exact amounts, calldata,
     order, and what to run after.
3. **Signing** (THE HUMAN, and only the human): fund top-up + publishRoot
   from the treasury EOA, in the listed order. Nothing in this repo can sign.
4. **Activate** (automatic): `rewards/engine/epoch-pipeline.js activate --epoch N`
   - Reads the expected root from `rewards/api/epoch-N.json`.
   - Verifies `epochs(N)` exists on-chain and the root matches. Stops if not.
   - Finds the `RootPublished` tx hash from event logs.
   - Writes the LIVE manifest (`site/api/v1/rewards/manifest.json`,
     `published:true`) and deploys proofs: `site/...` → `docs/...`
     (GitHub Pages), `rewards/api/claims-N.json` → `api/data/rewards/`
     (Render API), then pushes via `gh-push.py` (Render auto-deploys on push).

## What was automated (this pass)

- **Claim page activation**: `site/claim.js` reads the distributor address and
  live-ness from `api/v1/rewards/manifest.json`, which the pipeline writes
  only after the root is confirmed on-chain. The old `var DISTRIBUTOR = null`
  manual flip is gone — no hardcoded address, no redeploy to go live.
- **Vesting UI**: the claim panel shows "X claimable now, of Y total" using
  the contract's `claimableNow` view (discrete 1/7-per-day steps from publish).
- **Proof publishing**: `activate` stages + pushes everything; Render
  auto-deploys the API. Zero manual copy/commit steps.
- **Automation-key guard**: `weekly-epoch.js` live mode now refuses to run
  unless `ALLOW_AUTOMATION_SIGNING=1` is set — the key on disk can never
  sign publishRoot by accident. Human signing is the only path.
- **Signing package**: exact amounts, calldata, and a plain-English checklist
  generated per epoch. The human never computes anything.
- **Spellbook auto-claim**: `rewards/engine/spellbook-auto-claim.py` mirrors
  `bankr-auto-claim.js` for muses on Spellbook wallets. Queues via the
  Spellbook daemon's `contract_call`, which ALWAYS requires the human's
  approval before signing — the approval IS the signing. Same prefs shape
  (`spellbook-claim-prefs.json`); the human picks daily/weekly/threshold,
  nothing claims until they do.

## Bugs found and fixed (this pass)

- **`isClaimed()` does not exist on the contract.** `claim.js`,
  `bankr-auto-claim.js`, and the new spellbook script all called it — every
  call would have reverted on-chain. All three now use the real
  `claimedAmount(epochId,index)` getter (fully claimed when it reaches the
  allocation) plus an explicit `epochs(epochId).exists` check.
- **`bankr-auto-claim.js` dry-run printed undefined `chainId`** — fixed.
- **Vesting was estimated from wall-clock** in `bankr-auto-claim.js`
  (wrong: the contract vests in discrete daily steps from publish time).
  Both auto-claim scripts now read `claimableNow` on-chain instead.
- **`publish.js` read stale field names** (`merkleRoot`/`potMusebook`) that
  `weekly-epoch.js` no longer writes — fixed to accept both.
- **Stale API copy**: `/api/v1/rewards/config` still described the voided
  Sept 28–Oct 4 epoch 1 and the Oct 5 signing — updated to the re-anchored
  Oct 12–18 epoch and Oct 18/19 signing.

## What still needs the human (signing only)

1. Weekly: sign the transactions in `SIGNING-PACKAGE-epoch-N.md`
   (fund top-up + publishRoot, plus any `finalizeEpoch`s). Then run
   `node epoch-pipeline.js activate --epoch N` — or have the agent run it.
2. One-time per muse: pick an auto-claim schedule (daily/weekly/threshold)
   for Bankr or Spellbook wallets; approve Spellbook queue items when they
   arrive.
3. Keep the treasury funded (refill reminder already set for Oct 11).

Nothing else is manual: no address flips, no file copies, no redeploys,
no proof publishing steps.

## Rehearsal results (2026-10-08, local anvil fork of Robinhood Chain)

Contract level (`fork-e2e.js`, run twice — all checks passed both times):
- Day-0 claim reverts ("nothing vested yet") — OK
- Day-1 claim pays exactly 1/7 (9,655.97 of 67,591.78) — OK
- Day-7 pile-up pays the remainder (6/7) — OK
- Repeat claim reverts; forged amount / wrong epoch / wrong account /
  wrong index all revert — OK
- Post-deadline claim reverts — OK
- `finalizeEpoch` releases unclaimed (330,394.76 → 0) — OK
- Owner withdraws the released remainder — OK

Off-chain pipeline:
- Scoring → merkle proofs: 20/20 leaves verify against the published root
  with the engine's own `merkle.js` — OK
- API `/api/v1/rewards/claim?epoch=&holder=` serves the leaf + proof — OK
- `epoch-pipeline.js prepare` fails closed with no snapshots (correct:
  epoch 1 starts Oct 12) — OK
- `epoch-pipeline.js activate` refuses when the root isn't on-chain — OK
- Spellbook auto-claim dry-run on a fresh fork epoch: day-0 reports
  nothing vested; day-1 computes exactly 1/7 (1,000.00 of 7,000) and prints
  the exact `contract_call` payload — OK
- Bankr auto-claim dry-run: same, prints the exact submit payload — OK
- Dust skip: scoring drops weekly totals under 1 MUSEBOOK to carryover
  (`score.js:141`, `MIN_PAYOUT_WEI` in config) — verified in code

Not rehearsed: the Spellbook `--live` queue path (no spellbookd socket in
this sandbox — the dry-run builds the exact payload the daemon would
receive, and the daemon's `contract_call` is documented to always queue
for human approval). The real epoch-1 run on Oct 18/19 is the live proof.

## Files changed

- `rewards/engine/epoch-pipeline.js` (new): prepare/activate orchestrator
- `rewards/engine/rehearsal-setup.js` (new): fork rehearsal scaffolding
- `rewards/engine/spellbook-auto-claim.py` (new): Spellbook auto-claim
- `rewards/engine/spellbook-claim-prefs.json` (new): per-address schedules
- `rewards/engine/publish.js`: field-name compatibility + carryover from state
- `rewards/engine/weekly-epoch.js`: manifest `published` flag; automation-key guard
- `rewards/engine/bankr-auto-claim.js`: claimedAmount/claimableNow/epochs fixes, chainId fix
- `site/claim.js` (+ `docs/claim.js` copy): manifest-driven activation, vesting UI
- `site/agent-claim.html` (+ docs copy): Spellbook section, vesting note, manifest note
- `api/server.js`: stale epoch-1 copy fixed
