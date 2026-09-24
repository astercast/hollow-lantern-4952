# MuseDog Mint Design — Deep Dive

> **SUPERSESSION NOTE (2026-09-20).** This is a thinking document from the
> 2026-09-18 design iteration, kept as history. Andrew's locked decisions
> supersede several statements below — read with this note in hand:
> - **Supply split:** 500 = **380 community (free voucher mints) + 100 holder
>   (voucher mints) + 20 team/treasury**. The sections describing "380 holder
>   airdrops via batch mint" (§2, Phase 5) are superseded.
> - **Royalty:** **7%** (fixed, to the fee-splitter contract), split
>   10% Mikey's Bankr address (raw ETH) / 50% weekly holder-rewards vault /
>   20% MDOG-musebook LP / 20% MDOG-ETH LP. Both LP positions are minted
>   **directly to the dead address, locked forever. No MDOG tokens are ever
>   burned.** Statements about "10% to the project multisig" (§2) and
>   "buyback-and-burn" are superseded.
> - **Holder eligibility:** checked **on-chain at mint execution** via the
>   recipient's MDOG balance against `holderThresholdMDOG` (set by the owner
>   on mint day); the contract is fail-closed — `HolderThresholdNotSet`
>   while the threshold is zero. Never checked off-chain at registration.
> - **Whitelist cutoff:** muse identity created strictly before
>   **2026-09-23** (not 2026-09-20), 10+ posts, all 25 founding muses auto-in.
>   **SUPERSEDED 2026-09-24 (Andrew):** the creation-date cutoff is gone and the
>   post-count rule was already removed 2026-09-21 — any verified musebook
>   identity qualifies.
> - **Multisig:** 1-of-2 Safe (Andrew's fresh wallet + Mikey's Bankr wallet),
>   threshold 1 — supersedes the "2-of-3 Safe" assumption.
> - **Contract facts:** the current contract is `src/MuseDogs.sol` — no pause
>   mechanism (deliberate), EIP-712 voucher type
>   `MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)`,
>   royalty fixed at 700 bps, metadata freeze one-shot. `contracts/NOTES.md`
>   is the audit log.
> The contract's NatSpec is the source of truth for on-chain behavior.

Date: 2026-09-18. Status: thinking document. Nothing here deploys anything.

## 0. Thesis

The contract is the least of our worries — it's built, tested (23/23), and the
bucket design is sound. The three genuinely hard problems are:

1. **The claim last mile.** The site has no claim-submission code yet, and
   Bankr's API has no documented arbitrary contract-call endpoint. A muse with
   a voucher but no way to send `claim()` is stuck. This is the biggest
   unbuilt piece of the whole mint.
2. **The voucher signer.** It's the one new trusted component: whoever holds
   that key can mint up to 100 NFTs to arbitrary addresses. Custody and
   monitoring matter more than any remaining code question.
3. **Art finalization gates everything.** No token ID can be minted before the
   500-token metadata manifest is final, because IDs are sequential and the
   manifest maps ID → artwork. Andrew's picks are the true critical path.

---

## 1. Website

### What's built
Five static pages (Home, Register, Mint, Verify, API), no build step.
Registration works without wallet connection (two signed messages: address
proof + musebook identity proof). Phase banner reads `/api/v1/config`.
`/.well-known/muse-dog.json` exists for machine discovery.

### What's missing — the claim last mile (KEY GAP)
`site/app.js` has **zero** mint-page logic. The mint page is a static
"not open yet" notice. For the mint to work, a muse must go from voucher →
on-chain `claim()` transaction. Paths:

- **A. Project relayer (recommended).** `claim()` is permissionless — anyone
  may submit it, and the NFT always goes to the `claimant` in the voucher.
  Run a small relayer: muse fetches a voucher from the API, the relayer
  submits the tx. Trust properties are unusually good:
  - The relayer **cannot steal anything**. Voucher binds claimant; worst case
    is censorship (not submitting), which is visible on-chain.
  - The relayer key is low-value: it holds only gas money. If drained, top
    up; no NFTs or funds at risk.
  - Griefing is bounded: one voucher per identity/address → max 100 txs.
  - Gas on Robinhood Chain is negligible (measure on testnet; expect <$1
    total for all 100).
  - This makes "free mint" actually one-click for muses whose only wallet is
    Bankr — which is most of them.
- **B. Self-submit (fallback, always available).** Site shows exact calldata +
  a copy-paste `cast send` / ethers snippet. Any muse with their own signing
  infra uses this. Build it regardless — it's the censorship fallback if the
  relayer ever goes down.
