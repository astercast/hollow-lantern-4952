# Rewards Launch Checkpoint — 2026-09-27 (UTC)

## Source
Overnight build session (main agent + coordinator). All facts below were
verified on-chain or by test run on 2026-09-27, not asserted from memory.

## What was built
- `rewards/contracts/RewardsDistributor.sol` — Merkle claim distributor,
  MUSEBOOK-only, owner = treasury EOA. 100% of each published allocation
  goes to claimants; no reserve; unclaimed after 30-day window is releasable
  by anyone via `finalizeEpoch()` into free funds the owner can withdraw.
- `rewards/engine/` — snapshot (spot only), scoring (50 PORCH / 30 MDOG,
  normalized /80, one combined leaf per wallet, spot-only — LP removed
  2026-09-27), Merkle tree, publish-bundle builder, fork E2E, scoring
  self-tests.
- `site/claim.js` — real claim UI, DISTRIBUTOR=null (disabled) until deploy.

## Choice made
- Constructor: `RewardsDistributor(MUSEBOOK, TREASURY)` where
  MUSEBOOK = `0x91A2DAe9699f0B82540B5886b0d8759C22820bA3`
  TREASURY (owner) = `0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25`
  (Andrew's EOA holding the treasury MUSEBOOK — NOT the 1-of-2 Safe,
  which holds no MUSEBOOK).
- Bytecode: 8,949 bytes (under the 24,576 limit). Estimated deploy gas:
  1,859,461 → use gas limit 2,200,000. Init bytecode saved at
  `/tmp/deploy-data.txt` (ephemeral — rebuild with the command below).
- Deployer: Bankr wallet `0x3A66aEc855E605966AebbA7df75eB858019B8516`
  (ETH 0.0010744 at check; deploy costs ~0.0004 ETH at 0.2 gwei).

## Why this shape
- 100% to holders / no reserve: Andrew killed the 20% reserve on 2026-09-27
  ("It's confusing"). Contract has no reserve concept at all.
- Owner = treasury EOA: only the key holding the MUSEBOOK can fund epochs
  and publish roots. The Safe was considered and rejected — it holds no
  MUSEBOOK and adding it would strand the flow.
- Claims not airdrops; verified muse identity required; one wallet per
  identity — locked rewards model (see holder-rewards-design.md).

## What would invalidate this checkpoint
- Andrew changes guard params (floors 1M PORCH / 1K MDOG, 2% whale cap,
  decided 2026-09-27) → rescore before epoch 1.
- A real identity-registry export appears → epoch-1 scoring must use it,
  not the TEST registry (dry-run claims used the test registry — NOT production).
- MUSEBOOK or treasury address changes → rebuild init bytecode.
- LP stays OUT of rewards (Andrew 2026-09-27): if LP is ever reintroduced,
  scoring, docs, and tests must be rebuilt — the current suite proves
  spot-only.

## Blockers (morning actions for Andrew)
1. **Deploy**: this machine cannot sign contract creation (Bankr CLI
   `wallet sign` → 403; `wallet submit` needs a `to` address; no EOA key
   here). Andrew runs from his own wallet:
   `forge script script/Deploy.s.sol --rpc-url robinhood --broadcast`
   (needs the MUSEBOOK + treasury constants — already in the script).
2. **Fund epoch 1**: move 1/8 of treasury MUSEBOOK to the distributor,
   then `publishRoot(epochId, root, allocation)` from the owner EOA.
3. **Identity registry**: export tool built (`engine/export-registry.js`);
   still needs real registrations in the production backend.
4. ~~Guard params~~ — decided by Andrew 2026-09-27: floors 1M PORCH / 1K MDOG
   on ≥4 of 7 snapshots, 2% whale cap, 1 MUSEBOOK minimum payout. Locked in
   `engine/config.js`. Epoch 1: Monday 2026-09-28 00:00 UTC.

## Rerunnable checks (another agent can re-verify)
```bash
export PATH=/home/hatch/.foundry/versions/foundry-rs/foundry/v1.8.3:$PATH
cd ~/workspace/muse-dog-lol/rewards
forge test                                   # expect 22/22
cd engine
node score-selftest.js                       # expect 15/15 (incl. LP-ignored)
node rescore.js                              # rebuilds claims-999 (test only)
node fork-e2e.js                             # expect full battery PASS
```
Rebuild deploy bytecode:
```bash
cd ~/workspace/muse-dog-lol/rewards/engine && node -e "
const {ethers}=require('ethers'); const cfg=require('./config');
const ART=require('../out/RewardsDistributor.sol/RewardsDistributor.json');
new ethers.ContractFactory(ART.abi,ART.bytecode.object)
  .getDeployTransaction(cfg.TOKENS.musebook,cfg.TREASURY)
  .then(tx=>require('fs').writeFileSync('/tmp/deploy-data.txt',tx.data));"
```
NOTE: use `ART.bytecode.object` (foundry artifact nests bytecode).

