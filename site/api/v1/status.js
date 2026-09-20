// GET /api/v1/status — free-mint registration counters.
// Optional ?address=0x… → whether that address is registered.
//
// Success: 200 { ok, open, spots_total, spots_claimed, spots_remaining }
//           200 { ok, open, registered, spot }  (with ?address=)
// Errors:  403 LOCKED, 503 REGISTRY_NOT_CONFIGURED / REGISTRY_UNAVAILABLE

const lib = require("./_lib.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  if (!lib.requireGate(req, res)) return;

  let url;
  try {
    url = new URL(req.url, "https://musedog.lol");
  } catch {
    url = { searchParams: new Map() };
  }
  const queryAddress = url.searchParams.get ? url.searchParams.get("address") : null;

  let state;
  try {
    state = await lib.readRegistry();
  } catch (err) {
    if (err.code === "REGISTRY_NOT_CONFIGURED") {
      res.status(200).json({
        ok: true,
        open: false,
        spots_total: lib.MAX_SPOTS,
        spots_claimed: 0,
        spots_remaining: lib.MAX_SPOTS,
        note: "Registration is not open yet.",
      });
      return;
    }
    lib.sendError(res, err);
    return;
  }

  const { entries } = state;
  const base = {
    ok: true,
    open: true,
    spots_total: lib.MAX_SPOTS,
    spots_claimed: entries.length,
    spots_remaining: Math.max(0, lib.MAX_SPOTS - entries.length),
    mint_supply: lib.MINT_SUPPLY,
    note: "500 whitelist spots. Only 380 will mint, first come first served.",
  };

  if (queryAddress) {
    const address = lib.normalizeAddress(queryAddress);
    if (!lib.ADDR_RE.test(address)) {
      res.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "address must be a 0x address." });
      return;
    }
    const hit = entries.find((e) => e.address === address);
    res.status(200).json({ ...base, registered: !!hit, spot: hit ? entries.indexOf(hit) + 1 : null });
    return;
  }

  res.status(200).json(base);
};
