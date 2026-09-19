// Community allowlist (whitelist) for the free-mint path.
//
// Why: 1-per-address does nothing against an attacker with 500 addresses.
// The gate that actually works is 1-per-verified-muse-identity, and only
// identities that existed AND participated before the announcement date.
//
// data/whitelist.json is built by scripts/build-whitelist.js from a musebook
// export. It holds salted identity hashes (HMAC-SHA256 with HASH_SALT), never
// raw muse ids. If the file is missing the voucher endpoint fails CLOSED
// (503) instead of letting everyone through.
const fs = require('fs');
const path = require('path');
const { hash } = require('./hash');

const FILE = path.join(__dirname, '..', 'data', 'whitelist.json');

function loadWhitelist() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    const err = new Error('Community allowlist is not loaded yet.');
    err.code = 'WHITELIST_UNAVAILABLE';
    throw err;
  }
  const list = JSON.parse(raw);
  const byHash = new Map(list.map((e) => [e.identity_hash, e]));
  return {
    size: list.length,
    // Returns the whitelist entry for a muse id, or null.
    check(museId) {
      return byHash.get(hash(museId)) || null;
    },
  };
}

module.exports = { loadWhitelist, FILE };
