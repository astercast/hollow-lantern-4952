// Build the community allowlist from a musebook identity list.
//
// The allowlist is the real anti-snipe gate: only muses whose identity
// existed BEFORE the announcement can claim a free mint. An attacker with
// 500 fresh addresses still needs 500 aged muse identities, which is the
// expensive part.
//
// Locked rules (Andrew, 2026-09-21): the muse identity must have been
// created strictly BEFORE 2026-09-23. No post-count requirement. All 25
// founding muses are auto-included (they are also pre-announcement
// identities, so they qualify either way; the --founders flag is a
// belt-and-braces check and flags anything odd, like a banned founder).
//
// Usage:
//   HASH_SALT=<prod-salt> node scripts/build-whitelist.js \
//     --input muses.json --announcement 2026-09-23 \
//     [--founders founders.json] [--out data/whitelist.json]
//
// muses.json: [{ "muse_id": "...", "created_at": "2026-08-01T12:00:00Z",
//                "banned": false }, ...]
//   - muse_id: the musebook identity id (required).
//   - created_at: identity creation timestamp (required). Both ISO
//     ("2026-08-01T12:00:00Z") and musebook's "2026-08-01 12:00:00" formats
//     work — only the YYYY-MM-DD date part is compared, so there are no
//     timezone edge cases.
//   - banned: optional. Truthy means excluded. Not publicly exposed by
//     musebook — if you don't have banned data, leave the field out and
//     everyone is judged on creation date only (flag it with wynjr).
// founders.json: ["muse_...", ...] or [{ "muse_id": "..." }, ...] — the 25
//   founding muses, auto-included (banned founders are still excluded and
//   flagged for review).
// Output: data/whitelist.json — salted identity hashes + approval reasons.
// Also prints stats and the rejected list (with reasons) for review.
//
// WHERE THE INPUT COMES FROM: no admin export needed anymore. The public
// musebook API gives everything except banned status:
//   GET /api/muses.json            -> all muse ids (+ founder flags)
//   GET /api/identity.json?id=...  -> per-muse created_at
// Crawl those into muses.json and build. See DEPLOY.md "Building the
// production allowlist" for the exact procedure — the hashes must be
// generated with the PRODUCTION HASH_SALT from Render, otherwise every
// lookup fails.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.announcement) {
    console.error('Usage: node scripts/build-whitelist.js --input muses.json --announcement YYYY-MM-DD [--founders founders.json] [--out data/whitelist.json]');
    process.exit(1);
  }
  const salt = process.env.HASH_SALT || 'muse-dog-lol-dev-salt';
  // Strictly-before comparison on the YYYY-MM-DD date part only — no
  // timezone edge cases: "2026-09-22 23:59:59" counts, "2026-09-23" does not.
  const cutoffDay = args.announcement;

  const muses = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const founders = new Set();
  if (args.founders) {
    const fl = JSON.parse(fs.readFileSync(args.founders, 'utf8'));
    for (const f of fl) founders.add(String(typeof f === 'string' ? f : f.muse_id));
  }
  const approved = [];
  const rejected = [];

  const approve = (m, reason) => approved.push({
    identity_hash: crypto.createHmac('sha256', salt).update(String(m.muse_id)).digest('hex'),
    approved_at: new Date().toISOString().slice(0, 10),
    reason,
  });

  for (const m of muses) {
    const reasons = [];
    const isFounder = founders.has(String(m.muse_id));
    if (m.banned) reasons.push('banned');
    const createdDay = m.created_at ? String(m.created_at).slice(0, 10) : '';
    if (isFounder && !m.banned) {
      approve(m, `founding muse (auto-included), identity created ${createdDay}`);
      continue;
    }
    if (!m.created_at || !/^\d{4}-\d{2}-\d{2}$/.test(createdDay) || createdDay >= cutoffDay)
      reasons.push('identity created on/after announcement cutoff');
    if (reasons.length) {
      rejected.push({ muse_id: m.muse_id, founder: isFounder, reasons });
      continue;
    }
    approve(m, `identity created ${createdDay}, before announcement`);
  }

  const outPath = args.out || path.join(__dirname, '..', 'data', 'whitelist.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(approved, null, 2));

  console.log(JSON.stringify({
    announcement: args.announcement,
    rule: 'identity created strictly before announcement; 25 founders auto-included',
    banned_data_present: muses.some(m => 'banned' in m),
    total: muses.length,
    founders_listed: founders.size,
    approved: approved.length,
    rejected: rejected.length,
    wrote: outPath,
  }, null, 2));
  if (rejected.length) {
    console.log('\nRejected (review before finalizing):');
    for (const r of rejected.slice(0, 50)) console.log(` - ${r.muse_id}: ${r.reasons.join('; ')}`);
    if (rejected.length > 50) console.log(` ... and ${rejected.length - 50} more`);
  }
}

main();
