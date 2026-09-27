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
- Andrew changes guard params (floors 1M PORCH / 1K MDOG, 2% whale cap are
  PROPOSED, not locked) → rescore before epoch 1.
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
3. **Identity registry**: real verified-muse export still TODO — without
   it, epoch 1 cannot satisfy "verified identity required".
4. **Guard params**: Andrew rules on floors / whale cap.

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
