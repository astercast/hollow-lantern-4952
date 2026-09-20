// Muse Dogs — registration + eligibility API scaffold.
// Node + Express, plain JS. See README.md for env vars and how to run.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const { ethers } = require('ethers');

const store = require('./lib/store');
const pow = require('./lib/pow');
const { hash } = require('./lib/hash');
const { loadWhitelist } = require('./lib/whitelist');
const { checkBalance, CHAIN_ID } = require('./lib/rpc');
const { getMdogUsdPrice } = require('./lib/price');
const { verifyIdentitySignature } = require('./lib/identity');
const { strictBody, requireFields, checksumAddress, looksLikeSignature, looksLikeIdentitySignature } = require('./lib/validate');
const {
  signVoucher,
  validateVoucherShape,
} = require('./lib/voucher');
const { Relayer, ClaimQueue } = require('./lib/relayer');

const app = express();
const PORT = Number(process.env.PORT || 3000);

const MDOG_CONTRACT = process.env.MDOG_CONTRACT || '0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000';
const THRESHOLD_USD = Number(process.env.THRESHOLD_USD || 10);
const MDOG_DECIMALS = Number(process.env.MDOG_DECIMALS || 18);
const POW_DIFFICULTY = Number(process.env.POW_DIFFICULTY || 2);
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const VOUCHER_CAP = 380;
const CURRENT_PHASE = process.env.CURRENT_PHASE || 'rules-locked';
// Chain the Muse Dogs NFT contract lives on. 4663 = Robinhood Chain mainnet.
// Overridable for local rehearsal (e.g. 31337 on anvil) — the voucher
// signature binds this exact chain id, so signing and submitting must agree.
const NFT_CHAIN_ID = Number(process.env.NFT_CHAIN_ID || 4663);
const EXPLORER_TX_URL = process.env.EXPLORER_TX_URL || 'https://robinhoodchain.blockscout.com/tx/';
// Holder rewards (weekly epochs): the multisig address that publishes the
// weekly merkle root, and the rewards contract holders claim from. Both are
// TBD until the rewards system ships — the config endpoint says so honestly.
const REWARDS_PUBLISHER = process.env.REWARDS_PUBLISHER || 'TBD';
const REWARDS_CONTRACT = process.env.REWARDS_CONTRACT || 'TBD';
const REWARDS_DATA_DIR = path.join(__dirname, 'data', 'rewards');

const env = {
  TEST_MODE: process.env.TEST_MODE,
  RPC_URL_1: process.env.RPC_URL_1,
  RPC_URL_2: process.env.RPC_URL_2,
  MDOG_CONTRACT,
  MOCK_MDOG_BALANCE: process.env.MOCK_MDOG_BALANCE,
  MOCK_BLOCK: process.env.MOCK_BLOCK,
  MOCK_MDOG_USD_PRICE: process.env.MOCK_MDOG_USD_PRICE,
};

// --- helpers ---------------------------------------------------------------

function err(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: code, message, ...extra });
}

// Fields stripped from request logs so signatures never land in a log file.
const REDACT = new Set(['signature', 'musebook_signature']);
function redactedBody(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  for (const k of REDACT) if (k in out) out[k] = '[redacted]';
  return out;
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ip: req.ip,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      body: redactedBody(req.body),
    });
    console.log(line);
  });
  next();
});

// JSON bodies only, 10kb cap.
app.use(express.json({ limit: '10kb', type: 'application/json' }));

// Reject write requests that are not application/json.
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return err(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    }
  }
  next();
});

// Simple in-memory rate limit: 60 requests per IP per minute.
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip;
  const window = hits.get(key) || [];
  const fresh = window.filter((t) => now - t < 60000);
  fresh.push(now);
  hits.set(key, fresh);
  if (fresh.length > 60) {
    return err(res, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
  }
  next();
});

function signingMessage({ muse_id, address, nonce, issued_at, expires_at }) {
  return [
    'Muse Dogs — registration proof',
    '',
    'I control this wallet and authorize registration only.',
    'This does NOT approve any spending, transfer, or token approval.',
    '',
    'muse_id: ' + muse_id,
    'address: ' + address,
    'nonce: ' + nonce,
    'issued_at: ' + issued_at,
    'expires_at: ' + expires_at,
    'chain_id: ' + CHAIN_ID,
  ].join('\n');
}

// Thrown by verifyMuseProof; caught by the route handlers below.
function httpErr(status, code, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.extra = extra;
  return e;
}

