# Muse Dogs API — JSON store → Postgres migration plan

**Status:** design only. Nothing here touches a live database, creates a cloud
service, or deploys anything. Schema lives in `db/schema.sql`.

## Why we're doing this

The API currently keeps everything in `api/data/db.json` — one JSON file on
disk. That works for local testing but cannot hold the promises the launch
depends on:

- **Races.** Two muses registering in the same second can both read the file
  before either writes it, so both pass the "one identity, one wallet" check
  and both get in. The code checks, then writes — there is no lock in between.
- **Corruption / loss.** One bad write (crash mid-save, disk full) can take the
  whole file, and there are no real backups.
- **No audit.** "Which price did you use for my eligibility?" has no durable
  answer beyond the JSON row.

Postgres fixes all three: uniqueness is enforced by the database itself (even
in a race, only one transaction wins), writes are transactional, and backups
are real.

## JSON → table mapping

| `db.json` table | Postgres table | Key fields carried over |
|---|---|---|
| `challenges[]` | `challenges` | `challenge_id` (UUID PK), `nonce` (UNIQUE), `muse_id`, `address`, `message`, `pow_difficulty`, `issued_at`, `expires_at`, `consumed` |
| `registrations[]` | `registrations` | `registration_id` (UUID PK), `muse_id` + `muse_id_hash` (UNIQUE), `address` + `address_hash` (UNIQUE), `challenge_id` (UNIQUE, FK → challenges), balance + price fields, `eligible_now`, `allocation`, `distribution_status`, `recheck_required`, `created_at` |
| `vouchers[]` | `community_vouchers` | `voucher_nonce` (uint256 decimal → PK), `muse_id` + `muse_id_hash` (UNIQUE — one voucher per identity ever), `claimant` (unique index on `lower(claimant)` — one per address, case-insensitive), `payload` (→ JSONB), `issued_at`, `expires_at` |
| `idempotency[]` | `idempotency_keys` | `key` (PK), `muse_id`, `route`, `status`, `response` (→ JSONB), `created_at` |
| — | `price_observations` | **new**: every price the API acts on, with block + fetch time. Also replaces the current in-process price cache (see below). |
| — | `config` / `schema_migrations` | ops bookkeeping (voucher cap, schema version) |

## Race-by-race: what changes

| Rule | JSON today | Postgres after |
|---|---|---|
| One muse identity registers once | check-then-write, **raceable** | `UNIQUE(muse_id_hash)` — the DB rejects the loser with a constraint violation → 409 `DUPLICATE_IDENTITY` |
| One wallet registers once | check-then-write, **raceable** | `UNIQUE(address_hash)` → 409 `DUPLICATE_WALLET` |
| Challenge single-use | `consumed` boolean set before the network call, still raceable across processes | `UPDATE … WHERE consumed = false`, loser gets 0 rows affected → 400 "already used" |
| One voucher per identity ever | check-then-write, **raceable** | `UNIQUE(muse_id_hash)` → 409 `VOUCHER_ALREADY_ISSUED_FOR_IDENTITY` |
| One voucher per address | check-then-write, **raceable** (and the current pre-check lowercases while stored values are checksummed, so it can miss — the insert is the real enforcement) | unique index on `lower(claimant)` → 409 `VOUCHER_ALREADY_ISSUED`, now case-insensitive and airtight |
| 100 voucher cap | `if (vouchers.length >= 100)` in app code, **raceable** | `BEFORE INSERT` trigger reads the cap from `config`; exceeding inserts fail inside the transaction |
| Idempotent retries | find-then-insert, **raceable** | `key` is the PK; duplicate insert → replay stored response (same muse) or 409 (different muse — decision needed, below) |
| Price cache consistency | in-process memory — N workers each cache independently | `price_observations` is the shared cache: newest row younger than `PRICE_MAX_AGE_MS` wins; fetches take a single advisory lock so workers don't stampede the upstreams |

## Adapter contract: SQLSTATE 23505 → API error codes

The unique constraints in `schema.sql` have explicit names so the Postgres
adapter can map a unique-violation (`23505`) to the exact 409 the handlers
already return. The mapping the adapter must implement:

| Violated constraint / index | API code | HTTP |
|---|---|---|
| `registrations_muse_id_hash_uniq` | `DUPLICATE_IDENTITY` | 409 |
| `registrations_address_hash_uniq` | `DUPLICATE_WALLET` | 409 |
| `registrations_challenge_id_uniq` | `DUPLICATE_CHALLENGE` (challenge already used — treat like the 400 `EXPIRED_CHALLENGE`) | 400 |
| `community_vouchers_muse_id_hash_uniq` | `VOUCHER_ALREADY_ISSUED_FOR_IDENTITY` | 409 |
| `community_vouchers_claimant_lower_uniq` | `VOUCHER_ALREADY_ISSUED` | 409 |
| `idempotency_keys_pkey` (same key, same muse) | replay the stored `status` + `response`, do no work | stored |
| `idempotency_keys_pkey` (same key, different muse) | `IDEMPOTENCY_KEY_IN_USE` | 409 (decision 2) |

