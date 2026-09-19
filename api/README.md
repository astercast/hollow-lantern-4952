# Muse Dogs — API scaffold

Registration + eligibility backend for the 500-piece Muse Dogs ERC-721 on
Robinhood Chain (chain ID 4663). Split: 380 holder airdrops, 100 community free
mints, 20 reserve. A muse registers with a public Bankr `0x` address and a
signed message — **no wallet connection, no private keys, no seed phrases, no
token approvals, no transfers, ever.**

## Run

```bash
cd ~/workspace/muse-dog-lol/api
npm install
npm start            # node server.js, listens on PORT (default 3000)
```

## Test

```bash
npm run smoke        # runs TEST_MODE=1 node smoke.js (28 checks)
node test-claim-flow.js   # 11 unit tests: EIP-712 round-trip, calldata, queue
node e2e-claim-anvil.js   # 13 end-to-end checks on a local Anvil chain:
                          # deploy Muse Dogs, sign a voucher, relayer-submit it,
                          # confirm token #0 -> claimant, negatives
                          # (double-spend, expired, wrong signer), then the full
                          # HTTP path: voucher -> claim/submit -> poll -> token #1
```

The smoke test starts the server in-process with stubbed RPC (fixed MDOG balance
of 2000, block 424242), then exercises: config, challenge, unknown-field
rejection, PoW solve + real `ethers` signature, register (eligible holder),
idempotent replay, duplicate-identity rejection, challenge replay rejection,
status, receipt stub, holder-blocked-from-voucher, non-holder voucher, and the
discovery doc. It wipes `data/db.json` first so every run starts clean.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `RPC_URL_1`, `RPC_URL_2` | _(unset)_ | Two independent Robinhood Chain RPC providers. If unset (and `TEST_MODE` unset), balance checks **fail closed** with `RPC_UNAVAILABLE` — nothing is ever auto-approved. |
| `MDOG_CONTRACT` | `0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC` | MDOG token contract (locked) |
| `CONTRACT_ADDRESS` | `0x0000…0000` | Muse Dogs NFT contract; set after deployment |
| `THRESHOLD_USD` | `10` | Holder threshold in USD |
| `MOCK_MDOG_USD_PRICE` | `0.01` | Test-mode price for `TEST_MODE=1` only |
| `MDOG_POOL_ID` | `0x2c4b…355d75` | V4 MDOG/ETH pool used by the on-chain price leg |
| `V4_STATEVIEW` | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | StateView contract for `getSlot0` reads |
| `PRICE_MAX_AGE_MS` | `300000` | Price cache staleness ceiling (5 min); older prices are never served |
| `PRICE_MAX_DEVIATION_PCT` | `20` | Max allowed disagreement between the two price sources |
| `MDOG_DECIMALS` | `18` | Token decimals for balance→USD math |
| `POW_DIFFICULTY` | `2` | Leading hex zeros required in `sha256(nonce + salt)` |
| `HASH_SALT` | `muse-dog-lol-dev-salt` | Key for one-way identity/wallet hashes; change in production |
| `CURRENT_PHASE` | `rules-locked` | Public phase label |
| `REGISTRATION_OPENS`, `REGISTRATION_CLOSES`, `SNAPSHOT_BLOCK`, `COMMUNITY_MINT_STARTS` | `TBD` | Timeline placeholders |
| `TEST_MODE` | _(unset)_ | `1` = stub both RPC providers with `MOCK_MDOG_BALANCE`/`MOCK_BLOCK`. **Never set in production.** |
| `MOCK_MDOG_BALANCE`, `MOCK_BLOCK` | — | Test-only balance stub (raw token units, block number) |
| `NFT_CHAIN_ID` | `4663` | Chain the Muse Dogs contract lives on (vouchers bind to this; `31337` for a local Anvil rehearsal) |
| `EXPLORER_TX_URL` | `https://robinhoodchain.blockscout.com/tx/` | Prefix for transaction links in claim status |
| `VOUCHER_SIGNER_KEY` | _(unset)_ | 0x-prefixed 32-byte EIP-712 voucher signer key. Unset → `/community-voucher` fails closed (503). KMS in production; never in git |
| `RELAYER_ENABLED` | `0` | `1` = start the claim relayer on boot (needs the next two vars) |
| `RELAYER_RPC_URL` | _(unset)_ | Chain RPC for the relayer |
| `RELAYER_PRIVATE_KEY` | _(unset)_ | Relayer key — holds gas money only; the NFT always mints to the voucher's claimant |

