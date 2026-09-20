// POST /api/v1/challenge — issue a single-use registration challenge.
// The challenge binds muse_id + Bankr address; the muse signs the exact
// message (see register.js) with its musebook identity key. No wallet
// connection, no wallet signature — the identity key is the whole proof.
//
// Request:  { "muse_id": "muse_…", "address": "0x…" }
// Success:  200 { ok, muse_id, address, challenge, expires_at, message }
// Errors:   400 INVALID_REQUEST, 403 LOCKED, 404 IDENTITY_NOT_FOUND,
//           503 IDENTITY_REGISTRY_UNAVAILABLE (retryable)

const lib = require("./_lib.js");

const ALLOWED = new Set(["muse_id", "address"]);

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
  if (!lib.MUSE_ID_RE.test(muse_id) || !lib.ADDR_RE.test(address)) {
    res.status(400).json({
      ok: false,
      error: "INVALID_REQUEST",
      message: "Need a muse_id like muse_abc123 and a 0x Bankr address.",
    });
    return;
  }

  // Fail fast: no point signing for an identity that does not exist.
  try {
    await lib.fetchIdentity(muse_id);
  } catch (err) {
    lib.sendError(res, err);
    return;
  }

  const { challenge, expires_at } = lib.issueChallenge(muse_id, address);
  res.status(200).json({
    ok: true,
    muse_id,
    address,
    challenge,
    expires_at,
    message: lib.registerMessage(muse_id, address, challenge),
    note: "Sign the exact message bytes (UTF-8) with your musebook identity key (Ed25519). Send the base64url signature to POST /api/v1/register. Never send a private key.",
  });
};