The voucher-cap trigger raises `P0001` with message `VOUCHER_CAP_REACHED`
(→ 409, same code the JSON store returns today) or
`VOUCHER_CAP_MISCONFIGURED` (→ 503 `STORE_MISCONFIGURED`, fail closed — the
cap row must never be missing). The adapter must map these `raise_exception`
errors, not just `23505`.

Note on privileges: `CREATE EXTENSION IF NOT EXISTS pgcrypto` needs a role
that can create extensions (or a superuser installs it first, then the
dedicated API role only needs table rights). Decide this at provisioning
time (order-of-operations step 1).

With the constraints as the source of truth, the adapter can **drop the
pre-insert `exists()` checks** in the handlers — the check-then-write race
they contain is exactly what we're eliminating. (Keeping them as a fast-path
is harmless but they must never be treated as the enforcement.)

## `/register` transaction structure

The current handler does check → consume challenge → network calls → insert.
The Postgres port must preserve the exact consumption semantics (a failed
identity check does NOT consume the challenge; a consumed challenge stays
consumed even if the balance/price check then fails closed). Two short
transactions, never one long one spanning network I/O:

1. **Tx A — consume the challenge.** `UPDATE challenges SET consumed = true,
   consumed_at = now() WHERE challenge_id = $1 AND consumed = false;`
   0 rows affected → 400 `EXPIRED_CHALLENGE`. COMMIT immediately — this is the
   replay protection and must be visible before any network call.
2. **Network calls** (identity verify, PoW, wallet sig, whitelist, balance,
   price) — unchanged, still outside any transaction.
3. **Tx B — record the outcome.** On success: `INSERT` registration +
   `INSERT` idempotency row, one transaction; a `23505` maps via the table
   above. On balance/price failure (503 fail-closed): `INSERT` the idempotency
   error row with `ON CONFLICT (key) DO NOTHING` (a concurrent retry may have
   recorded it first) and COMMIT — the challenge stays consumed, matching
   today's behavior where `store.save(db)` runs on the failure paths.

## Code gaps the schema exposed (fix before cutover)

1. **The voucher endpoint never records idempotency.** `POST
   /api/v1/community-voucher` requires `idempotency_key` in the body but
   never looks it up or stores it — a retried voucher request gets a 409
   (`VOUCHER_ALREADY_ISSUED_FOR_IDENTITY`) instead of the original 200
   replayed. The schema already supports `route = 'community-voucher'`; the
   handler needs the same lookup-then-record pattern as `/register`.
2. **Voucher allocation case.** The handler inserts `allocation: 'COMMUNITY'`
   (uppercase) into the voucher row; the schema's `allocation_type` enum is
   lowercase. The adapter must normalize the row value to `'community'`
   before INSERT. The JSONB `payload` keeps the original uppercase value the
   contract expects.
3. **Voucher claimant pre-check case bug.** The handler checks
   `store.exists(db, 'vouchers', 'claimant', address.toLowerCase())` but stores
   the checksummed address, so the pre-check can miss. Harmless today (the
   insert still enforces it) and fixed properly by the `lower(claimant)`
   unique index — listed here so nobody "fixes" it by lowercasing stored
   values, which would break the EIP-55 checksum display.

## Order of operations

1. **Provision Postgres** (managed instance, e.g. a small dedicated DB — never the
   same box as the API for real launch). Create a dedicated role with rights
   only on this database's tables (no superuser, no `public` schema writes).
   `DATABASE_URL` goes into the secret store, never into the repo.
2. **Run the schema.** `psql $DATABASE_URL < db/schema.sql`. Verify with
   `\dt` and the validation queries below.