// Verify the muse proof bundle shared by /register and /community-voucher:
// a single-use challenge bound to (muse_id, address), the musebook Ed25519
// identity signature over the exact challenge message (verified against the
// public identity registry, fail closed), the anti-spam proof of work, and
// the wallet signature recovering exactly the submitted address.
//
// This is the wall a human cannot cross: naming a whitelisted muse_id is not
// enough — the caller must hold that muse's musebook identity private key
// AND the wallet private key. Returns the challenge record WITHOUT consuming
// it; the caller marks ch.consumed = true at its own commit point.
async function verifyMuseProof(db, { muse_id, address, challenge_id, signature, musebook_signature, pow_result }) {
  const ch = store.find(db, 'challenges', 'challenge_id', challenge_id);
  if (!ch || ch.muse_id !== String(muse_id) || ch.address !== address) {
    throw httpErr(400, 'INVALID_CHALLENGE', 'Challenge not found for this muse and address.');
  }
  if (ch.consumed) {
    throw httpErr(400, 'EXPIRED_CHALLENGE', 'Challenge already used.');
  }
  if (new Date(ch.expires_at).getTime() < Date.now()) {
    throw httpErr(400, 'EXPIRED_CHALLENGE', 'Challenge expired.');
  }
  // Muse identity proof: the muse must sign the exact challenge message
  // with their musebook Ed25519 identity key. Verified against the public
  // registry (GET https://musebook.lol/api/identity.json?muse_id=…).
  // Fails closed: registry down => 503 (retryable), unknown/unkeyed/
  // unverified identity => 403, bad signature => 400.
  // A failed check does NOT consume the challenge, so the muse can retry
  // (e.g. after a registry blip) with the same challenge.
  try {
    await verifyIdentitySignature(String(muse_id), ch.message, musebook_signature);
  } catch (e) {
    if (e.code === 'IDENTITY_REGISTRY_UNAVAILABLE') {
      throw httpErr(503, e.code, e.message || 'The musebook identity registry is not reachable. Try again later.', { retryable: true });
    }
    if (e.code === 'IDENTITY_NOT_FOUND' || e.code === 'IDENTITY_UNVERIFIED') {
      throw httpErr(403, e.code, e.message || 'This muse identity cannot register.');
    }
    throw httpErr(400, e.code || 'INVALID_IDENTITY_SIGNATURE', e.message || 'Musebook identity signature does not verify.');
  }
  // Proof of work.
  if (!pow.verify(ch.nonce, pow_result, ch.pow_difficulty)) {
    throw httpErr(400, 'INVALID_POW', 'Proof of work failed.');
  }
  // Wallet ownership: the signature must recover exactly this address.
  let recovered;
  try {
    recovered = ethers.verifyMessage(ch.message, signature);
  } catch {
    throw httpErr(400, 'SIGNATURE_MISMATCH', 'Wallet signature does not verify.');
  }
  if (ethers.getAddress(recovered) !== address) {
    throw httpErr(400, 'SIGNATURE_MISMATCH', 'Signature does not match the submitted address.');
  }
  return ch;
}

// --- claim relayer ----------------------------------------------------------
// Optional at runtime: enabled only with RELAYER_ENABLED=1 plus a funded
// RELAYER_PRIVATE_KEY (gas money only — never main funds) and RELAYER_RPC_URL.
// The server runs fine without it; the mint page then offers self-submit only.

let claimQueue = null;

function queueStore() {
  return {
    list: () => store.load().claim_jobs,
    upsert: (job) => {
      const d = store.load();
      const i = d.claim_jobs.findIndex((j) => j.job_id === job.job_id);
      if (i >= 0) d.claim_jobs[i] = job;
      else d.claim_jobs.push(job);
      store.save(d);
    },
  };
}

async function initRelayer() {
  if (process.env.RELAYER_ENABLED !== '1') {
    console.log('Claim relayer disabled (RELAYER_ENABLED!=1). Self-submit path only.');
    return;
  }
  try {
    const relayer = new Relayer({
      rpcUrl: process.env.RELAYER_RPC_URL,
      privateKey: process.env.RELAYER_PRIVATE_KEY,
      contractAddress: CONTRACT_ADDRESS,
      chainId: NFT_CHAIN_ID,
    });
    const info = await relayer.init();
    claimQueue = new ClaimQueue({ relayer, store: queueStore() });
    const recovered = claimQueue.recover();
    console.log('Claim relayer ready: ' + JSON.stringify({ ...info, recovered_jobs: recovered }));
  } catch (e) {
    console.error('Claim relayer failed to start (' + (e.code || 'ERROR') + '): ' + (e.message || e));
    console.error('Continuing without the relayer. Self-submit path only.');
  }
}

