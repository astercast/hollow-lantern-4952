// Shared keyed one-way hash for identity/address lookups.
// Raw values are stored once; hashes are what get compared and whitelisted.
const crypto = require('crypto');

function hash(value) {
  const key = process.env.HASH_SALT || 'muse-dog-lol-dev-salt';
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
}

module.exports = { hash };
