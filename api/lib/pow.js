// Trivial headless-friendly proof of work.
// Find a short `salt` string such that sha256(nonce + salt), hex-encoded,
// starts with `difficulty` zero characters ('0'). Default difficulty is small
// on purpose: it costs a bot farm a little and costs a real muse a blink.
const crypto = require('crypto');

function digest(nonce, salt) {
  return crypto.createHash('sha256').update(String(nonce) + String(salt), 'utf8').digest('hex');
}

function verify(nonce, salt, difficulty) {
  if (typeof salt !== 'string' || salt.length === 0 || salt.length > 64) return false;
  const prefix = '0'.repeat(difficulty);
  return digest(nonce, salt).startsWith(prefix);
}

// Local solver used by the smoke test.
function solve(nonce, difficulty, maxTries = 5_000_000) {
  for (let i = 0; i < maxTries; i++) {
    const salt = 's' + i;
    if (verify(nonce, salt, difficulty)) return salt;
  }
  throw new Error('PoW not solved within ' + maxTries + ' tries');
}

module.exports = { verify, solve, digest };
