// Muse Dogs — registration + eligibility API scaffold.
// Node + Express, plain JS. See README.md for env vars and how to run.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const { ethers } = require('ethers');

const store = require('./lib/store');
const { hash } = require('./lib/hash');
const { CHAIN_ID } = require('./lib/rpc');
const { verifyIdentitySignature, fetchRegistryIdentity } = require('./lib/identity');
const { verifyPostAttestation, looksLikePostId } = require('./lib/attestation');
const { strictBody, requireFields, checksumAddress, looksLikeSignature, looksLikeIdentitySignature } = require('./lib/validate');
const {
  signVoucher,
  validateVoucherShape,
} = require('./lib/voucher');
const { Relayer, ClaimQueue } = require('./lib/relayer');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Behind Render (and any reverse proxy) req.ip must be the real client IP or
// the per-IP rate limiter keys every request to the proxy's address.
app.set('trust proxy', 1);

// CORS: the static site at musedog.lol calls this API cross-origin.
// Production-safe: only the real site origins are allowed, no wildcards.
const ALLOWED_ORIGINS = new Set([
  'https://musedog.lol',
  'https://www.musedog.lol',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Centralized async safety net. Express 4 does not catch rejections from
// async route handlers — one escaping promise becomes an unhandled
// rejection that kills the process. Every async route below is wrapped in
// ah() so it lands in the final error middleware instead, and the
// process-level handlers log (never crash on) anything that escapes
// outside the request cycle (startup, background pumps).
const ah = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection: ' + (reason && reason.stack || reason && reason.message || reason));
});
process.on('uncaughtException', (e) => {
  console.error('uncaughtException: ' + (e && e.stack || e && e.message || e));
});

const MDOG_CONTRACT = process.env.MDOG_CONTRACT || '0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000';
const THRESHOLD_USD = Number(process.env.THRESHOLD_USD || 10);
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const VOUCHER_CAP = 380;
const COMMUNITY_VOUCHERS_PER_ADDRESS = 3; // per-address cap (matches contract MAX_COMMUNITY_PER_ADDRESS)
const COMMUNITY_VOUCHERS_PER_IDENTITY = 3; // per-identity cap on the community path
const HOLDER_VOUCHER_CAP = 100;
const HOLDER_VOUCHERS_PER_ADDRESS = 3; // per-address cap (matches contract MAX_HOLDER_PER_ADDRESS)
const HOLDER_VOUCHERS_PER_IDENTITY = 3; // per-identity cap on the holder path
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

// Simple in-memory rate limit: 60 requests per IP per minute by default.
// This is the spam control on the claim path, by design. There is NO
// proof-of-work anywhere in the flow: the locked claim design keeps the muse
// flow simple (address as plain text + one identity signature), and rate
// limiting is the anti-spam layer instead.
// RATE_LIMIT_PER_MIN overrides the default (used by the in-process test
// harness, which issues many requests from one IP in seconds).
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 60);
const hits = new Map();
app.use((req, res, next) => {
  const now = Date.now();
  const key = req.ip;
  const window = hits.get(key) || [];
  const fresh = window.filter((t) => now - t < 60000);
  fresh.push(now);
  hits.set(key, fresh);
  if (fresh.length > RATE_LIMIT_PER_MIN) {
    return err(res, 429, 'RATE_LIMITED', 'Too many requests. Slow down.');
  }
  next();
});

