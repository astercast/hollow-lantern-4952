// JSON-file-backed store with enforced unique constraints.
// File: ./data/db.json (relative to the api directory).
// This is a scaffold: for production, replace with Postgres and real transactions.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function blankDb() {
  return {
    challenges: [],     // { challenge_id, nonce, muse_id, address, message, pow_difficulty, issued_at, expires_at, consumed }
    registrations: [],  // { registration_id, muse_id, address, muse_id_hash, address_hash, challenge_id, balance_raw, balance_usd, balance_checked_at_block, eligible_now, allocation, distribution_status, created_at, recheck_required }
    vouchers: [],       // { voucher_nonce, claimant, expires_at, issued_at, payload, eip712_signature }
    claim_jobs: [],     // { job_id, voucher, signature, idempotency_key, status, attempts, tx_hash, token_id, block_number, error, created_at, updated_at }
    idempotency: [],    // { key, muse_id, route, status, response, created_at }
  };
}

function load() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(raw);
    return Object.assign(blankDb(), db);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const db = blankDb();
      save(db);
      return db;
    }
    throw err;
  }
}

function save(db) {
  // Write-then-rename so a crash never leaves a half-written file.
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function find(db, table, key, value) {
  return db[table].find((row) => row[key] === value) || null;
}

function exists(db, table, key, value) {
  return db[table].some((row) => row[key] === value);
}

// Insert enforcing the table's unique keys. Throws { code: 'DUPLICATE_...' } on conflict.
function insert(db, table, row, uniqueKeys) {
  for (const key of uniqueKeys) {
    if (exists(db, table, key, row[key])) {
      throw { code: 'DUPLICATE_' + key.toUpperCase(), key };
    }
  }
  db[table].push(row);
  save(db);
  return row;
}

module.exports = { load, save, find, exists, insert, blankDb, DB_PATH };
