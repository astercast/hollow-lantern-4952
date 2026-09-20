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
- **Fee splitter: autonomous Uniswap DEX legs** (decision reversed 2026-09-20,
  see §2). The manual `forwardBuyback`/`forwardLiquidity` functions are kept
  as owner-only emergency hatches.

## 2. The fee-splitter decision (read before changing)

The task allowed two designs for the 25% buyback-burn and 25% LP legs:
(a) fully-autonomous on-chain swaps, or (b) escrow + multisig forwarding.
**We first shipped (b), deliberately — then Andrew reversed the decision on
2026-09-19: "uniswap is very trustworthy we can do it automated."**
The contracts below now implement (a), with (b) retained as the emergency
fallback.

Why (a) became shippable: the blocker for (a) was pinning the DEX surface on
Robinhood Chain. On 2026-09-19 the official Uniswap deployment page
(`github.com/Uniswap/uniswapx` playbook/chains/robinhood.md, chain id 4663)
was verified, and every pinned address was confirmed live via `eth_getCode`
on `https://rpc.mainnet.chain.robinhood.com`:
- v3 factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (official page + code)
- SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2` (official page + code)
- WETH9 `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` (official page + code)
- NonfungiblePositionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`
  (code + on-chain `factory()`/`WETH9()` point at the two official contracts
  above — first-party linkage, not a docs claim)

What ships now:

- `process()` (permissionless keeper, runs when new funds ≥ threshold) splits
  ONLY newly arrived funds into the four buckets exactly as before
  (**escrowed funds are never re-split** — invariant unchanged), pushes the
  10%/40% legs failing-open as before, then settles the two DEX legs
  **fail-SAFE**: each leg runs inside `try/catch`; a leg that cannot complete
  (no pool, MDOG unset, TWAP guard tripped, router revert) is SKIPPED with a
  `DexLegSkipped` event, its ETH stays escrowed, and `process()` still
  succeeds. Any keeper can retry a leg via `executeBuyback()` /
  `executeLiquidity()`.
- **Buyback leg:** wraps the bucket to WETH, `exactInputSingle` WETH→MDOG on
  the configured fee-tier pool with `deadline = block.timestamp`, checks the
  ACTUAL received amount against the pool's TWAP (default 30-min window,
  default 3% tolerance) and reverts the whole leg on shortfall — a sandwich
  that moves execution >3% off TWAP just burns the attacker's gas — then
  burns the full MDOG balance to the dead address.
- **Liquidity leg:** wraps the bucket, swaps half to MDOG (same TWAP guard),
  and mints a FULL-RANGE v3 position (ticks aligned to the pool's tick
  spacing) DIRECTLY to the dead address — locked forever on mint, no
  withdrawal possible, no exit to front-run. WETH dust is unwrapped back to
  ETH so the next `process()` sweeps it; MDOG dust stays for the next leg.
- **Why the router/NPM/factory/WETH are IMMUTABLE:** an owner-updatable
  router would let a compromised owner key point the DEX legs at a malicious
  contract and drain the escrowed buckets. Immutable means even a stolen
  multisig key cannot redirect DEX funds — only the pre-existing `forward*`
  trust assumption remains. If Uniswap ever migrates, the autonomous legs
  brick safely (skip forever) and the multisig falls back to `forward*`.
- **Owner-tunable DEX policy** (guarded): `mdogToken` (required before legs
  run; zero/ EOA/ WETH rejected), `feeTier`, `twapWindow` (5 min–24 h),
  `maxSlippageBps` (0–20%), `processThreshold`. The constructor refuses to
  deploy on any chain other than 4663.
- Tick math (`_getSqrtRatioAtTick`) is a clean-room implementation of the
  1.0001-tick curve (constants are fixed-point encodings of powers of the
  tick base — mathematical facts), pinned by canonical vectors in
  `test_TickMathVectors` (tick 0 → 2^96, MIN/MAX ticks, tick 1 verified
  against exact arbitrary-precision math).
- Rounding dust from bps floor math still flows to the liquidity leg via
  remainder arithmetic, so the four legs sum to exactly the processed amount
  and no wei can ever be stranded outside the buckets.

## 3. Trust assumptions (explicit)

1. **The owner is the project Safe multisig** (after the post-test-mint
   handover). It is trusted to: rotate the voucher signer only when needed,
   set the base URI to the true final Arweave manifest, set the correct
   `mdogToken` address, tune the DEX policy (`feeTier`, `twapWindow`,
   `maxSlippageBps`) and the process threshold sanely, and use the manual
   `forwardBuyback`/`forwardLiquidity` hatches only as intended. It CANNOT:
   exceed any mint cap, change metadata after the freeze, change the royalty
   rate or receiver after wiring, redirect the mikey/vault legs (immutable
   recipients), forward more than each escrow bucket holds, **or change the
   pinned Uniswap wiring** (router/factory/NPM/WETH are immutable — see §2,
   this is deliberate: a mutable router would let a compromised owner key
   drain the DEX buckets via a fake router).
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

### Pass 4 — autonomous DEX legs (2026-09-20). Decision reversed by Andrew:

> "uniswap is very trustworthy we can do it automated"