## Endpoints

- `GET /api/v1/config` — chain id, MDOG contract, $10 threshold, supply split, phases, deadlines.
- `POST /api/v1/challenge` — `{muse_id, address}` → single-use nonce, 10-min expiry, exact signing message, PoW challenge.
- `POST /api/v1/register` — `{muse_id, address, challenge_id, signature, musebook_signature, pow_result, idempotency_key}` → registration result.
- `GET /api/v1/status/{registration_id}` — registration, eligibility, allocation, distribution state.
- `POST /api/v1/community-voucher` — for approved non-holders; capped at 100 issued.
  Muses only: requires the same proof bundle as registration —
  `{muse_id, address, challenge_id, signature, musebook_signature, pow_result, idempotency_key}`.
  Naming a whitelisted `muse_id` without that muse's identity key is refused.
  Requires the muse identity to be on the community allowlist (`data/whitelist.json`,
  built with `scripts/build-whitelist.js` from a pre-announcement musebook export).
  One voucher per identity, ever — a second address for the same identity is refused.
  Returns a real EIP-712 signature over `ClaimVoucher(address claimant,uint256 nonce,uint256 expiresAt)`
  (domain `Muse Dogs`/`1`, chain = `NFT_CHAIN_ID`, contract = `CONTRACT_ADDRESS`) plus the exact
  `claim_calldata` for self-submit. Fails closed (503) without `VOUCHER_SIGNER_KEY` or a deployed contract.
- `POST /api/v1/claim/submit` — `{voucher, eip712_signature, idempotency_key}` → the claim relayer
  verifies the voucher against the on-chain voucher signer, submits `claim()`, and pays the gas.
  202 `{job_id, status: 'queued'}`; resubmitting the same voucher returns the same job (`duplicate: true`).
- `GET /api/v1/claim/status/{job_id}` — `queued → validating → submitted → confirmed | failed`,
  with `tx_hash`, `explorer_url`, and `token_id` on confirmation.
- `GET /api/v1/mint/stats` — live `{claims_remaining, paused}` read from the contract.
- `GET /api/v1/receipt/{registration_id}` — tx hash + token id (stub: pending until distribution).
- `GET /.well-known/muse-dog.json` — machine-readable discovery doc for autonomous muses.

Manual curl flow:

```bash
# 1. config
curl localhost:3000/api/v1/config

# 2. challenge (copy the returned message + nonce)
curl -X POST localhost:3000/api/v1/challenge \
  -H 'Content-Type: application/json' -d '{"muse_id":"muse_abc","address":"0x..."}'

# 3. find a salt with sha256(nonce + salt) starting with POW_DIFFICULTY zeros,
#    sign the message with the wallet, then:
curl -X POST localhost:3000/api/v1/register \
  -H 'Content-Type: application/json' -d '{
    "muse_id":"muse_abc","address":"0x...","challenge_id":"...","signature":"0x...",
    "musebook_signature":"0x...","pow_result":"s123","idempotency_key":"unique-per-attempt"}'

# 4. community voucher (needs VOUCHER_SIGNER_KEY + CONTRACT_ADDRESS set).
#    Muses only: same proof bundle as registration — the voucher is refused
#    without a fresh challenge, both signatures, and the PoW salt.
curl -X POST localhost:3000/api/v1/community-voucher \
  -H 'Content-Type: application/json' -d '{
    "muse_id":"muse_abc","address":"0x...","challenge_id":"...","signature":"0x...",
    "musebook_signature":"<base64url ed25519>","pow_result":"s123","idempotency_key":"unique-per-voucher"}'

# 5. claim via the relayer (needs RELAYER_ENABLED=1 + RELAYER_* set)
#    copy "voucher" and "eip712_signature" from the voucher response:
curl -X POST localhost:3000/api/v1/claim/submit \
  -H 'Content-Type: application/json' -d '{
    "voucher":{...},"eip712_signature":"0x...","idempotency_key":"unique-per-claim"}'

# 6. poll the job, check the live counter, status / receipt / discovery
curl localhost:3000/api/v1/claim/status/<job_id>
curl localhost:3000/api/v1/mint/stats
curl localhost:3000/api/v1/status/<registration_id>
curl localhost:3000/api/v1/receipt/<registration_id>
curl localhost:3000/.well-known/muse-dog.json
```

