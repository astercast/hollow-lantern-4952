// Build the community allowlist from a musebook export.
//
// The allowlist is the real anti-snipe gate: only muses that existed AND
// participated BEFORE the announcement can claim a free mint. An attacker
// with 500 fresh addresses still needs 500 aged, active muse identities,
// which is the expensive part.
//
// Locked rules: cutoff date 2026-09-23 — the muse
// identity must have been created strictly BEFORE 2026-09-23, have 10+ posts,
// and all 25 founding muses are auto-included.
//
// Usage:
//   HASH_SALT=<prod-salt> node scripts/build-whitelist.js \
//     --input muses.json --announcement 2026-09-23 --min-posts 10 \
//     [--founders founders.json]
//
// muses.json: [{ "muse_id": "...", "created_at": "2026-08-01T..Z",
//                "post_count": 34, "banned": false }, ...]
// founders.json: ["muse_...", ...] or [{ "muse_id": "..." }, ...] — the 25
//   founding muses, auto-included even if they miss the post threshold
//   (banned founders are still excluded and flagged for review).
// Output: data/whitelist.json — salted identity hashes + approval reasons.
// Also prints stats and the rejected list (with reasons) for review.
//
// WHERE THE INPUT COMES FROM: musebook.lol has no public directory endpoint
// exposing identity creation dates and lifetime post counts, so muses.json
// must come from a musebook admin export (ask wynjr). See DEPLOY.md
// "Building the production allowlist" for the exact procedure — the hashes
// must be generated with the PRODUCTION HASH_SALT from Render, otherwise
// every lookup fails.

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
  if (!args.input || !args.announcement || !args['min-posts']) {
    console.error('Usage: node scripts/build-whitelist.js --input muses.json --announcement YYYY-MM-DD --min-posts N [--out data/whitelist.json]');
    process.exit(1);
  }
  const salt = process.env.HASH_SALT || 'muse-dog-lol-dev-salt';
  const cutoff = new Date(args.announcement + 'T00:00:00Z');
  const minPosts = parseInt(args['min-posts'], 10);

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
    if (isFounder && !m.banned) {
      approve(m, `founding muse (auto-included), active since ${String(m.created_at).slice(0, 10)}, ${m.post_count || 0} posts before announcement`);
      continue;
    }
    if (!m.created_at || new Date(m.created_at) >= cutoff) reasons.push('created after announcement');
    if ((m.post_count || 0) < minPosts) reasons.push(`only ${m.post_count || 0} posts (< ${minPosts})`);
    if (reasons.length) {
      rejected.push({ muse_id: m.muse_id, founder: isFounder, reasons });
      continue;
    }
    approve(m, `active since ${String(m.created_at).slice(0, 10)}, ${m.post_count} posts before announcement`);
  }

  const outPath = args.out || path.join(__dirname, '..', 'data', 'whitelist.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(approved, null, 2));

  console.log(JSON.stringify({
    announcement: args.announcement,
    min_posts: minPosts,
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
