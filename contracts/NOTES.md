# Muse Dogs — contracts: design notes, trust assumptions, audit log

**Status: written, compiled (solc 0.8.30), 70/70 Foundry tests passing. NOT
audited by an independent third party. NOT deployed. Do not deploy to mainnet
without the checklist at the bottom.**

Toolchain: Foundry, solc 0.8.30 (pinned — no floating pragmas), OpenZeppelin
Contracts v5.4.0 (pinned), EVM Cancun. Target: Robinhood Chain (chain id 4663).

Files:

| Path | What it is |
|---|---|
| `src/MuseDogs.sol` | The collection: ERC-721 "Muse Dogs" / "MUSEDOGS", 500 hard cap |
| `src/MuseDogsFeeSplitter.sol` | Royalty splitter: 10/40/25/25 of every 5% resale royalty |
| `src/MuseDogRewards.sol` | Pre-existing holder-rewards vault (40% leg recipient) — unchanged |
| `test/MuseDogs.t.sol` | 37 tests: vouchers, caps, metadata freeze, royalties, reentrancy |
| `test/MuseDogsFeeSplitter.t.sol` | 19 tests: split math, accounting invariant, fail-open, forwarding |
| `test/MuseDogRewards.t.sol` | Pre-existing vault tests (14, still passing) |
| `script/Deploy.s.sol` | Deploy script; all params from env, key via `--private-key` flag |

---

## 1. Design decisions (locked specs → code)

- **Buckets sum exactly to the cap.** 380 community + 100 holder + 20 team =
  500 = `MAX_SUPPLY`. Every mint path checks its bucket cap AND a
  defense-in-depth `totalMinted() >= MAX_SUPPLY` guard. There is no code path
  that can mint token 501.
- **Token IDs 1–500.** 1-based (not 0-based) to avoid token-0 edge cases in
  third-party tooling. Sequential across all three buckets.
- **Vouchers: `MintVoucher(address recipient, uint8 mintType, uint256 nonce,
  uint256 expiry)`**, EIP-712, domain `("Muse Dogs", "1", chainId,
  verifyingContract)`. `mintType` 0 = COMMUNITY (max 3/address, 380 cap),
  1 = HOLDER (max 1/address, 100 cap). One NFT per voucher call; the relayer
  submits and pays gas; the NFT always goes to the voucher's `recipient`,
  never `msg.sender`.
- **Nonces are per-recipient, not global and not per-mint-type.** The backend
  MUST issue nonces unique per recipient across BOTH mint types, or the
  second voucher reverts `NonceAlreadyUsed`. (Tested:
  `test_NonceIndependentAcrossMintTypesIsBlocked`.)
- **Expiry is inclusive**: valid while `block.timestamp <= expiry`.
- **Team mint is strict**: any zero address in the batch reverts the whole
  call (the multisig fixes its input; nothing is silently skipped).
- **baseURI: set-once-then-frozen, atomically.** `setBaseURI` sets AND freezes
  in one call — there is no separate freeze step to forget, and no way to
  change metadata after. `tokenURI` reverts until it is set, so broken
  metadata can never be served. `tokenURI = baseURI + tokenId + ".json"`.
- **Royalty: fixed 5% (500 bps), no setter exists for the rate.** The
  receiver (fee splitter) is settable exactly once — constructor or
  `setFeeSplitter` — then immutable. Until it is set, `royaltyInfo` returns a
  zero receiver, so wire it promptly (the deploy script wires it at
  construction).
- **Ownership: `Ownable2Step`.** `transferOwnership(multisig)` does nothing
  until the multisig calls `acceptOwnership()` — a mistyped address cannot
  brick ownership. `renounceOwnership` still exists (deliberate: the multisig
  may one day burn its own powers, but it must do so explicitly).
- **No pause mechanism.** Deliberate least-privilege choice (see audit log).
  The voucher signer is rotatable by the owner at any time with an event;
  rotation instantly kills the old key's vouchers.
- **Fee splitter: NO autonomous DEX swaps.** See §2.

## 2. The fee-splitter decision (read before changing)

The task allowed two designs for the 25% buyback-burn and 25% LP legs:
(a) fully-autonomous on-chain swaps, or (b) escrow + multisig forwarding.
**We shipped (b), deliberately.**

Rationale: an autonomous swapper must hard-code a DEX router/quoter for
Robinhood Chain. That surface cannot be pinned safely at build time — router
addresses change, pools may be thin, and a stale or misconfigured router
turns the splitter into an MEV/loss machine with no human in the loop.
A "minimal, audited swap interface" against a chain whose DEX landscape is
still being mapped is not airtight — so per the task's own fallback rule, we
did not ship it.

What shipped instead:

- `process()` (permissionless keeper, runs when new funds ≥ threshold) splits
  ONLY newly arrived funds into four escrow buckets: 10% Mikey, 40% vault,
  25% buyback, 25% liquidity. **Escrowed funds are never re-split** —
  `process()` splits `balance - totalPending()`, so a second call cannot
  dilute the buyback/liquidity buckets (invariant covered by
  `test_ProcessNeverReSplitsEscrowedFunds`).