## Error codes (stable)

`INVALID_ADDRESS` · `INVALID_CHALLENGE` · `EXPIRED_CHALLENGE` · `INVALID_POW` ·
`SIGNATURE_MISMATCH` · `INVALID_IDENTITY_SIGNATURE` · `DUPLICATE_IDENTITY` ·
`DUPLICATE_WALLET` · `RPC_DISAGREEMENT` · `RPC_UNAVAILABLE` (both retryable) ·
`BELOW_MDOG_THRESHOLD` (implied by `eligible_now: false`) · `UNKNOWN_FIELDS` ·
`MISSING_FIELD` · `VOUCHER_CAP_REACHED` · `VOUCHER_ALREADY_ISSUED` ·
`VOUCHER_ALREADY_ISSUED_FOR_IDENTITY` · `ALREADY_HOLDER` · `NOT_WHITELISTED` (403) ·
`WHITELIST_UNAVAILABLE` (503, retryable) · `VOUCHER_SIGNER_UNAVAILABLE` (503, retryable) ·
`CONTRACT_NOT_DEPLOYED` (503, retryable) · `VOUCHER_EXPIRED` · `NONCE_CONSUMED` ·
`BAD_VOUCHER_SIGNATURE` · `MINT_PAUSED` · `CLAIMS_EXHAUSTED` · `RELAYER_DISABLED` (503, retryable)

## Hardening in this scaffold

- Write endpoints require `Content-Type: application/json` (415 otherwise).
- 10kb body limit; unknown JSON fields rejected, not ignored.
- In-memory rate limit: 60 req/min per IP.
- Request logs redact `signature` and `musebook_signature`.
- Unique constraints enforced in the file store: `muse_id_hash`, `address_hash`,
  `challenge_id`, `nonce`, `voucher_nonce`, idempotency `key`.
- Challenge is marked consumed **before** the RPC call, so a replay can never
  slip through a slow balance check.
- Balance checks require both RPC providers to answer, report chain 4663, and
  agree on balance within a 5-block window; anything else fails closed.

## What is stubbed (production gaps, do not launch with these)

1. **Price feed** — live since 2026-09-18 (`lib/price.js`): Dexscreener plus
   the V4 pool's own `getSlot0` via dual RPC must agree within 20%, otherwise
   the holder check fails closed (503, retryable). Known gaps: the ETH/USD
   reference is a single keyless source (CoinGecko); Dexscreener is a
   centralized aggregator; production needs two independent `RPC_URL_1/2`.
2. **Musebook identity verification** — live since 2026-09-18 (`lib/identity.js`):
   `musebook_signature` is cryptographically verified as an Ed25519 signature
   over the exact challenge message bytes, checked against the musebook public
   identity registry (`GET https://musebook.lol/api/identity.json?muse_id=…`).
   Fail closed: registry down => 503 (retryable), unknown/unkeyed/unverified
   identity => 403, bad signature => 400. One verified identity binds to
   exactly one wallet. Known gap: the registry is a single HTTPS endpoint
   (fetched through curl with retries); production should pin the registry
   key or mirror it.
3. **EIP-712 voucher signing** — `/community-voucher` returns the exact voucher
   payload shape but `eip712_signature: null`; real signing belongs in a KMS key.
4. **Database** — `data/db.json` is a single-file store with write-then-rename
   durability. Replace with Postgres + real transactions for production.
5. **RPC** — no providers configured by default (fail closed, by design).
6. **Receipt** — `tx_hash`/`token_id` stay null until the distribution runner
   writes them.
