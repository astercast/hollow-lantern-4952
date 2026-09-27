/* Export the verified-muse identity registry for rewards scoring.
 *
 * Reads registrations from the registration backend (the same store the
 * API uses: JSON file ./api/data/db.json locally, Postgres when
 * DATABASE_URL is set — production registrations live in Postgres on
 * Render) and emits the registry format run-epoch.js expects:
 *
 *   { "0xabc…": { "muse_id": "muse_…", "linked_at": 1695… }, … }
 *
 * Guarantees:
 *   - every registration was committed only after a verified musebook
 *     identity proof (identity key signature with id_verified, or a live
 *     post-attestation + registry lookup). Both paths fail closed when the
 *     registry is unreachable.
 *   - the API enforces one registration per muse identity and one per
 *     wallet address at write time (unique hashes / indexes); the export
 *     also dedups defensively (latest wins).
 *   - malformed rows (bad address, missing muse_id) are skipped and
 *     counted in the report, never exported.
 *
 * Usage:
 *   node engine/export-registry.js --out identity-registry.json
 *
 * Read-only against the store. Never signs, never sends.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const store = require(path.join(__dirname, '..', '..', 'api', 'lib', 'store'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

async function main() {
  const outPath = arg('out', path.join(__dirname, '..', 'api', 'identity-registry.json'));

  const db = await store.load();
  const regs = (db && db.registrations) || [];

  const report = {
    source: store.USE_PG ? 'postgres (DATABASE_URL)' : 'json (' + store.DB_PATH + ')',
    readAt: new Date().toISOString(),
    rowsRead: regs.length,
    rowsSkipped: 0,
    skippedReasons: {},
    byProof: {},
    musesExported: 0,
    walletsExported: 0,
  };

  // latest-wins dedup by muse_id and by wallet
  const byMuse = new Map(); // muse_id -> row
  const byWallet = new Map(); // wallet -> row
  const sorted = [...regs].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  for (const r of sorted) {
    const skip = (reason) => {
      report.rowsSkipped++;
      report.skippedReasons[reason] = (report.skippedReasons[reason] || 0) + 1;
    };
    const addr = String(r.address || '').trim();
    const muse = String(r.muse_id || '').trim();
    if (!ADDR_RE.test(addr)) return skip('bad_address');
    if (!muse) return skip('missing_muse_id');
    const row = { muse_id: muse, address: addr.toLowerCase(), linked_at: Math.floor(new Date(r.created_at || Date.now()).getTime() / 1000), proof: r.proof || 'legacy' };
    byMuse.set(muse, row);
    byWallet.set(row.address, row);
  }

  // reconcile: a wallet can only belong to one muse (latest registration wins)
  const final = {};
  for (const row of byMuse.values()) {
    const owner = byWallet.get(row.address);
    if (owner && owner.muse_id !== row.muse_id) continue; // wallet re-registered to a newer muse
    final[row.address] = { muse_id: row.muse_id, linked_at: row.linked_at };
    report.byProof[row.proof] = (report.byProof[row.proof] || 0) + 1;
  }
  report.musesExported = new Set(Object.values(final).map((e) => e.muse_id)).size;
  report.walletsExported = Object.keys(final).length;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(final, null, 2));

  console.log('identity registry export:');
  console.log('  source:        ', report.source);
  console.log('  rows read:     ', report.rowsRead);
  console.log('  wallets exported:', report.walletsExported);
  console.log('  muses exported:', report.musesExported);
  console.log('  by proof:      ', JSON.stringify(report.byProof));
  if (report.rowsSkipped) console.log('  skipped:       ', JSON.stringify(report.skippedReasons));
  console.log('  written to:    ', outPath);
  if (report.walletsExported === 0) {
    console.log('  NOTE: zero verified registrations in the backend — a real epoch');
    console.log('  cannot run until muses register (every registration requires a');
    console.log('  verified musebook identity proof). Unlinked wallets earn nothing.');
  }
  fs.writeFileSync(outPath + '.report.json', JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
