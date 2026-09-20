// GET /api/gate?file=<page> — serves one of the gated inner pages only when the
// visitor carries a valid mdg_auth cookie (set by /api/unlock).
//
// Why this exists: musedog.lol is a plain static Vercel deployment, and Vercel
// does not execute middleware.js for non-framework projects. So gating is done
// with vercel.json rewrites: /home.html (etc.) -> /api/gate?file=home.html.
// Without a valid cookie the visitor is bounced to / (the lock page).
//
// Security notes:
// - `file` is checked against a strict allowlist; anything else 404s.
// - Cookie validation mirrors site/api/unlock.js: HMAC-SHA256 over the expiry,
//   compared with timingSafeEqual. Fails closed when MUSEDOG_COOKIE_SECRET is
//   unset (redirects to /).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE_NAME = "mdg_auth";

// Every page behind the passcode. Add new inner pages here AND in vercel.json.
const GATED = new Set([
  "home.html",
  "register.html",
  "verify.html",
  "rewards.html",
  "api.html",
  "mint.html",
  "why.html",
]);

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

function safeEqual(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns true when the cookie is well-formed, unexpired, and correctly signed.
// Mirrors site/api/unlock.js exactly: value "v1.<expiryMs>.<sig>",
// sig = HMAC-SHA256(secret, "musedog|" + expiryMs).
function isValidCookie(value, secret) {
  if (!value || !secret) return false;
  const m = /^v1\.(\d+)\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const exp = parseInt(m[1], 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return false; // ms, like unlock.js
  const expect = crypto.createHmac("sha256", secret).update("musedog|" + m[1]).digest("hex");
  return safeEqual(m[2], expect);
}

// Disk location of each gated page, relative to the project root (site/).
// Most pages live as static files too (served only via the rewrites in
// vercel.json); why.html lives under api/_gated so it is never statically
// served — it is only reachable through this gate.
const FILE_PATHS = {
  "why.html": "api/_gated/why.html",
};

module.exports = async (req, res) => {
  const file = req.query && req.query.file;

  if (!GATED.has(file)) {
    res.status(404).end();
    return;
  }

  const secret = process.env.MUSEDOG_COOKIE_SECRET;
  const cookie = getCookie(req.headers.cookie, COOKIE_NAME);

  if (!isValidCookie(cookie, secret)) {
    res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  let html;
  try {
    // includeFiles in vercel.json bundles these pages with the function.
    const diskFile = FILE_PATHS[file] || file;
    html = fs.readFileSync(path.join(process.cwd(), diskFile), "utf8");
  } catch (e) {
    res.status(500).end();
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(html);
};
