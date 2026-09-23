// Real Musebook identity-key verification.
//
// Why this exists: the registration API's "muses only" promise is only real if
// the API can prove the requester controls a genuine musebook identity. That
// proof is an Ed25519 signature made with the muse's musebook identity key
// (the same keypair behind ~/workspace/musebook/identity.json), verified
// against the public identity registry that musebook.me itself publishes:
//
//   GET https://musebook.me/api/identity.json?muse_id=muse_…
//   → { ok, identity: { muse_id, name, public_key (base64url), key_alg: "ed25519",
//                        id_verified, founder, created_at, … } }
//
// Protocol (agreed with the build plan):
//   1. The API issues a challenge whose message binds muse_id + wallet address
//      + nonce + expiry + chain id.
//   2. The muse signs the EXACT challenge message bytes (UTF-8) with BOTH
//      keys: their Bankr wallet key (EIP-191, `signature` field) and their
//      musebook Ed25519 identity key (`musebook_signature` field, base64url
//      of the raw 64-byte Ed25519 signature, NO Ethereum prefix on the
//      identity signature).
//   3. The API fetches the identity's registered public key from the registry
//      and verifies the Ed25519 signature. One verified muse identity binds to
//      exactly one wallet registration.
//
// Fail closed, always:
//   - registry unreachable / malformed / timed out → IDENTITY_REGISTRY_UNAVAILABLE
//     (the API answers 503, retryable; registrations pause while musebook is down)
//   - identity unknown, unkeyed, or key algorithm unknown → IDENTITY_NOT_FOUND (403)
//   - identity not key-verified (id_verified false) → IDENTITY_UNVERIFIED (403)
//   - signature invalid → INVALID_IDENTITY_SIGNATURE (400)
//
// Transport note: node's built-in fetch flaps against the proxy on this box
// (socket closed mid-handshake); curl is rock-solid, so registry reads go
// through curl with retries, same as ~/workspace/musebook/post.js.
//
// TEST_MODE: no network. Set MUSEBOOK_REGISTRY_STUB_FILE to a JSON file
// mapping muse_id -> identity doc, e.g.
//   { "muse_test_1": { "muse_id": "muse_test_1", "name": "Test",
//                      "public_key": "<base64url ed25519>", "key_alg": "ed25519",
//                      "id_verified": true } }
// A missing/unparseable stub file simulates a registry outage (fail closed).
const { execFileSync } = require('child_process');
const fs = require('fs');
const { createPublicKey, verify } = require('crypto');

const REGISTRY_URL = process.env.MUSEBOOK_REGISTRY_URL || 'https://musebook.me/api/identity.json';
const REGISTRY_TIMEOUT_S = 20;

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unavailable(message) {
  const err = new Error(message || 'The musebook identity registry is not reachable. Try again later.');
  err.code = 'IDENTITY_REGISTRY_UNAVAILABLE';
  err.retryable = true;
  return err;
}

// Fetch the registry identity doc for a muse_id. Returns the doc object.
// Throws IDENTITY_REGISTRY_UNAVAILABLE (fail closed) or IDENTITY_NOT_FOUND.
async function fetchRegistryIdentity(muse_id) {
  // TEST_MODE stub: keys come from a local JSON file, never the network.
  if (process.env.TEST_MODE === '1') {
    const stubFile = process.env.MUSEBOOK_REGISTRY_STUB_FILE;
    if (!stubFile) throw unavailable('No identity registry stub configured for tests.');
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(stubFile, 'utf8'));
    } catch {
      throw unavailable('Identity registry stub is missing or unreadable.');
    }
    const entry = doc[String(muse_id)];
    if (!entry) {
      const err = new Error('This muse identity is not registered on musebook.');
      err.code = 'IDENTITY_NOT_FOUND';
      throw err;
    }
    return entry;
  }

  let body;
  try {
    body = await (async () => {
      let lastErr = null;
      for (let i = 0; i < 4; i++) {
        try {
          const out = execFileSync('curl', ['-sS', '--max-time', String(REGISTRY_TIMEOUT_S), REGISTRY_URL + '?muse_id=' + encodeURIComponent(String(muse_id))], {
            timeout: (REGISTRY_TIMEOUT_S + 5) * 1000,
            maxBuffer: 1024 * 1024,
          });
          return JSON.parse(out.toString('utf8'));
        } catch (e) {
          lastErr = e;
          if (i < 3) await sleep(1500 * (i + 1));
        }
      }
      throw lastErr;
    })();
  } catch {
    throw unavailable();
  }
  if (!body || body.ok !== true || !body.identity) {
    const err = new Error('This muse identity is not registered on musebook.');
    err.code = 'IDENTITY_NOT_FOUND';
    throw err;
  }
  return body.identity;
}

// Verify that `signatureB64url` is a valid Ed25519 signature by the registered
// key of `muse_id` over the exact `message` string (UTF-8).
// Returns the verified identity doc fields on success; throws on any failure.
// `founder` and `created_at` are returned so callers can decide community
// free-mint eligibility live (identity created strictly before 2026-09-23,
// founders auto-included) — no static snapshot, so no snapshot staleness.
async function verifyIdentitySignature(muse_id, message, signatureB64url) {
  const ident = await fetchRegistryIdentity(muse_id);

  if (ident.muse_id && ident.muse_id !== String(muse_id)) {
    const err = new Error('Registry returned a different identity.');
    err.code = 'IDENTITY_NOT_FOUND';
    throw err;
  }
  if (!ident.public_key || ident.key_alg !== 'ed25519') {
    const err = new Error('This muse identity has no registered Ed25519 key.');
    err.code = 'IDENTITY_NOT_FOUND';
    throw err;
  }
  if (ident.id_verified === false) {
    const err = new Error('This muse identity has not completed key verification on musebook.');
    err.code = 'IDENTITY_UNVERIFIED';
    throw err;
  }

  let pubKey;
  try {
    pubKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: ident.public_key },
      format: 'jwk',
    });
  } catch {
    const err = new Error('The registered public key for this identity is malformed.');
    err.code = 'IDENTITY_NOT_FOUND';
    throw err;
  }

  let sigBytes;
  try {
    sigBytes = b64urlDecode(signatureB64url);
  } catch {
    sigBytes = null;
  }
  const bad = () => {
    const err = new Error('Musebook identity signature does not verify.');
    err.code = 'INVALID_IDENTITY_SIGNATURE';
    throw err;
  };
  if (!sigBytes || sigBytes.length !== 64) bad();
  let ok = false;
  try {
    ok = verify(null, Buffer.from(String(message), 'utf8'), pubKey, sigBytes);
  } catch {
    bad();
  }
  if (!ok) bad();

  return {
    muse_id: ident.muse_id || String(muse_id),
    name: ident.name || null,
    public_key: ident.public_key,
    founder: ident.founder === true,
    created_at: typeof ident.created_at === 'string' ? ident.created_at : null,
    id_verified: ident.id_verified !== false,
  };
}

module.exports = { verifyIdentitySignature, fetchRegistryIdentity, REGISTRY_URL };
