// POST /api/unlock — verifies the passcode server-side and issues the gate cookie.
// The SHA-256 of the passcode lives ONLY in the MUSEDOG_PASSCODE_HASH env var;
// the client never sees it, so the hash cannot be lifted from page source.
//
// Request:  { "passcode": "..." }
// Success:  200 { "ok": true } + Set-Cookie: mdg_auth=v1.<expiry>.<hmac>
// Failure:  401 { "ok": false } (wrong code) — rate-limiting left to Vercel.

const crypto = require("crypto");

function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024) req.destroy(); // passcode-sized bodies only
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  const body = await readJsonBody(req);
  const passcode = typeof body.passcode === "string" ? body.passcode : "";
  const expectedHash = process.env.MUSEDOG_PASSCODE_HASH || "";

  if (!passcode || !expectedHash) {
    res.status(401).json({ ok: false });
    return;
  }

  const actualHash = crypto.createHash("sha256").update(passcode, "utf8").digest("hex");

  let match = false;
  try {
    match =
      actualHash.length === expectedHash.length &&
      crypto.timingSafeEqual(Buffer.from(actualHash, "utf8"), Buffer.from(expectedHash, "utf8"));
  } catch {
    match = false;
  }

  if (!match) {
    // Small delay to blunt brute force; real rate limiting is Vercel's job.
    await new Promise((r) => setTimeout(r, 400));
    res.status(401).json({ ok: false });
    return;
  }

  const secret = process.env.MUSEDOG_COOKIE_SECRET || "";
  if (!secret) {
    res.status(500).json({ ok: false });
    return;
  }

  const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  const payload = "musedog|" + expiry;
  const sig = crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const value = "v1." + expiry + "." + sig;

  res.setHeader(
    "Set-Cookie",
    "mdg_auth=" +
      value +
      "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000"
  );
  res.status(200).json({ ok: true });
};
