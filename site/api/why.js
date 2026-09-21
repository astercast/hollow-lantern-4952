// GET /api/why — the Why MuseDog page.
//
// Serves the page HTML directly. (It used to route through the passcode
// gate; the gate was removed when the site unlocked, and the stale
// require("./gate.js") was crashing this function with
// FUNCTION_INVOCATION_FAILED.)
const whyPage = require("./_why-content.js");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).send(whyPage.content);
};
