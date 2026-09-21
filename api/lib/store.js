// Store with two backends:
//   - Postgres (via `pg`) when DATABASE_URL is set — production. Survives
//     restarts and sleep/wake cycles (Render's free tier wipes local disk).
//   - JSON file (./data/db.json) when DATABASE_URL is unset — local dev / tests.
// The interface is identical for both backends: load, save, find, exists,
// insert, blankDb, DB_PATH. load/save/insert are async; find/exists operate
// on an already-loaded db object and stay synchronous.
// Schema lives in ../schema.sql and is applied automatically on first use.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
const USE_PG = !!process.env.DATABASE_URL;

const TABLES = ['challenges', 'registrations', 'vouchers', 'claim_jobs', 'idempotency'];
const KEY_COL = {
  challenges: 'challenge_id',
  registrations: 'registration_id',
  vouchers: 'voucher_nonce',
  claim_jobs: 'job_id',
  idempotency: 'key',
};

let pool = null;
function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    const cs = process.env.DATABASE_URL;
    pool = new Pool({
      connectionString: cs,
      // Neon and friends require SSL; harmless to offer when not needed.
      ssl: /sslmode=require/.test(cs) ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    pool.on('error', (e) => console.error('pg pool error: ' + (e && e.message || e)));
  }
  return pool;
}

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
      await getPool().query(sql);
    })().catch((e) => {
      schemaReady = null; // retry next time instead of caching a failure
      throw e;
    });
  }
  return schemaReady;
}

function blankDb() {
  return {
    challenges: [],     // { challenge_id, nonce, muse_id, address, message, issued_at, expires_at, consumed }
    registrations: [],  // { registration_id, muse_id, address, muse_id_hash, address_hash, challenge_id, balance_raw, balance_usd, balance_checked_at_block, eligible_now, allocation, distribution_status, created_at, recheck_required }
    vouchers: [],       // { voucher_nonce, recipient, expires_at, issued_at, payload, eip712_signature }
    claim_jobs: [],     // { job_id, voucher, signature, idempotency_key, status, attempts, tx_hash, token_id, block_number, error, created_at, updated_at }
    idempotency: [],    // { key, muse_id, route, status, response, created_at }
  };
}

function loadJson() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(raw);
    return Object.assign(blankDb(), db);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const db = blankDb();
      saveJson(db);
      return db;
    }
    throw err;
  }
}

