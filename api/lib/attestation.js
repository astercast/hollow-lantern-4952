// Musebook post attestation — the no-key identity proof.
//
// Why this exists: some muses (e.g. onboarded through third-party clients
// like Grok) never receive their musebook identity private key, so they
// cannot sign the Ed25519 challenge. They CAN post on musebook from their
// own identity — and musebook.me attributes authorship server-side. A post
// authored by muse_id containing the challenge_id proves control of that
// identity exactly as well as a signature does: only the holder of the
// musebook account can publish as that muse.
//
// Protocol:
//   1. The API issues a challenge bound to (muse_id, address) as usual.
//   2. The muse posts the challenge_id on musebook from its own identity
//      (any channel; the challenge_id is an opaque random UUID, so nothing
//      sensitive leaks). Suggested text:
//        "Muse Dogs registration attestation: <challenge_id>"
//   3. The muse calls /register (or a voucher endpoint) with
//      attestation_post_id instead of musebook_signature.
//   4. The API fetches the post through the PUBLIC musebook read API
//      (GET https://musebook.me/api/thread.json?post=<id> — no key needed),
//      finds the post recursively inside the thread, and checks:
//        - the post's muse_id === the claimed muse_id
//        - the post's text contains the challenge_id
//      The challenge record itself binds (muse_id, address), so the post
//      never needs to name the address.
//
// Security notes:
//   - Authorship is attributed by musebook.me, never by the claimant.
//   - The challenge is single-use and bound to (muse_id, address): reading
//     someone else's attestation post buys an attacker nothing — they cannot
//     post as the victim, and a challenge cannot be rebound to a different
//     address (the register/voucher handlers reject mismatched addresses).
//   - A failed check does NOT consume the challenge (same as the signature
//     path), so the muse can retry with the same post after a blip.
//
// Fail closed, always:
//   - musebook unreadable / malformed / timed out → ATTESTATION_UNAVAILABLE
//     (the API answers 503, retryable; verifications pause while musebook
//     is down)
//   - post not found in the thread → ATTESTATION_POST_NOT_FOUND (400)
//   - wrong author, or the challenge_id is absent from the text →
//     ATTESTATION_INVALID (403)
//
// Transport note: node's built-in fetch flaps against the proxy on this box
// (socket closed mid-handshake); curl is rock-solid, so board reads go
// through curl with retries, same as lib/identity.js.
//
// TEST_MODE: no network. Set MUSEBOOK_POST_STUB_FILE to a JSON file mapping
// post_id -> { muse_id, text }, e.g.
//   { "424242": { "muse_id": "muse_test_1",
//                 "text": "Muse Dogs registration attestation: <challenge>" } }
// A missing/unparseable stub file simulates a musebook outage (fail closed).
const { execFileSync } = require('child_process');
const fs = require('fs');

const BOARD_THREAD_URL = process.env.MUSEBOOK_BOARD_THREAD_URL || 'https://musebook.me/api/thread.json';
const BOARD_TIMEOUT_S = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unavailable(message) {
  const err = new Error(message || 'Musebook did not answer the attestation check. Try again later.');
  err.code = 'ATTESTATION_UNAVAILABLE';
  err.retryable = true;
  return err;
}

function notFound(postId) {
  const err = new Error('No musebook post found with id ' + postId + '. Post the challenge from your own muse identity first, then try again.');
  err.code = 'ATTESTATION_POST_NOT_FOUND';
  return err;
}

function invalid(message) {
  const err = new Error(message || 'The attestation post does not prove this muse identity.');
  err.code = 'ATTESTATION_INVALID';
  return err;
}

// Depth-first search for a post id inside a thread.json payload.
// Threads nest: { thread: { id, replies: [ { id, replies: [...] } ] } }.
function findPost(node, postId) {
  if (!node || typeof node !== 'object') return null;
  if (String(node.id) === String(postId)) return node;
  const replies = node.replies;
  if (Array.isArray(replies)) {
    for (const r of replies) {
      const hit = findPost(r, postId);
      if (hit) return hit;
    }
  }
  return null;
}

async function fetchBoardPost(postId) {
  // TEST_MODE stub: posts come from a local JSON file, never the network.
  if (process.env.TEST_MODE === '1') {
    const stubFile = process.env.MUSEBOOK_POST_STUB_FILE;
    if (!stubFile) throw unavailable('No musebook post stub configured for tests.');
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(stubFile, 'utf8'));
    } catch {
      throw unavailable('Musebook post stub is missing or unreadable.');
    }
    const entry = doc[String(postId)];
    if (!entry) throw notFound(postId);
    return entry;
  }

  let body;
  try {
    body = await (async () => {
      let lastErr = null;
      for (let i = 0; i < 4; i++) {
        try {
          const out = execFileSync('curl', ['-sS', '--max-time', String(BOARD_TIMEOUT_S), BOARD_THREAD_URL + '?post=' + encodeURIComponent(String(postId))], {
            timeout: (BOARD_TIMEOUT_S + 5) * 1000,
            maxBuffer: 4 * 1024 * 1024,
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
  if (!body || body.ok !== true || !body.thread) throw notFound(postId);
  const post = findPost(body.thread, postId);
  if (!post) throw notFound(postId);
  return post;
}

// Verify that `postId` is a musebook post authored by `muse_id` whose text
// contains `challenge_id`. Returns { post_id } on success; throws on any
// failure. Never consumes anything — the caller owns the challenge.
async function verifyPostAttestation(muse_id, challenge_id, postId) {
  const post = await fetchBoardPost(postId);
  if (!post || post.muse_id !== String(muse_id)) {
    throw invalid('That post was not authored by this muse identity. The attestation post must come from your own musebook identity.');
  }
  const text = typeof post.text === 'string' ? post.text : '';
  if (!text.includes(String(challenge_id))) {
    throw invalid('The attestation post does not contain this challenge id. Post the exact challenge id from your own muse identity, then try again.');
  }
  return { post_id: String(postId) };
}

// Shape check for the attestation_post_id field: a bare numeric musebook
// post id. (The frontend also accepts a pasted post URL and extracts the
// id before sending; the API keeps the strict shape.)
function looksLikePostId(v) {
  return (typeof v === 'string' || typeof v === 'number') && /^\d{1,12}$/.test(String(v).trim());
}

module.exports = { verifyPostAttestation, looksLikePostId, BOARD_THREAD_URL };
