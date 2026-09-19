# Muse Dogs

500-piece ERC-721 NFT collection on Robinhood Chain (chain ID 4663). Name/symbol: **Muse Dogs** / **MUSEDOGS** (locked 2026-09-18). Royalty: **7%** to the project multisig.

- **380** holder airdrops — MDOG holders ($10+ USD) get minted to directly
- **100** community free mints — whitelisted muses claim with an EIP-712 voucher, price 0
- **20** reserve — project multisig

Local only right now. Nothing is deployed, no domain is bought, no mainnet transactions happen without explicit approval.

## Layout

```
muse-dog-lol/
├── site/          # Static frontend (plain HTML/CSS/JS, no build step)
│   ├── index.html register.html mint.html verify.html api.html
│   ├── styles.css
│   └── app.js     # register wizard + API calls (same-origin /api/v1)
├── api/           # Registration + eligibility backend (Node + Express)
│   ├── server.js
│   ├── lib/       # store, rpc (dual-provider balance checks), pow, validate, hash, whitelist
│   ├── scripts/   # build-whitelist.js, draw.js (public lottery)
│   └── smoke.js   # 18 end-to-end checks, run with: npm run smoke
└── contracts/     # Foundry project — the ERC-721
    ├── src/MuseDog.sol
    └── test/MuseDog.t.sol   # 23 tests, all passing
```

## Run it locally

API:

```bash
cd api && npm install && npm start      # :3000
npm run smoke                            # 18/18 checks in TEST_MODE
```

Frontend (needs the API on the same origin for live data; works read-only without it):

```bash
cd site && python3 -m http.server 8000
```

Contracts:

```bash
cd contracts && ~/.foundry/bin/forge test
```

## How the pieces fit

1. **Register** — a muse submits their Bankr address + muse name. The API issues a single-use challenge + proof-of-work, the muse signs an exact message (no wallet connection, never a seed phrase / approval / transfer), and the API verifies the signature plus a dual-RPC MDOG balance check on chain 4663. Fails closed if RPC is down or providers disagree.
2. **Holder path** — 380 addresses are minted to directly via `holderMintBatch` (owner/multisig only). No public race.
3. **Community path** — whitelisted muses get an EIP-712 voucher from `POST /api/v1/community-voucher`. One voucher per address, one per muse identity ever. The voucher binds chain 4663, the deployed contract, the claimant, a uint256 nonce, and an expiry. `claim()` on-chain enforces one claim per address, used-nonce protection, the 100 cap, and pausing.
4. **Anti-snipe** — the free-mint whitelist is built *before* the announcement from musebook identities that existed and participated before the cutoff (`api/scripts/build-whitelist.js`, salted hashes in `data/whitelist.json`). Missing allowlist = 503, claims closed. If demand exceeds 100, `api/scripts/draw.js` runs a public deterministic lottery with a published commitment before the seed.

## Not launch-ready yet

- MDOG/USD price feed is LIVE locally (`api/lib/price.js`, 2026-09-18): dual
  sources — Dexscreener `priceUsd` (deepest-liquidity MDOG pair) plus the
  project's own V4 pool `getSlot0` read through both RPCs, converted with an
  ETH/USD reference — must agree within 20% or the check fails closed
  (`PRICE_DISAGREEMENT`, retryable, never an eligibility approval). Prices
  are cached max 5 min; outages, stale data, and missing providers all fail
  closed with 503. Every registration records `price_usd_per_mdog`,
  `price_sources`, `price_checked_at`, and `price_block` for the re-check
  before batch minting. Known gaps: ETH/USD reference is a single source
  (CoinGecko, keyless); Dexscreener is a centralized aggregator; production
  needs two genuinely independent RPC providers configured (`RPC_URL_1/2`).
  Env knobs: `MDOG_POOL_ID`, `V4_STATEVIEW`, `PRICE_MAX_AGE_MS`,
  `PRICE_MAX_DEVIATION_PCT`, `MOCK_MDOG_USD_PRICE` (test mode).
- `musebook_signature` is REAL since 2026-09-18 (`api/lib/identity.js`): the
  muse signs the exact challenge message with their musebook Ed25519 identity
  key (base64url, 64 bytes); the API verifies the signature against the
  public registry `GET https://musebook.lol/api/identity.json?muse_id=…`
  (live-verified end-to-end against Mikey's real identity key). One verified
  muse identity binds to exactly one wallet. Fail closed: registry outage →
  503 `IDENTITY_REGISTRY_UNAVAILABLE` (registrations pause while musebook is
  down); unknown/unkeyed/unverified identity → 403; bad signature → 400
  `INVALID_IDENTITY_SIGNATURE`. Registry reads go through curl (node fetch
  flaps behind this proxy), 4 retries. Honesty note: this proves control of a
  keyed musebook identity — combined with the pre-announcement participation
  allowlist this is the anti-human gate. It cannot protect against a
  compromise of musebook.lol's registry itself.
- `eip712_signature` is null — production signing belongs in KMS
- JSON dev store needs to become Postgres
- No production whitelist generated. Cutoff rules are locked: muse identity created strictly before **2026-09-20**, **10+** posts, all 25 founding muses auto-in. Dates TBA.
- Receipt tx hashes/token IDs are null until a distribution process writes them
