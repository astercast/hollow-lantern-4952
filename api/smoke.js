// Smoke test for the Muse Dogs API scaffold.
// Run: TEST_MODE=1 node smoke.js
// Spins up the server in-process, exercises every endpoint, and verifies
// the happy path, duplicates, unknown fields, fail-closed behavior, and the
// discovery document. Exits non-zero on the first failure.
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const { generateKeyPairSync, createPrivateKey, sign: cryptoSign, randomBytes } = require('node:crypto');
const fs = require('fs');
const path = require('path');
// NOTE: there is no proof-of-work anywhere in the claim flow by design
// (address as plain text + one musebook identity signature; per-IP rate
// limiting is the spam control), so no PoW solver is used here.
const { hash } = require('./lib/hash');

const PORT = 4137;
const BASE = 'http://127.0.0.1:' + PORT;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// Ed25519 identity keys for the test muses, mirroring the real musebook
// identity-key flow: the muse signs the exact challenge message bytes with its
// musebook identity key (base64url, 64 bytes); the API verifies the signature
// against the public-key registry.
function makeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyB64: publicKey.export({ format: 'jwk' }).x,
    privateKey: createPrivateKey({ key: privateKey.export({ format: 'jwk' }), format: 'jwk' }),
  };
}
function identitySig(ident, message) {
  return cryptoSign(null, Buffer.from(message, 'utf8'), ident.privateKey).toString('base64url');
}
const identities = {
  muse_smoke_1: makeIdentity(),
  muse_smoke_3: makeIdentity(),
  muse_smoke_7: makeIdentity(),
  muse_smoke_9: makeIdentity(),
  muse_forged: makeIdentity(), // never appears in the registry stub
};

// Registry stub: muse_id -> public key doc. Rewritten mid-run for the
// fail-closed identity tests (missing identity, missing registry file).
const REG_STUB_PATH = path.join(__dirname, 'data', 'identity-registry-stub.json');
function writeRegistryStub(idMap) {
  const doc = {};
  for (const [muse_id, ident] of Object.entries(idMap)) {
    doc[muse_id] = { muse_id, name: muse_id, public_key: ident.publicKeyB64, key_alg: 'ed25519', id_verified: true };
  }
  fs.writeFileSync(REG_STUB_PATH, JSON.stringify(doc, null, 2));
}
writeRegistryStub({ muse_smoke_1: identities.muse_smoke_1, muse_smoke_3: identities.muse_smoke_3, muse_smoke_7: identities.muse_smoke_7, muse_smoke_9: identities.muse_smoke_9 });

function log(ok, label) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  if (!ok) { server.kill(); process.exit(1); }
}

async function api(method, pathName, body) {
  const res = await fetch(BASE + pathName, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

// Start from a clean database every run.
try { fs.unlinkSync(DB_PATH); } catch { /* first run */ }
// Seed the community allowlist (whitelist) for the voucher tests.
const WL_PATH = path.join(__dirname, 'data', 'whitelist.json');
fs.writeFileSync(WL_PATH, JSON.stringify([
  { identity_hash: hash('muse_smoke_9'), approved_at: '2026-09-18', reason: 'smoke test allowlist' },
  { identity_hash: hash('muse_smoke_1'), approved_at: '2026-09-18', reason: 'smoke test allowlist' },
], null, 2));
const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), TEST_MODE: '1', MOCK_MDOG_BALANCE: '2000000000000000000000', MOCK_BLOCK: '424242', MOCK_MDOG_USD_PRICE: '0.01', MUSEBOOK_REGISTRY_STUB_FILE: REG_STUB_PATH,
    // The voucher endpoint fails closed without these; the smoke run signs
    // real EIP-712 vouchers with a throwaway test key.
    VOUCHER_SIGNER_KEY: '0x' + randomBytes(32).toString('hex'),
    CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
    // The in-process suite fires ~100 requests from one IP in seconds; the
    // production default (60/min) is the spam control, but the harness
    // needs headroom. A dedicated rate-limit test below pins the default.
    RATE_LIMIT_PER_MIN: '1000' },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/v1/config'); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('server did not start');
  server.kill();
  process.exit(1);
}