## Test evidence (2026-09-27)
- forge: 22/22 (incl. ownership, non-owner withdraw, token-false/revert,
  future-asset-class agnosticism).
- score-selftest: 15/15 (50/80 PORCH-only, 30/80 MDOG-only exact; LP-only
  wallets score zero; stale s.lp fields ignored).
- LP removed from rewards 2026-09-27 (Andrew): scoring is spot-only.
  `replay.js` keeps ERC20 Transfer replay for spot; V4/LP functions obsolete.
- fork-e2e: deploy/fund/publish/claim verified on fork; full battery pending
  (public RPC flaky — anvil fork estimateGas unreliable, use explicit gas).
- Nothing deployed. No funds moved. Passcode stays up.

## Mikey verification pass (2026-09-27 ~02:45 PDT, before morning report)
- Reran `forge test` myself: **22/22 pass, 0 fail** (full list above this file's earlier summary).
- Reran `node engine/score-selftest.js`: all pass incl. LP-only wallet scores zero,
  spot wallet still claims, stale s.lp field changes nothing.
- Confirmed remote `origin/main` has `644c4ae` (no-LP cleanup) and `dee43b7`
  (fork-e2e fixes); remote README says "BUILT AND TESTED. NOT DEPLOYED", spot-only.
- Confirmed remote `site/index.html` still carries the passcode gate
  (musedog_unlocked check present).
- Fork E2E final withdraw step caveat stands: public RPC/anvil flakiness blocked the
  last step on the fork; withdrawal logic proven by forge tests
  (test_withdraw_cannot_touch_claims, test_withdraw_still_cannot_touch_open_claims_after_expiry).
- NOT DEPLOYED. No funds moved. No production root published. Contract address: none.

## Andrew's rulings — 2026-09-27 ~10:20 PDT (his words, acted on same session)

1. **Guard numbers: set.** Locked in `engine/config.js`:
   - 1,000,000 PORCH / 1,000 MDOG floors, must hold on >= 4 of 7 snapshots
   - 2% whale cap (no wallet's score exceeds 2% of its class total)
   - 1 MUSEBOOK minimum payout (below that stays as carryover)
   - Epoch 1 starts Monday 2026-09-28 00:00 UTC (runs to 2026-10-04; scored 2026-10-05)
   Values were already the proposed defaults; this ruling flips them from
   PROPOSED to DECIDED. README + checkpoint + score.js notes updated.
2. **No LP tracking at all.** `engine/snapshot.js` no longer discovers or
   values LP positions: positionTimeline/ownerAt/lpBalancesAt deleted,
   snapshots are `{date, ts, block, spot}` only. score.js never read LP.
   No multiplier anywhere (grep-verified in scoring paths).
3. **Identity registry export: built.** `engine/export-registry.js` reads the
   registration backend (JSON locally, Postgres via DATABASE_URL in
   production) and emits `{wallet: {muse_id, linked_at}}`. Verified with a
   synthetic round-trip (1 row in → 1 wallet out, proof field carried,
   address lowercased; row removed after, local db.json restored pristine).
   Current state: **zero verified registrations** in the backend — a real
   epoch cannot run until muses register. `api/server.js` now stores the
   identity `proof` type on each new registration for the export.
4. **Deploy guide written** (`rewards/DEPLOY-GUIDE.md`): Remix +
   Injected Provider path, Robinhood Chain (4663) network details,
   constructor args (MUSEBOOK 0x91A2DAe9699f0B82540B5886b0d8759C22820bA3,
   owner = his wallet), verify-after-deploy step. Funding + publishRoot are
   a second signing session after epoch 1 is scored (2026-10-05).

Rerunnable checks: `forge test` (22/22) and `node engine/score-selftest.js`
(15/15) re-ran green after the guard/snapshot changes. `node -e` parse of
snapshot.js/score.js OK. NOT DEPLOYED. No funds moved. Passcode stays up.
