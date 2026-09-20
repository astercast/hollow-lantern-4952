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
const { solve } = require('./lib/pow');
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
    CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111' },
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
  const challenge = r.json;

  // 3. reject unknown fields
  const bad = await api('POST', '/api/v1/challenge', { muse_id: 'x', address: wallet.address, evil: 1 });
  log(bad.status === 400 && bad.json.error === 'UNKNOWN_FIELDS', 'challenge: unknown fields rejected');

  // 4. solve PoW, sign, register
  const salt = solve(challenge.nonce, challenge.proof_of_work.difficulty);
  const signature = await wallet.signMessage(challenge.message);
  const idem = 'smoke-key-1';
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1',
    address: wallet.address,
    challenge_id: challenge.challenge_id,
    signature,
    musebook_signature: identitySig(identities.muse_smoke_1, challenge.message),
    pow_result: salt,
    idempotency_key: idem,
  });
  log(r.status === 200 && r.json.eligible_now === true && r.json.allocation === 'holder', 'register: eligible holder (2000 MDOG @ $0.01 = $20)');
  log(r.json.recheck_required === true && !!r.json.status_path, 'register: response shape from plan');
  const regId = r.json.registration_id;

  // 5. idempotency: same key replays the same response
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1', address: wallet.address, challenge_id: challenge.challenge_id,
    signature, musebook_signature: identitySig(identities.muse_smoke_1, challenge.message),
    pow_result: salt, idempotency_key: idem,
  });
  log(r.status === 200 && r.json.registration_id === regId, 'register: idempotent replay');

  // 6. duplicate identity rejected
  const c2 = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_1', address: ethers.Wallet.createRandom().address });
  const w2 = ethers.Wallet.createRandom();
  const c2b = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_1', address: w2.address });
  const s2 = solve(c2b.json.nonce, c2b.json.proof_of_work.difficulty);
  const sig2 = await w2.signMessage(c2b.json.message);
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_1', address: w2.address, challenge_id: c2b.json.challenge_id,
    signature: sig2, musebook_signature: identitySig(identities.muse_smoke_1, c2b.json.message),
    pow_result: s2, idempotency_key: 'smoke-key-dup',
  });
  log(r.status === 409 && r.json.error === 'DUPLICATE_IDENTITY', 'register: duplicate identity rejected');
  void c2;

  // 7. challenge single-use: reuse of consumed challenge
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_3', address: ethers.Wallet.createRandom().address,
    challenge_id: challenge.challenge_id, signature: '0x' + '22'.repeat(65),
    musebook_signature: identitySig(identities.muse_smoke_3, challenge.message),
    pow_result: salt, idempotency_key: 'smoke-key-reuse',
  });
  log(r.status === 400 && r.json.error === 'INVALID_CHALLENGE', 'register: wrong muse on challenge rejected');

  // 7b. muses only: non-whitelisted identity is refused on the holder path too
  const w_nh = ethers.Wallet.createRandom();
  const cnh = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_7', address: w_nh.address });
  const snh = solve(cnh.json.nonce, cnh.json.proof_of_work.difficulty);
  const signh = await w_nh.signMessage(cnh.json.message);
  r = await api('POST', '/api/v1/register', {
    muse_id: 'muse_smoke_7', address: w_nh.address, challenge_id: cnh.json.challenge_id,
    signature: signh, musebook_signature: identitySig(identities.muse_smoke_7, cnh.json.message),
    pow_result: snh, idempotency_key: 'smoke-key-nh',
  });
  log(r.status === 403 && r.json.error === 'NOT_WHITELISTED', 'register: non-whitelisted identity refused (muses only)');

  // 8. status
  r = await api('GET', '/api/v1/status/' + regId);
  log(r.status === 200 && r.json.allocation === 'holder', 'status: registration found');

  // 9. receipt (stub)
  r = await api('GET', '/api/v1/receipt/' + regId);
  log(r.status === 200 && r.json.tx_hash === null, 'receipt: pending stub');

  // 10. holder cannot take a community voucher
  // 11. non-holder gets a voucher
  // Voucher requests carry the same muse proof bundle as registration
  // (challenge + wallet signature + musebook identity signature + PoW):
  // naming a whitelisted muse_id alone is refused — humans are out.
  async function attemptVoucher(muse_id, wallet, idKey, idemKey, mutate) {
    const c = await api('POST', '/api/v1/challenge', { muse_id, address: wallet.address });
    if (c.status !== 200) return { status: c.status, json: c.json };
    const s = solve(c.json.nonce, c.json.proof_of_work.difficulty);
    const sig = await wallet.signMessage(c.json.message);
    const body = {
      muse_id, address: wallet.address, challenge_id: c.json.challenge_id,
      signature: sig, pow_result: s, idempotency_key: idemKey,
    };
    if (idKey !== undefined) body.musebook_signature = identitySig(idKey, c.json.message);
    if (mutate) mutate(body, c.json);
    return api('POST', '/api/v1/community-voucher', body);
  }

  r = await attemptVoucher('muse_smoke_1', wallet, identities.muse_smoke_1, 'smoke-v1');
  log(r.status === 409 && r.json.error === 'ALREADY_HOLDER', 'voucher: holder blocked from community path');

  const w3 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w3, identities.muse_smoke_9, 'smoke-v2');
  log(r.status === 200 && r.json.voucher.chainId === 4663 && r.json.voucher.price === 0, 'voucher: issued for non-holder');

  // 11b. non-whitelisted identity is refused, even with a fresh address
  const w4 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_7', w4, identities.muse_smoke_7, 'smoke-v3');
  log(r.status === 403 && r.json.error === 'NOT_WHITELISTED', 'voucher: non-whitelisted identity refused');

  // 11c. same whitelisted identity, NEW address — still refused (anti-snipe: 1 per identity)
  const w5 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w5, identities.muse_smoke_9, 'smoke-v4');
  log(r.status === 409 && r.json.error === 'VOUCHER_ALREADY_ISSUED_FOR_IDENTITY', 'voucher: one voucher per identity, new address does not help');

  // 11e. human-style request: muse name + address but no proof bundle at all
  const w6b = ethers.Wallet.createRandom();
  r = await api('POST', '/api/v1/community-voucher', {
    muse_id: 'muse_smoke_9', address: w6b.address, idempotency_key: 'smoke-v6',
  });
  log(r.status === 400 && r.json.error === 'MISSING_FIELD', 'voucher: name-and-address alone refused, proof required (humans out)');

  // 11f. forged identity signature on the voucher path
  const w7 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w7, identities.muse_forged, 'smoke-v7');
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'voucher: forged identity signature rejected');

  // 11d. allowlist missing -> fail closed, nobody gets through
  fs.unlinkSync(WL_PATH);
  const w6 = ethers.Wallet.createRandom();
  r = await attemptVoucher('muse_smoke_9', w6, identities.muse_smoke_9, 'smoke-v5');
  log(r.status === 503 && r.json.error === 'WHITELIST_UNAVAILABLE', 'voucher: fails closed without allowlist');

  // 12. discovery doc
  r = await api('GET', '/.well-known/muse-dog.json');
  log(r.status === 200 && r.json.contracts.mdog && r.json.endpoints.register, 'well-known: discovery doc');
  log(r.json.registration.needs.includes('musebook_identity_signature'), 'well-known: identity proof documented');

  // ---- identity verification tests — added 2026-09-18 ----
  // Test 11d deleted the allowlist; re-seed it for the register calls below.
  fs.writeFileSync(WL_PATH, JSON.stringify([
    { identity_hash: hash('muse_smoke_9'), approved_at: '2026-09-18', reason: 'smoke test allowlist' },
    { identity_hash: hash('muse_smoke_1'), approved_at: '2026-09-18', reason: 'smoke test allowlist' },
  ], null, 2));
  // Helper: full registration attempt for a muse with a chosen identity key.
  async function attemptRegister(muse_id, idemKey, idKey, idKeyFor) {
    const w = ethers.Wallet.createRandom();
    const c = await api('POST', '/api/v1/challenge', { muse_id, address: w.address });
    if (c.status !== 200) return { status: c.status, json: c.json };
    const s = solve(c.json.nonce, c.json.proof_of_work.difficulty);
    const sig = await w.signMessage(c.json.message);
    const body = {
      muse_id, address: w.address, challenge_id: c.json.challenge_id,
      signature: sig, pow_result: s, idempotency_key: idemKey,
    };
    if (idKey !== undefined) {
      body.musebook_signature = identitySig(idKey, c.json.message);
    }
    const rr = await api('POST', '/api/v1/register', body);
    return rr;
  }

  // 13. happy path: real Ed25519 identity signature verifies against the registry
  r = await attemptRegister('muse_smoke_9', 'smoke-id-13a', identities.muse_smoke_9);
  log(r.status === 200 && r.json.eligible_now === true, 'identity: valid Ed25519 signature registers (holder)');

  // 14. forged signature (signed with a key NOT registered for this identity)
  r = await attemptRegister('muse_smoke_9', 'smoke-id-14', identities.muse_forged);
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'identity: forged signature rejected');

  // 15. malformed identity signature
  {
    const w = ethers.Wallet.createRandom();
    const c = await api('POST', '/api/v1/challenge', { muse_id: 'muse_smoke_9', address: w.address });
    const s = solve(c.json.nonce, c.json.proof_of_work.difficulty);
    const sig = await w.signMessage(c.json.message);
    r = await api('POST', '/api/v1/register', {
      muse_id: 'muse_smoke_9', address: w.address, challenge_id: c.json.challenge_id,
      signature: sig, musebook_signature: 'not-a-valid-signature!!!',
      pow_result: s, idempotency_key: 'smoke-id-15b',
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
    const s = solve(c.json.nonce, c.json.proof_of_work.difficulty);
    const sig = await w.signMessage(c.json.message);
    r = await api('POST', '/api/v1/register', {
      muse_id: 'muse_smoke_9', address: w.address, challenge_id: c.json.challenge_id,
      signature: sig,
      musebook_signature: identitySig(identities.muse_smoke_9, 'tampered message'),
      pow_result: s, idempotency_key: 'smoke-id-19',
    });
  }
  log(r.status === 400 && r.json.error === 'INVALID_IDENTITY_SIGNATURE', 'identity: signature over wrong message rejected');

  // ---- price feed tests — added 2026-09-18 ----
  const { getMdogUsdPrice, _agreeOnPrice, _clearCache } = require('./lib/price');

  // P1. config reports the feed mode (test stub under TEST_MODE)
  r = await api('GET', '/api/v1/config');
  log(r.json.price_feed === 'test', 'price: config reports feed mode');

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

  // P5. the holder registration recorded which price its decision used
  r = await api('GET', '/api/v1/status/' + regId);
  log(r.status === 200 && r.json.price_usd_per_mdog === 0.01 && !!r.json.price_checked_at, 'price: registration records price used for decision');

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

  console.log('\nAll smoke tests passed.');
  server.kill();
  process.exit(0);
})().catch((e) => { console.error('SMOKE ERROR', e); server.kill(); process.exit(1); });
