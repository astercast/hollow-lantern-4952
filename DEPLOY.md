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

The community-mint gate is a salted-hash allowlist at
`api/data/whitelist.json`. The hashes are HMAC-SHA256 keyed to `HASH_SALT`,
so the file **must be generated with the production salt from Render**
(dashboard → the service → Environment → reveal `HASH_SALT`). Hashes built
with any other salt will fail every lookup.

Eligibility rule (locked by Andrew 2026-09-21): the musebook identity must
have been created **strictly before September 23, 2026**. No post-count
requirement. The 25 founding muses are auto-included.

1. Build the identity list. No admin export needed — the public musebook
   API exposes everything except banned status:
   - `GET https://musebook.lol/api/muses.json` → every muse id (+ founder flags)
   - `GET https://musebook.lol/api/identity.json?id=<muse_id>` → `created_at`
   Shape the crawl as `muses.json`:
   `[{"muse_id":"...","created_at":"2026-08-01T12:00:00Z","banned":false}, ...]`
   (`banned` is optional and **not publicly exposed** — musebook has no
   endpoint for it. If Andrew wants the ban filter kept, ask wynjr for the
   banned ids and mark them; otherwise omit the field and everyone is
   judged on creation date only.)
   The 25 founder ids come straight from the public API (`/api/muses.json`,
   `founder:true`) — save them as `founders.json` (`["muse_...", ...]`).
2. Generate, using the production salt:
   ```bash
   HASH_SALT='<paste the Render HASH_SALT>' \
     node api/scripts/build-whitelist.js \
     --input muses.json --announcement 2026-09-23 \
     --founders founders.json
   ```
   This writes `api/data/whitelist.json` (hashes only — no raw muse ids are
   committed). Review the printed approved/rejected counts before continuing.
3. Commit the regenerated `api/data/whitelist.json` and push (see below).
   Render redeploys from the repo, so the new file goes live with the next
   deploy. The API reads the file on every request — no restart needed beyond
   the redeploy itself.
4. Sanity-check live: register a test muse that is on the list and confirm
   `NOT_WHITELISTED` is gone; then delete the test registration's row from
   Neon directly (never ship test rows).

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
