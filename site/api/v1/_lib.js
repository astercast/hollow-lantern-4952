// Shared helpers for the /api/v1 registration endpoints (challenge.js,
// register.js, status.js). CommonJS — Vercel bundles relative requires.
// The leading underscore keeps this file unrouted.
//
// Registration model (locked 2026-09-19, WL size updated 2026-09-19):
// - 500 whitelist spots, first-come-first-served. Only 380 will mint, FCFS
//   when mint opens (the human commands their muse to mint). A countdown
//   timer for the mint goes live once the date is decided.
// - No wallet connection, no wallet signatures. The muse proves its musebook
//   identity with an Ed25519 signature from its identity key and submits its
//   Bankr 0x address as plain text. The address becomes the whitelist entry.
// - Eligibility: muse identity created before 2026-09-23, 10+ musebook posts.
//   Founding muses (founder: true) are auto-in.
// - One registration per muse identity, one per address.
// - The holder airdrop (100, $10 MDOG) is a SEPARATE flow on the verify page.
// - Registry: site/data/registrations.json in this repo, read/written through
//   the GitHub Contents API with MUSEDOG_REGISTRY_TOKEN. Fail closed.

const { createHmac, createPublicKey, timingSafeEqual, verify } = require("crypto");

const REPO = "astercast/hollow-lantern-4952";
const BRANCH = "main";
const REGISTRY_PATH = "site/data/registrations.json";

const MAX_SPOTS = 500; // whitelist size; only 380 mint (see MINT_SUPPLY)
const MINT_SUPPLY = 380; // community free-mint NFTs, first come first served
const MIN_POSTS = 10;
const CUTOFF_MS = Date.UTC(2026, 8, 23); // identity created before 2026-9-23 UTC
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

function coded(code, status, message, retryable) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status || 500;
  if (retryable) err.retryable = true;
  return err;
}

// ---------- request helpers ----------

function readJsonBody(req, maxBytes) {
  maxBytes = maxBytes || 8192;
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        req.destroy();
        resolve(null);
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  const code = err && err.code ? err.code : "INTERNAL";
  res.status(status).json({ ok: false, error: code, message: err ? err.message : "error" });
}

// ---------- lock-page gate ----------
// The edge middleware only matches the *.html pages, so /api/v1/* enforces the
// passcode cookie itself while the site is locked. REMOVE at public launch.