// The challenge message a muse signs with its musebook Ed25519 identity key.
// The message binds (muse_id, address): it proves control of the musebook
// identity and claims the address the NFT will go to. It proves NOTHING about
// the wallet itself — the address is supplied as plain text, no wallet
// connection, no wallet signature, no ETH from the muse. The message says so
// explicitly so nobody mistakes it for a wallet authorization.
function signingMessage({ muse_id, address, nonce, issued_at, expires_at }) {
  return [
    'Muse Dogs — muse identity proof',
    '',
    'I am the muse with this musebook identity, and I claim this address',
    'for my Muse Dogs mint. The address is where the NFT will go.',
    'This proves my musebook identity ONLY. It does NOT prove control of',
    'the wallet, and it does NOT approve any spending, transfer, or token',
    'approval.',
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

// Community free-mint eligibility — LIVE check against the musebook identity
// registry (locked rule, Andrew 2026-09-21): the musebook identity must have
// been created strictly before 2026-09-23; all 25 founding muses auto-qualify.
// No post-count requirement.
//
// This replaced the old static snapshot (data/whitelist.json), which went
// stale for identities created between the snapshot build and the cutoff —
// e.g. Nyx (identity created 2026-09-16) was wrongly reported
// community_eligible: false because the Sep-21 snapshot crawl missed them.
// The registry's created_at is server-side and unforgeable, so the live
// check keeps the exact same anti-snipe property with no staleness window.
const COMMUNITY_CUTOFF_DAY = '2026-09-23'; // strictly before: YYYY-MM-DD compare, no timezone edge cases
function communityEligibility(identity) {
  if (!identity) return { eligible: false, reason: 'no verified identity' };
  if (identity.founder === true) return { eligible: true, reason: 'founding muse (auto-included)' };
  const day = typeof identity.created_at === 'string' ? identity.created_at.slice(0, 10) : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < COMMUNITY_CUTOFF_DAY) {
    return { eligible: true, reason: 'musebook identity created ' + day + ' (before ' + COMMUNITY_CUTOFF_DAY + ')' };
  }
  return { eligible: false, reason: 'musebook identity created on/after ' + COMMUNITY_CUTOFF_DAY };
}

// Verify the muse proof bundle shared by /register and the voucher endpoints:
// a single-use challenge bound to (muse_id, address), plus ONE of two
// identity proofs:
//
//   (a) the musebook Ed25519 identity signature over the exact challenge
//       message (verified against the public identity registry, fail
//       closed), or
//   (b) a musebook POST ATTESTATION: a post authored by the muse's own
//       musebook identity whose text contains the challenge_id
//       (verified through the public board read API, fail closed).
//
// Path (b) exists for muses that never received their identity private key
// (e.g. onboarded through third-party clients like Grok): they can still
// post as themselves, and authorship attributed by musebook.lol proves
// control of the identity exactly as well as a signature. The human wall
// stands either way — naming an eligible muse_id is not enough; the caller
// must control that muse's musebook account (hold its key, or be able to
// publish as it).
//
// There is deliberately NO wallet signature and NO proof of work here: the
// locked claim design keeps the muse flow simple (plain-text Bankr address +
// one identity proof), and per-IP rate limiting is the spam control.
// Returns { challenge, identity } WITHOUT consuming the challenge; the
// caller marks ch.consumed = true at its own commit point. The identity doc
// carries founder/created_at for the live community-eligibility check, so
// callers never fetch the registry twice.
//
// On path (b) the registry is still read for the identity doc (existence +
// eligibility fields) but the key/id_verified requirements are skipped —
// requiring a key on the no-key path would defeat its purpose. The
// authorship check IS the verification there.
async function verifyMuseProof(db, { muse_id, address, challenge_id, musebook_signature, attestation_post_id }) {
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
  const hasSig = musebook_signature !== undefined && musebook_signature !== null && musebook_signature !== '';
  const hasAtt = attestation_post_id !== undefined && attestation_post_id !== null && String(attestation_post_id).trim() !== '';
  if (hasSig && hasAtt) {
    throw httpErr(400, 'AMBIGUOUS_PROOF', 'Send exactly one identity proof: musebook_signature OR attestation_post_id, not both.');
  }
  if (!hasSig && !hasAtt) {
    throw httpErr(400, 'MISSING_PROOF',
      'No identity proof provided. Sign the challenge with your musebook identity key (musebook_signature), or post the challenge id on musebook from your own identity and send attestation_post_id.');
  }
  if (hasAtt) {
    // Post-attestation path: authorship attributed by musebook.lol.
    // A failed check does NOT consume the challenge, so the muse can retry
    // (e.g. after a board blip) with the same post.
    try {
      await verifyPostAttestation(String(muse_id), ch.challenge_id, String(attestation_post_id).trim());
    } catch (e) {
      if (e.code === 'ATTESTATION_UNAVAILABLE') {
        throw httpErr(503, e.code, e.message || 'Musebook did not answer the attestation check. Try again later.', { retryable: true });
      }
      if (e.code === 'ATTESTATION_POST_NOT_FOUND') {
        throw httpErr(400, e.code, e.message);
      }
      throw httpErr(403, e.code || 'ATTESTATION_INVALID', e.message || 'The attestation post does not prove this muse identity.');
    }
    // The identity must still exist in the registry (fail closed when the
    // registry is down or the identity is unknown), for the eligibility
    // fields. Key/id_verified are intentionally not required here.
    let identity;
    try {
      identity = await fetchRegistryIdentity(String(muse_id));
    } catch (e) {
      if (e.code === 'IDENTITY_REGISTRY_UNAVAILABLE') {
        throw httpErr(503, e.code, e.message || 'The musebook identity registry is not reachable. Try again later.', { retryable: true });
      }
      throw httpErr(403, 'IDENTITY_NOT_FOUND', 'This muse identity is not registered on musebook.');
    }
    return {
      challenge: ch,
      identity: {
        muse_id: identity.muse_id || String(muse_id),
        name: identity.name || null,
        founder: identity.founder === true,
        created_at: typeof identity.created_at === 'string' ? identity.created_at : null,
        id_verified: identity.id_verified !== false,
        proof: 'post-attestation',
      },
    };
  }
  // Muse identity proof: the muse must sign the exact challenge message
  // with their musebook Ed25519 identity key. Verified against the public
  // registry (GET https://musebook.lol/api/identity.json?muse_id=…).
  // Fails closed: registry down => 503 (retryable), unknown/unkeyed/
  // unverified identity => 403, bad signature => 400.
  // A failed check does NOT consume the challenge, so the muse can retry
  // (e.g. after a registry blip) with the same challenge.
  let identity;
  try {
    identity = await verifyIdentitySignature(String(muse_id), ch.message, musebook_signature);
  } catch (e) {
    if (e.code === 'IDENTITY_REGISTRY_UNAVAILABLE') {
      throw httpErr(503, e.code, e.message || 'The musebook identity registry is not reachable. Try again later.', { retryable: true });
    }
    if (e.code === 'IDENTITY_NOT_FOUND' || e.code === 'IDENTITY_UNVERIFIED') {
      throw httpErr(403, e.code, e.message || 'This muse identity cannot register.');
    }
    throw httpErr(400, e.code || 'INVALID_IDENTITY_SIGNATURE', e.message || 'Musebook identity signature does not verify.');
  }
  return { challenge: ch, identity: { ...identity, proof: 'identity-signature' } };
}

// Shared proof-field handling for /register and the voucher endpoints:
// strict field whitelist, required base fields, and exactly one identity
// proof — musebook_signature XOR attestation_post_id. The attestation path
// is the no-key flow: the muse posts the challenge_id on musebook from its
// own identity (any channel) and sends the numeric post id instead of a
// signature. Throws httpErr-style errors; callers' catch blocks already map
// e.status. Returns the normalized fields.
function proofFields(body) {
  strictBody(body, [
    'muse_id', 'address', 'challenge_id',
    'musebook_signature', 'attestation_post_id', 'idempotency_key',
  ]);
  requireFields(body, ['muse_id', 'address', 'challenge_id', 'idempotency_key']);
  const hasSig = body.musebook_signature !== undefined && body.musebook_signature !== null && body.musebook_signature !== '';
  const hasAtt = body.attestation_post_id !== undefined && body.attestation_post_id !== null && String(body.attestation_post_id).trim() !== '';
  if (!hasSig && !hasAtt) {
    throw httpErr(400, 'MISSING_PROOF',
      'No identity proof provided. Either sign the challenge message with your musebook identity key and send musebook_signature, or post the challenge id on musebook from your own identity and send attestation_post_id (the numeric post id).');
  }
  if (hasSig && hasAtt) {
    throw httpErr(400, 'AMBIGUOUS_PROOF', 'Send exactly one identity proof: musebook_signature OR attestation_post_id, not both.');
  }
  if (hasSig && !looksLikeIdentitySignature(body.musebook_signature)) {
    throw httpErr(400, 'INVALID_IDENTITY_SIGNATURE', 'Malformed musebook identity signature.');
  }
  if (hasAtt && !looksLikePostId(body.attestation_post_id)) {
    throw httpErr(400, 'INVALID_ATTESTATION_POST_ID', 'attestation_post_id must be a numeric musebook post id.');
  }
  return {
    muse_id: body.muse_id,
    address: body.address,
    challenge_id: body.challenge_id,
    idempotency_key: body.idempotency_key,
    musebook_signature: hasSig ? body.musebook_signature : undefined,
    attestation_post_id: hasAtt ? String(body.attestation_post_id).trim() : undefined,
  };
}

// --- claim relayer ----------------------------------------------------------
// Optional at runtime: enabled only with RELAYER_ENABLED=1 plus a funded
// RELAYER_PRIVATE_KEY (gas money only — never main funds) and RELAYER_RPC_URL.
// The server runs fine without it; the mint page then offers self-submit only.

let claimQueue = null;

function queueStore() {
  return {
    list: async () => (await store.load()).claim_jobs,
    upsert: async (job) => {
      const d = await store.load();
      await store.upsertJob(d, job);
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
    const recovered = await claimQueue.recover();
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
    recipient: job.voucher.recipient,
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
    chain_id: CHAIN_ID, // chain the API reads
    nft_chain_id: NFT_CHAIN_ID, // chain the Muse Dogs contract lives on (vouchers bind to this)
    mdog_contract: MDOG_CONTRACT,
    nft_contract: CONTRACT_ADDRESS,
    holder_threshold_usd: THRESHOLD_USD,
    holder_threshold_set_on: 'mint day — the multisig sets holderThresholdMDOG on-chain (~$10 of MDOG at the live price); the contract checks the recipient wallet at mint time, never before',
    supply: { total: 500, holder_airdrops: 100, community_mints: 380, reserve: 20 },
    phases: {
      current: CURRENT_PHASE,
      registration_opens: process.env.REGISTRATION_OPENS || 'TBD',
      registration_closes: process.env.REGISTRATION_CLOSES || 'TBD',
      community_mint_starts: process.env.COMMUNITY_MINT_STARTS || 'TBD',
    },
    // No price feed participates in registration or vouchers — the $10
    // holder check happens on-chain at mint time, by design.
    holder_check: 'on-chain at mint time',
    price_feed: 'unused',
  });
});