- The 10%/40% legs are **pushed immediately, failing OPEN**: if a recipient
  reverts, the amount stays in its pending bucket (no revert of `process()`,
  no stuck funds) and anyone can retry via `claimMikey()` / `claimRewards()`.
- The 25%/25% legs accumulate in `buybackPending` / `liquidityPending` and are
  forwarded **only by the owner (multisig)**, only up to the bucket balance,
  to a destination the multisig chooses per call, with an event per forward.
  The multisig executes the MDOG buyback-and-burn and the MDOG/ETH LP mint to
  the dead address (`0x000000000000000000000000000000000000dEaD`) transparently,
  or points a forward at a future separately-audited swapper contract.
- Rounding dust from bps floor math flows to the liquidity leg via remainder
  arithmetic (`liquidityShare = newFunds - mikey - rewards - buyback`), so the
  four legs sum to exactly the processed amount and no wei can ever be
  stranded outside the buckets.

## 3. Trust assumptions (explicit)

1. **The owner is the project Safe multisig** (after the post-test-mint
   handover). It is trusted to: rotate the voucher signer only when needed,
   set the base URI to the true final Arweave manifest, forward the
   buyback/liquidity legs to the right destinations, and tune the process
   threshold sanely. It CANNOT: exceed any mint cap, change metadata after the
   freeze, change the royalty rate or receiver after wiring, redirect the
   mikey/vault legs (immutable recipients), or forward more than each escrow
   bucket holds.
2. **The voucher signer key is dedicated** (signs vouchers only, never sends
   transactions, ideally in KMS/HSM). If compromised, the owner rotates it;
   the blast radius is bounded by the bucket caps (380/100) and voucher
   expiries. There is no pause — this is the accepted residual risk (§5.5).
3. **Constructor arguments are triple-checked at deploy**, especially the
   immutable `mikeyBankr` / `rewardsVault` (wrong forever if wrong) and the
   multisig address (Ownable2Step protects against typos, not against a
   wrong-but-valid address). The contracts additionally refuse EOAs for the
   fee-splitter and rewards-vault parameters (`NotAContract`).
4. **The backend is trusted to**: issue unique nonces per recipient, keep
   voucher expiries short, check the $10 MDOG holdings before issuing HOLDER
   vouchers, and never reuse the voucher key as a hot transaction key.
5. **Marketplaces are trusted to honor ERC-2981.** Royalty bypass via
   non-compliant marketplaces or OTC transfers is inherent to ERC-2981 and
   cannot be fixed on-chain without breaking free transfers (which we will
   not do).

## 4. ⚠️ INTEGRATION RISK #1 — `site/api/v1/_voucher.js` MUST be updated

The EIP-712 voucher type in these contracts is **intentionally different**
from the `MintVoucher{to,quantity,nonce,deadline}` draft in
`VOUCHER_SPEC.md` / `site/api/v1/_voucher.js`:

```
// what the contract verifies:
MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)
// domain: { name: "Muse Dogs", version: "1", chainId, verifyingContract }
```

The JS signer must be updated to this exact type (field names, `uint8
mintType` with 0=COMMUNITY/1=HOLDER, `expiry` instead of `deadline`, no
`quantity` — the per-address caps are now enforced on-chain) and
**re-cross-verified** against the contract before mint opens, or every
voucher will revert with `BadVoucherSignature`. The Foundry test
`_signVoucher` is the reference digest construction to match byte-for-byte.

---

## 5. Audit log

### Pass 1 — write (2026-09-19)

Wrote `MuseDogs.sol`, `MuseDogsFeeSplitter.sol`, rewrote `Deploy.s.sol`,
removed the superseded old-design files (`MuseDog.sol`,
`MuseDogFeeEngine.sol`, `V4Math.sol`, `MuseDogRoyaltySplitter.sol` and their
tests — recoverable from git history). `MuseDogRewards.sol` (holder vault)
and its tests were kept as-is; its NatSpec numbers were already consistent
with the final economics (40% of the 5% royalty = 2% of sale price).

### Pass 2 — adversarial audit (2026-09-19/20). Findings:

**P2-F1 (fixed): zero-amount `Paid` events.** `process()` emitted
`MikeyPaid(0)`/`RewardsPaid(0)` when a bucket was already empty (the
`_tryPush` no-op path returned true). Misleading for indexers.
→ Fixed: skip push and emit when the bucket is zero.

**P2-F2 (fixed): wrong error on over-bucket forward.** `forwardBuyback` /
`forwardLiquidity` reverted `NothingPending` when `amount > bucket`, which
misdescribes the failure.
→ Fixed: new `InsufficientPending(requested, available)` error.

**P2-F3 (fixed): ecrecover ran before cap checks.** `mintWithVoucher`
recovered the signature before checking bucket/per-address caps, wasting gas
on every call that would revert for exhausted caps anyway.
→ Fixed: checks reordered cheap→expensive; `ecrecover` is now last.

