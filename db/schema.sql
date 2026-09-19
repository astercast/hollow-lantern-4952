-- ============================================================================
-- Muse Dogs registration API — production Postgres schema (v1)
-- Target: Postgres 14+. Migration-ready DDL. Contains NO user data.
--
-- Design notes:
--   * Every uniqueness rule the API promises ("one identity ever", "one
--     wallet ever", "one voucher per identity", idempotent keys) is enforced
--     AT THE DATABASE LEVEL with UNIQUE constraints, so two racing requests
--     cannot slip past each other the way they can with the JSON dev store.
--   * Raw muse ids and addresses are stored once (needed for display, the
--     status endpoint, and distribution runners); the uniqueness checks run
--     on the salted HMAC-SHA256 hashes, exactly as the current code does.
--   * Signatures (wallet signature, musebook_signature) are NEVER stored —
--     they are verified in-flight and then dropped, same as today.
--   * The voucher cap (450) is enforced by a trigger reading a config row,
--     so the cap is adjustable without a schema change and cannot be raced.
-- ============================================================================

BEGIN;

-- gen_random_uuid() for UUID primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- Migrations bookkeeping: which schema versions have been applied.
-- ----------------------------------------------------------------------------
CREATE TABLE schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Small key/value config the schema itself needs (so ops can tune without DDL).
-- ----------------------------------------------------------------------------
CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO config (key, value) VALUES
  ('voucher_cap', '450'),
  ('schema_version', '1')
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Shared enums.
-- ----------------------------------------------------------------------------
CREATE TYPE allocation_type AS ENUM ('holder', 'community');

CREATE TYPE distribution_status_type AS ENUM (
  'not_eligible',     -- registered below the $10 threshold
  'awaiting_snapshot',-- eligible; waiting for the holder snapshot / batch mint
  'mint_queued',      -- handed to a distribution runner
  'minted',          -- tx hash + token id written by the runner
  'failed'           -- runner reported failure; needs human review
);

-- ----------------------------------------------------------------------------
-- challenges — single-use registration challenges with proof-of-work.
--
-- JSON source: challenges[] in api/data/db.json.
--
-- A challenge is consumed by marking it, never by deleting it: the row is the
-- replay-protection record. A failed identity check does NOT consume the
-- challenge (the muse may retry with the same challenge); consuming happens
-- with a guarded UPDATE so only one transaction can win the race:
--
--   UPDATE challenges
--      SET consumed = true, consumed_at = now()
--    WHERE challenge_id = $1 AND consumed = false;
--
-- If the affected row count is 0, the challenge was already used (400).
-- ----------------------------------------------------------------------------
CREATE TABLE challenges (
  challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce        TEXT NOT NULL UNIQUE,
  muse_id      TEXT NOT NULL,
  address      CHAR(42) NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  message      TEXT NOT NULL,
  pow_difficulty INT NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed     BOOLEAN NOT NULL DEFAULT false,
  consumed_at  TIMESTAMPTZ,
  CONSTRAINT consumed_consistent CHECK (
    (consumed AND consumed_at IS NOT NULL) OR
    (NOT consumed AND consumed_at IS NULL)
  )
);

CREATE INDEX challenges_muse_address_idx ON challenges (muse_id, address);
-- Fast sweep of stale unconsumed challenges (for a janitor job, if desired).
CREATE INDEX challenges_expires_idx ON challenges (expires_at) WHERE NOT consumed;

-- ----------------------------------------------------------------------------
-- registrations — holder-path registrations.
--
-- JSON source: registrations[] in api/data/db.json.
--
-- Uniqueness rules enforced here (all DB-level, race-safe):
--   * muse_id_hash UNIQUE  → one muse identity registered, EVER (409 DUPLICATE_IDENTITY)
--   * address_hash UNIQUE  → one wallet registered, EVER (409 DUPLICATE_WALLET)
--     (address_hash is HMAC-SHA256 over the lowercased EIP-55 address, exactly
--     as lib/hash.js does: hash(address.toLowerCase()))
--   * challenge_id UNIQUE  → one registration per challenge (replay protection)
-- Below-threshold registrations still occupy the identity/wallet hashes, exactly
-- as the current code does: a muse cannot re-register a second wallet to get
-- a second bite.
--
-- identity_name / identity_key_fingerprint are audit fields only: the display
-- name and a sha256 fingerprint of the registry public key that verified this
-- registration. They do not change any logic; they let a human audit later
-- prove WHICH registry identity approved each registration.
-- ----------------------------------------------------------------------------
CREATE TABLE registrations (
  registration_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  muse_id                  TEXT NOT NULL,
  -- Explicit constraint names: the Postgres adapter maps SQLSTATE 23505 to the
  -- API's DUPLICATE_* codes by constraint name, so the names are part of the
  -- contract between schema and code. Do not rename them casually.
  muse_id_hash             CHAR(64) NOT NULL CONSTRAINT registrations_muse_id_hash_uniq UNIQUE,
  address                  CHAR(42) NOT NULL CHECK (address ~ '^0x[0-9a-fA-F]{40}$'),
  address_hash             CHAR(64) NOT NULL CONSTRAINT registrations_address_hash_uniq UNIQUE,
  challenge_id             UUID NOT NULL CONSTRAINT registrations_challenge_id_uniq UNIQUE REFERENCES challenges (challenge_id),
  identity_name            TEXT,                      -- registry display name (audit)
  identity_key_fingerprint CHAR(64),                   -- sha256 of registry public_key (audit)
  balance_raw              NUMERIC(78,0),             -- raw MDOG token units
  balance_usd              NUMERIC(24,8),
  balance_checked_at_block BIGINT,
  price_usd_per_mdog       NUMERIC(30,12),
  price_sources            TEXT,                      -- e.g. 'dexscreener,v4-pool-dual-rpc'
  price_checked_at         TIMESTAMPTZ,
  price_block              BIGINT,
  eligible_now             BOOLEAN NOT NULL,
  allocation               allocation_type,           -- 'holder' when eligible, else NULL
  distribution_status      distribution_status_type NOT NULL DEFAULT 'not_eligible',
  recheck_required         BOOLEAN NOT NULL DEFAULT true,
  tx_hash                  TEXT,                      -- written by the distribution runner
  token_id                 BIGINT,                    -- written by the distribution runner
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The /api/v1/community-voucher "already holder" check looks a registration up
-- by address case-insensitively; make that lookup fast.
CREATE INDEX registrations_address_lower_idx ON registrations (lower(address));
-- Distribution runners scan for rows awaiting work; partial index keeps it cheap.
CREATE INDEX registrations_pending_distribution_idx ON registrations (created_at)
  WHERE distribution_status IN ('awaiting_snapshot', 'mint_queued');

-- ----------------------------------------------------------------------------
-- community_vouchers — free-mint path (EIP-712 vouchers, 450 cap).
--
-- JSON source: vouchers[] in api/data/db.json.
--
-- Uniqueness rules enforced here (all DB-level, race-safe):
--   * voucher_nonce PRIMARY KEY  → nonce can never repeat on-chain or off
--   * lower(claimant) UNIQUE     → one voucher per address, case-insensitive.
--     (The current code's pre-check compares a lowercased address against
--     checksummed stored values, so it can miss; the insert-time check is what
--     actually enforces it today. This index makes the intent airtight.)
--   * muse_id_hash UNIQUE        → one voucher per muse identity, EVER
--     (this is the rule that stops the 500-address sniper)
--
-- NOTE on allocation: the current handler inserts 'COMMUNITY' (uppercase) into
-- the voucher row while the payload keeps it too. The Postgres adapter MUST
-- normalize the row value to lowercase 'community' before INSERT (the enum
-- values are lowercase); the JSONB payload keeps the original uppercase value
-- the contract expects.
--
-- The 450 cap is enforced by the trigger below, which reads the live cap from
-- the config table: an INSERT that would exceed the cap is rejected inside the
-- same transaction, so concurrent voucher requests cannot both slip through.
-- ----------------------------------------------------------------------------
CREATE TABLE community_vouchers (
  voucher_nonce   NUMERIC(78,0) PRIMARY KEY,  -- uint256 as decimal string, contract-bound
  muse_id         TEXT NOT NULL,
  muse_id_hash    CHAR(64) NOT NULL CONSTRAINT community_vouchers_muse_id_hash_uniq UNIQUE,
  claimant        CHAR(42) NOT NULL CHECK (claimant ~ '^0x[0-9a-fA-F]{40}$'),
  allocation      allocation_type NOT NULL DEFAULT 'community',
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  payload         JSONB NOT NULL,             -- the exact EIP-712 voucher payload
  eip712_signature TEXT,                      -- filled by the KMS signer when live
  redeemed_at     TIMESTAMPTZ,                 -- when claim() was seen on-chain
  redeemed_tx_hash TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive one-voucher-per-address. Explicit index name so the adapter
-- can map SQLSTATE 23505 on it to 409 VOUCHER_ALREADY_ISSUED. (Replaces the
-- old plain UNIQUE on claimant plus the separate lower() lookup index.)
CREATE UNIQUE INDEX community_vouchers_claimant_lower_uniq
  ON community_vouchers (lower(claimant));

CREATE OR REPLACE FUNCTION enforce_voucher_cap() RETURNS trigger AS $$
DECLARE
  cap INT;
BEGIN
  SELECT value::INT INTO cap FROM config WHERE key = 'voucher_cap';
  IF cap IS NULL THEN
    RAISE EXCEPTION 'VOUCHER_CAP_MISCONFIGURED' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM community_vouchers) >= cap THEN
    RAISE EXCEPTION 'VOUCHER_CAP_REACHED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voucher_cap_trg
  BEFORE INSERT ON community_vouchers
  FOR EACH ROW EXECUTE FUNCTION enforce_voucher_cap();

-- ----------------------------------------------------------------------------
-- idempotency_keys — safe retries for every write endpoint.
--
-- JSON source: idempotency[] in api/data/db.json.
--
-- The key is the PRIMARY KEY: two requests with the same key can never create
-- two rows, even if they arrive in the same millisecond. The API's contract:
--   * same key + same muse_id  → replay the stored status + response, do no work
--   * same key + DIFFERENT muse_id → 409 (key belongs to someone else)
--     [decision needed — see MIGRATION_PLAN.md]
--
-- Error paths (503 fail-closed on RPC/price/registry outage) are recorded here
-- too, exactly as today: a retry with the same key replays the failure instead
-- of starting a second registration attempt.
-- ----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key        TEXT PRIMARY KEY,
  muse_id    TEXT NOT NULL,
  route      TEXT NOT NULL,          -- e.g. 'register', 'community-voucher'
  status     INT NOT NULL,
  response   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idempotency_muse_idx ON idempotency_keys (muse_id);

-- ----------------------------------------------------------------------------
-- price_observations — audit trail + shared cache for the MDOG/USD feed.
--
-- Every price the API acts on is written here with its block and fetch time,
-- so any eligibility decision can later be re-verified ("which price did you
-- use, and from where?"). registrations.price_usd_per_mdog / price_block
-- reference the observation used.
--
-- This table also replaces the current in-process price cache: with more than
-- one API worker, each process caching in memory means redundant upstream
-- fetches and inconsistent staleness windows. The shared rule becomes:
-- "reuse the newest observation younger than PRICE_MAX_AGE_MS; otherwise fetch
-- fresh and record it" — guarded by a single-row advisory lock on fetch so
-- concurrent workers don't stampede the upstream sources.
-- ----------------------------------------------------------------------------
CREATE TABLE price_observations (
  id              BIGSERIAL PRIMARY KEY,
  price_usd       NUMERIC(30,12) NOT NULL,
  block           BIGINT,
  sources         TEXT[] NOT NULL,   -- e.g. '{dexscreener,v4-pool-dual-rpc}'
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  age_ms          INT,
  context         TEXT NOT NULL DEFAULT 'registration',
  registration_id UUID REFERENCES registrations (registration_id)
);

CREATE INDEX price_observations_fetched_idx ON price_observations (fetched_at DESC);

-- Record this schema version.
INSERT INTO schema_migrations (version) VALUES ('1') ON CONFLICT DO NOTHING;

COMMIT;