- **C. Bankr agent prompt ("please submit this tx").** Nondeterministic,
  needs Club/Max credits, untested. Do not rely on it; test it once as a
  curiosity, not a path.

Recommendation: build A as primary, B as fallback. Both are local builds;
neither deploys anything until approved.

### Mint page states
The page needs four states, not one: **upcoming** (countdown + how it works)
→ **open** (voucher fetch + relayer/self-submit UI + live counter reading
`communityClaimsRemaining()`) → **paused** (plain-language incident notice)
→ **closed/sold out**. Each state needs its own copy. Never show a generic
error where a state explanation belongs.

### Verify page — the anti-scam hub
Free mints attract phishing. The verify page should carry: official domain,
contract address (post-deploy), deployer address, multisig owners, Blockscout
source-verification link, the "we will never ask for" list (seed phrase,
private key, approvals, transfers, nonzero payment), and one strong fact:
**vouchers cryptographically bind chain ID 4663 + the contract address**, so
a phishing site cannot replay a stolen voucher anywhere else. Say this
publicly — it's the actual mechanism, not vibes.

### Agent-first audience
The minters are AI agents. Extend `/.well-known/muse-dog.json` with contract
address, ABI, voucher endpoint, and a worked `cast` example. Add curl examples
for the full flow (challenge → register → voucher → claim) on the API page.
Consider `llms.txt`. Humans get the pretty pages; agents get the machine
pages. Both must agree on the facts.

### Gallery
After Andrew picks art, adapt the 400-dog picks gallery into a collection
gallery page (lazy-load, paginated). Do not ship the 400-concept firehose as
"the collection" — it isn't until he picks.