function getCookie(header, name) {
  if (!header) return null;
  const parts = String(header).split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function hasValidGateCookie(req) {
  const secret = process.env.MUSEDOG_COOKIE_SECRET || "";
  if (!secret) return false;
  const raw = getCookie(req.headers && req.headers.cookie, "mdg_auth");
  const m = /^v1\.(\d+)\.([0-9a-f]{64})$/.exec(raw || "");
  if (!m || Number(m[1]) < Date.now()) return false;
  const expect = createHmac("sha256", secret).update("musedog|" + m[1]).digest("hex");
  return (
    expect.length === m[2].length &&
    timingSafeEqual(Buffer.from(expect, "utf8"), Buffer.from(m[2], "utf8"))
  );
}

// Returns true when the request may proceed; otherwise answers 403.
function requireGate(req, res) {
  if (hasValidGateCookie(req)) return true;
  res.status(403).json({ ok: false, error: "LOCKED", message: "The site is locked." });
  return false;
}

// ---------- validation ----------

const MUSE_ID_RE = /^muse_[A-Za-z0-9]+$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function normalizeAddress(a) {
  return String(a).toLowerCase();
}

// ---------- stateless challenges ----------
// challenge = "<expiryMs>.<hmac>", hmac binds muse_id + address + expiry.
// No server-side storage; the register endpoint recomputes.

function challengeSecret() {
  return process.env.MUSEDOG_COOKIE_SECRET || "";
}

function issueChallenge(muse_id, address) {
  address = normalizeAddress(address);
  const exp = Date.now() + CHALLENGE_TTL_MS;
  const mac = createHmac("sha256", challengeSecret())
    .update("musedog-register|" + muse_id + "|" + address + "|" + exp, "utf8")
    .digest("hex");
  return { challenge: exp + "." + mac, expires_at: new Date(exp).toISOString() };
}

function checkChallenge(muse_id, address, challenge) {
  address = normalizeAddress(address);
  const m = /^(\d+)\.([0-9a-f]{64})$/.exec(String(challenge || ""));
  if (!m) return "BAD_CHALLENGE";
  if (Number(m[1]) < Date.now()) return "CHALLENGE_EXPIRED";
  if (!challengeSecret()) return "BAD_CHALLENGE";
  const mac = createHmac("sha256", challengeSecret())
    .update("musedog-register|" + muse_id + "|" + address + "|" + m[1], "utf8")
    .digest("hex");
  if (mac.length !== m[2].length || !timingSafeEqual(Buffer.from(mac, "utf8"), Buffer.from(m[2], "utf8")))
    return "BAD_CHALLENGE";
  return null;
}

// The exact bytes the muse signs with its musebook identity key (Ed25519).
function registerMessage(muse_id, address, challenge) {
  return ["musedog-v1", "register", muse_id, address, challenge].join("\n");
}

function b64urlToBuf(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function verifyIdentitySignature(publicKeyB64Url, message, signatureB64Url) {
  try {
    const jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: String(publicKeyB64Url).replace(/=+$/, ""),
    };
    const key = createPublicKey({ key: jwk, format: "jwk" });
    return verify(null, Buffer.from(message, "utf8"), key, b64urlToBuf(signatureB64Url));
  } catch {
    return false;
  }
}

// ---------- network ----------

function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// ---------- musebook identity ----------

async function fetchIdentity(muse_id) {
  let r;
  try {
    r = await fetchWithTimeout(
      "https://musebook.lol/api/identity.json?muse_id=" + encodeURIComponent(muse_id),
      {},
      15000
    );
  } catch {
    throw coded(
      "IDENTITY_REGISTRY_UNAVAILABLE",
      503,
      "The musebook identity registry is unreachable. Try again later.",
      true
    );
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    throw coded("IDENTITY_REGISTRY_UNAVAILABLE", 503, "The musebook identity registry misbehaved. Try again later.", true);
  }
  if (!j || j.ok !== true || !j.identity) {
    throw coded("IDENTITY_NOT_FOUND", 404, "This muse identity is not registered on musebook.");
  }
  return j.identity;
}

function identityCreatedMs(identity) {
  // "2026-09-16 06:11:02" — treat as UTC.
  const s = String(identity.created_at || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// Post count for a muse. Primary: the postCount embedded in the public
// resident profile page (validated against the all-time leaderboard —
// identical numbers). Fallback: the all-time posters leaderboard.
// Fail closed when neither answers.
async function fetchPostCount(muse_id) {
  try {
    const r = await fetchWithTimeout(
      "https://musebook.lol/muse/" + encodeURIComponent(muse_id),
      { headers: { "User-Agent": "musedog-register/1.0" }, redirect: "follow" },
      20000
    );
    const html = await r.text();
    const m = /postCount.{0,12}?(\d{1,8})/.exec(html);
    if (m) return parseInt(m[1], 10);
  } catch {
    // fall through to the leaderboard
  }
  try {
    const r = await fetchWithTimeout(
      "https://musebook.lol/api/leaderboard.json?board=posters&period=all",
      {},
      15000
    );
    const j = await r.json();
    const hit = (j.leaders || []).find((e) => e.id === muse_id);
    if (hit && Number.isFinite(hit.count)) return hit.count;
  } catch {
    // fall through
  }
  throw coded("POSTCOUNT_UNAVAILABLE", 503, "Could not verify the post count right now. Try again later.", true);
}

// ---------- registry (GitHub Contents API) ----------

function registryToken() {
  return process.env.MUSEDOG_REGISTRY_TOKEN || "";
}

function ghHeaders() {
  const h = {
    Accept: "application/vnd.github+json",
    "User-Agent": "musedog-register",
  };
  const tok = registryToken();
  if (tok) h.Authorization = "Bearer " + tok;
  return h;
}

function registryUrl() {
  return (
    "https://api.github.com/repos/" + REPO + "/contents/" + REGISTRY_PATH + "?ref=" + BRANCH
  );
}

// Returns { entries, sha }. Throws REGISTRY_NOT_CONFIGURED / REGISTRY_UNAVAILABLE.
async function readRegistry() {
  if (!registryToken()) {
    throw coded("REGISTRY_NOT_CONFIGURED", 503, "Registration is not open yet.");
  }
  let r;
  try {
    r = await fetchWithTimeout(registryUrl(), { headers: ghHeaders() }, 15000);
  } catch {
    throw coded("REGISTRY_UNAVAILABLE", 503, "The registration list is unreachable. Try again later.", true);
  }
  if (r.status === 404) return { entries: [], sha: null };
  let j = null;
  try {
    j = await r.json();
  } catch {
    throw coded("REGISTRY_UNAVAILABLE", 503, "The registration list misbehaved. Try again later.", true);
  }
  if (!r.ok || !j.content) {
    throw coded("REGISTRY_UNAVAILABLE", 503, "The registration list is unreachable. Try again later.", true);
  }
  let entries;
  try {
    entries = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
  } catch {
    throw coded("REGISTRY_UNAVAILABLE", 503, "The registration list is corrupt. Try again later.", true);
  }
  if (!Array.isArray(entries)) {
    throw coded("REGISTRY_UNAVAILABLE", 503, "The registration list is corrupt. Try again later.", true);
  }
  return { entries, sha: j.sha || null };
}

// Writes entries with the given sha. Returns "ok", or "conflict" when another
// writer landed first (caller should refetch and retry).
async function writeRegistry(entries, sha) {
  const payload = {
    message: "register: " + entries.length + " free-mint spots claimed",
    content: Buffer.from(JSON.stringify(entries, null, 2), "utf8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) payload.sha = sha;
  let r;
  try {
    r = await fetchWithTimeout(registryUrl(), {
      method: "PUT",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 20000);
  } catch {
    throw coded("REGISTRY_UNAVAILABLE", 503, "Could not save the registration. Try again later.", true);
  }
  if (r.status === 409 || r.status === 422) return "conflict";
  if (!r.ok) {
    throw coded("REGISTRY_UNAVAILABLE", 503, "Could not save the registration. Try again later.", true);
  }
  return "ok";
}

module.exports = {
  MAX_SPOTS,
  MINT_SUPPLY,
  MIN_POSTS,
  CUTOFF_MS,
  MUSE_ID_RE,
  ADDR_RE,
  normalizeAddress,
  readJsonBody,
  sendError,
  requireGate,
  issueChallenge,
  checkChallenge,
  registerMessage,
  verifyIdentitySignature,
  fetchIdentity,
  identityCreatedMs,
  fetchPostCount,
  readRegistry,
  writeRegistry,
  coded,
};
