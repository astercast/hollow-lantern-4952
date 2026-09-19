// Muse Dogs — public verifiable lottery draw.
//
// When more muses qualify for the community free mint than there are spots,
// winners are picked by this script and the result is reproducible by anyone.
//
// Fairness design (so nobody can snipe all the spots):
//   1. Registration closes at a published time. Being first gives no advantage.
//   2. BEFORE the seed is known, the project publishes the commitment:
//        sha256 of the canonical input file (salted identity/address hashes).
//   3. The seed is announced publicly (e.g. a future block hash, published in advance).
//   4. This script ranks every entry by sha256(seed || salted_hash), ascending,
//      and takes the first N. Anyone can re-run it and get the same winners.
//
// Usage:
//   node scripts/draw.js --input eligible.json --seed <hex-or-text> --winners 100 --salt <salt>
//
// Input JSON: [{ "identity_hash": "...", "address_hash": "..." }, ...]
//   Hashes are salted at export time (the salt is public AFTER the draw).
// Output: prints commitment check instructions + winners JSON to stdout.
//   Also writes winners.json next to the input file.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}

function canonical(entries) {
  // Deterministic canonical form: sorted by identity_hash, one JSON object per line.
  const sorted = [...entries].sort((a, b) =>
    String(a.identity_hash).localeCompare(String(b.identity_hash))
  );
  return sorted.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.seed || !args.winners || !args.salt) {
    console.error(
      "Usage: node scripts/draw.js --input eligible.json --seed <seed> --winners 100 --salt <salt>"
    );
    process.exit(1);
  }

  const raw = fs.readFileSync(args.input, "utf8");
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("input must be a non-empty JSON array");
  }

  // Step 1: commitment over the canonical input (publish this BEFORE the seed).
  const commitment = sha256Hex(canonical(entries));

  // Step 2: rank each entry by sha256(seed || salted identity_hash).
  const seed = String(args.seed);
  const salt = String(args.salt);
  const ranked = entries.map((e) => {
    const salted = sha256Hex(salt + ":" + e.identity_hash + ":" + e.address_hash);
    const ticket = sha256Hex(seed + ":" + salted);
    return { ...e, _ticket: ticket };
  });
  ranked.sort((a, b) => a._ticket.localeCompare(b._ticket));

  const n = Math.min(parseInt(args.winners, 10), ranked.length);
  const winners = ranked.slice(0, n).map(({ _ticket, ...rest }) => rest);
  const waitlist = ranked.slice(n).map(({ _ticket, ...rest }) => rest);

  const result = {
    algorithm: "sha256(seed || sha256(salt:identity_hash:address_hash)) ascending, take first N",
    input_commitment: commitment,
    seed,
    entries: entries.length,
    winners: n,
    winner_list: winners,
    waitlist_order: waitlist.map((w) => w.identity_hash),
    verify:
      "Re-run: node scripts/draw.js --input eligible.json --seed <seed> --winners <N> --salt <salt>. " +
      "The input_commitment must match the commitment published before the seed was known.",
  };

  const outPath = path.join(path.dirname(args.input), "draw-result.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ input_commitment: commitment, winners: n, wrote: outPath }, null, 2));
}

main();