**P2-F4 (fixed): EOA accepted as royalty receiver / rewards vault.** The
fee-splitter and vault parameters accepted any non-zero address. A typo'd
EOA would irrevocably swallow the royalty stream (both are immutable
once set).
→ Fixed: `NotAContract` check (`code.length > 0`) on the NFT's
`initialFeeSplitter`/`setFeeSplitter` and the splitter's `rewardsVault`.
(`mikeyBankr` is intentionally unchecked — it is expected to be an EOA.)

**P2-I1 (info, accepted): no pause mechanism.** Considered adding
`Pausable` + rotation-only-while-paused (the old design). Rejected:
least-privilege wins — a pause is another owner power that can itself be
abused or fumbled, and the voucher-signer's blast radius is already bounded
by the on-chain bucket caps plus short voucher expiries. Rotation is instant
and public (event). Accepted residual risk, documented here.

**P2-I2 (info, accepted): `renounceOwnership` remains.** The multisig could
brick the owner functions by renouncing. This is standard OZ behavior and
also the eventual path to full immutability; the multisig simply must not
call it until everything (baseURI, splitter, signer) is final. Not removed.

**P2-I3 (info, accepted): reentrancy test initially mis-specified.** The
first version of `test_ReentrantMikeyCannotDrain` expected the attacker's
push to fail; analysis showed the push legitimately succeeds (it IS the
attacker's 10% — the reentrant inner `process()` is what reverts, causing no
double payment). The test was corrected to assert the true secure behavior:
exactly one payment of the attacker's rightful share, buckets intact, no
double-dip. Lesson recorded: assert the invariant, not the mechanism.

### Pass 3 — fixes verified + final re-audit (2026-09-20)

- All four fixes compiled; full suite re-run: **70/70 passing**
  (37 NFT + 19 splitter + 14 rewards vault).
- Re-read both contracts end-to-end after the edits. Verified: CEI ordering
  in `mintWithVoucher`/`process`/claims/forwards; `nonReentrant` on every
  payable/external state-changing function; no `delegatecall`/`selfdestruct`
  anywhere; pinned pragma; custom errors only; events on every state change;
  zero-address checks on all address parameters; `Ownable2Step` on both
  contracts.
- Re-verified the critical splitter invariant by code inspection AND test:
  `process()` splits `balance - totalPending()` only; every wei that leaves
  decrements its bucket by the same amount; `balance >= totalPending()` holds
  by construction, so the subtraction cannot underflow and escrowed legs can
  never be re-split or diluted.
- Re-verified voucher binding: chainid + verifyingContract in the domain
  (OZ EIP712 rebuilds the separator if chainid changes — fork-safe),
  recipient + mintType + nonce + expiry in the struct hash; `ECDSA.recover`
  reverts on malleable signatures (tested with an s-flipped signature).
- Gas snapshot (for the record, not a target): community mint ~243k,
  holder mint ~213k, team mint of 20 ~1.18M, `process()` ~200k.

### Residual risks / open questions for Andrew

1. **No independent third-party audit yet.** These contracts passed three
   internal passes and 70 tests, but a second set of eyes (paid audit or at
   minimum a review by a trusted Solidity dev) is strongly recommended before
   mainnet — this is real money and 500 permanent NFTs.
2. **`_voucher.js` migration (§4)** is the single most likely launch-day
   failure if missed: vouchers signed with the old type will all revert.
3. **Robinhood Chain testnet rehearsal** (chain 46630, in foundry.toml)
   should run the FULL flow before mainnet: deploy → setBaseURI → teamMint
   20 → transfer both contracts to the Safe → accept → issue real vouchers
   from the backend → relayer submits → `process()` a royalty → forward a
   DEX leg. The old README's rehearsal checklist still applies.
4. **Voucher-signer compromise window** (P2-I1): no pause; rotation is the
   response. Keep voucher expiries short (hours, not days) to shrink it.
5. **Royalty bypass** is inherent to ERC-2981 (§3.5) — honest disclosure only.
6. **Threshold tuning**: `processThreshold` should be set so `process()` is
   worth calling but not spammable; the multisig can tune it later.
7. The old autonomous fee-engine contracts were deleted per the locked
   decision. If a future audited swapper is built, it becomes a *forward
   destination*, not a change to these contracts.

### Pre-mainnet checklist

- [ ] `_voucher.js` updated to the new EIP-712 type + re-cross-verified
- [ ] Independent Solidity review — no unresolved high/criticals
- [ ] Testnet (46630) full rehearsal incl. backend voucher + relayer
- [ ] Arweave upload complete; manifest txid in hand
- [ ] Deploy splitter → deploy NFT (script wires royalties)
- [ ] Verify source on Blockscout (both contracts)
- [ ] `setBaseURI` ONCE with the final manifest URL
- [ ] `teamMint` the 20 (deployer wallet = pre-launch test)
- [ ] `transferOwnership(multisig)` on BOTH contracts; multisig `acceptOwnership`s
- [ ] Confirm `owner()`, `voucherSigner`, `feeSplitter`, `royaltyInfo` on-chain
- [ ] Publish canonical addresses from a verified channel