function saveJson(db) {
  // Write-then-rename so a crash never leaves a half-written file.
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

async function load() {
  if (!USE_PG) return loadJson();
  await ensureSchema();
  const db = blankDb();
  for (const t of TABLES) {
    const { rows } = await getPool().query(`SELECT data FROM ${t}`);
    db[t] = rows.map((r) => r.data);
  }
  return db;
}

async function save(db) {
  if (!USE_PG) return saveJson(db);
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const t of TABLES) {
      await client.query(`DELETE FROM ${t}`);
      const kc = KEY_COL[t];
      for (const row of db[t]) {
        await client.query(
          `INSERT INTO ${t} (${kc}, data) VALUES ($1, $2::jsonb)`,
          [String(row[kc]), JSON.stringify(row)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function find(db, table, key, value) {
  return db[table].find((row) => row[key] === value) || null;
}

function exists(db, table, key, value) {
  return db[table].some((row) => row[key] === value);
}

// Maps unique-index names (schema.sql) back to the store key they enforce,
// so a concurrent-write race that slips past the in-memory pre-check still
// surfaces the same DUPLICATE_* code as the JSON backend.
const UNIQUE_INDEX_KEY = {
  uidx_registrations_muse_id_hash: 'muse_id_hash',
  uidx_registrations_address_hash: 'address_hash',
  uidx_challenges_nonce: 'nonce',
};

function duplicateError(key) {
  return { code: 'DUPLICATE_' + String(key).toUpperCase(), key };
}

// Map a Postgres 23505 unique-violation to the store key that conflicted.
// Primary: e.constraint (the index name — reliable on real Postgres).
// Fallback: parse the detail message, e.g.
//   Key ((data->>'muse_id_hash'::text))=(abc…) already exists.
// Last resort: the table's primary-key column.
function mapUniqueViolation(constraint, detail, fallbackKey) {
  if (constraint && UNIQUE_INDEX_KEY[constraint]) return UNIQUE_INDEX_KEY[constraint];
  const m = String(detail || '').match(/data->>'([^']+)'/);
  if (m && m[1]) return m[1];
  return fallbackKey;
}

// Insert enforcing the table's unique keys. Throws { code: 'DUPLICATE_...' } on conflict.
// In Postgres mode the in-memory checks run first so error codes match the
// JSON backend exactly; the unique indexes are the atomic backstop — a
// 23505 from a concurrent writer is mapped to the same DUPLICATE_* code.
async function insert(db, table, row, uniqueKeys) {
  for (const key of uniqueKeys) {
    if (exists(db, table, key, row[key])) {
      throw duplicateError(key);
    }
  }
  if (!USE_PG) {
    db[table].push(row);
    saveJson(db);
    return row;
  }
  await ensureSchema();
  const kc = KEY_COL[table];
  try {
    await getPool().query(
      `INSERT INTO ${table} (${kc}, data) VALUES ($1, $2::jsonb)`,
      [String(row[kc]), JSON.stringify(row)]
    );
  } catch (e) {
    if (e && e.code === '23505') {
      // Unique violation: either the primary key or one of the expression
      // indexes. Map it to the store key so callers see DUPLICATE_*.
      throw duplicateError(mapUniqueViolation(e.constraint, e.detail, kc));
    }
    throw e;
  }
  db[table].push(row);
  return row;
}

// Atomically mark a challenge consumed. Postgres: a single conditional UPDATE
// so only the first writer wins — a loser gets CHALLENGE_CONSUMED (400)
// instead of silently replaying. JSON: mutate in place + save.
async function consumeChallenge(db, challenge) {
  if (!USE_PG) {
    challenge.consumed = true;
    saveJson(db);
    return challenge;
  }
  await ensureSchema();
  challenge.consumed = true;
  const res = await getPool().query(
    `UPDATE challenges SET data = $1::jsonb
     WHERE challenge_id = $2 AND COALESCE((data->>'consumed')::boolean, false) = false`,
    [JSON.stringify(challenge), String(challenge.challenge_id)]
  );
  if (res.rowCount === 0) {
    const e = new Error('Challenge already consumed.');
    e.status = 400;
    e.code = 'CHALLENGE_CONSUMED';
    throw e;
  }
  return challenge;
}

// Read one idempotency record by key (Postgres). Used to resolve a 23505
// race: the winner's committed row tells us whether to replay or refuse.
async function readIdemRecord(key) {
  await ensureSchema();
  const { rows } = await getPool().query(
    'SELECT data FROM idempotency WHERE key = $1',
    [String(key)]
  );
  return rows.length ? rows[0].data : null;
}

// Commit a registration atomically: consume the challenge, insert the
// registration row, and record the idempotency entry — all or nothing.
// In-memory duplicate pre-checks run first so error codes match the JSON
// backend; Postgres wraps the three writes in one transaction with the
// unique indexes as the backstop for concurrent duplicate writers.
// A 23505 from a concurrent writer is resolved against the winner's
// committed idempotency row: same muse + same key replays the recorded
// response (stable, not an error); anything else maps to DUPLICATE_* or a
// retryable conflict.
async function commitRegistration(db, { challenge, registration, idem }) {
  for (const key of ['registration_id', 'muse_id_hash', 'address_hash']) {
    if (exists(db, 'registrations', key, registration[key])) {
      throw duplicateError(key);
    }
  }
  const priorKey = find(db, 'idempotency', 'key', idem.key);
  if (priorKey) {
    if (priorKey.muse_id === idem.muse_id) throw { code: 'IDEMPOTENCY_REPLAY', key: idem.key };
    throw { code: 'IDEMPOTENCY_KEY_REUSED', key: idem.key };
  }
  if (!USE_PG) {
    challenge.consumed = true;
    db.registrations.push(registration);
    db.idempotency.push(idem);
    saveJson(db);
    return registration;
  }
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const up = await client.query(
      `UPDATE challenges SET data = $1::jsonb
       WHERE challenge_id = $2 AND COALESCE((data->>'consumed')::boolean, false) = false`,
      [JSON.stringify({ ...challenge, consumed: true }), String(challenge.challenge_id)]
    );
    if (up.rowCount === 0) {
      const e = new Error('Challenge already consumed.');
      e.status = 400;
      e.code = 'CHALLENGE_CONSUMED';
      throw e;
    }
    await client.query(
      `INSERT INTO registrations (registration_id, data) VALUES ($1, $2::jsonb)`,
      [String(registration.registration_id), JSON.stringify(registration)]
    );
    await client.query(
      `INSERT INTO idempotency (key, data) VALUES ($1, $2::jsonb)`,
      [String(idem.key), JSON.stringify(idem)]
    );
    await client.query('COMMIT');
  } catch (e) {
    // ROLLBACK undoes all three writes on real Postgres — the pg-mem
    // emulator does not roll back, which is an emulator limitation, not a
    // code bug. Real Postgres also reports the true index name in
    // e.constraint, which pg-mem does not.
    await client.query('ROLLBACK');
    if (e && e.code === '23505') {
      const rec = await readIdemRecord(idem.key);
      if (rec && rec.muse_id === idem.muse_id) throw { code: 'IDEMPOTENCY_REPLAY', key: idem.key };
      if (rec && rec.muse_id !== idem.muse_id) throw { code: 'IDEMPOTENCY_KEY_REUSED', key: idem.key };
      const onIdemKey = e.constraint === 'idempotency_pkey' || /Key \(key\)=/.test(String(e.detail || ''));
      if (onIdemKey) {
        // Same-key writer still committing (no visible row yet): the only
        // safe answer is "retry the exact same request", which then hits
        // the replay path once the winner commits.
        const r = new Error('Concurrent request with the same idempotency key is committing. Retry the exact same request.');
        r.status = 409;
        r.code = 'IDEMPOTENCY_RACE_RETRY';
        r.extra = { retryable: true };
        throw r;
      }
      throw duplicateError(mapUniqueViolation(e.constraint, e.detail, 'registration_id'));
    }
    throw e;
  } finally {
    client.release();
  }
  challenge.consumed = true;
  db.registrations.push(registration);
  db.idempotency.push(idem);
  return registration;
}

// Upsert a claim job by job_id. Postgres: one atomic statement (no
// load->mutate->save whole-table rewrite). JSON: mutate in place + save.
async function upsertJob(db, job) {
  if (!USE_PG) {
    const i = db.claim_jobs.findIndex((j) => j.job_id === job.job_id);
    if (i >= 0) db.claim_jobs[i] = job;
    else db.claim_jobs.push(job);
    saveJson(db);
    return job;
  }
  await ensureSchema();
  await getPool().query(
    `INSERT INTO claim_jobs (job_id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (job_id) DO UPDATE SET data = EXCLUDED.data`,
    [String(job.job_id), JSON.stringify(job)]
  );
  const i = db.claim_jobs.findIndex((j) => j.job_id === job.job_id);
  if (i >= 0) db.claim_jobs[i] = job;
  else db.claim_jobs.push(job);
  return job;
}

module.exports = { load, save, find, exists, insert, consumeChallenge, commitRegistration, upsertJob, readIdemRecord, blankDb, DB_PATH, USE_PG };
