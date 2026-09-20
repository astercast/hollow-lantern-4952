// GET /api/why — the Why MuseDog page, behind the same passcode gate as the
// other inner pages.
//
// Why a dedicated endpoint: the www Vercel project's edge routing does not
// apply the /why.html rewrite from vercel.json, so /why.html would otherwise
// be served statically (ungated). This endpoint serves the page through the
// gate function instead, so the page is locked on every deployment with no
// routing dependency. The static why.html file lives at api/_gated/why.html
// and is never served directly.
const gate = require("./gate.js");

module.exports = (req, res) => {
  req.query = Object.assign({}, req.query, { file: "why.html" });
  return gate(req, res);
};