3. **Backfill from `db.json`.** A one-off script reads each JSON table and
   inserts rows (skipping ones already present by PK/hash). Requirements:
   - Use the **production** `HASH_SALT` when re-deriving `muse_id_hash` /
     `address_hash`, then compare against the JSON values — any mismatch means
     the salt is wrong and the backfill must stop (see decision 1).
   - `challenge_id` / `registration_id` come over as-is (they're UUIDs).
   - Old registrations may lack price fields — those columns are nullable, so
     backfill inserts them as NULL; the re-check runner will re-price them.
   - Voucher nonces arrive as decimal strings → insert as `NUMERIC`.
   - Voucher rows carry `allocation: 'COMMUNITY'` (uppercase) in the JSON —
     normalize to lowercase `'community'` for the enum column; the `payload`
     JSONB keeps the original.
   - Run the whole backfill in one transaction; on any error, roll back and
     fix forward — never hand-edit rows.
4. **Swap the store adapter.** Replace `lib/store.js`'s file I/O with a
   Postgres adapter behind the same function names (`load/find/exists/insert`
   semantics, but `insert` now catches `23505` unique-violation and maps it to
   the existing `DUPLICATE_*` codes the handlers already expect). Keep the
   JSON file as a read-only fallback **only for local dev** — production must
   never read it.
5. **Smoke + dry run.** `npm run smoke` in `TEST_MODE=1` against the real
   schema (point `DATABASE_URL` at the prod-shape DB, no real traffic). Then a
   live dry run: issue a challenge and register a test muse against production
   RPCs/registry, verify the row, then delete the test rows.
6. **Cutover with fail-closed.** Flip the API to Postgres. From that moment:
   - If the DB is unreachable, **every write endpoint returns 503**
     (`STORE_UNAVAILABLE`, retryable) — the API must **never** silently fall
     back to the JSON file or to accepting registrations it can't record.
   - Keep `db.json` untouched as the pre-cutover archive; stop writing to it.
7. **Backups before launch.** Enable point-in-time recovery and take a
   `pg_basebackup`/`pg_dump` snapshot right after cutover. Test a restore once.

### Validation queries (run after backfill, before cutover)

```sql
-- No duplicate hashes (should all return 0)
SELECT count(*) FROM (SELECT muse_id_hash FROM registrations GROUP BY 1 HAVING count(*) > 1) d;
SELECT count(*) FROM (SELECT address_hash FROM registrations GROUP BY 1 HAVING count(*) > 1) d;
SELECT count(*) FROM (SELECT muse_id_hash FROM community_vouchers GROUP BY 1 HAVING count(*) > 1) d;
-- Row counts match the JSON archive
SELECT 'challenges' t, count(*) FROM challenges
UNION ALL SELECT 'registrations', count(*) FROM registrations
UNION ALL SELECT 'vouchers', count(*) FROM community_vouchers
UNION ALL SELECT 'idempotency', count(*) FROM idempotency_keys;
-- Voucher cap trigger is live
SELECT * FROM config WHERE key = 'voucher_cap';
```

## What Postgres cannot cleanly enforce (flags)

1. **The anti-snipe whitelist stays a file.** `data/whitelist.json` (salted
   identity hashes, built pre-announcement) is loaded at startup; its
   missing-file → 503 fail-closed behavior stays in app code. Moving it into a
   DB table is possible later, but the security property that matters — it is
   frozen before the announcement and never edited after — is a *process*
   rule, not a schema rule.
2. **"Holder must use the airdrop path" is app logic.** The voucher endpoint
   rejects an address that already has an eligible registration. That's a
   cross-table business rule; a trigger could do it, but the honest place is
   the handler, inside the same transaction.
3. **The price agreement math lives in app code.** The DB stores the *result*
   (price, block, sources, timestamp). It cannot verify that two sources
   agreed — that's `lib/price.js`'s job.
4. **Challenge expiry is time-based.** Expired-but-unconsumed challenges just
   sit there; the API rejects them by comparing `expires_at`. A janitor job
   can delete ancient ones, but nothing breaks if it doesn't run.
5. **In-memory rate limiting doesn't survive multiple workers.** Today's
   60-req/min per-IP limiter lives in a `Map` in `server.js`. With two API
   processes, each gets its own budget (so the real limit doubles). For
   launch this needs a shared limiter (Redis, or a small DB table) — flagged,
   not solved here.
6. **Signatures are intentionally not stored.** Wallet + identity signatures
   are verified in-flight and dropped. If a dispute ever needs "show me the
   signature," it won't exist — that's the privacy-safe tradeoff, and it's
   deliberate. The new audit columns (`identity_name`,
   `identity_key_fingerprint`) record *which* registry identity verified,
   without keeping the signature itself.

## Decisions Andrew still needs to make

1. **`HASH_SALT` custody.** Every uniqueness hash is HMAC-SHA256 with this
   salt. If the production salt differs from the one used to build the
   whitelist and backfill, all hashes mismatch and duplicates become possible.
   It must live in the secret store, be backed up, and **never** be committed
   or rotated casually. (The dev default `'muse-dog-lol-dev-salt'` must never
   reach production.)
2. **Idempotency key scope.** Today: same key + same muse → replay. Same key +
   *different* muse → falls through and eventually 409s on a duplicate
   somewhere. With a PK on `key`, we should make this explicit: recommend 409
   `IDEMPOTENCY_KEY_IN_USE` for the cross-muse case. Your call.
3. **Voucher-cap adjustability.** The cap (100) is a config row the trigger
   reads. Should changing it require your explicit sign-off + a logged reason?
   Recommend yes — it's a supply promise.
4. **Price staleness ceiling.** `PRICE_MAX_AGE_MS` (5 min) and the 20%
   source-agreement band are env knobs. Tighter = safer, but more paused
   registrations during volatility. Your call before launch.
5. **Two genuinely independent RPC providers.** The code enforces dual-RPC
   agreement, but two URLs pointed at the same node is theater. Production
   needs two different providers (decision: which ones).
6. **Whitelist cutoff + min posts** (already on your list) — the DB design
   assumes the whitelist file exists and is frozen; the numbers are yours.
7. **Batch-mint re-check runner** doesn't exist yet — it will consume
   `registrations.price_checked_at` / `price_block` and write `tx_hash` /
   `token_id` / `distribution_status`. That's the next build after this.

## Non-goals (explicitly out of scope)

- No migration is run here. No database is created. No cloud services, no
  domains, no deployments.
- The JSON store and all current code are untouched — this is design only.
- Contract-side supply enforcement (the 1,000 cap, one-claim-per-address
  on-chain) already lives in `Muse Dogs.sol` and is unaffected.