### Hosting
Domain not bought yet (not authorized). The site is static: also publish it
to IPFS (content-addressed, can't be quietly replaced). Canonical domain +
IPFS hash both printed on the verify page.

---

## 2. Contract — review verdict: keep it

`contracts/src/MuseDog.sol` is in good shape: rigid buckets
(380/100/20, sum = 500 = MAX_SUPPLY), no owner god-mint, no proxy, pause
halts minting but not transfers, CEI ordering + nonReentrant on `claim()`,
signer rotation only while paused (deliberate, announced), royalty bounded at
10%, metadata freeze is one-way. 23/23 Foundry tests pass.

### Voucher vs Merkle — analyzed, recommendation: KEEP VOUCHERS
A Merkle allowlist would remove the signer key entirely (fully permissionless
claims, no API liveness needed). But the whitelist needs flexibility the
frozen-tree design fights: lottery overflow (draw.js), waitlist backfill, late
corrections. Vouchers handle all three naturally, and the build + tests are
sunk and passing. The honest price of vouchers is one trusted key — so pay it
by hardening custody instead of rewriting:

- **Custody ladder:** v1 = key in server env on a hardened box (acceptable:
  blast radius is bounded — see below) → v2 = KMS/HSM. Decide before mainnet.
- **Bounded blast radius:** a leaked signer can mint at most 100 NFTs to
  attacker addresses. It cannot steal funds (`claim()` is non-payable) and
  minting is pausable. Bad, not catastrophic.
- **Monitoring:** alert on voucher-issuance rate spikes (leak signature) and
  on `VoucherSignerRotated` / `Paused` events.
- **Drill:** rehearse pause + rotation on testnet until it's boring.

### Open contract questions — resolved 2026-09-18 (Andrew)
1. **Unclaimed community supply.** SUPERSEDED: Andrew decided claims stay
   open until everything is claimed out — keep promoting, no burn, no
   auto-close. (Old recommendation was leaving them unminted forever.)
2. **Token ID ordering.** Run holder batches first → holders get IDs 0–499
   (low IDs are a natural perk for MDOG supporters). **Shuffle the metadata
   manifest** so art assignment is fair, publish the manifest hash before any
   mint.
3. **Royalty.** LOCKED 2026-09-18: **10%** to the project multisig. That is
   the max most marketplaces honor; the contract enforces a 1000 bps ceiling.
   Enforcement on Robinhood Chain marketplaces is unknown — treat it as a
   request, not a guarantee.
4. **Reveal.** LOCKED 2026-09-18: **immediate reveal** — baseURI is set at
   deploy with the final metadata, art visible from the first mint. No
   placeholder/mystery phase. (Old proposal was delayed reveal; dropped.)
5. **Metadata hosting.** ~500 images ≈ ~50MB. IPFS (needs a pinning
   provider — paid, decision needed) or Arweave (one-time fee). baseURI is
   settable post-deploy, so this doesn't block deployment — but the freeze is
   the point of no return. Decide before freeze, not before deploy.
6. **Multisig on 4663.** "2-of-3 Safe" is assumed but **not verified** on
   Robinhood Chain. Check Blockscout for canonical Safe singletons / the
   safe.global chain list. Fallback: deploy the audited Safe contracts
   deterministically — never roll a custom multisig.
7. **Name/symbol.** LOCKED 2026-09-18: **"Muse Dogs" / "MUSEDOGS"**. The
   EIP-712 domain includes the name — it is baked into the contract now
   (changing it = redeploy). Contracts, API, site, and docs all updated.
8. **Edition structure.** No rarity tiers: flat metadata for all 500 tokens
   (same attribute structure, each with its unique art). Exact trait
   assignment after Andrew's art picks, not before.

---

## 3. How to mint it — phased runbook

### Phase 0 — Art (GATING EVERYTHING)
Andrew picks favorites + colors from the 400 → final high-res renders (PNG,
not the webp samples) → build the 500-row manifest (tokenId → concept,
color, background, rarity, image CID; **shuffled**) → upload to IPFS/Arweave
→ publish manifest hash. **No mint happens before this.**

### Phase 1 — Testnet rehearsal (chain 46630)
- RPC: `https://rpc.testnet.chain.robinhood.com`,
  faucet: `faucet.testnet.chain.robinhood.com`,
  explorer: `explorer.testnet.chain.robinhood.com`.
- Full dry run: deploy → 5× holder batches → voucher claims (via relayer AND
  self-submit) → pause/unpause → signer rotation → reserve mint → royalty set
  → baseURI set → freeze. Rehearse the multisig signing flow too.
- Measure: relayer gas per claim (costing), batch gas, voucher expiry timing.

### Phase 2 — Review + mainnet deploy ceremony
- Independent Solidity + app-security reviews (still pending — do not skip).
- Deploy to 4663, then `transferOwnership(multisig)` (cleaner than deploying
  from the multisig directly). Verify source on Blockscout. Set placeholder
  baseURI. Publish the address everywhere (site verify page, well-known file,
  musebook, X). Never ask anyone for a seed phrase or private key — the
  ceremony is multisig-signed.

### Phase 3 — Backend production
Postgres cutover (fail-closed 503, never silent JSON fallback), voucher
idempotency fix, shared rate limiter, signer live, monitoring (API health,
issuance-rate alerts, RPC agreement, claim-tx success rate).

### Phase 4 — Registration window
Whitelist frozen **before** the announcement (cutoff/minimum/founder exception
— Andrew's pending call). Announce. Registrations open.

### Phase 5 — Holder airdrops (380)
Close registration → snapshot → **recheck each address immediately before
its batch** using the same dual-source $10 logic (380 addrs × 2 RPCs, cheap).
4× `holderMintBatch` via multisig, publish receipts per batch. v1 rule:
ERC-20 MDOG balance only — MDOG inside LP positions doesn't count (say this
on the site so LPs aren't surprised). Price-move tolerance between recheck
and landing is small on a 100ms chain; keep check→submit→confirm tight per
batch.

### Phase 6 — Community claim window (100)
API issues short-expiry vouchers → relayer submits (primary), self-submit
documented (fallback) → monitor. LOCKED 2026-09-18: claims stay open until
claimed out — no window close, no burn, no auto-close; keep promoting until
all 100 are gone (per §2).

### Phase 7 — Reserve, launch, closeout
Mikey's 1 from reserve + prizes/waitlist → launch with final metadata
(immediate reveal: art visible from the first mint) → `freezeMetadata()` →
royalty set → public post-mortem with receipts.

---

## 4. Decisions Andrew must make

1. Vouchers vs Merkle → rec: **keep vouchers**.
2. Claim relayer (project-sponsored gas) → rec: **yes**.
3. Royalty % + receiver → **locked: 10% to the project multisig** (max most marketplaces honor).
4. Edition/rarity structure → **no rarity tiers**: flat metadata for all 500; trait assignment after art picks.
5. Metadata hosting (IPFS pinner / Arweave).
6. Unclaimed supply → rec: **leave unminted**.
7. Whitelist cutoff / minimum / founder exception → **locked: muse identity created strictly before 2026-09-20, 10+ posts, all 25 founding muses auto-in.**
8. Registration close, snapshot, claim window, reserve sunset dates → **TBA**.
9. Two independent RPC providers.
10. Voucher signer custody (env vs KMS) + HASH_SALT custody.
11. Final collection name/symbol.
12. The 3 multisig signers.

## 5. Honesty notes (never claim)
- Not "audited", "hardened", or "reviewed" until the reviews actually happen.
- The homepage fee card is about **MDOG/ETH pool trading fees**, not NFT
  royalties — keep them separate in every public sentence.
- "Verified Musebook identities only": cryptography proves control of the
  identity key, not that no human operates it.
- Royalties are a norm signal; enforcement on Robinhood Chain marketplaces is
  unproven.

## 6. Build status — 2026-09-18/19 (local only, no deployment)

The sponsored-mint path Andrew approved is built and tested locally. Nothing
has been deployed; no testnet or mainnet transactions have been sent.

**Built:**
- `api/lib/voucher.js` — real EIP-712 sign/verify for
  `ClaimVoucher(address claimant,uint256 nonce,uint256 expiresAt)`, domain
  `MuseDog`/`1`. All errors are `Error` instances with machine-readable `code`.
- `api/lib/relayer.js` — `Relayer` (init, on-chain signer read, preflight,
  submit with gas estimate + 20% buffer, receipt polling, `CommunityClaimed`
  token-id extraction) and `ClaimQueue` (serial, idempotent by voucher nonce,
  3-attempt retry on non-terminal failures, crash recovery, JSON persistence).
- `POST /api/v1/community-voucher` — real signing; fails closed without
  `VOUCHER_SIGNER_KEY` or a deployed contract; response now includes the exact
  `claim_calldata` for self-submit.
- `POST /api/v1/claim/submit` + `GET /api/v1/claim/status/:job_id` (+ `duplicate`
  flag) and `GET /api/v1/mint/stats` (live claims-remaining counter).
- `site/mint.html` + `site/app.js` `initMintPage()` — voucher fetch, facts
  table shown before anything is sent, relayer submit with job polling,
  permanent self-submit panel (calldata + copy buttons + cast command), and the
  four mint states: upcoming / open / paused / complete.
- Copy everywhere now reads "verified Musebook identities only."

**Tested (all passing):**
- `node test-claim-flow.js` — 11 unit tests (sign/verify round-trip, tamper,
  wrong chain, malformed sig, shape validation, expiry, calldata
  encode/decode + selector `0x2ada8a32`, queue idempotency, confirm path,
  terminal-failure fast-fail, transient retry).
- `TEST_MODE=1 node smoke.js` — 28 smoke tests, incl. real EIP-712 voucher
  issuance (throwaway test key).
- `node e2e-claim-anvil.js` — 13 end-to-end checks on a local Anvil chain:
  deploy, preflight, relayer submit → token #0 to claimant, NONCE_CONSUMED /
  VOUCHER_EXPIRED / BAD_VOUCHER_SIGNATURE negatives, HTTP voucher issuance
  with signature recovery check, HTTP claim → token #1, duplicate-submit
  idempotency, live counter 450 → 448 (on the earlier 1,000-split build).

**Still required before production:** full testnet rehearsal, independent
Solidity + appsec review, production Postgres (race-safe voucher cap,
idempotency, shared rate limiter), real KMS key custody, two RPC providers,
final metadata/royalty decisions, multisig signer set, and the whitelist rules.

---

## Addendum — 2026-09-18: final supply locked at 500

Andrew locked the collection at **500 total = 380 holder airdrops + 100 community free-mint claims + 20 reserve**.

Path here: the build started at 1,000 (500/450/50). He floated 333 (220/100/13) and asked to tighten to best-of-best art with a strict pose lock, then reversed to **500 total, 20 reserve**, and confirmed the split **380/100/20** — keeping 100 free community mints and 20 reserve, with the remainder going to holder airdrops.

Changes applied locally (nothing deployed):
- Contract: `MAX_SUPPLY = 500`, `HOLDER_CAP = 380`, `COMMUNITY_CAP = 120`, `RESERVE_MAX = 20`, `COMMUNITY_CLAIM_MAX = 100`. Nat-spec and comments updated; royalty logic untouched.
- Forge tests re-parameterized (holder fill = 3×100+80, claims fill = 100, reserve fill = 20, totals = 500). **23/23 pass.**
- API: `VOUCHER_CAP = 100`; well-known + mint/stats supply blocks; draw lottery `--winners 100`; copy and docs updated.
- Site: stat blocks, verify/api/mint pages, app.js copy all reflect 380/100/20; `site-preview.html` rebuilt.
- Full suite re-run on fresh local Anvil: forge 23/23, claim-flow unit 11/11, API smoke 28/28, E2E 20/20 — on-chain `communityClaimsRemaining()` reads **100** after deploy.

Historical note: earlier test evidence recorded against the 1,000-split build (e.g. "live counter 450 → 448") stays in the log above as a dated record; it does not describe the current build.

---

## Addendum — 2026-09-18: Andrew's locked decisions

Andrew answered the open questions (all applied locally, nothing deployed):

1. **Name/symbol:** **Muse Dogs** / **MUSEDOGS**. Contract `ERC721("Muse Dogs", "MUSEDOGS")`, EIP-712 domain `("Muse Dogs", "1")` — contract, API `lib/voucher.js` domain, site copy, and docs all updated. (Contract *code* identifier stays `MuseDog`; only the on-chain name/symbol/domain changed.)
2. **Royalty:** **10%** to the project multisig. That is the max most marketplaces honor; the contract enforces a 1000 bps ceiling, so this sits exactly at the cap. Constructor/tests now use 1000 bps.
3. **Art storage:** Andrew chose **Arweave** (locked 2026-09-18) over fully-on-chain — storing 500 full-resolution images on-chain is not practical (storage gas would cost a fortune). Arweave is pay-once, stored forever. Full plan in `storage-plan-arweave.md`: Bundlr/Irys bundle upload of 500 images + 500 metadata JSONs, one Arweave path manifest, `baseURI` = `https://arweave.net/<manifest-txid>/` set via `setBaseURI` after upload is verified (immediate reveal means the upload must complete before mint opens), `freezeMetadata()` only after the collection is done minting out. No uploads yet — Andrew's art picks and the 500-row token manifest come first.
4. **Reveal:** **immediate** — art visible from the first mint. No delayed-reveal placeholder phase anywhere in the code.
5. **Leftover supply:** claims stay **open until claimed out** — keep promoting, no burn, no auto-close. No expiry logic in the contract or API closes a mint window early (vouchers have individual short expiries, but the windows themselves never auto-close).
6. **Whitelist:** muse identity created strictly before **2026-09-20** + **10+ posts** + **all 25 founding muses auto-in** (`api/scripts/build-whitelist.js` docs updated).
7. **Dates:** TBA (placeholders in config, e.g. `CURRENT_PHASE=rules-locked`).
8. **Multisig:** Andrew will ask friends to be signers. He asked whether this uses SAFE — the plan is a Safe 2-of-3, but Safe on Robinhood Chain (4663) is **not yet verified**; verification is still on the pre-deploy checklist (§2 item 6 above). No signers named yet.
9. **Rarity:** **no rarity tiers** — flat metadata for all 500 tokens (same attribute structure, unique art per token). There was never any rarity-weighting/tier code to remove; none exists in the build.

## Addendum — 2026-09-18: site redesign (Andrew's direction)

- **Theme:** **light** — Andrew reviewed the dark preview and rejected it ("why is it dark, I don't want it dark"). Site rebuilt with a musebook.lol-inspired light theme: warm paper background (#fbfaf7), dark ink text, lantern-amber accent (#8f5e17), Georgia serif headlines, hairline borders, soft white cards, generous whitespace.
- **Art hidden:** Andrew asked to **not show the art yet**. All concept-art images removed from the site (hero, 4 gallery thumbnails, header logo dog photo, mint page side photo). Hero now has a dashed placeholder card ("Art reveals at launch"); the gallery section is 4 numbered placeholder tiles (001–004, "Revealed at launch"). The art image files were moved out of `site/` into `art-hidden/` so a future deploy cannot leak them. Section copy now reads "Art stays hidden until launch day."
- **Second pass:** Andrew then asked for the UI to look like **musebook.lol** (fetched 2026-09-18: "a kinder internet lives here" — warm, lantern-lit, thoughtful) and **VERY sleek, VERY minimal**: CTA band de-boxed to a simple divider band, stat numbers in serif, primary buttons white-on-amber, code blocks light. Less is more.
- Preview rebuilt: `site-preview.html` (25 KB, self-contained, zero image/data URIs). All content, copy, sections, phase banner, and inner pages (register/mint/verify/api) preserved.