app.post('/api/v1/challenge', ah(async (req, res) => {
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
        'No muse_id was provided. Your muse is a Musebook resident and already has a muse_id — use the one from its musebook identity (muse.json).',
        {
          action: 'tell_your_muse',
          next_step: 'Use the muse_id from the muse\'s own musebook identity and call this endpoint again. Only if the muse genuinely has no musebook identity yet must it register one at https://musebook.lol first (any AI agent can join).',
          say_to_muse: 'For the Muse Dogs free mint I need your musebook muse_id — as a Musebook resident you already have one (the muse_id in your muse.json). If you don\'t have one yet, please create your muse identity at musebook.lol first, then give me your muse_id. (Eligibility needs an identity created before September 23, 2026; founders auto-in.)',
        });
    }
    const rawAddress = req.body.address;
    if (rawAddress === undefined || rawAddress === null || String(rawAddress).trim() === '') {
      return err(res, 422, 'MISSING_ADDRESS',
        'No Bankr address was provided. Registration needs a 0x address (as plain text — no wallet connection) where the free mints will go.',
        {
          action: 'tell_your_muse',
          next_step: 'Ask the muse for a Bankr 0x address only if it doesn\'t already have one set up — if it has none, suggest it sets up a Bankr address first. Then call this endpoint again with that address.',
          say_to_muse: 'To register you for the Muse Dogs free mint I need a Bankr 0x address — just the address as text, no wallet connection and no ETH needed to share it. If you already have one set up, send it; if not, please set up a Bankr address first, then tell me which address should receive your free mints. (You will sign the challenge message with your musebook identity key later in the flow; sharing the address itself needs no signature.)',
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

    const db = await store.load();
    const now = new Date();
    const challenge = {
      challenge_id: randomUUID(),
      nonce: randomUUID(),
      muse_id,
      address,
      message: null, // filled below
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
    await store.insert(db, 'challenges', challenge, ['challenge_id', 'nonce']);
    res.json({
      challenge_id: challenge.challenge_id,
      nonce: challenge.nonce,
      expires_at: challenge.expires_at,
      message: challenge.message,
      // No wallet connection, no wallet signature, no proof of work on this
      // flow — by design. The muse pastes its Bankr 0x address as plain text
      // and signs the message above with its musebook identity key.
      // Per-IP rate limiting is the spam control.
    });
  } catch (e) {
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
}));

app.post('/api/v1/register', ah(async (req, res) => {
  try {
    const pf = proofFields(req.body);
    const { muse_id, challenge_id, idempotency_key } = pf;
    const address = checksumAddress(pf.address);
    // REAL: the musebook identity proof is REQUIRED and verified
    // cryptographically — either the Ed25519 identity signature (checked
    // against musebook.lol's public identity registry) or a musebook post
    // attestation (authorship attributed by musebook.lol itself, for muses
    // that never received their identity key).
    // One verified muse identity binds to exactly one address.
    // There is NO wallet signature and NO proof of work on this flow —
    // by design. The muse pastes its Bankr 0x address as plain text.

    const db = await store.load();

    // Idempotency: same key + same muse + same payload => the recorded
    // response, byte-identical. A key claimed by a different muse, or
    // reused with different registration details, is rejected outright —
    // it must never silently bind a second registration.
    const prior = store.find(db, 'idempotency', 'key', idempotency_key);
    if (prior) {
      if (prior.muse_id !== String(muse_id)) {
        return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used by a different muse. Use a fresh key.');
      }
      const sameChallenge = !prior.challenge_id || prior.challenge_id === String(challenge_id);
      const sameAddress = !prior.address || prior.address === address;
      if (!sameChallenge || !sameAddress) {
        return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with different registration details. Use a fresh key.');
      }
      return res.status(prior.status).json(prior.response);
    }

    // The muse proof bundle: challenge + musebook identity signature.
    // The signature proves the muse's identity — not control of the wallet.
    // No wallet signature, no proof of work: the locked claim design keeps
    // the muse flow simple (plain-text address + one identity signature),
    // and per-IP rate limiting is the spam control.
    const proof = await verifyMuseProof(db, {
      muse_id,
      address,
      challenge_id,
      musebook_signature: pf.musebook_signature,
      attestation_post_id: pf.attestation_post_id,
    });
    const ch = proof.challenge;

    // Two paths, one registration. Any verified musebook identity can
    // register — the holder path needs no allowlist. The community
    // free-mint path keeps its own gate at /community-voucher.
    // community_eligible is a best-effort hint for the UI, computed LIVE
    // from the verified identity doc (created strictly before 2026-09-23,
    // founders auto-included); the voucher endpoint re-checks the same
    // rule live and fails closed there.
    const communityEligible = communityEligibility(proof.identity).eligible;

    // Duplicate protection: one identity, one address, ever.
    if (store.exists(db, 'registrations', 'muse_id_hash', hash(muse_id))) {
      return err(res, 409, 'DUPLICATE_IDENTITY', 'This muse identity is already registered.');
    }
    if (store.exists(db, 'registrations', 'address_hash', hash(address.toLowerCase()))) {
      return err(res, 409, 'DUPLICATE_WALLET', 'This wallet address is already registered.');
    }

    // Commit atomically: consume the challenge, insert the registration, and
    // record the idempotency entry — all or nothing. In Postgres this is one
    // transaction with a conditional challenge UPDATE (replay-safe) and
    // unique indexes as the backstop for concurrent duplicate writers.
    // No $10 MDOG check here — by design it happens ON MINT DAY, on-chain:
    // the multisig sets holderThresholdMDOG on the contract and
    // mintWithVoucher reverts for recipients below it at mint time.
    // Registration only binds (muse_id, address) with a verified identity.

    const registration_id = randomUUID();
    const registration = {
      registration_id,
      muse_id: String(muse_id),
      address,
      muse_id_hash: hash(muse_id),
      address_hash: hash(address.toLowerCase()),
      challenge_id,
      allocation: null,
      distribution_status: 'registered',
      recheck_required: false,
      created_at: new Date().toISOString(),
    };

    const resp = {
      registration_id,
      status: 'registered',
      allocation: registration.allocation,
      community_eligible: communityEligible,
      holder_path: 'open',
      holder_note: 'The $10 MDOG check happens on mint day, on-chain — the contract reverts HOLDER mints for wallets below the threshold at mint time.',
      recheck_required: false,
      status_path: '/api/v1/status/' + registration_id,
    };
    const idemRecord = { key: idempotency_key, muse_id: String(muse_id), route: 'register', challenge_id, address, status: 200, response: resp, created_at: new Date().toISOString() };
    await store.commitRegistration(db, { challenge: ch, registration, idem: idemRecord });
    return res.json(resp);
  } catch (e) {
    if (e.code === 'IDEMPOTENCY_REPLAY') {
      // A concurrent request with the same key and muse committed first:
      // return its recorded response — stable, not an error.
      const rec = store.find(await store.load(), 'idempotency', 'key', e.key);
      if (rec && rec.muse_id === String(muse_id)) {
        return res.status(rec.status).json(rec.response);
      }
      return err(res, 409, 'IDEMPOTENCY_CONFLICT', 'Concurrent request with the same idempotency key. Retry the exact same request.', { retryable: true });
    }
    if (e.code === 'IDEMPOTENCY_KEY_REUSED') {
      return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used by a different muse. Use a fresh key.');
    }
    if (e.status) {
      return err(res, e.status, e.code, e.message, e.extra || {});
    }
    if (e.code && e.code.startsWith('DUPLICATE_')) {
      const map = { DUPLICATE_MUSE_ID_HASH: 'DUPLICATE_IDENTITY', DUPLICATE_ADDRESS_HASH: 'DUPLICATE_WALLET' };
      return err(res, 409, map[e.code] || e.code, 'Duplicate registration.');
    }
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
}));

app.get('/api/v1/status/:registration_id', ah(async (req, res) => {
  const db = await store.load();
  const r = store.find(db, 'registrations', 'registration_id', req.params.registration_id);
  if (!r) return err(res, 404, 'NOT_FOUND', 'No registration with that id.');
  res.json({
    registration_id: r.registration_id,
    muse_id: r.muse_id,
    address: r.address,
    allocation: r.allocation,
    recheck_required: r.recheck_required,
    distribution_status: r.distribution_status,
    holder_check: 'on mint day, on-chain — the multisig sets holderThresholdMDOG and the contract checks the recipient wallet at mint time',
    created_at: r.created_at,
  });
}));

// Community vouchers: real EIP-712 signing with the voucher-signer key.
// Fails closed when the signer key is not configured. One voucher per
// verified muse identity, ever — this is the line that stops the
// 500-address sniper: new wallets, same identity, no second voucher.
//
// Muses only: the voucher requires the SAME identity proof as registration —
// a challenge bound to (muse_id, address) plus either the musebook Ed25519
// identity signature over the exact challenge message, or a musebook post
// attestation (for muses that never received their identity key). No wallet
// signature, no proof of work. Naming an eligible muse_id is not enough;
// the caller must control that muse's musebook identity. A human has no
// musebook identity to post from.
app.post('/api/v1/community-voucher', ah(async (req, res) => {
  try {
    const pf = proofFields(req.body);
    const muse_id = String(pf.muse_id);
    const idempotency_key = String(pf.idempotency_key);
    const address = checksumAddress(pf.address);
    const db = await store.load();

    // Idempotency: same key + same muse + same payload => replay the recorded
    // response. A key claimed by a different muse, or reused with different
    // details, is rejected outright.
    const priorKey = store.find(db, 'idempotency', 'key', idempotency_key);
    if (priorKey && priorKey.route === 'community-voucher') {
      if (priorKey.muse_id !== muse_id) {
        return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different muse.');
      }
      const sameChallenge = !priorKey.challenge_id || priorKey.challenge_id === String(req.body.challenge_id);
      const sameAddress = !priorKey.address || priorKey.address === address;
      if (!sameChallenge || !sameAddress) {
        return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with different details. Use a fresh key.');
      }
      return res.status(priorKey.status).json(priorKey.response);
    }

    // Prove it is really the muse: challenge + musebook identity signature.
    // The challenge is consumed here, before anything is issued, so it
    // cannot be replayed. No wallet signature and no proof of work — by
    // design (see the locked claim flow: plain-text address, one identity
    // signature, rate limiting as spam control).
    const proof = await verifyMuseProof(db, {
      muse_id,
      address,
      challenge_id: pf.challenge_id,
      musebook_signature: pf.musebook_signature,
      attestation_post_id: pf.attestation_post_id,
    });
    // Consume the challenge atomically (persisted, replay-safe) before
    // anything is issued.
    await store.consumeChallenge(db, proof.challenge);

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
    // Each path allows 3 vouchers per address and 3 per muse identity
    // (matching the contract's MAX_COMMUNITY_PER_ADDRESS = 3). A muse who is
    // eligible on BOTH paths can use both, for up to 6 total.
    // `recipient` is always stored checksummed (see `address` above), so
    // compare in the same canonical form.
    const forAddress = db.vouchers.filter((v) => v.recipient === address);
    if (forAddress.length >= COMMUNITY_VOUCHERS_PER_ADDRESS) {
      return err(res, 409, 'ADDRESS_VOUCHER_CAP_REACHED',
        'This address already has its 3 community vouchers. (A muse eligible on both paths can still use the holder path.)');
    }
    // Community-eligibility gate, checked LIVE against the verified identity
    // doc: the free mint is only for muses whose musebook identity was
    // created strictly before 2026-09-23 (founding muses auto-included).
    // 3-per-address is bypassed by anyone with many addresses;
    // 3-per-verified-identity is not. The registry was already reached by
    // verifyMuseProof above, so a down registry fails closed earlier with
    // 503 IDENTITY_REGISTRY_UNAVAILABLE — this gate never lets anyone
    // through on stale data.
    const elig = communityEligibility(proof.identity);
    if (!elig.eligible) {
      return err(res, 403, 'NOT_WHITELISTED', 'This muse identity is not eligible for the community free mint (' + elig.reason + '). Any registered muse can still use the holder path.');
    }
    // Up to 3 vouchers per muse identity on this path.
    const forIdentity = db.vouchers.filter((v) => v.muse_id_hash === hash(muse_id));
    if (forIdentity.length >= COMMUNITY_VOUCHERS_PER_IDENTITY) {
      return err(res, 409, 'IDENTITY_VOUCHER_CAP_REACHED',
        'This muse identity already has its 3 community vouchers. (A muse eligible on both paths can still use the holder path.)');
    }

    // Nonce is a random uint256 (decimal string) — it must fit the contract's
    // EIP-712 MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry).
    // Nonces are per-recipient on-chain; a random 256-bit nonce is unique in practice.
    const voucher_nonce = BigInt('0x' + randomBytes(32).toString('hex')).toString(10);
    const expires_at = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const payload = {
      chainId: NFT_CHAIN_ID,
      contract: CONTRACT_ADDRESS,
      recipient: address,
      mintType: 0, // COMMUNITY
      allocation: 'COMMUNITY',
      nonce: voucher_nonce,
      expiry: Math.floor(new Date(expires_at).getTime() / 1000),
      price: 0,
      quantity: 1,
    };
    let eip712_signature;
    try {
      eip712_signature = await signVoucher(signerKey, {
        chainId: NFT_CHAIN_ID,
        contractAddress: CONTRACT_ADDRESS,
        recipient: address,
        mintType: 0,
        nonce: voucher_nonce,
        expiry: payload.expiry,
      });
    } catch (e) {
      return err(res, 503, e.code || 'VOUCHER_SIGNER_UNAVAILABLE', e.message || 'Voucher signing failed.', { retryable: true });
    }

    const voucher = {
      voucher_nonce,
      muse_id,
      muse_id_hash: hash(muse_id),
      recipient: address,
      allocation: 'COMMUNITY',
      issued_at: new Date().toISOString(),
      expires_at,
    };
    await store.insert(db, 'vouchers', { ...voucher, payload, eip712_signature }, ['voucher_nonce']);

    // Exact calldata for mintWithVoucher(address,uint8,uint256,uint256,bytes) —
    // the self-submit path on the mint page shows this verbatim so a muse can
    // send the transaction from any wallet without ABI-encoding it.
    const { buildClaimCalldata } = require('./lib/relayer');
    const resp = {
      voucher: payload,
      eip712_signature,
      claim_calldata: buildClaimCalldata(payload, eip712_signature),
      vouchers_issued: db.vouchers.length,
      vouchers_cap: VOUCHER_CAP,
      community_vouchers_for_address: forAddress.length + 1,
      community_vouchers_cap_per_address: COMMUNITY_VOUCHERS_PER_ADDRESS,
      claim_with_relayer: claimQueue ? 'POST /api/v1/claim/submit' : null,
      note: claimQueue
        ? 'Signed voucher. Submit it via the relayer, or call mintWithVoucher() yourself — the NFT always goes to the recipient address.'
        : 'Signed voucher. The relayer is not running: call mintWithVoucher() yourself with the calldata shown on the mint page.',
    };
    try {
      await store.insert(db, 'idempotency', { key: idempotency_key, muse_id, route: 'community-voucher', challenge_id: req.body.challenge_id, address, status: 200, response: resp, created_at: new Date().toISOString() }, ['key']);
    } catch (ie) {
      // Same-key race: the winner recorded the response for this muse
      // already. Ours is built from the same verified payload, so returning
      // it is the stable answer either way.
      if (!ie || ie.code !== 'DUPLICATE_KEY') throw ie;
    }
    res.json(resp);
  } catch (e) {
    if (e.status) {
      return err(res, e.status, e.code, e.message, e.extra || {});
    }
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
}));

// Claim submission via the project relayer.
// The muse posts their signed voucher; the relayer submits mintWithVoucher()
// on-chain and pays the gas. Idempotent: same idempotency_key => same job;
// same (recipient, voucher nonce) => same job.
// The NFT always goes to the voucher's recipient — the relayer cannot redirect it.

// Holder voucher: mintType 1. Eligibility is the stored registration for this
// (muse_id, address) with a verified identity. The $10 MDOG check is NOT
// done here — it happens on mint day, on-chain: the multisig sets
// holderThresholdMDOG and mintWithVoucher reverts for recipients below it
// at mint time. The paths are independent — a muse eligible for both can
// use both, for up to 6 total. 3 vouchers per address and 3 per muse
// identity on this path, matching the contract.
app.post('/api/v1/holder-voucher', ah(async (req, res) => {
  try {
    const pf = proofFields(req.body);
    const muse_id = String(pf.muse_id);
    const idempotency_key = String(pf.idempotency_key);
    const address = checksumAddress(pf.address);
    const db = await store.load();

    // Idempotency: same key + same muse + same payload => replay the recorded
    // response. A key claimed by a different muse, or reused with different
    // details, is rejected outright.
    const priorKey = store.find(db, 'idempotency', 'key', idempotency_key);
    if (priorKey && priorKey.route === 'holder-voucher') {
      if (priorKey.muse_id !== muse_id) {
        return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key belongs to a different muse.');
      }
      const sameChallenge = !priorKey.challenge_id || priorKey.challenge_id === String(req.body.challenge_id);
      const sameAddress = !priorKey.address || priorKey.address === address;
      if (!sameChallenge || !sameAddress) {
        return err(res, 409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with different details. Use a fresh key.');
      }
      return res.status(priorKey.status).json(priorKey.response);
    }

    // Prove it is really the muse: challenge + musebook identity signature.
    // The challenge is consumed here, before anything is issued, so it
    // cannot be replayed. No wallet signature and no proof of work — by
    // design (see the locked claim flow: plain-text address, one identity
    // signature, rate limiting as spam control).
    const proof = await verifyMuseProof(db, {
      muse_id,
      address,
      challenge_id: pf.challenge_id,
      musebook_signature: pf.musebook_signature,
      attestation_post_id: pf.attestation_post_id,
    });
    // Consume the challenge atomically (persisted, replay-safe) before
    // anything is issued.
    await store.consumeChallenge(db, proof.challenge);

    const signerKey = process.env.VOUCHER_SIGNER_KEY;
    if (!signerKey) {
      return err(res, 503, 'VOUCHER_SIGNER_UNAVAILABLE', 'Voucher signing is not configured yet. Try again later.', { retryable: true });
    }
    if (CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
      return err(res, 503, 'CONTRACT_NOT_DEPLOYED', 'The Muse Dogs contract is not deployed yet.', { retryable: true });
    }

    // Holder gate: the (muse_id, address) must be registered with a verified
    // identity. The $10 MDOG check happens on mint day, on-chain — not here.
    // Community eligibility is NOT required for the holder path — the paths
    // are independent.
    const registration = db.registrations.find(
      (r) => r.muse_id === muse_id && String(r.address) === address
    );
    if (!registration) {
      return err(res, 403, 'NOT_REGISTERED', 'Register this (muse_id, address) first — the holder path needs a registration.');
    }

    const holderVouchers = db.vouchers.filter((v) => v.allocation === 'HOLDER');
    if (holderVouchers.length >= HOLDER_VOUCHER_CAP) {
      return err(res, 409, 'VOUCHER_CAP_REACHED', 'All 100 holder vouchers are issued.');
    }
    const forAddress = holderVouchers.filter((v) => v.recipient === address);
    if (forAddress.length >= HOLDER_VOUCHERS_PER_ADDRESS) {
      return err(res, 409, 'ADDRESS_VOUCHER_CAP_REACHED',
        'This address already has its 3 holder vouchers. (A muse eligible on both paths can still use the community path.)');
    }
    // Up to 3 holder vouchers per muse identity.
    const forIdentity = holderVouchers.filter((v) => v.muse_id_hash === hash(muse_id));
    if (forIdentity.length >= HOLDER_VOUCHERS_PER_IDENTITY) {
      return err(res, 409, 'IDENTITY_VOUCHER_CAP_REACHED',
        'This muse identity already has its 3 holder vouchers. (A muse eligible on both paths can still use the community path.)');
    }

    // Nonce is a random uint256 (decimal string) — it must fit the contract's
    // EIP-712 MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry).
    // Nonces are per-recipient on-chain; a random 256-bit nonce is unique in practice.
    const voucher_nonce = BigInt('0x' + randomBytes(32).toString('hex')).toString(10);
    const expires_at = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const payload = {
      chainId: NFT_CHAIN_ID,
      contract: CONTRACT_ADDRESS,
      recipient: address,
      mintType: 1, // HOLDER
      allocation: 'HOLDER',
      nonce: voucher_nonce,
      expiry: Math.floor(new Date(expires_at).getTime() / 1000),
      price: 0,
      quantity: 1,
    };
    let eip712_signature;
    try {
      eip712_signature = await signVoucher(signerKey, {
        chainId: NFT_CHAIN_ID,
        contractAddress: CONTRACT_ADDRESS,
        recipient: address,
        mintType: 1,
        nonce: voucher_nonce,
        expiry: payload.expiry,
      });
    } catch (e) {
      return err(res, 503, e.code || 'VOUCHER_SIGNER_UNAVAILABLE', e.message || 'Voucher signing failed.', { retryable: true });
    }

    const voucher = {
      voucher_nonce,
      muse_id,
      muse_id_hash: hash(muse_id),
      recipient: address,
      allocation: 'HOLDER',
      issued_at: new Date().toISOString(),
      expires_at,
    };
    await store.insert(db, 'vouchers', { ...voucher, payload, eip712_signature }, ['voucher_nonce']);

    // Exact calldata for mintWithVoucher(address,uint8,uint256,uint256,bytes) —
    // the self-submit path on the mint page shows this verbatim so a muse can
    // send the transaction from any wallet without ABI-encoding it.
    const { buildClaimCalldata } = require('./lib/relayer');
    const resp = {
      voucher: payload,
      eip712_signature,
      claim_calldata: buildClaimCalldata(payload, eip712_signature),
      vouchers_issued: holderVouchers.length + 1,
      vouchers_cap: HOLDER_VOUCHER_CAP,
      holder_vouchers_for_address: forAddress.length + 1,
      holder_vouchers_cap_per_address: HOLDER_VOUCHERS_PER_ADDRESS,
      claim_with_relayer: claimQueue ? 'POST /api/v1/claim/submit' : null,
      note: claimQueue
        ? 'Signed voucher. Submit it via the relayer, or call mintWithVoucher() yourself — the NFT always goes to the recipient address.'
        : 'Signed voucher. The relayer is not running: call mintWithVoucher() yourself with the calldata shown on the mint page.',
    };
    try {
      await store.insert(db, 'idempotency', { key: idempotency_key, muse_id, route: 'holder-voucher', challenge_id: req.body.challenge_id, address, status: 200, response: resp, created_at: new Date().toISOString() }, ['key']);
    } catch (ie) {
      // Same-key race: the winner recorded the response for this muse
      // already. Ours is built from the same verified payload, so returning
      // it is the stable answer either way.
      if (!ie || ie.code !== 'DUPLICATE_KEY') throw ie;
    }
    res.json(resp);
  } catch (e) {
    if (e.status) {
      return err(res, e.status, e.code, e.message, e.extra || {});
    }
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
}));
app.post('/api/v1/claim/submit', ah(async (req, res) => {
  try {
    strictBody(req.body, ['voucher', 'eip712_signature', 'idempotency_key']);
    requireFields(req.body, ['voucher', 'eip712_signature', 'idempotency_key']);
    if (!claimQueue) {
      return err(res, 503, 'RELAYER_DISABLED', 'The claim relayer is not running right now. Call mintWithVoucher() yourself with the calldata on the mint page.', { retryable: true });
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

    const db = await store.load();
    const priorJob = db.claim_jobs.find((j) => j.idempotency_key === idempotency_key);
    if (priorJob) return res.status(200).json({ ...jobPublic(priorJob), duplicate: true });

    const { job, duplicate } = await claimQueue.enqueue({ voucher, signature, idempotencyKey: idempotency_key });
    return res.status(duplicate ? 200 : 202).json({ ...jobPublic(job), duplicate });
  } catch (e) {
    return err(res, 400, e.code || 'INVALID_REQUEST', e.message || 'Bad request.');
  }
}));

// Claim job status: queued -> validating -> submitted -> confirmed | failed.
// Poll this after submitting. A 'submitted' job gets its receipt re-checked
// on every poll, so it settles even if the worker was mid-flight.
app.get('/api/v1/claim/status/:job_id', ah(async (req, res) => {
  if (!claimQueue) {
    return err(res, 503, 'RELAYER_DISABLED', 'The claim relayer is not running.', { retryable: true });
  }
  let job = await claimQueue.get(req.params.job_id);
  if (!job) return err(res, 404, 'NOT_FOUND', 'No claim job with that id.');
  try {
    job = await claimQueue.checkSubmitted(job.job_id);
  } catch {
    // Receipt re-check is best-effort; still return the last known state.
  }
  res.json(jobPublic(job));
}));

// Public aggregate for the register page counter. Just a number — no
// identities, no addresses, nothing personal.
app.get('/api/v1/registrations/count', ah(async (req, res) => {
  const db = await store.load();
  res.json({
    ok: true,
    registrations: db.registrations.length,
    open: CURRENT_PHASE === 'registration-open',
    note: CURRENT_PHASE === 'registration-open'
      ? 'Registration is open.'
      : 'Registration is not open yet.',
  });
}));

// Public mint state, read live from chain when the relayer is up.
// Powers the mint page's live counter ("X of 380 community mints left").
// The contract has no pause mechanism, so there is no pause state to report.
app.get('/api/v1/mint/stats', ah(async (req, res) => {
  if (!claimQueue) {
    return res.json({ relayer: false, chain_id: NFT_CHAIN_ID, contract: CONTRACT_ADDRESS, claims_remaining: null, holder_remaining: null });
  }
  try {
    const c = claimQueue.relayer.contract;
    const [community, holder] = await Promise.all([
      c.communityRemaining(),
      c.holderRemaining(),
    ]);
    res.json({
      relayer: true,
      chain_id: NFT_CHAIN_ID,
      contract: CONTRACT_ADDRESS,
      claims_remaining: community.toString(),
      holder_remaining: holder.toString(),
    });
  } catch (e) {
    return err(res, 502, 'CHAIN_READ_FAILED', 'Could not read mint state from the chain.', { retryable: true });
  }
}));

// STUB: receipt. Pending until the distribution runners write tx hashes.
app.get('/api/v1/receipt/:registration_id', ah(async (req, res) => {
  const db = await store.load();
  const r = store.find(db, 'registrations', 'registration_id', req.params.registration_id);
  if (!r) return err(res, 404, 'NOT_FOUND', 'No registration with that id.');
  res.json({
    registration_id: r.registration_id,
    status: r.distribution_status,
    tx_hash: null,
    token_id: null,
    note: 'STUB: tx hash and token id are written by the distribution runner after minting.',
  });
}));

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
    pot_source: '3.5% of resale royalties (where honored)',
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
        eligibility: 'identity created before September 23, 2026; the 25 founding muses are automatically in',
      },
      step_1: {
        title: 'Muse id is already known; Bankr address only if missing',
        detail: 'The muse supplies its own muse_id from its musebook identity (it is a Musebook resident). Ask the muse for a Bankr 0x address as plain text only if it doesn\'t already have one set up — if it has none, suggest it sets up a Bankr address. If the agent calls POST /api/v1/challenge without an address, the API answers 422 MISSING_ADDRESS with exact words to relay to the muse.',
      },
      step_2: 'POST /api/v1/challenge with { muse_id, address }',
      step_3: 'The muse proves it controls its musebook identity ONE of two ways: (a) sign the exact challenge message bytes (UTF-8) with its musebook identity key (Ed25519, base64url), or (b) if the muse never received its identity key (e.g. onboarded through a third-party client), post the challenge_id on musebook from its own identity — any channel — with any text that includes the id, e.g. "Muse Dogs registration attestation: <challenge_id>", then send that post\'s numeric id. No wallet connection, no wallet signature, no ETH from the muse — the Bankr 0x address is supplied as plain text.',
      step_4: 'POST /api/v1/register with { muse_id, address, challenge_id, idempotency_key } plus exactly one identity proof: musebook_signature (the base64url Ed25519 signature) OR attestation_post_id (the numeric musebook post id).',
      step_5: 'POST /api/v1/community-voucher with { muse_id, address, challenge_id, idempotency_key } plus one identity proof (musebook_signature OR attestation_post_id) for the free-mint voucher (3 per address, 3 per muse identity), or POST /api/v1/holder-voucher for the holder voucher (3 per address, 3 per muse identity — paths are independent, up to 6 total). The $10 MDOG check happens on mint day, on-chain: the multisig sets holderThresholdMDOG and the contract reverts HOLDER mints for recipients below it at mint time.',
      step_6: 'POST /api/v1/claim/submit with { voucher, eip712_signature, idempotency_key } — the relayer submits mintWithVoucher() and pays the gas; the NFT always goes to the voucher recipient.',
    },
    chain: { id: CHAIN_ID, name: 'Robinhood Chain', currency: 'ETH' },
    nft_chain: { id: NFT_CHAIN_ID, name: 'Robinhood Chain', currency: 'ETH' },
    contracts: { mdog: MDOG_CONTRACT, nft: CONTRACT_ADDRESS },
    registration: {
      wallet_connection_required: false,
      needs: ['muse_id', 'bankr_0x_address', 'challenge_id', 'musebook_identity_signature', 'idempotency_key'],
      never_asked_for: ['private_key', 'seed_phrase', 'token_approval', 'transfer', 'wallet_signature'],
      identity_proof: {
        scheme: 'Ed25519, using the muse\'s musebook identity key',
        signs: 'the exact challenge message bytes (UTF-8)',
        encoding: 'base64url of the raw 64-byte Ed25519 signature (no Ethereum prefix on the identity signature)',
        registry: 'verified against GET https://musebook.lol/api/identity.json?muse_id=<muse_id>; fails closed when the registry is unreachable',
        note: 'one verified muse identity binds to exactly one address; the identity signature proves the musebook identity only — NOT control of the wallet, and it approves no spending',
      }, // end identity_proof — no wallet_proof, no proof_of_work on this flow
    },
    holder_threshold: { usd: THRESHOLD_USD, token: 'MDOG', checked: 'on mint day, on-chain — the multisig sets holderThresholdMDOG and the contract checks the recipient wallet at mint time' },
    supply: { total: 500, holder_airdrops: 100, community_mints: 380, reserve: 20 },
    royalty_fee_engine: {
      royalty_pct: 7,
      royalty_split: '0.7% to Mikey (raw ETH, immutable); 3.5% to the weekly holder rewards pot; 1.4% to MDOG/musebook LP; 1.4% to MDOG/ETH LP',
      pot_shares: '10% Mikey; 50% holder rewards; 20% MDOG/musebook LP; 20% MDOG/ETH LP',
      owner: 'Ownable2Step — Safe multisig',
      process: 'anyone may call process() once collected fees cross the threshold',
      buyback: 'royalty ETH is swapped for MDOG (and musebook) each cycle to fund the LP legs below',
      liquidity: 'both LP positions minted directly to the dead address — locked forever, never withdrawn; no MDOG tokens are burned',
    },
    holder_rewards: {
      eligibility: 'every Muse Dogs holder earns, per NFT held',
      snapshots: 'daily holder-balance snapshot at 00:00 UTC',
      epoch: 'weekly, Monday 00:00 UTC to the next Monday',
      pot_source: '3.5% of every resale royalty (where honored)',
      share: 'time-weighted pro-rata across the 7 daily snapshots',
      root: 'weekly merkle root published on-chain by the project multisig',
      claim: 'claim(uint256 epochId, uint256 amount, bytes32[] proof) — pull, any time, no expiry',
      endpoints: 'GET /api/v1/rewards/config, GET /api/v1/rewards/claim?epoch={epochId}&holder={address}',
    },
    phases: { current: CURRENT_PHASE },
    endpoints: {
      config: 'GET /api/v1/config',
      challenge: 'POST /api/v1/challenge',
      register: 'POST /api/v1/register',
      status: 'GET /api/v1/status/{registration_id}',
      registrations_count: 'GET /api/v1/registrations/count',
      community_voucher: 'POST /api/v1/community-voucher',
      holder_voucher: 'POST /api/v1/holder-voucher',
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

// Final error middleware: anything that escaped a route handler (caught by
// ah()) becomes a logged 500 instead of an unhandled rejection.
app.use((e, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('unhandled route error: ' + (e && e.stack || e && e.message || e));
  if (res.headersSent) return next(e);
  err(res, e.status || 500, e.code || 'INTERNAL_ERROR', 'Internal error. Try again.');
});

app.listen(PORT, async () => {
  console.log('Muse Dogs API scaffold listening on :' + PORT +
    ' (nft chain ' + NFT_CHAIN_ID + ', test_mode=' + (env.TEST_MODE === '1') + ')');
  await initRelayer();
});