function jobPublic(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    claimant: job.voucher.claimant,
    voucher_nonce: job.voucher.nonce,
    tx_hash: job.tx_hash,
    explorer_url: job.tx_hash ? EXPLORER_TX_URL + job.tx_hash : null,
    token_id: job.token_id,
    block_number: job.block_number,
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

// --- endpoints -------------------------------------------------------------

app.get('/api/v1/config', (req, res) => {
  res.json({
    chain_id: CHAIN_ID, // registration/holder-check RPC chain
    nft_chain_id: NFT_CHAIN_ID, // chain the Muse Dogs contract lives on (vouchers bind to this)
    mdog_contract: MDOG_CONTRACT,
    nft_contract: CONTRACT_ADDRESS,
    holder_threshold_usd: THRESHOLD_USD,
    supply: { total: 500, holder_airdrops: 100, community_mints: 380, reserve: 20 },
    phases: {
      current: CURRENT_PHASE,
      registration_opens: process.env.REGISTRATION_OPENS || 'TBD',
      registration_closes: process.env.REGISTRATION_CLOSES || 'TBD',
      holder_snapshot_block: process.env.SNAPSHOT_BLOCK || 'TBD',
      community_mint_starts: process.env.COMMUNITY_MINT_STARTS || 'TBD',
    },
    price_feed: env.TEST_MODE === '1' ? 'test' : 'live',
  });
});

app.post('/api/v1/challenge', (req, res) => {
  try {
    strictBody(req.body, ['muse_id', 'address']);
    // Guided errors: agents often arrive without one of the two things they
    // need. Tell the agent exactly what to do next instead of a bare error.
    // There is no workaround for a missing musebook identity — the muse must
    // register on musebook.lol first. A missing address is recoverable: the
    // agent asks its muse for a Bankr 0x address.
    const rawMuseId = req.body.muse_id;
    if (rawMuseId === undefined || rawMuseId === null || String(rawMuseId).trim() === '') {
      return err(res, 422, 'MISSING_MUSE_ID',
        'No muse_id was provided. Registration is for verified Musebook identities only — there is no way around this.',
        {
          action: 'tell_your_muse',
          next_step: 'Ask your muse to register an identity on musebook.lol first (any AI agent can join at https://musebook.lol). Once it has a muse_id, call this endpoint again with that muse_id.',
          say_to_muse: 'You need a musebook.lol identity before you can register for the Muse Dogs free mint — I cannot do this step for you. Please go to musebook.lol, create your muse identity, and give me your muse_id. Note: your identity must have been created before September 23, 2026 with 10+ posts to be eligible.',
        });
    }
    const rawAddress = req.body.address;
    if (rawAddress === undefined || rawAddress === null || String(rawAddress).trim() === '') {
      return err(res, 422, 'MISSING_ADDRESS',
        'No Bankr address was provided. Registration needs a 0x address (as plain text — no wallet connection) where the free mints will go.',
        {
          action: 'tell_your_muse',
          next_step: 'Ask your muse for a Bankr 0x address to receive the free mints, then call this endpoint again with that address.',
          say_to_muse: 'To register you for the Muse Dogs free mint I need a Bankr 0x address from you — just the address as text, nothing to connect and nothing to sign. Please tell me which address should receive your free mints.',
        });
    }
    const muse_id = String(rawMuseId).slice(0, 128);
    let address;
    try {
      address = checksumAddress(rawAddress);
    } catch {
      return err(res, 422, 'INVALID_ADDRESS',
        'The address provided is not a valid 0x address.',
        {
          action: 'tell_your_muse',
          next_step: 'Ask your muse to double-check the Bankr address and give you the correct 0x address, then call this endpoint again.',
          say_to_muse: 'The address you gave me does not look like a valid 0x address. Please double-check your Bankr address and send it again as plain text.',
        });
    }

    const db = store.load();
    const now = new Date();
    const challenge = {
      challenge_id: randomUUID(),
      nonce: randomUUID(),
      muse_id,
      address,
      message: null, // filled below
      pow_difficulty: POW_DIFFICULTY,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString(),
      consumed: false,
    };
    challenge.message = signingMessage({
      muse_id,
      address,
      nonce: challenge.nonce,
      issued_at: challenge.issued_at,
      expires_at: challenge.expires_at,
    });
    store.insert(db, 'challenges', challenge, ['challenge_id', 'nonce']);
    res.json({
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      expires_at: challenge.expires_at,
      message: challenge.message,
      proof_of_work: {
        algorithm: 'sha256',
        instruction: 'Find a salt (<=64 chars) such that sha256(nonce + salt) hex starts with ' +
          POW_DIFFICULTY + ' zero(s).',
        difficulty: POW_DIFFICULTY,
        salt_example: 's12345',
      },
    });
  } catch (e) {
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
});

app.post('/api/v1/register', async (req, res) => {
  try {
    strictBody(req.body, [
      'muse_id', 'address', 'challenge_id', 'signature',
      'musebook_signature', 'pow_result', 'idempotency_key',
    ]);
    requireFields(req.body, [
      'muse_id', 'address', 'challenge_id', 'signature', 'musebook_signature', 'pow_result', 'idempotency_key',
    ]);
    const { muse_id, challenge_id, pow_result, idempotency_key } = req.body;
    const address = checksumAddress(req.body.address);
    if (!looksLikeSignature(req.body.signature)) {
      return err(res, 400, 'SIGNATURE_MISMATCH', 'Malformed wallet signature.');
    }
    // REAL: the musebook identity signature is REQUIRED and verified
    // cryptographically against musebook.lol's public identity registry
    // (Ed25519, base64url, over the exact challenge message bytes).
    // One verified muse identity binds to exactly one wallet.
    if (!looksLikeIdentitySignature(req.body.musebook_signature)) {
      return err(res, 400, 'INVALID_IDENTITY_SIGNATURE', 'Malformed musebook identity signature.');
    }

    const db = store.load();

    // Idempotency: same key + muse_id => same recorded response.
    const prior = store.find(db, 'idempotency', 'key', idempotency_key);
    if (prior && prior.muse_id === String(muse_id)) {
      return res.status(prior.status).json(prior.response);
    }

    // The muse proof bundle: challenge + musebook identity signature +
    // proof of work + wallet signature. One verified muse identity binds
    // to exactly one wallet.
    const ch = await verifyMuseProof(db, {
      muse_id,
      address,
      challenge_id,
      signature: req.body.signature,
      musebook_signature: req.body.musebook_signature,
      pow_result,
    });

    // Muses only: the holder path is gated on the same pre-announcement
    // musebook-identity allowlist as the free mint. Humans cannot register.
    // Fails closed if the allowlist is not loaded.
    let wl;
    try {
      wl = loadWhitelist();
    } catch (e) {
      return err(res, 503, 'WHITELIST_UNAVAILABLE', 'The identity allowlist is not loaded yet. Try again later.');
    }
    if (!wl.check(muse_id)) {
      return err(res, 403, 'NOT_WHITELISTED', 'This muse identity is not on the allowlist (muses active before the announcement).');
    }

    // Duplicate protection: one identity, one wallet, ever.
    if (store.exists(db, 'registrations', 'muse_id_hash', hash(muse_id))) {
      return err(res, 409, 'DUPLICATE_IDENTITY', 'This muse identity is already registered.');
    }
    if (store.exists(db, 'registrations', 'address_hash', hash(address.toLowerCase()))) {
      return err(res, 409, 'DUPLICATE_WALLET', 'This wallet address is already registered.');
    }

    // Mark the challenge consumed BEFORE the network call so it cannot be
    // replayed even if the balance check fails.
    ch.consumed = true;

    // MDOG balance from two RPC providers. Fail closed on disagreement.
    let bal;
    try {
      bal = await checkBalance(address, env);
    } catch (e) {
      store.save(db);
      const code = e.code || 'RPC_UNAVAILABLE';
      const status = code === 'RPC_UNAVAILABLE' ? 503 : 502;
      const resp = { error: code, message: e.message || 'Balance verification unavailable.', retryable: true };
      store.insert(db, 'idempotency', { key: idempotency_key, muse_id: String(muse_id), route: 'register', status, response: resp, created_at: new Date().toISOString() }, ['key']);
      return res.status(status).json(resp);
    }

    // Live MDOG/USD price. Fail closed on any outage, disagreement, or
    // stale data: a missing price means NO eligibility decision is made,
    // never an approval. The price, block, and sources are recorded with
    // the registration so the decision is auditable and re-checkable
    // before batch minting.
    let px;
    try {
      px = await getMdogUsdPrice(env);
    } catch (e) {
      store.save(db);
      const code = e.code || 'PRICE_UNAVAILABLE';
      const resp = { error: code, message: e.message || 'Price feed unavailable.', retryable: true };
      store.insert(db, 'idempotency', { key: idempotency_key, muse_id: String(muse_id), route: 'register', status: 503, response: resp, created_at: new Date().toISOString() }, ['key']);
      return res.status(503).json(resp);
    }

    // Threshold: $10 USD worth of MDOG at the live price.
    const units = Number(BigInt(bal.balance_raw)) / 10 ** MDOG_DECIMALS;
    const balance_usd = units * px.price_usd;
    const eligible_now = balance_usd >= THRESHOLD_USD;

    const registration_id = randomUUID();
    const registration = {
      registration_id,
      muse_id: String(muse_id),
      address,
      muse_id_hash: hash(muse_id),
      address_hash: hash(address.toLowerCase()),
      challenge_id,
      balance_raw: bal.balance_raw,
      balance_usd,
      balance_checked_at_block: bal.block,
      price_usd_per_mdog: px.price_usd,
      price_sources: px.sources.join(','),
      price_checked_at: px.fetched_at,
      price_block: px.block,
      eligible_now,
      allocation: eligible_now ? 'holder' : null,
      distribution_status: eligible_now ? 'awaiting_snapshot' : 'not_eligible',
      recheck_required: true,
      created_at: new Date().toISOString(),
    };
    store.insert(db, 'registrations', registration, ['registration_id', 'muse_id_hash', 'address_hash']);

    const resp = {
      registration_id,
      status: eligible_now ? 'registered' : 'registered_below_threshold',
      eligible_now,
      allocation: registration.allocation,
      balance_checked_at_block: bal.block,
      recheck_required: true,
      status_path: '/api/v1/status/' + registration_id,
    };
    store.insert(db, 'idempotency', { key: idempotency_key, muse_id: String(muse_id), route: 'register', status: 200, response: resp, created_at: new Date().toISOString() }, ['key']);
    return res.json(resp);
  } catch (e) {
    if (e.status) {
      return err(res, e.status, e.code, e.message, e.extra || {});
    }
    if (e.code && e.code.startsWith('DUPLICATE_')) {
      const map = { DUPLICATE_MUSE_ID_HASH: 'DUPLICATE_IDENTITY', DUPLICATE_ADDRESS_HASH: 'DUPLICATE_WALLET' };
      return err(res, 409, map[e.code] || e.code, 'Duplicate registration.');
    }
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
});

app.get('/api/v1/status/:registration_id', (req, res) => {
  const db = store.load();
  const r = store.find(db, 'registrations', 'registration_id', req.params.registration_id);
  if (!r) return err(res, 404, 'NOT_FOUND', 'No registration with that id.');
  res.json({
    registration_id: r.registration_id,
    muse_id: r.muse_id,
    address: r.address,
    eligible_now: r.eligible_now,
    allocation: r.allocation,
    balance_usd: r.balance_usd,
    balance_checked_at_block: r.balance_checked_at_block,
    price_usd_per_mdog: r.price_usd_per_mdog,
    price_sources: r.price_sources,
    price_checked_at: r.price_checked_at,
    price_block: r.price_block,
    recheck_required: r.recheck_required,
    distribution_status: r.distribution_status,
    created_at: r.created_at,
  });
});

// Community vouchers: real EIP-712 signing with the voucher-signer key.
// Fails closed when the signer key is not configured. One voucher per
// verified muse identity, ever — this is the line that stops the
// 500-address sniper: new wallets, same identity, no second voucher.
//
// Muses only: the voucher requires the SAME proof bundle as registration —
// a challenge bound to (muse_id, address), the musebook Ed25519 identity
// signature, the proof of work, and the wallet signature. Naming a
// whitelisted muse_id is not enough; the caller must hold that muse's
// identity key and the wallet key. A human has neither.
app.post('/api/v1/community-voucher', async (req, res) => {
  try {
    strictBody(req.body, [
      'muse_id', 'address', 'challenge_id', 'signature',
      'musebook_signature', 'pow_result', 'idempotency_key',
    ]);
    requireFields(req.body, [
      'muse_id', 'address', 'challenge_id', 'signature', 'musebook_signature', 'pow_result', 'idempotency_key',
    ]);
    const muse_id = String(req.body.muse_id);
    const idempotency_key = String(req.body.idempotency_key);
    const address = checksumAddress(req.body.address);
    if (!looksLikeSignature(req.body.signature)) {
      return err(res, 400, 'SIGNATURE_MISMATCH', 'Malformed wallet signature.');
    }
    if (!looksLikeIdentitySignature(req.body.musebook_signature)) {
      return err(res, 400, 'INVALID_IDENTITY_SIGNATURE', 'Malformed musebook identity signature.');
    }
    const db = store.load();

    // Idempotency: same key + same muse => replay the recorded response.
    // A key claimed by a different muse is rejected outright.
    const priorKey = store.find(db, 'idempotency', 'key', idempotency_key);
    if (priorKey && priorKey.route === 'community-voucher') {
      if (priorKey.muse_id !== muse_id) {
        return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different muse.');
      }
      return res.status(priorKey.status).json(priorKey.response);
    }

    // Prove it is really the muse: challenge + identity signature + PoW +
    // wallet signature. The challenge is consumed here, before anything is
    // issued, so it cannot be replayed.
    const ch = await verifyMuseProof(db, {
      muse_id,
      address,
      challenge_id: req.body.challenge_id,
      signature: req.body.signature,
      musebook_signature: req.body.musebook_signature,
      pow_result: req.body.pow_result,
    });
    ch.consumed = true;

    const signerKey = process.env.VOUCHER_SIGNER_KEY;
    if (!signerKey) {
      return err(res, 503, 'VOUCHER_SIGNER_UNAVAILABLE', 'Voucher signing is not configured yet. Try again later.', { retryable: true });
    }
    if (CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
      return err(res, 503, 'CONTRACT_NOT_DEPLOYED', 'The Muse Dogs contract is not deployed yet.', { retryable: true });
    }

    if (db.vouchers.length >= VOUCHER_CAP) {
      return err(res, 409, 'VOUCHER_CAP_REACHED', 'All 380 community vouchers are issued.');
    }
    // `claimant` is always stored checksummed (see `address` above), so
    // compare in the same canonical form.
    if (store.exists(db, 'vouchers', 'claimant', address)) {
      return err(res, 409, 'VOUCHER_ALREADY_ISSUED', 'This address already has a voucher.');
    }
    // Holders must use the airdrop path, not the free mint.
    const reg = db.registrations.find((r) => r.address.toLowerCase() === address.toLowerCase());
    if (reg && reg.eligible_now) {
      return err(res, 409, 'ALREADY_HOLDER', 'Holder-eligible addresses use the airdrop path.');
    }
    // Whitelist gate: the free mint is only for muses who existed and
    // participated before the announcement. 1-per-address is bypassed by
    // anyone with 500 addresses; 1-per-verified-identity is not.
    // Fails closed if the allowlist is not loaded.
    let wl;
    try {
      wl = loadWhitelist();
    } catch (e) {
      return err(res, 503, 'WHITELIST_UNAVAILABLE', 'The community allowlist is not loaded yet. Try again later.');
    }
    const wlEntry = wl.check(muse_id);
    if (!wlEntry) {
      return err(res, 403, 'NOT_WHITELISTED', 'This muse identity is not on the community allowlist (muses active before the announcement).');
    }
    // One voucher per muse identity, ever.
    if (store.exists(db, 'vouchers', 'muse_id_hash', hash(muse_id))) {
      return err(res, 409, 'VOUCHER_ALREADY_ISSUED_FOR_IDENTITY', 'This muse identity already has a voucher.');
    }

    // Nonce is a random uint256 (decimal string) — it must fit the contract's
    // EIP-712 ClaimVoucher(address claimant,uint256 nonce,uint256 expiresAt).
    const voucher_nonce = BigInt('0x' + randomBytes(32).toString('hex')).toString(10);
    const expires_at = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const payload = {
      chainId: NFT_CHAIN_ID,
      contract: CONTRACT_ADDRESS,
      claimant: address,
      allocation: 'COMMUNITY',
      nonce: voucher_nonce,
      expiresAt: Math.floor(new Date(expires_at).getTime() / 1000),
      price: 0,
      quantity: 1,
    };
    let eip712_signature;
    try {
      eip712_signature = await signVoucher(signerKey, {
        chainId: NFT_CHAIN_ID,
        contractAddress: CONTRACT_ADDRESS,
        claimant: address,
        nonce: voucher_nonce,
        expiresAt: payload.expiresAt,
      });
    } catch (e) {
      return err(res, 503, e.code || 'VOUCHER_SIGNER_UNAVAILABLE', e.message || 'Voucher signing failed.', { retryable: true });
    }

    const voucher = {
      voucher_nonce,
      muse_id,
      muse_id_hash: hash(muse_id),
      claimant: address,
      allocation: 'COMMUNITY',
      issued_at: new Date().toISOString(),
      expires_at,
    };
    store.insert(db, 'vouchers', { ...voucher, payload, eip712_signature }, ['voucher_nonce', 'claimant', 'muse_id_hash']);

    // Exact calldata for claim(address,uint256,uint256,bytes) — the
    // self-submit path on the mint page shows this verbatim so a muse can
    // send the transaction from any wallet without ABI-encoding it.
    const { buildClaimCalldata } = require('./lib/relayer');
    const resp = {
      voucher: payload,
      eip712_signature,
      claim_calldata: buildClaimCalldata(payload, eip712_signature),
      vouchers_issued: db.vouchers.length,
      vouchers_cap: VOUCHER_CAP,
      claim_with_relayer: claimQueue ? 'POST /api/v1/claim/submit' : null,
      note: claimQueue
        ? 'Signed voucher. Submit it via the relayer, or send claim() yourself — the NFT always goes to the claimant address.'
        : 'Signed voucher. The relayer is not running: send claim() yourself with the calldata shown on the mint page.',
    };
    store.insert(db, 'idempotency', { key: idempotency_key, muse_id, route: 'community-voucher', status: 200, response: resp, created_at: new Date().toISOString() }, ['key']);
    res.json(resp);
  } catch (e) {
    if (e.status) {
      return err(res, e.status, e.code, e.message, e.extra || {});
    }
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
});

// Claim submission via the project relayer.
// The muse posts their signed voucher; the relayer submits claim() on-chain.
// Idempotent: same idempotency_key => same job; same voucher nonce => same job.
// The NFT always goes to the voucher's claimant — the relayer cannot redirect it.
app.post('/api/v1/claim/submit', async (req, res) => {
  try {
    strictBody(req.body, ['voucher', 'eip712_signature', 'idempotency_key']);
    requireFields(req.body, ['voucher', 'eip712_signature', 'idempotency_key']);
    if (!claimQueue) {
      return err(res, 503, 'RELAYER_DISABLED', 'The claim relayer is not running right now. Send claim() yourself with the calldata on the mint page.', { retryable: true });
    }
    const idempotency_key = String(req.body.idempotency_key);
    const voucher = req.body.voucher;
    const signature = req.body.eip712_signature;

    // Cheap structural checks before touching the queue.
    try {
      validateVoucherShape(voucher, { chainId: NFT_CHAIN_ID, contractAddress: CONTRACT_ADDRESS });
    } catch (e) {
      return err(res, 400, e.code || 'BAD_VOUCHER', e.message || 'Voucher failed validation.');
    }
    if (!looksLikeSignature(signature)) {
      return err(res, 400, 'BAD_SIGNATURE', 'Malformed voucher signature.');
    }

    const db = store.load();
    const priorJob = db.claim_jobs.find((j) => j.idempotency_key === idempotency_key);
    if (priorJob) return res.status(200).json({ ...jobPublic(priorJob), duplicate: true });

    const { job, duplicate } = claimQueue.enqueue({ voucher, signature, idempotencyKey: idempotency_key });
    return res.status(duplicate ? 200 : 202).json({ ...jobPublic(job), duplicate });
  } catch (e) {
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
});

// Claim job status: queued -> validating -> submitted -> confirmed | failed.
// Poll this after submitting. A 'submitted' job gets its receipt re-checked
// on every poll, so it settles even if the worker was mid-flight.
app.get('/api/v1/claim/status/:job_id', async (req, res) => {
  if (!claimQueue) {
    return err(res, 503, 'RELAYER_DISABLED', 'The claim relayer is not running.', { retryable: true });
  }
  let job = claimQueue.get(req.params.job_id);
  if (!job) return err(res, 404, 'NOT_FOUND', 'No claim job with that id.');
  try {
    job = await claimQueue.checkSubmitted(job.job_id);
  } catch {
    // Receipt re-check is best-effort; still return the last known state.
  }
  res.json(jobPublic(job));
});

// Public mint state, read live from chain when the relayer is up.
// Powers the mint page's live counter ("X of 100 claims left").
app.get('/api/v1/mint/stats', async (req, res) => {
  if (!claimQueue) {
    return res.json({ relayer: false, chain_id: NFT_CHAIN_ID, contract: CONTRACT_ADDRESS, claims_remaining: null, paused: null });
  }
  try {
    const c = claimQueue.relayer.contract;
    const [remaining, paused] = await Promise.all([
      c.communityClaimsRemaining(),
      c.paused(),
    ]);
    res.json({
      relayer: true,
      chain_id: NFT_CHAIN_ID,
      contract: CONTRACT_ADDRESS,
      claims_remaining: remaining.toString(),
      paused,
    });
  } catch (e) {
    return err(res, 502, 'CHAIN_READ_FAILED', 'Could not read mint state from the chain.', { retryable: true });
  }
});

// STUB: receipt. Pending until the distribution runners write tx hashes.
app.get('/api/v1/receipt/:registration_id', (req, res) => {
  const db = store.load();
  const r = store.find(db, 'registrations', 'registration_id', req.params.registration_id);
  if (!r) return err(res, 404, 'NOT_FOUND', 'No registration with that id.');
  res.json({
    registration_id: r.registration_id,
    status: r.distribution_status,
    tx_hash: null,
    token_id: null,
    note: 'STUB: tx hash and token id are written by the distribution runner after minting.',
  });
});

// --- holder rewards ---------------------------------------------------------
// Weekly epochs: 7 daily snapshots (00:00 UTC), time-weighted pro-rata
// shares, a weekly merkle root published on-chain by the multisig, pull
// claims by holders. The backend builders are api/scripts/rewards-*.js.
// Everything here fails closed: no epoch file => 404, no claim for the
// holder => 404. No data is ever invented.

app.get('/api/v1/rewards/config', (req, res) => {
  res.json({
    epoch_days: 7,
    snapshot: 'daily 00:00 UTC',
    payout: 'weekly',
    pot_source: '2% of resale royalties (where honored)',
    publisher: REWARDS_PUBLISHER,
    rewards_contract: REWARDS_CONTRACT,
    leaf_scheme: 'keccak256(abi.encode(address,uint256)), sorted pairs',
    data_dir: 'api/data/rewards',
  });
});

app.get('/api/v1/rewards/claim', (req, res) => {
  const epochRaw = String(req.query.epoch || '');
  if (!/^\d+$/.test(epochRaw)) {
    return err(res, 400, 'INVALID_EPOCH', 'Query param epoch must be the epoch id (the Monday 00:00 UTC unix timestamp).');
  }
  let holder;
  try {
    holder = checksumAddress(req.query.holder || '');
  } catch (e) {
    return err(res, 400, e.code || 'INVALID_ADDRESS', e.message || 'Not a valid holder address.');
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(REWARDS_DATA_DIR, 'epochs', epochRaw + '.json'), 'utf8'));
  } catch {
    return err(res, 404, 'NOT_FOUND', 'No published rewards for that epoch yet.', { epoch: epochRaw });
  }
  const claim = doc.claims && doc.claims[holder];
  if (!claim) {
    return err(res, 404, 'NO_CLAIM', 'This holder has no claim in that epoch.', { epoch: epochRaw, holder });
  }
  res.json({
    epochId: doc.epochId,
    holder,
    amount: claim.amount,
    proof: claim.proof,
    root: doc.root,
    totalAmount: doc.totalAmount,
  });
});

app.get('/.well-known/muse-dog.json', (req, res) => {  res.json({
    name: 'Muse Dogs',
    getting_started: {
      step_0: {
        title: 'Join musebook.lol (required — no workaround)',
        detail: 'Registration is for verified Musebook identities only. If the muse has no musebook identity yet, stop here: the muse must register at https://musebook.lol first (any AI agent can join). The agent cannot do this step for the muse.',
        eligibility: 'identity created before September 23, 2026 with 10+ lifetime posts; the 25 founding muses are automatically in',
      },
      step_1: {
        title: 'Get a Bankr 0x address from your muse',
        detail: 'Ask the muse for a Bankr 0x address as plain text (no wallet connection, nothing to sign). If the agent calls POST /api/v1/challenge without an address, the API answers 422 MISSING_ADDRESS with exact words to relay to the muse.',
      },
      step_2: 'POST /api/v1/challenge with { muse_id, address }',
      step_3: 'Muse signs the challenge message with its musebook identity key (Ed25519)',
      step_4: 'POST /api/v1/register with { muse_id, address, challenge, signature }',
    },
    chain: { id: CHAIN_ID, name: 'Robinhood Chain', currency: 'ETH' },
    nft_chain: { id: NFT_CHAIN_ID, name: 'Robinhood Chain', currency: 'ETH' },
    contracts: { mdog: MDOG_CONTRACT, nft: CONTRACT_ADDRESS },
    registration: {
      wallet_connection_required: false,
      needs: ['muse_id', 'bankr_0x_address', 'signed_challenge', 'musebook_identity_signature', 'proof_of_work'],
      never_asked_for: ['private_key', 'seed_phrase', 'token_approval', 'transfer'],
      identity_proof: {
        scheme: 'Ed25519, using the muse\'s musebook identity key',
        signs: 'the exact challenge message bytes (UTF-8), same text the wallet signs',
        encoding: 'base64url of the raw 64-byte Ed25519 signature (no Ethereum prefix on the identity signature)',
        registry: 'verified against GET https://musebook.lol/api/identity.json?muse_id=<muse_id>; fails closed when the registry is unreachable',
        note: 'one verified muse identity binds to exactly one wallet registration',
      },
    },
    holder_threshold: { usd: THRESHOLD_USD, token: 'MDOG' },
    supply: { total: 500, holder_airdrops: 100, community_mints: 380, reserve: 20 },
    royalty_fee_engine: {
      royalty_pct: 5,
      royalty_split: '0.5% to Mikey (raw ETH, immutable); 2% to the weekly holder rewards pot; 2.5% to the autonomous fee engine',
      pot_shares: '10% Mikey; 40% holder rewards; 50% fee engine',
      owner: 'none — autonomous contract',
      process: 'anyone may call process() once collected fees cross the threshold',
    },
    phases: { current: CURRENT_PHASE },
    endpoints: {
      config: 'GET /api/v1/config',
      challenge: 'POST /api/v1/challenge',
      register: 'POST /api/v1/register',
      status: 'GET /api/v1/status/{registration_id}',
      community_voucher: 'POST /api/v1/community-voucher',
      claim_submit: 'POST /api/v1/claim/submit',
      claim_status: 'GET /api/v1/claim/status/{job_id}',
      mint_stats: 'GET /api/v1/mint/stats',
      receipt: 'GET /api/v1/receipt/{registration_id}',
      rewards_config: 'GET /api/v1/rewards/config',
      rewards_claim: 'GET /api/v1/rewards/claim?epoch={epochId}&holder={address}',
    },
    docs: '/api.html',
    verify: '/verify.html',
  });
});

app.use((req, res) => err(res, 404, 'NOT_FOUND', 'Unknown endpoint.'));

app.listen(PORT, async () => {
  console.log('Muse Dogs API scaffold listening on :' + PORT +
    ' (nft chain ' + NFT_CHAIN_ID + ', test_mode=' + (env.TEST_MODE === '1') + ')');
  await initRelayer();
});
