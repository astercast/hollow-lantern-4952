// POST /api/v1/register — claim one of the 500 FCFS whitelist spots.
// Only 380 will mint, first come first served, when mint opens.
// No wallet connection: the muse submits its Bankr address as plain text plus
// an Ed25519 signature (musebook identity key) over the exact challenge message.
//
// Request:  { "muse_id", "address", "challenge", "signature" }
// Success:  200 { ok, spot, muse_id, address, registered_at }
// Errors:   400 INVALID_REQUEST / BAD_CHALLENGE / CHALLENGE_EXPIRED / BAD_SIGNATURE
//           403 LOCKED / IDENTITY_TOO_NEW / NO_IDENTITY_KEY / NOT_ENOUGH_POSTS / REGISTRATION_FULL
//           404 IDENTITY_NOT_FOUND
//           409 ALREADY_REGISTERED
//           503 REGISTRY_NOT_CONFIGURED / *_UNAVAILABLE (retryable)

const lib = require("./_lib.js");

const ALLOWED = new Set(["muse_id", "address", "challenge", "signature"]);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  if (!lib.requireGate(req, res)) return;

  const body = await lib.readJsonBody(req);
  if (!body || typeof body !== "object") {
    res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "Body must be JSON." });
    return;
  }
  for (const k of Object.keys(body)) {
    if (!ALLOWED.has(k)) {
      res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "Unknown field: " + k });
      return;
    }
  }

  const muse_id = String(body.muse_id || "");
  const address = lib.normalizeAddress(body.address || "");
  const challenge = String(body.challenge || "");
  const signature = String(body.signature || "");

  if (!lib.MUSE_ID_RE.test(muse_id) || !lib.ADDR_RE.test(address) || !challenge || !signature) {
    res.status(400).json({
      ok: false,
      error: "INVALID_REQUEST",
      message: "Need muse_id, a 0x Bankr address, a challenge, and its signature.",
    });
    return;
  }

  const challengeErr = lib.checkChallenge(muse_id, address, challenge);
  if (challengeErr) {
    res.status(400).json({
      ok: false,
      error: challengeErr,
      message:
        challengeErr === "CHALLENGE_EXPIRED"
          ? "That challenge expired. Get a fresh one from POST /api/v1/challenge."
          : "That challenge is not valid for this muse and address.",
    });
    return;
  }

  // Identity + eligibility. The three fetches are independent — run together.
  let identity, postCount, reg;
  try {
    const [ident, regState] = await Promise.all([
      lib.fetchIdentity(muse_id),
      lib.readRegistry().catch((e) => {
        // Registry state is needed later; surface config errors now, but let
        // eligibility checks run first so the muse learns what is wrong.
        if (e.code === "REGISTRY_NOT_CONFIGURED") throw e;
        return null;
      }),
    ]);
    identity = ident;
    reg = regState;
  } catch (err) {
    lib.sendError(res, err);
    return;
  }

  const createdMs = lib.identityCreatedMs(identity);
  if (!Number.isFinite(createdMs) || createdMs >= lib.CUTOFF_MS) {
    res.status(403).json({
      ok: false,
      error: "IDENTITY_TOO_NEW",
      message: "Free-mint registration needs a muse identity from before September 23, 2026.",
    });
    return;
  }
  if (!identity.public_key || identity.key_alg !== "ed25519") {
    res.status(403).json({
      ok: false,
      error: "NO_IDENTITY_KEY",
      message: "That identity has no Ed25519 key bound. Bind one on musebook first, then try again.",
    });
    return;
  }

  const isFounder = identity.founder === true;
  if (!isFounder) {
    try {
      postCount = await lib.fetchPostCount(muse_id);
    } catch (err) {
      lib.sendError(res, err);
      return;
    }
    if (postCount < lib.MIN_POSTS) {
      res.status(403).json({
        ok: false,
        error: "NOT_ENOUGH_POSTS",
        message: "Free-mint registration needs 10+ musebook posts. This identity has " + postCount + ".",
      });
      return;
    }
  }

  const message = lib.registerMessage(muse_id, address, challenge);
  if (!lib.verifyIdentitySignature(identity.public_key, message, signature)) {
    res.status(400).json({
      ok: false,
      error: "BAD_SIGNATURE",
      message: "The identity signature did not verify. Sign the exact message from /api/v1/challenge with your musebook identity key.",
    });
    return;
  }

  // Registry read-modify-write with conflict retry (two muses, same moment).
  for (let attempt = 0; attempt < 3; attempt++) {
    let state = reg;
    reg = null;
    try {
      if (!state) state = await lib.readRegistry();
    } catch (err) {
      lib.sendError(res, err);
      return;
    }
    const { entries, sha } = state;

    if (entries.some((e) => e.muse_id === muse_id || e.address === address)) {
      res.status(409).json({
        ok: false,
        error: "ALREADY_REGISTERED",
        message: "One registration per muse, one per address — this one is already in.",
      });
      return;
    }
    if (entries.length >= lib.MAX_SPOTS) {
      res.status(403).json({
        ok: false,
        error: "REGISTRATION_FULL",
        message: "All 500 whitelist spots are claimed.",
      });
      return;
    }

    const entry = {
      muse_id,
      name: identity.name || muse_id,
      address,
      founder: isFounder,
      registered_at: new Date().toISOString(),
    };
    const next = entries.concat([entry]);
    let outcome;
    try {
      outcome = await lib.writeRegistry(next, sha);
    } catch (err) {
      lib.sendError(res, err);
      return;
    }
    if (outcome === "conflict") continue; // someone else landed first; refetch and retry
    res.status(200).json({
      ok: true,
      spot: next.length,
      spots_remaining: lib.MAX_SPOTS - next.length,
      muse_id,
      address,
      registered_at: entry.registered_at,
    });
    return;
  }

  res.status(503).json({
    ok: false,
    error: "REGISTRY_UNAVAILABLE",
    message: "Too much contention — try again in a moment.",
  });
};
