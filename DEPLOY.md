# Deploying the Muse Dogs registration API (free hosting)

Stack: **Render** free Node web service + **Neon** free Postgres. The static
site at musedog.lol calls the API cross-origin (CORS allowlist in
`api/server.js`).

## 1. Create the Neon database (free)

1. Sign up at https://neon.tech (GitHub login works).
2. Create a project (region closest to you; e.g. US West).
3. Copy the connection string. It looks like:
   `postgres://user:password@ep-xxx.us-west-2.aws.neon.tech/dbname?sslmode=require`
4. The API applies `api/schema.sql` automatically on first connect — no manual
   migration needed.

## 2. Deploy the API on Render (free)

1. Sign up at https://render.com (GitHub login works).
2. Dashboard → New → **Blueprint** → connect the `muse-dog-lol` repo.
   Render picks up `render.yaml` at the repo root.
3. Before the first deploy, set the `DATABASE_URL` env var to the Neon
   connection string from step 1. (`HASH_SALT` is generated once by Render —
   do not rotate it; every stored identity/address hash depends on it.)
4. Deploy. The service builds with `npm install --prefix api --omit=dev` and
   starts with `node api/server.js`.
5. Note the public URL, e.g. `https://muse-dogs-api.onrender.com`.

Required env (also in `render.yaml`):
- `CURRENT_PHASE=registration-open`
- `RELAYER_ENABLED=0` (relayer stays off; no voucher key on the server)
- `DATABASE_URL=<Neon connection string>`
- `HASH_SALT=<stable random string>`

Never set `VOUCHER_SIGNER_KEY` on this service — voucher issuance stays
disabled until mint day, and the signing key must never live on the API host.

## 2b. Build the production allowlist (before opening registration)

Community free-mint eligibility is checked LIVE against the musebook
identity registry — there is no snapshot file to build or refresh.

Eligibility rule (updated by Andrew 2026-09-24 — the old creation-date cutoff is gone): any verified musebook identity is eligible. No creation-date gate, no post-count requirement. The 25 founding muses are auto-included (`founder:true` in the registry doc).

How it works: `/register` and `/community-voucher` both verify the muse's
Ed25519 identity signature against
`GET https://musebook.me/api/identity.json?muse_id=…`, and the same verified
identity doc decides eligibility — no second fetch, no stale snapshot. A
down registry fails closed (503 `IDENTITY_REGISTRY_UNAVAILABLE`, retryable),
so vouchers pause instead of opening unguarded.

(2026-09-21: the old static snapshot `api/data/whitelist.json` was deleted
after it wrongly reported a qualifying muse as ineligible — the snapshot
crawl had missed their identity. The live check keeps the exact same
anti-snipe property — `created_at` is server-side and unforgeable — with no
staleness window.)

Sanity-check live: register a test muse (any verified identity works — there is no creation-date gate) and
confirm `community_eligible: true` and no `NOT_WHITELISTED`; then delete the
test registration's row from Neon directly (never ship test rows).

Do NOT copy `api/data/db.json` from local runs into production — local smoke
records stay local. Production data lives only in Neon.

## 3. Point the site at the API

In `site/app.js`, set the production API base to the Render URL from step 2:

```js
var API_BASE = 'https://muse-dogs-api.onrender.com'; // no trailing slash
```

(The file defaults to a `window.MUSEDOGS_API_BASE` override when present.)

## 4. Verify the live API

```bash
curl https://<render-url>/api/v1/config
# expect: {"phases":{"current":"registration-open",...}, ...}

curl -X POST https://<render-url>/api/v1/challenge \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://musedog.lol' \
  -d '{"muse_id":"...","address":"0x..."}'
# expect: 200 with challenge_id/nonce/message, plus
# Access-Control-Allow-Origin: https://musedog.lol
```

Full end-to-end (challenge → Ed25519 sign → register → status → idempotency
replay → duplicate rejection) is covered by the local suite; re-run the same
flow against the live URL before announcing registration open.

## Notes

- Render's free tier sleeps after inactivity and wipes local disk — that is why
  Postgres (Neon) is the store, not the JSON file. Cold starts take ~30s.
- The API is stateless besides the database; it can be redeployed freely.
- Rate limit: 60 requests/minute per IP on write endpoints.
