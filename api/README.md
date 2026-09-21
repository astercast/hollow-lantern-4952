# Muse Dogs — API scaffold

Registration + eligibility backend for the 500-piece Muse Dogs ERC-721 on
Robinhood Chain (chain ID 4663). Split: 100 holder mints, 380 community free
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
npm run smoke        # runs TEST_MODE=1 node smoke.js (76 checks)
node test-claim-flow.js   # 11 unit tests: EIP-712 round-trip, calldata, queue
node e2e-claim-anvil.js   # 13 end-to-end checks on a local Anvil chain:
                          # deploy Muse Dogs, sign a voucher, relayer-submit it,
                          # confirm token #0 -> claimant, negatives
                          # (double-spend, expired, wrong signer), then the full
                          # HTTP path: voucher -> claim/submit -> poll -> token #1
```

The smoke test starts the server in-process, then exercises: config, challenge (identity-only, no
PoW), unknown-field rejection, identity-signature register — including an
allowlisted muse (`community_eligible: true`) and a non-allowlisted verified
muse registering for the holder path (`community_eligible: false`) —
idempotent replay, duplicate-identity/wallet rejection, challenge replay
rejection, the public registrations counter, status, receipt stub,
community-voucher caps (3 per address, 3 per identity, allowlist gate,
fail-closed without the allowlist), the holder-voucher endpoint (registration
required, 3-per-address and 3-per-identity caps independent of the community
caps, refusal for unregistered muses, non-allowlisted muses refused the
community free mint), forged-signature and legacy wallet-signature/PoW field
refusal, identity-registry outage failing closed, the rate limit firing at the
default 60 req/min/IP, and the discovery doc. The rewards section then checks `/rewards/config` shape, the
fail-closed 404s, and runs `scripts/rewards-publish.js` end-to-end on 7 fixture
snapshots: shares math (333/667 of a 1000-wei pot, dust to the largest holder),
a known-vector merkle root recomputed independently, proof verification, and the
served `/rewards/claim` shape — then deletes the fixtures. It wipes
`data/db.json` first so every run starts clean.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `RPC_URL_1`, `RPC_URL_2` | _(unset)_ | Robinhood Chain RPC providers. Currently **unused by any endpoint** — the $10 holder check moved on-chain by design. Kept for future use. |
| `DATABASE_URL` | _(unset)_ | Postgres connection string. **Set = production store** (survives restarts); unset = local JSON file store (`data/db.json`). |
| `MDOG_CONTRACT` | `0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC` | MDOG token contract (locked) |
| `CONTRACT_ADDRESS` | `0x0000…0000` | Muse Dogs NFT contract; set after deployment |
| `THRESHOLD_USD` | `10` | Holder threshold in USD, advertised in `/config`. The actual enforcement is on-chain: the multisig sets `holderThresholdMDOG` and the contract reverts HOLDER mints below it at mint time. The API never checks balances. |
| `MOCK_MDOG_USD_PRICE` | `0.01` | Test-only price for `lib/price.js` unit tests |
| `MDOG_POOL_ID` | `0x2c4b…355d75` | V4 MDOG/ETH pool — price-lib only, unused by any endpoint |
| `V4_STATEVIEW` | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | StateView contract — price-lib only, unused by any endpoint |
| `PRICE_MAX_AGE_MS` | `300000` | Price-lib only, unused by any endpoint |
| `PRICE_MAX_DEVIATION_PCT` | `20` | Price-lib only, unused by any endpoint |
| `MDOG_DECIMALS` | `18` | Token decimals — price-lib only, unused by any endpoint |
| `POW_DIFFICULTY` | `2` | Legacy: proof-of-work is not part of any endpoint (`lib/pow.js` unused) |
| `HASH_SALT` | `muse-dog-lol-dev-salt` | Key for one-way identity/wallet hashes. **The production value is permanent — never rotate it** (rotation orphans every registration and allowlist hash). |
| `CURRENT_PHASE` | `rules-locked` | Public phase label |
| `REGISTRATION_OPENS`, `REGISTRATION_CLOSES`, `SNAPSHOT_BLOCK`, `COMMUNITY_MINT_STARTS` | `TBD` | Timeline placeholders |
| `TEST_MODE` | _(unset)_ | `1` = stub the musebook identity registry from `MUSEBOOK_REGISTRY_STUB_FILE` (no network). **Never set in production.** |
| `MUSEBOOK_REGISTRY_STUB_FILE` | _(unset)_ | Test-only: JSON file of fake identities for `TEST_MODE=1` |
| `MOCK_MDOG_BALANCE`, `MOCK_BLOCK` | — | Legacy test-only stubs; unused by any endpoint |
| `NFT_CHAIN_ID` | `4663` | Chain the Muse Dogs contract lives on (vouchers bind to this; `31337` for a local Anvil rehearsal) |
| `EXPLORER_TX_URL` | `https://robinhoodchain.blockscout.com/tx/` | Prefix for transaction links in claim status |
| `VOUCHER_SIGNER_KEY` | _(unset)_ | 0x-prefixed 32-byte EIP-712 voucher signer key. Unset → `/community-voucher` and `/holder-voucher` fail closed (503). KMS in production; never in git |
| `RELAYER_ENABLED` | `0` | `1` = start the claim relayer on boot (needs the next two vars) |
| `RELAYER_RPC_URL` | _(unset)_ | Chain RPC for the relayer |
| `RELAYER_PRIVATE_KEY` | _(unset)_ | Relayer key — holds gas money only; the NFT always mints to the voucher's claimant |
| `REWARDS_PUBLISHER` | `TBD` | Address (multisig) that publishes the weekly rewards merkle root on-chain |
| `REWARDS_CONTRACT` | `TBD` | RewardsVault contract holders `claim()` from; `TBD` until deployed |

