// Vercel Routing Middleware — server-side gate for musedog.lol.
// Runs on the edge BEFORE the cache: any request for an inner page without a
// valid signed auth cookie gets a 302 to the lock page (/). Raw fetches, curl,
// view-source tricks, and search-engine crawlers all hit this — there is no
// client-side bypass because the content never leaves the origin.
//
// The cookie is issued by /api/unlock.js after a correct passcode and is
// HMAC-signed with MUSEDOG_COOKIE_SECRET. It is HttpOnly, so page JavaScript
// can never read or forge it.

const GATED_PATHS = [
  "/home.html",
  "/register.html",
  "/verify.html",
  "/rewards.html",
  "/api.html",
  "/mint.html",
];

function getCookie(cookieHeader, name) {
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Constant-time string compare (edge runtime has no timingSafeEqual).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hasValidCookie(request) {
  const raw = getCookie(request.headers.get("cookie") || "", "mdg_auth");
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;
  const secret = process.env.MUSEDOG_COOKIE_SECRET;
  if (!secret) return false; // fail closed: no secret configured, nobody passes
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("musedog|" + parts[1])
  );
  const expected = Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return safeEqual(expected, parts[2]);
}

// "x-middleware-next: 1" tells Vercel to continue the request to the origin
// (the NextResponse.next() signal, without Next.js).
function passThrough() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}

export default async function middleware(request) {
  if (await hasValidCookie(request)) return passThrough();
  const url = new URL(request.url);
  url.pathname = "/";
  url.search = "";
  return Response.redirect(url.toString(), 302);
}

export const config = {
  matcher: [
    "/home.html",
    "/register.html",
    "/verify.html",
    "/rewards.html",
    "/api.html",
    "/mint.html",
  ],
};
