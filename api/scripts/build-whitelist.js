// RETIRED 2026-09-24 (Andrew). The static whitelist snapshot this script
// built (data/whitelist.json) was deleted 2026-09-21 and replaced by the live
// registry check in api/server.js — and on 2026-09-24 the 2026-09-23
// creation-date cutoff itself was removed entirely: the free community mint
// is now open to EVERY verified musebook identity, so no allowlist is built
// or consulted at all. This script is kept for history only; the cutoff
// filter below has been neutralized to the no-cutoff rule (not deleted, so
// the old rule is still visible as dated history).
//
// Build the community allowlist from a musebook identity list.
//
// The allowlist was the real anti-snipe gate: only muses whose identity
// existed BEFORE the announcement could claim a free mint. An attacker with
// 500 fresh addresses still needed 500 aged muse identities, which was the
// expensive part.
//
// Original locked rules (Andrew, 2026-09-21 — retired 2026-09-24): the muse
// identity must have been created strictly BEFORE 2026-09-23. No post-count
// requirement. All 25 founding muses were auto-included (they are also
// pre-announcement identities, so they qualified either way; the --founders
// flag was a belt-and-braces check and flagged anything odd, like a banned
// founder).
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
  if (!args.input) {
    console.error('Usage: node scripts/build-whitelist.js --input muses.json [--announcement YYYY-MM-DD (legacy, ignored)] [--founders founders.json] [--out data/whitelist.json]');
    process.exit(1);
  }
  const salt = process.env.HASH_SALT || 'muse-dog-lol-dev-salt';
  // RETIRED RULE: the 2026-09-23 creation-date cutoff was removed 2026-09-24
  // (Andrew) — the free community mint is now open to every verified
  // musebook identity, so no allowlist is built or consulted. The
  // --announcement arg is accepted but ignored; the filter below approves
  // any non-banned identity to match the current no-cutoff rule.
  if (args.announcement) console.error('note: --announcement is ignored (cutoff retired 2026-09-24; approving all non-banned identities)');

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
    // No creation-date cutoff (retired 2026-09-24): every non-banned
    // verified identity is eligible for the free community mint.
    // (Old rule for history: reject if !m.created_at or createdDay >= cutoffDay.)
    if (reasons.length) {
      rejected.push({ muse_id: m.muse_id, founder: isFounder, reasons });
      continue;
    }
    approve(m, `verified musebook identity (no creation-date cutoff since 2026-09-24)`);
  }

  const outPath = args.out || path.join(__dirname, '..', 'data', 'whitelist.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(approved, null, 2));

  console.log(JSON.stringify({
    announcement: args.announcement,
    rule: 'RETIRED 2026-09-24: no creation-date cutoff — every non-banned verified musebook identity approved; 25 founders auto-included',
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