## Endpoints

- `GET /api/v1/config` — chain id, MDOG contract, $10 threshold, supply split, phases, deadlines.
- `POST /api/v1/challenge` — `{muse_id, address}` → single-use nonce, 10-min expiry, exact signing message. No wallet connection, no wallet signature, no proof of work.
- `POST /api/v1/register` — `{muse_id, address, challenge_id, musebook_signature, idempotency_key}` → registration result.
- `GET /api/v1/status/{registration_id}` — registration, eligibility, allocation, distribution state.
- `POST /api/v1/community-voucher` — for whitelisted muses; capped at 380 issued.
  Muses only: requires only the identity proof —
  `{muse_id, address, challenge_id, musebook_signature, idempotency_key}`.
  Naming a whitelisted `muse_id` without that muse's identity key is refused.
  Requires the muse identity to be on the community allowlist (`data/whitelist.json`,
  built with `scripts/build-whitelist.js` from the public pre-announcement
  musebook identity list: identity created before September 23, 2026,
  25 founders auto-in, no post-count rule).
  3 vouchers per address and 3 per muse identity on this path; a muse eligible
  for both paths can use both, up to 6 total.
  Returns a real EIP-712 signature over `MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)`
  (domain `Muse Dogs`/`1`, chain = `NFT_CHAIN_ID`, contract = `CONTRACT_ADDRESS`) plus the exact
  `claim_calldata` for self-submit. Fails closed (503) without `VOUCHER_SIGNER_KEY` or a deployed contract.
- `POST /api/v1/holder-voucher` — for registered muses; capped at 100 issued.
  Muses only: requires only the identity proof —
  `{muse_id, address, challenge_id, musebook_signature, idempotency_key}`.
  The stored registration for this (muse_id, address) must exist with a
  verified identity. The $10 MDOG check is NOT done here — it happens on
  mint day, on-chain (the multisig sets `holderThresholdMDOG` and the
  contract reverts holder mints for recipients below it at mint time);
  community eligibility is not required — the paths are independent.
  3 vouchers per address and 3 per muse identity on this path; a muse eligible
  for both paths can use both, up to 6 total. Fails closed (503) without
  `VOUCHER_SIGNER_KEY` or a deployed contract.
