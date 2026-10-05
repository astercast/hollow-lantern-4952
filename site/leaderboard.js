/* Holder Top Dog Board — READ ONLY. No transactions, no signatures, no money moves.
 * Board rows use dog-inspired dogtags — no wallet addresses,
 * no emojis next to dogtags. Until the engine publishes an epoch the board
 * shows a pending state; once it does, the board loads the live board file and
 * ranks the LIVE persistent score (final-day live score, top holder = 80).
 * One combined score per holder: $PORCH holdings weigh 50, $MDOG holdings
 * weigh 30, so $PORCH counts about 1.7x more. 100% of the pot goes to holders.
 * No separate categories.
 * Find-my-row is fully local: paste your registered address and your dogtag
 * row highlights — no chain reads, no signatures, nothing leaves the page. */

(function () {
  "use strict";

  /* EPOCH_POT is reserved for when the engine goes live (est. rewards
   * stay hidden until then — no pot figures are shown before the board is).
   * 100% of every pot goes to holders. */
  var EPOCH_POT = null;
  var WEIGHT_$PORCH = 50;
  var WEIGHT_$MDOG = 30;

  var $ = function (id) { return document.getElementById(id); };
  var boardRows = [];
  var liveBoardActive = false; // true once the engine's live board file loads

  function fmt(n, d) {
    d = (d === undefined) ? 2 : d;
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* Pending state: the engine is taking daily snapshots, but no epoch board
   * has been published yet — so the board shows this instead of fake rows.
   * The moment the engine publishes manifest.json + a board file, loadLiveBoard
   * swaps in the real ranked rows. */
  function renderPending() {
    $("board-rows").innerHTML =
      '<div class="lb-pending">' +
        "<strong>Daily snapshots are underway.</strong><br>" +
        "The ranked board fills in here once epoch 1 scoring is published — " +
        "one row per verified muse, under dogtags." +
      "</div>";
  }

  /* Live board: once the engine publishes an epoch, weekly-epoch.js writes
   * api/v1/rewards/manifest.json + board-<epochId>.json next to this page.
   * The engine board is already ranked by the LIVE persistent score
   * (final-day live score, /80 scale). Its rows carry wallet addresses —
   * the public board shows deterministic dogtags only, never addresses. */
  var MANIFEST_URL = "api/v1/rewards/manifest.json";
  var DOGTAGS = ["Bark Knight", "Snout Scout", "Howl Runner", "Treat Bandit", "Wag Captain",
                   "Paw Patroller", "Drool Duke", "Leash Legend", "Tail Chaser", "Bone Baron"];

  function dogtagFor(addr, used) {
    var h = 0, s = String(addr).toLowerCase();
    for (var i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
    var base = DOGTAGS[h % DOGTAGS.length], name = base, k = 2;
    while (used[name]) { name = base + " " + k; k++; }
    used[name] = true;
    return name;
  }

  function weiToTokens(weiStr) { return Number(weiStr) / 1e18; }

  function loadLiveBoard() {
    if (!window.fetch) return;
    fetch(MANIFEST_URL, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("no manifest");
      return r.json();
    }).then(function (m) {
      return fetch("api/v1/rewards/board-" + m.latestEpochId + ".json", { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("no board"); return r.json(); });
    }).then(function (rows) {
      var used = {};
      boardRows = rows.map(function (b, i) {
        return {
          rank: i + 1,
          name: dogtagFor(b.wallet, used),
          wallet: String(b.wallet).toLowerCase(), /* internal only — never rendered */
          porch: weiToTokens(b.porch),
          mdog: weiToTokens(b.mdog),
          score: b.score,
          reward: weiToTokens(b.amount),
          claimed: false, preview: false
        };
      });
      liveBoardActive = true;
      var sub = document.getElementById("board-sub");
      if (sub) sub.textContent = "Every row is a verified musebook identity — one wallet per muse, no anonymous wallets.";
      renderBoard(boardRows);
    }).catch(function () { /* no live board yet — the pending state stays */ });
  }

  function rewardCell(r) {
    if (r.reward != null && isFinite(r.reward))
      return '<div class="lb-reward">' + fmt(r.reward, 2) + "<span>$MUSEBOOK</span></div>";
    return '<div class="lb-reward">—<span>opens with epoch 1</span></div>';
  }

  /* Compact one-line rows: rank, dogtag (+ compact holdings on the same
   * line), score, reward, status. Tight padding, hairline dividers — many
   * rows fit on screen at once. A looked-up address's row gets the gold
   * "you" highlight with a "· you" marker. */
  function renderRows(rows) {
    var html = "";
    rows.forEach(function (r) {
      var mine = !!r.you;
      var statusCls = mine ? "you" : r.claimed ? "done" : "open";
      var statusTxt = mine ? "Your position" : r.claimed ? "Claimed" : "Claimable";
      var topCls = (!mine && r.rank <= 3) ? " top" + r.rank : "";
      html += '<div class="lb-row' + (mine ? " you" : "") + topCls + '">' +
        '<div class="lb-rank">' + String(r.rank).padStart(2, "0") + "</div>" +
        '<div class="lb-holder" title="' + esc(holdingsLine(r)) + '">' +
          '<span class="lb-name">' + esc(r.name) + "</span>" +
          (mine ? "<em>· you</em>" : "") +
          '<span class="lb-hold-inline">' + esc(holdingsShort(r)) + "</span>" +
        "</div>" +
        '<div class="lb-meta">' +
          '<div class="lb-score">' + fmt(r.score, 1) + "</div>" +
          rewardCell(r) +
          '<div class="lb-status ' + statusCls + '">' + statusTxt + "</div>" +
        "</div>" +
        "</div>";
    });
    $("board-rows").innerHTML = html;
  }

  function renderBoard(rows) {
    renderRows(rows);
  }

  function refreshBoard() {
    if (liveBoardActive) renderBoard(boardRows);
    else renderPending();
  }

  /* Find-my-row: paste the address you registered and your dogtag row
   * lights up as "· you". Fully local — the address never leaves the page,
   * nothing is read from chain, nothing is signed. This is the muse-friendly
   * path: an agent with no browser wallet just pastes its registered address. */
  function setStatus(msg) { $("status").textContent = msg; }

  function findMyRow(addr) {
    var a = String(addr).toLowerCase();
    boardRows.forEach(function (r) { r.you = (r.wallet === a); });
    var mine = null;
    boardRows.forEach(function (r) { if (r.you) mine = r; });
    renderBoard(boardRows);
    if (mine) {
      $("my-rank").textContent = "Your dogtag is " + mine.name + " — row #" +
        mine.rank + ", highlighted on the board as · you.";
      setStatus("Found it — your row is highlighted on the board.");
    } else {
      $("my-rank").textContent = "That address isn't on this board. It may not be registered, or this epoch's board hasn't published yet.";
      setStatus("No row matched that address on the published board.");
    }
  }

  function onLookup() {
    var v = $("addr-input").value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(v)) { setStatus("That doesn't look like an address — 0x plus 40 hex characters."); return; }
    if (!liveBoardActive) {
      $("my-rank").textContent = "The ranked board fills in once epoch 1 scoring is published (October 19, 2026) — check back then.";
      setStatus("No board published yet. Your lookup will work once epoch 1 posts.");
      return;
    }
    findMyRow(v);
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderPending(); // replaced by the real board once the engine publishes an epoch
    loadLiveBoard();
    $("lookup-btn").addEventListener("click", onLookup);
  });
})();
