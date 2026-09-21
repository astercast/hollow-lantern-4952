-- Muse Dogs API — Postgres schema.
-- One table per store collection. Each row keeps its natural primary key
-- plus the full document as JSONB, so the store interface stays identical
-- to the original JSON-file version (load everything, work in memory).
-- Applied automatically by lib/store.js on first use (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS challenges (
  challenge_id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS registrations (
  registration_id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS vouchers (
  voucher_nonce TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_jobs (
  job_id TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL
);

-- Uniqueness the API enforces on JSON-document fields, as real DB constraints
-- so concurrent writers cannot slip past the in-memory pre-checks:
-- one registration per muse identity and per wallet address, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_registrations_muse_id_hash
  ON registrations ((data->>'muse_id_hash'));
CREATE UNIQUE INDEX IF NOT EXISTS uidx_registrations_address_hash
  ON registrations ((data->>'address_hash'));
CREATE UNIQUE INDEX IF NOT EXISTS uidx_challenges_nonce
  ON challenges ((data->>'nonce'));