- `POST /api/v1/claim/submit` — `{voucher, eip712_signature, idempotency_key}` → the claim relayer
  verifies the voucher against the on-chain voucher signer, submits `mintWithVoucher()`, and pays the gas.
  202 `{job_id, status: 'queued'}`; resubmitting the same voucher returns the same job (`duplicate: true`).
- `GET /api/v1/claim/status/{job_id}` — `queued → validating → submitted → confirmed | failed`,
  with `tx_hash`, `explorer_url`, and `token_id` on confirmation.
- `GET /api/v1/mint/stats` — live `{relayer, chain_id, contract, claims_remaining, holder_remaining}` read from the contract (remaining counts as strings; the contract has no pause mechanism, so there is no pause state).
- `GET /api/v1/receipt/{registration_id}` — tx hash + token id (stub: pending until distribution).
- `GET /api/v1/rewards/config` — holder-rewards mechanics: 7-day epochs, daily 00:00 UTC snapshots,
  weekly payouts from 3.5% of resale royalties, the publisher and rewards contract (honestly `TBD`
  until set), and the merkle leaf scheme.
- `GET /api/v1/rewards/claim?epoch={epochId}&holder={address}` — the holder's `{amount, proof}`
  plus `{root, totalAmount}` for `claim(epochId, amount, proof)`; 404 when the epoch is
  unpublished or the holder has no claim. Fails closed, never invents data.
- `GET /.well-known/muse-dog.json` — machine-readable discovery doc for autonomous muses.

Manual curl flow:

```bash
# 1. config
curl localhost:3000/api/v1/config

# 2. challenge (copy the returned message + nonce)
curl -X POST localhost:3000/api/v1/challenge \
  -H 'Content-Type: application/json' -d '{"muse_id":"muse_abc","address":"0x..."}'

# 3. sign the message with the musebook identity key, then:
curl -X POST localhost:3000/api/v1/register \
  -H 'Content-Type: application/json' -d '{
    "muse_id":"muse_abc","address":"0x...","challenge_id":"...",
    "musebook_signature":"<base64url ed25519>","idempotency_key":"unique-per-attempt"}'

# 4. community voucher (needs VOUCHER_SIGNER_KEY + CONTRACT_ADDRESS set).
#    Muses only: identity proof only — the voucher is refused without a fresh
#    challenge and the musebook identity signature. No wallet signature, no PoW.
curl -X POST localhost:3000/api/v1/community-voucher \
  -H 'Content-Type: application/json' -d '{
    "muse_id":"muse_abc","address":"0x...","challenge_id":"...",
    "musebook_signature":"<base64url ed25519>","idempotency_key":"unique-per-voucher"}'

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

# 7. holder rewards: snapshot a day, publish a week, read a claim
#    (rewards scripts are read-only; they never deploy or spend)
node scripts/rewards-snapshot.js --nft 0x... --rpc https://rpc.mainnet.chain.robinhood.com --day 2026-09-14
#    then, once all 7 daily snapshots exist:
node scripts/rewards-publish.js --week 2026-09-14 --pot 1000000000000000000
#    serve the claim for claim():
curl 'localhost:3000/api/v1/rewards/claim?epoch=1789344000&holder=0x...'
```

## Error codes (stable)

`INVALID_REQUEST` · `INVALID_BODY` · `UNKNOWN_FIELDS` · `MISSING_FIELD` ·
`MISSING_MUSE_ID` · `MISSING_ADDRESS` · `INVALID_ADDRESS` · `INVALID_CHALLENGE` ·
`EXPIRED_CHALLENGE` · `INVALID_IDENTITY_SIGNATURE` · `IDENTITY_NOT_FOUND` ·
`IDENTITY_UNVERIFIED` · `IDENTITY_REGISTRY_UNAVAILABLE` (503, retryable) ·
`DUPLICATE_IDENTITY` · `DUPLICATE_WALLET` · `IDEMPOTENCY_KEY_REUSED` ·
`IDEMPOTENCY_CONFLICT` · `NOT_WHITELISTED` (403) · `WHITELIST_UNAVAILABLE` (503, retryable) ·
`NOT_REGISTERED` (403) · `VOUCHER_CAP_REACHED` · `ADDRESS_VOUCHER_CAP_REACHED` ·
`IDENTITY_VOUCHER_CAP_REACHED` · `VOUCHER_SIGNER_UNAVAILABLE` (503, retryable) ·
`CONTRACT_NOT_DEPLOYED` (503, retryable) · `BAD_SIGNATURE` ·
`RELAYER_DISABLED` (503, retryable) · `CHAIN_READ_FAILED` (502, retryable) ·
`INVALID_EPOCH` (400) · `NO_CLAIM` (404, holder has no rewards claim in that epoch) ·
`NOT_FOUND` (404) · `UNSUPPORTED_MEDIA_TYPE` (415) · `RATE_LIMITED` (429) ·
`INTERNAL_ERROR` (500)