Rewrote `MuseDogsFeeSplitter` to execute the 25%/25% legs itself against
pinned Uniswap v3 on Robinhood Chain (4663). Verification trail (§2):
official Uniswap docs page + on-chain code + cross-contract linkage for the
NPM. `Deploy.s.sol` wires the pinned addresses (overridable via env at
script time, immutable after deploy).

Design review summary (see §2 for the full rationale):

- **Fail-safe, not fail-open, for DEX legs:** `try this.executeBuyback()` /
  `try this.executeLiquidity()` inside `process()`; any failure (no pool,
  MDOG unset, TWAP shortfall, router/NPM revert, OOG) skips the leg with a
  `DexLegSkipped` event, escrowed ETH untouched, `process()` still succeeds.
- **Sandwich bound:** actual received amount is checked against the pool's
  TWAP (30-min default, 3% default tolerance) AFTER the swap; a sandwich that
  moves execution >3% off TWAP reverts the leg and burns the attacker's gas.
  Residual profit is bounded by the tolerance.
- **Reentrancy:** `process()` is `nonReentrant`. The DEX executors zero their
  bucket BEFORE any external call (CEI); a reentrant `process()` from a
  token hook either finds nothing new or legitimately splits new funds
  (no double-spend — covered by `test_ReentrantMdogCannotDrain`).
- **Tick math** pinned by canonical vectors; tick-1 value verified against
  exact arbitrary-precision math (the remembered "canonical" value in the
  first test draft was wrong; the contract was right).
- **Negative-tick TWAP** floor-division path covered end-to-end
  (`test_TwapNegativeTickFloorDivision`).
- **Router/NPM immutability is a security feature:** a mutable router would
  let a compromised owner key drain the buckets via a fake router.
- **Dead-address LP is irreversible by design** — `mdogToken`/`feeTier` must
  be verified on Blockscout before `setMdogToken` (pre-mainnet checklist).

Full suite after Pass 4: **87/87 passing** (37 NFT + 36 splitter + 14
rewards vault). No deployment, no gas spent, nothing broadcast.

### Residual risks / open questions for Andrew

1. **No independent third-party audit yet.** These contracts passed four
   internal passes and 87 tests, but a second set of eyes (paid audit or at
   minimum a review by a trusted Solidity dev) is strongly recommended before
   mainnet — this is real money and 500 permanent NFTs.
2. **`_voucher.js` migration (§4)** is the single most likely launch-day
   failure if missed: vouchers signed with the old type will all revert.
3. **Robinhood Chain testnet rehearsal** (chain 46630, in foundry.toml)
   should run the FULL flow before mainnet: deploy → setBaseURI → teamMint
   20 → transfer both contracts to the Safe → accept → issue real vouchers
   from the backend → relayer submits → `process()` a royalty → DEX legs
   execute on a testnet MDOG/ETH pool (or verify skip-and-hatch path if no
   pool exists).
4. **Voucher-signer compromise window** (P2-I1): no pause; rotation is the
   response. Keep voucher expiries short (hours, not days) to shrink it.
5. **Royalty bypass** is inherent to ERC-2981 (§3.5) — honest disclosure only.
6. **Threshold tuning**: `processThreshold` should be set so `process()` is
   worth calling but not spammable; the multisig can tune it later.
7. **DEX-leg residuals (accepted):** (a) sandwich tolerance is bounded by
   `maxSlippageBps` (default 3%) — a price move within tolerance can extract
   a small profit from a buyback leg; (b) TWAP manipulation costs scale with
   the window (default 30 min) and pool depth — thin MDOG liquidity makes
   legs expensive or skippable; (c) a dead-address LP is IRREVERSIBLE — a
   mistyped `mdogToken` or wrong `feeTier` burns funds into the wrong pool
   forever; the multisig must verify the pool on Blockscout before setting
   `mdogToken`; (d) if Uniswap deprecates the pinned router, the autonomous
   legs brick safely and the multisig falls back to `forward*`; (e) an
   immature pool without enough TWAP observations fails SAFE (legs skip) but
   could delay automation until the pool matures.
8. The old escrow-only splitter design is preserved in git history
   (pre-autonomous commits). The manual `forward*` hatches are kept in the
   contract as the emergency path.

### Pre-mainnet checklist

- [ ] `_voucher.js` updated to the new EIP-712 type + re-cross-verified
- [ ] Independent Solidity review — no unresolved high/criticals
- [ ] Testnet (46630) full rehearsal incl. backend voucher + relayer + DEX legs
- [ ] MDOG token address triple-checked; `setMdogToken` called; MDOG/ETH pool
      with the chosen fee tier verified on Blockscout with TWAP history
- [ ] Arweave upload complete; manifest txid in hand
- [ ] Deploy splitter → deploy NFT (script wires royalties)
- [ ] Verify source on Blockscout (both contracts)
- [ ] `setBaseURI` ONCE with the final manifest URL
- [ ] `teamMint` the 20 (deployer wallet = pre-launch test)
- [ ] `transferOwnership(multisig)` on BOTH contracts; multisig `acceptOwnership`s
- [ ] Confirm `owner()`, `voucherSigner`, `feeSplitter`, `royaltyInfo`,
      `mdogToken`, `feeTier` on-chain
- [ ] Publish canonical addresses from a verified channel