(async () => {
  await waitForServer();

  // 1. config
  let r = await api('GET', '/api/v1/config');
  log(r.status === 200 && r.json.chain_id === 4663, 'config: chain 4663');
  log(r.json.mdog_contract === '0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC', 'config: MDOG contract');
  log(r.json.holder_threshold_usd === 10, 'config: $10 threshold');

  // 2. challenge
  const wallet = ethers.Wallet.createRandom();
  r = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_1', address: wallet.address });
  log(r.status === 200 && !!r.json.challenge_id && !!r.json.message, 'challenge: issued');
  // Locked design: no proof-of-work and no wallet signature anywhere in
  // the claim flow — the muse pastes its Bankr address as plain text and
  // signs the challenge with its musebook identity key only.
  log(!r.json.proof_of_work, 'challenge: no proof-of-work in response');
  const challenge = r.json;

  // 3. reject unknown fields
  const bad = await api('POST', '/api/v1/challenge', { muse_id: 'x', address: wallet.address, evil: 1 });
  log(bad.status === 400 && bad.json.error === 'UNKNOWN_FIELDS', 'challenge: unknown fields rejected');

  // 4. sign the challenge with the musebook identity key and register.
  // No wallet signature, no PoW: the address is plain text.
  const idem = 'smoke-key-1';
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1',
    address: wallet.address,
    challenge_id: challenge.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_1, challenge.message),
    idempotency_key: idem,
  });
  log(r.status === 200 && r.json.status === 'registered' && r.json.allocation === null, 'register: muse registered (no balance check at registration — the $10 MDOG check happens on mint day, on-chain)');
  log(r.json.recheck_required === false && !!r.json.status_path, 'register: response shape from plan');
  log(r.json.community_eligible === true && r.json.holder_path === 'open', 'register: allowlisted muse sees community_eligible true, holder path open');
  const regId = r.json.registration_id;

  // 5. idempotency: same key replays the same response
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1', address: wallet.address, challenge_id: challenge.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_1, challenge.message),
    idempotency_key: idem,
  });
  log(r.status === 200 && r.json.registration_id === regId, 'register: idempotent replay');

  // 5c. same idempotency key claimed by a DIFFERENT muse is rejected outright
  const c5c = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_9', address: wallet.address });
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_9', address: wallet.address, challenge_id: c5c.json.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_9, c5c.json.message),
    idempotency_key: idem,
  });
  log(r.status === 409 && r.json.error === 'IDEMPOTENCY_KEY_REUSED', 'register: idempotency key of another muse rejected');

  // 5d. same key + same muse but DIFFERENT payload is rejected (must use a fresh key)
  const w5d = ethers.Wallet.createRandom();
  const c5d = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_1', address: w5d.address });
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1', address: w5d.address, challenge_id: c5d.json.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_1, c5d.json.message),
    idempotency_key: idem,
  });
  log(r.status === 409 && r.json.error === 'IDEMPOTENCY_KEY_REUSED', 'register: idempotency key with different payload rejected');


  // 5b. the legacy proof bundle (wallet signature + proof of work) is REJECTED:
  // strictBody allows only the locked fields.
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1', address: wallet.address, challenge_id: challenge.challenge_id,
    signature: '0x' + '11'.repeat(65), pow_result: 's1',
    musebook_signature: identitySig(identities.muse_smoke_1, challenge.message),
    idempotency_key: 'smoke-key-legacy',
  });
  log(r.status === 400 && r.json.error === 'UNKNOWN_FIELDS', 'register: legacy wallet-signature/PoW fields rejected');

  // 6. duplicate identity rejected
  const w2 = ethers.Wallet.createRandom();
  const c2b = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_1', address: w2.address });
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1', address: w2.address, challenge_id: c2b.json.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_1, c2b.json.message),
    idempotency_key: 'smoke-key-dup',
  });
  log(r.status === 409 && r.json.error === 'DUPLICATE_IDENTITY', 'register: duplicate identity rejected');

  // 6b. duplicate wallet: a different whitelisted muse cannot reuse the address.
  // Reuses the (muse_smoke_9, wallet.address) challenge from 5c — it was never
  // consumed because the idempotency check rejected that request first.
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_9', address: wallet.address, challenge_id: c5c.json.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_9, c5c.json.message),
    idempotency_key: 'smoke-key-dup-wallet',
  });
  log(r.status === 409 && r.json.error === 'DUPLICATE_WALLET', 'register: duplicate wallet rejected');

  // 7. challenge single-use: reuse of consumed challenge
  const w3re = ethers.Wallet.createRandom();
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_3', address: w3re.address,
    challenge_id: challenge.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_3, challenge.message),
    idempotency_key: 'smoke-key-reuse',
  });
  log(r.status === 400 && r.json.error === 'INVALID_CHALLENGE', 'register: wrong muse on challenge rejected');

  // 7a. consumed challenge: the original registration (test 4) consumed
  // `challenge`; replaying it with a fresh idempotency key is refused.
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1', address: wallet.address,
    challenge_id: challenge.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_1, challenge.message),
    idempotency_key: 'smoke-key-consumed',
  });
  log(r.status === 400 && r.json.error === 'EXPIRED_CHALLENGE', 'register: consumed challenge rejected');

  // 7b. holder path open: a verified musebook identity NOT on the
  // community allowlist registers fine. The holder path needs no allowlist —
  // any verified muse gets in; the response says which paths are open.
  const w_nh = ethers.Wallet.createRandom();
  const cnh = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_7', address: w_nh.address });
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_7', address: w_nh.address, challenge_id: cnh.json.challenge_id,
    musebook_signature: identitySig(identities.muse_smoke_7, cnh.json.message),
    idempotency_key: 'smoke-key-nh',
  });
  log(r.status === 200 && r.json.status === 'registered' && r.json.community_eligible === false && r.json.holder_path === 'open',
    'register: non-allowlisted verified muse registers (holder path open, community_eligible false)');

  // 8. status
  r = await api('GET', '/api/v1/status/' + regId);
  log(r.status === 200 && r.json.allocation === null && r.json.distribution_status === 'registered', 'status: registration found');

  // 9. receipt (stub)
  r = await api('GET', '/api/v1/receipt/' + regId);
  log(r.status === 200 && r.json.tx_hash === null, 'receipt: pending stub');

  // 10. community and holder paths are INDEPENDENT: a holder-eligible muse
  // still gets a community voucher. There is no ALREADY_HOLDER block — the
  // locked design lets a muse eligible on both paths use both.
  // Voucher requests carry the identity proof only: a challenge bound to
  // (muse_id, address) plus the musebook Ed25519 identity signature.
  // No wallet signature, no proof of work — by design.
  async function attemptVoucher(muse_id, wallet, idKey, idemKey, mutate, route) {
    const c = await api('POST', '/api/v1/challenge', { muse_id, address: wallet.address });
    if (c.status !== 200) return { status: c.status, json: c.json };
    const body = {
      muse_id, address: wallet.address, challenge_id: c.json.challenge_id,
      idempotency_key: idemKey,
    };
    if (idKey !== undefined) body.musebook_signature = identitySig(idKey, c.json.message);
    if (mutate) mutate(body, c.json);
    return api('POST', '/api/v1/' + (route || 'community-voucher'), body);
  }
  async function attemptHolderVoucher(muse_id, wallet, idKey, idemKey, mutate) {
    return attemptVoucher(muse_id, wallet, idKey, idemKey, mutate, 'holder-voucher');
  }

  r = await attemptVoucher('muse_smoke_1', wallet, identities.muse_smoke_1, 'smoke-v1');
  log(r.status === 200 && r.json.voucher.chainId === 4663 && r.json.voucher.price === 0, 'voucher: holder-eligible muse gets a community voucher too (paths independent)');

  // 11. each path allows 3 vouchers per address and 3 per muse identity.
  const w3 = ethers.Wallet.createRandom();
  for (let i = 2; i <= 4; i++) {
    r = await attemptVoucher('muse_smoke_9', w3, identities.muse_smoke_9, 'smoke-v' + i);
  }
  log(r.status === 200 && r.json.community_vouchers_for_address === 3 && r.json.community_vouchers_cap_per_address === 3, 'voucher: 3 vouchers per address issued');
  r = await attemptVoucher('muse_smoke_9', w3, identities.muse_smoke_9, 'smoke-v5');
  log(r.status === 409 && r.json.error === 'ADDRESS_VOUCHER_CAP_REACHED', 'voucher: 4th voucher for same address refused');

  // 11c. same whitelisted identity, NEW address — the identity already used
  // its 3, so it is refused (per-identity cap, not per-address).
  const w5 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w5, identities.muse_smoke_9, 'smoke-v6');
  log(r.status === 409 && r.json.error === 'IDENTITY_VOUCHER_CAP_REACHED', 'voucher: 3-per-identity cap enforced');

  // 11b. non-whitelisted identity is refused, even with a fresh address
  const w4 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_7', w4, identities.muse_smoke_7, 'smoke-v7');
  log(r.status === 403 && r.json.error === 'NOT_WHITELISTED', 'voucher: non-whitelisted identity refused');

  // 11e. human-style request: muse name + address but no proof at all
  const w6b = ethers.Wallet.createRandom();
  r = await api('POST', '/api/v1/community-voucher', {
    muse_id: 'muse_smoke_9', address: w6b.address, idempotency_key: 'smoke-v8',
  });
  log(r.status === 400 && r.json.error === 'MISSING_FIELD', 'voucher: name-and-address alone refused, proof required (humans out)');

  // 11f. forged identity signature on the voucher path
  const w7 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w7, identities.muse_forged, 'smoke-v9');
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'voucher: forged identity signature rejected');

  // 11g. the legacy proof bundle (wallet signature + proof of work) is rejected
  const w8 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w8, identities.muse_smoke_9, 'smoke-v10', (body) => {
    body.signature = '0x' + '11'.repeat(65);
    body.pow_result = 's1';
  });
  log(r.status === 400 && r.json.error === 'UNKNOWN_FIELDS', 'voucher: legacy wallet-signature/PoW fields rejected');

  // 11d. allowlist missing -> fail closed, nobody gets through
  fs.unlinkSync(WL_PATH);
  const w6 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w6, identities.muse_smoke_9, 'smoke-v11');
  log(r.status === 503 && r.json.error === 'WHITELIST_UNAVAILABLE', 'voucher: fails closed without allowlist');
  // Re-seed for the tests below (register calls need the allowlist present
  // to report community_eligible accurately).
  fs.writeFileSync(WL_PATH, JSON.stringify([
    { identity_hash: hash('muse_smoke_9'), approved_at: '2026-09-18', reason: 'smoke test allowlist' },
    { identity_hash: hash('muse_smoke_1'), approved_at: '2026-09-18', reason: 'smoke test allowlist' },
  ], null, 2));

  // 11h. holder vouchers: the holder path needs only a registration with a
  // verified identity. The $10 MDOG check is NOT done here — it happens on
  // mint day, on-chain (the multisig sets holderThresholdMDOG and the
  // contract checks the recipient wallet at mint time).
  r = await attemptHolderVoucher('muse_smoke_1', wallet, identities.muse_smoke_1, 'smoke-h1');
  log(r.status === 200 && r.json.voucher.mintType === 1 && r.json.voucher.allocation === 'HOLDER'
    && r.json.holder_vouchers_for_address === 1 && r.json.holder_vouchers_cap_per_address === 3
    && r.json.vouchers_cap === 100,
    'holder-voucher: holder-eligible muse gets a holder voucher (mintType 1, 3 per address)');

  // Fixture: holder-path registrations for muse_smoke_7 on two addresses.
  // Registration alone is enough for a holder voucher now — the $10 MDOG
  // check happens on mint day, on-chain, not at registration.
  // muse_smoke_7 and muse_smoke_3 are used here so muse_smoke_9 stays free for
  // the fresh-registration test later (one registration per muse identity).
  const w9 = ethers.Wallet.createRandom();
  const w9b = ethers.Wallet.createRandom();
  {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const regFixture = (muse_id, addr) => ({
      registration_id: 'reg-smoke-h-' + addr.slice(2, 10),
      muse_id,
      address: ethers.getAddress(addr),
      muse_id_hash: hash(muse_id),
      address_hash: hash(addr.toLowerCase()),
      allocation: 'holder',
      created_at: new Date().toISOString(),
    });
    db.registrations.push(regFixture('muse_smoke_7', w9.address), regFixture('muse_smoke_7', w9b.address));
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }

  // 11i. holder path: 3 per address, then refused.
  for (let i = 2; i <= 4; i++) {
    r = await attemptHolderVoucher('muse_smoke_7', w9, identities.muse_smoke_7, 'smoke-h' + i);
  }
  log(r.status === 200 && r.json.holder_vouchers_for_address === 3, 'holder-voucher: 3 vouchers per address issued');
  r = await attemptHolderVoucher('muse_smoke_7', w9, identities.muse_smoke_7, 'smoke-h5');
  log(r.status === 409 && r.json.error === 'ADDRESS_VOUCHER_CAP_REACHED', 'holder-voucher: 4th voucher for same address refused');

  // 11j. holder path: 3 per identity, then refused on a new address.
  r = await attemptHolderVoucher('muse_smoke_7', w9b, identities.muse_smoke_7, 'smoke-h6');
  log(r.status === 409 && r.json.error === 'IDENTITY_VOUCHER_CAP_REACHED', 'holder-voucher: 3-per-identity cap enforced');

  // 11k. holder path: unregistered muse is refused (a stored registration
  // with a verified identity is still required for the holder path).
  const w11 = ethers.Wallet.createRandom();
  r = await attemptHolderVoucher('muse_smoke_3', w11, identities.muse_smoke_3, 'smoke-h7');
  log(r.status === 403 && r.json.error === 'NOT_REGISTERED', 'holder-voucher: unregistered muse refused');

  // 11k2. holder path: a muse NOT on the community allowlist registers
  // through the real API (no fixture) and gets a holder voucher. No balance
  // check here — the $10 MDOG check happens on mint day, on-chain.
  const w11b = ethers.Wallet.createRandom();
  {
    const c = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_3', address: w11b.address });
    const rr = await api('POST', '/api/v1/register', {
      muse_id: 'muse_smoke_3', address: w11b.address, challenge_id: c.json.challenge_id,
      musebook_signature: identitySig(identities.muse_smoke_3, c.json.message),
      idempotency_key: 'smoke-h7b-reg',
    });
    log(rr.status === 200 && rr.json.status === 'registered' && rr.json.community_eligible === false,
      'register: non-allowlisted muse registers via the API for the holder path');
  }
  r = await attemptHolderVoucher('muse_smoke_3', w11b, identities.muse_smoke_3, 'smoke-h7b');
  log(r.status === 200 && r.json.voucher.mintType === 1, 'holder-voucher: registered non-allowlisted muse gets holder voucher (check is on mint day)');

  // 11k3. the same non-allowlisted muse CANNOT take the community free mint.
  r = await attemptVoucher('muse_smoke_3', w11b, identities.muse_smoke_3, 'smoke-h7c');
  log(r.status === 403 && r.json.error === 'NOT_WHITELISTED', 'community-voucher: non-allowlisted holder-path muse refused the free mint');

  // 11l. holder path: forged identity signature rejected.
  const w12 = ethers.Wallet.createRandom();
  r = await attemptHolderVoucher('muse_smoke_1', w12, identities.muse_forged, 'smoke-h8');
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'holder-voucher: forged identity signature rejected');

  // 11m. holder path: legacy wallet-signature/PoW fields rejected.
  const w13 = ethers.Wallet.createRandom();
  r = await attemptHolderVoucher('muse_smoke_1', w13, identities.muse_smoke_1, 'smoke-h9', (body) => {
    body.signature = '0x' + '11'.repeat(65);
    body.pow_result = 's1';
  });
  log(r.status === 400 && r.json.error === 'UNKNOWN_FIELDS', 'holder-voucher: legacy wallet-signature/PoW fields rejected');

  // 12. discovery doc
  r = await api('GET', '/.well-known/muse-dog.json');
  log(r.status === 200 && r.json.contracts.mdog && r.json.endpoints.register, 'well-known: discovery doc');
  log(r.json.registration.needs.includes('musebook_identity_signature'), 'well-known: identity proof documented');
  log(!r.json.registration.needs.includes('wallet_signature') && !r.json.registration.needs.includes('proof_of_work'), 'well-known: no wallet signature or PoW in the proof bundle');
  log(!r.json.registration.wallet_proof && !r.json.registration.proof_of_work, 'well-known: no wallet/PoW proof blocks');

  // ---- identity verification tests — added 2026-09-18 ----
  // (The allowlist was re-seeded right after test 11d for the register
  // calls below.)
  // Helper: full registration attempt for a muse with a chosen identity key.
  // Identity proof only: challenge + musebook Ed25519 identity signature.
  async function attemptRegister(muse_id, idemKey, idKey, idKeyFor) {
    const w = ethers.Wallet.createRandom();
    const c = await api('POST', '/api/v1/challenge', { muse_id, address: w.address });
    if (c.status !== 200) return { status: c.status, json: c.json };
    const body = {
      muse_id, address: w.address, challenge_id: c.json.challenge_id,
      idempotency_key: idemKey,
    };
    if (idKey !== undefined) {
      body.musebook_signature = identitySig(idKey, c.json.message);
    }
    const rr = await api('POST', '/api/v1/register', body);
    return rr;
  }

  // 13. happy path: real Ed25519 identity signature verifies against the registry
  r = await attemptRegister('muse_smoke_9', 'smoke-id-13a', identities.muse_smoke_9);
  log(r.status === 200 && r.json.status === 'registered', 'identity: valid Ed25519 signature registers');
  log(r.json.community_eligible === true, 'identity: allowlisted muse sees community_eligible true');

  // 14. forged signature (signed with a key NOT registered for this identity)
  r = await attemptRegister('muse_smoke_9', 'smoke-id-14', identities.muse_forged);
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'identity: forged signature rejected');

  // 15. malformed identity signature
  {
    const w = ethers.Wallet.createRandom();
    const c = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_9', address: w.address });
    r = await api('POST', '/api/v1/register', {
      muse_id: 'muse_smoke_9', address: w.address, challenge_id: c.json.challenge_id,
      musebook_signature: 'not-a-valid-signature!!!',
      idempotency_key: 'smoke-id-15b',
    });
  }
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'identity: malformed signature rejected');

  // 16. missing musebook_signature entirely
  r = await attemptRegister('muse_smoke_9', 'smoke-id-16', undefined);
  log(r.status === 400 && r.json.error === 'MISSING_FIELD', 'identity: signature is required, not optional');

  // 17. identity not in the registry -> 403 (fail closed, no registration)
  writeRegistryStub({ muse_smoke_1: identities.muse_smoke_1 }); // drops muse_smoke_9
  r = await attemptRegister('muse_smoke_9', 'smoke-id-17', identities.muse_smoke_9);
  log(r.status === 403 && r.json.error === 'IDENTITY_NOT_FOUND', 'identity: unknown muse identity refused (403)');
  writeRegistryStub({ muse_smoke_1: identities.muse_smoke_1, muse_smoke_3: identities.muse_smoke_3, muse_smoke_7: identities.muse_smoke_7, muse_smoke_9: identities.muse_smoke_9 });

  // 18. registry unreachable (stub file deleted) -> 503 fail closed, retryable
  fs.unlinkSync(REG_STUB_PATH);
  r = await attemptRegister('muse_smoke_9', 'smoke-id-18', identities.muse_smoke_9);
  log(r.status === 503 && r.json.error === 'IDENTITY_REGISTRY_UNAVAILABLE' && r.json.retryable === true, 'identity: registry outage fails closed (503)');
  writeRegistryStub({ muse_smoke_1: identities.muse_smoke_1, muse_smoke_3: identities.muse_smoke_3, muse_smoke_7: identities.muse_smoke_7, muse_smoke_9: identities.muse_smoke_9 });

  // 19. wrong-message signature: valid key, wrong message -> rejected
  {
    const w = ethers.Wallet.createRandom();
    const c = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_9', address: w.address });
    r = await api('POST', '/api/v1/register', {
      muse_id: 'muse_smoke_9', address: w.address, challenge_id: c.json.challenge_id,
      musebook_signature: identitySig(identities.muse_smoke_9, 'tampered message'),
      idempotency_key: 'smoke-id-19',
    });
  }
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'identity: signature over wrong message rejected');

  // ---- price feed tests — added 2026-09-18 ----
  const { getMdogUsdPrice, _agreeOnPrice, _clearCache } = require('./lib/price');

  // P1. config is honest: no price feed participates in registration or
  // vouchers; the holder check happens on-chain at mint time, by design.
  r = await api('GET', '/api/v1/config');
  log(r.json.holder_check === 'on-chain at mint time' && r.json.price_feed === 'unused', 'price: config reports the on-chain holder check, no live feed');

  // P2. TEST_MODE stub returns the mocked price with provenance fields
  _clearCache();
  const stub = await getMdogUsdPrice({ TEST_MODE: '1', MOCK_MDOG_USD_PRICE: '0.02' });
  log(stub.price_usd === 0.02 && stub.sources[0] === 'test-stub' && !!stub.fetched_at, 'price: test stub returns mocked price');

  // P3. live mode with no providers fails closed, never approves
  _clearCache();
  let pthrew = null;
  try { await getMdogUsdPrice({ TEST_MODE: '0' }); } catch (e) { pthrew = e; }
  log(!!pthrew && pthrew.code === 'PRICE_UNAVAILABLE' && pthrew.retryable === true, 'price: fails closed with no sources configured');

  // P4. source disagreement fails closed
  pthrew = null;
  try { _agreeOnPrice(0.00004, 0.00006, 20); } catch (e) { pthrew = e; }
  log(!!pthrew && pthrew.code === 'PRICE_DISAGREEMENT' && pthrew.retryable === true, 'price: >20% disagreement fails closed');
  pthrew = null;
  try { _agreeOnPrice(0.00004, 0.000041, 20); } catch (e) { pthrew = e; }
  log(pthrew === null, 'price: small deviation agrees');

  // P5. the holder check is on mint day, on-chain — the status endpoint no
  // longer carries a registration-time price decision.
  r = await api('GET', '/api/v1/status/' + regId);
  log(r.status === 200 && r.json.holder_check && r.json.holder_check.includes('mint day'), 'price: status points to the mint-day holder check');

  // ---- holder rewards — added 2026-09-19 ----
  const { spawnSync } = require('child_process');
  const REWARDS_DIR = path.join(__dirname, 'data', 'rewards');
  // Wipe first: a crashed run must never leave fixture data behind.
  fs.rmSync(REWARDS_DIR, { recursive: true, force: true });

  // R1. rewards config shape (200)
  r = await api('GET', '/api/v1/rewards/config');
  log(r.status === 200 && r.json.epoch_days === 7, 'rewards: config epoch_days=7');
  log(r.json.snapshot === 'daily 00:00 UTC' && r.json.payout === 'weekly', 'rewards: config snapshot/payout');
  log(typeof r.json.pot_source === 'string' && r.json.pot_source.includes('royalt'), 'rewards: config pot_source');
  log(typeof r.json.leaf_scheme === 'string' && r.json.leaf_scheme.includes('keccak256'), 'rewards: config leaf_scheme');
  log(r.json.data_dir === 'api/data/rewards', 'rewards: config data_dir');

  // R2. unknown epoch fails closed (404, no fake data)
  r = await api('GET', '/api/v1/rewards/claim?epoch=9999999999&holder=' + wallet.address);
  log(r.status === 404 && r.json.error === 'NOT_FOUND', 'rewards: unknown epoch 404');

  // R3. malformed inputs rejected
  r = await api('GET', '/api/v1/rewards/claim?epoch=notanumber&holder=' + wallet.address);
  log(r.status === 400 && r.json.error === 'INVALID_EPOCH', 'rewards: malformed epoch 400');
  r = await api('GET', '/api/v1/rewards/claim?epoch=1789344000&holder=notanaddress');
  log(r.status === 400 && r.json.error === 'INVALID_ADDRESS', 'rewards: malformed holder 400');

  // R4. end-to-end: 7 fixture snapshots -> rewards-publish.js -> epoch file ->
  //     independent known-vector check -> served by /claim -> cleaned up.
  //     Week 2026-09-14 is a Monday; epochId = 1789344000.
  const holderA = ethers.getAddress('0x' + '11'.repeat(20));
  const holderB = ethers.getAddress('0x' + '22'.repeat(20));
  const fixtureNft = ethers.getAddress('0x' + '33'.repeat(20));
  const snapDir = path.join(REWARDS_DIR, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  const weekDays = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'];
  for (const day of weekDays) {
    fs.writeFileSync(path.join(snapDir, day + '.json'), JSON.stringify({
      date: day, boundaryUtc: day + 'T00:00:00.000Z', blockNumber: 1000,
      nft: fixtureNft, chainId: 4663, balances: { [holderA]: 1, [holderB]: 2 },
    }));
  }
  // weights: A=7, B=14, total=21. pot=1000 -> A=floor(7000/21)=333,
  // B=floor(14000/21)=666, dust=1 -> B (largest weight). Final: A=333, B=667.
  const pub = spawnSync('node', ['scripts/rewards-publish.js', '--week', '2026-09-14', '--pot', '1000'], {
    cwd: __dirname, encoding: 'utf8',
  });
  log(pub.status === 0, 'rewards: publish script exits 0');
  const lastLine = (pub.stdout || '').trim().split('\n').pop() || '';
  log(pub.stdout.includes('publishRoot') && /^0x[0-9a-f]{8,}$/.test(lastLine),
    'rewards: publish script prints publishRoot calldata');
  const epochPath = path.join(REWARDS_DIR, 'epochs', '1789344000.json');
  let epoch = null;
  try { epoch = JSON.parse(fs.readFileSync(epochPath, 'utf8')); } catch { /* checked below */ }
  log(!!epoch && epoch.epochId === 1789344000, 'rewards: epoch file written with epochId');

  // Known vector, recomputed by an independent code path (no reuse of the
  // script's tree builder): 2 leaves -> root = sorted-pair hash of the two.
  function indepLeaf(addr, amountWei) {
    return ethers.keccak256(ethers.solidityPacked(['address', 'uint256'], [addr, BigInt(amountWei)]));
  }
  function indepPair(a, b) {
    const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    return ethers.keccak256(ethers.concat([x, y]));
  }
  const leafA = indepLeaf(holderA, 333);
  const leafB = indepLeaf(holderB, 667);
  const expectRoot = indepPair(leafA, leafB);
  log(epoch && epoch.root.toLowerCase() === expectRoot.toLowerCase(), 'rewards: root matches known vector');
  log(epoch && epoch.claims[holderA].amount === '333' && epoch.claims[holderB].amount === '667',
    'rewards: pro-rata shares with dust to largest holder (333/667 of 1000)');
  const sumClaims = Object.values(epoch.claims).reduce((s, c) => s + BigInt(c.amount), 0n);
  log(sumClaims === 1000n, 'rewards: claims sum exactly to the pot');
  // A's proof must be exactly [leafB]; walking it must land on the root
  // (this is what the Solidity OZ MerkleProof.verify check does).
  const proofA = epoch.claims[holderA].proof;
  log(proofA.length === 1 && proofA[0].toLowerCase() === leafB.toLowerCase(), 'rewards: proof of A is [leafB]');
  log(indepPair(leafA, proofA[0]).toLowerCase() === epoch.root.toLowerCase(), 'rewards: proof of A verifies against the root');

  // R5. served by the API
  r = await api('GET', '/api/v1/rewards/claim?epoch=1789344000&holder=' + holderA);
  log(r.status === 200 && r.json.epochId === 1789344000 && r.json.holder === holderA &&
    r.json.amount === '333' && r.json.root === epoch.root && r.json.totalAmount === '1000' &&
    Array.isArray(r.json.proof), 'rewards: claim served with full shape');
  r = await api('GET', '/api/v1/rewards/claim?epoch=1789344000&holder=' + wallet.address);
  log(r.status === 404 && r.json.error === 'NO_CLAIM', 'rewards: holder with no claim 404');

  // R6. fixture cleanup: the served data was test-only.
  fs.rmSync(REWARDS_DIR, { recursive: true, force: true });

  // R7. rate limit: the production default (60 req/IP/min, no env override)
  // still 429s — the spam control on the claim path. A second short-lived
  // server with the default env proves the default trips.
  {
    const rlPort = PORT + 1;
    const rlServer = spawn('node', ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(rlPort), TEST_MODE: '1', RATE_LIMIT_PER_MIN: '' },
      stdio: 'ignore',
    });
    const rlBase = 'http://127.0.0.1:' + rlPort;
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { const rr = await fetch(rlBase + '/api/v1/config'); if (rr.ok || rr.status === 429) up = true; } catch { /* not up */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    let saw429 = false;
    if (up) {
      for (let i = 0; i < 65; i++) {
        const rr = await fetch(rlBase + '/api/v1/config');
        if (rr.status === 429) { saw429 = true; break; }
      }
    }
    rlServer.kill();
    log(up && saw429, 'rate-limit: default 60/min trips 429 (spam control intact)');
  }

  console.log('\nAll smoke tests passed.');
  server.kill();
  process.exit(0);
})().catch((e) => { console.error('SMOKE ERROR', e); server.kill(); process.exit(1); });