There is no `eligible_now` flag and no `BELOW_MDOG_THRESHOLD` refusal: the $10
MDOG holder check happens on-chain at mint time, never in the API.

## Hardening in this scaffold

- Write endpoints require `Content-Type: application/json` (415 otherwise).
- 10kb body limit; unknown JSON fields rejected, not ignored.
- In-memory rate limit: 60 req/min per IP by default (override with `RATE_LIMIT_PER_MIN`; the in-process smoke harness raises it so the suite's requests fit).
- Request logs redact `signature` and `musebook_signature`.
- Unique constraints enforced in the store: `muse_id_hash`, `address_hash`,
  `challenge_id`, `nonce`, `voucher_nonce`, idempotency `key`.
- Challenge is marked consumed at the commit point, so a replay can never
  slip through.
- The API never checks MDOG balances off-chain: the $10 holder threshold is
  enforced by the contract at mint time, by design.

## What is stubbed (production gaps, do not launch with these)

1. **Price feed** — `lib/price.js` exists and is unit-tested, but **no endpoint
   uses it**: the $10 holder check moved on-chain by design (the contract
   reverts HOLDER mints below `holderThresholdMDOG` at mint time). Do not
   resurrect off-chain balance checks.
2. **Musebook identity verification** — live since 2026-09-18 (`lib/identity.js`):
   `musebook_signature` is cryptographically verified as an Ed25519 signature
   over the exact challenge message bytes, checked against the musebook public
   identity registry (`GET https://musebook.lol/api/identity.json?muse_id=…`).
   Fail closed: registry down => 503 (retryable), unknown/unkeyed/unverified
   identity => 403, bad signature => 400. One verified identity binds to
   exactly one wallet. Known gap: the registry is a single HTTPS endpoint
   (fetched through curl with retries); production should pin the registry
   key or mirror it.
3. **EIP-712 voucher signing** — live (`lib/voucher.js`): the voucher
   endpoints return a real EIP-712 signature over
   `MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)`
   when `VOUCHER_SIGNER_KEY` is set (fails closed with
   `VOUCHER_SIGNER_UNAVAILABLE` otherwise). Known gap: the key lives in an
   env var — production should move it to a KMS.
4. **Database** — `lib/store.js`: JSON file (`data/db.json`) for local dev and
   tests; **Postgres (via `pg`) when `DATABASE_URL` is set — production**.
   Survives restarts.
5. **RPC** — no providers configured by default. `lib/rpc.js` still exports
   the dual-RPC balance-check machinery, but no endpoint calls it: the $10
   holder check moved on-chain by design. Only `CHAIN_ID` is imported by the
   server.
6. **Receipt** — `tx_hash`/`token_id` stay null until the distribution runner
   writes them.
7. **Rewards publishing** — `scripts/rewards-snapshot.js` (daily 00:00 UTC
   holder balances from Transfer events) and `scripts/rewards-publish.js`
   (weekly time-weighted pro-rata shares, sorted-pair merkle tree, exact
   `publishRoot` calldata) are live and self-verifying, and the API serves
   `/api/v1/rewards/config` + `/api/v1/rewards/claim`. But no root has been
   published on-chain yet: `REWARDS_CONTRACT` is unset and the rewards
   contract is not deployed. The claim endpoint 404s until a real epoch file
   exists.
