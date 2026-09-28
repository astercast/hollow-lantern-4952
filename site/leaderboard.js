/* Holder leaderboard — READ ONLY. No transactions, no signatures, no money moves.
 * Board rows use dog-inspired codenames — no wallet addresses,
 * no emojis next to codenames. Until the engine publishes an epoch the rows
 * are example data; once it does, the board loads the live board file and
 * ranks the LIVE persistent score (final-day live score, top holder = 80).
 * One combined score per holder: PORCH holdings weigh 50, MDOG holdings
 * weigh 30, so PORCH counts about 1.7x more. 100% of the pot goes to holders.
 * No separate categories.
 * The wallet checker reads live token balances from Robinhood Chain. */

(function () {
  "use strict";

  var CHAIN_ID = 4663;
  var RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
  var TREASURY = "0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25";

  /* EPOCH_POT is reserved for when the engine goes live (est. rewards
   * stay hidden until then — no pot figures are shown on the example board).
   * 100% of every pot goes to holders. */
  var EPOCH_POT = null;
  var WEIGHT_PORCH = 50;
  var WEIGHT_MDOG = 30;

  var TOKENS = {
    porch:    { address: "0x4B434541873f171aB70D7d2F3a48b0f0b0f13ba3", symbol: "PORCH",    min: 1000000 },
    mdog:     { address: "0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC", symbol: "MDOG",     min: 1000 },
    musebook: { address: "0x91A2DAe9699f0B82540B5886b0d8759C22820bA3", symbol: "MUSEBOOK", min: 0 }
  };

  var ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
  ];

  var $ = function (id) { return document.getElementById(id); };
  var currentAddr = null;
  var boardRows = [];
  var liveBoardActive = false; // true once the engine's live board file loads

  function fmt(n, d) {
    d = (d === undefined) ? 2 : d;
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* Deterministic mock leaderboard so the layout is stable every load.
   * [codename, PORCH holding, MDOG holding, claimed?] — no emojis next to
   * codenames. One combined score per pup, same 50/30 weighting as the engine. */
  var PREVIEW_SEED = [
    ["Bark Knight",   8400000000, 2900000, true ],
    ["Snout Scout",   5100000000, 1200000, false],
    ["Howl Runner",   1200000000, 2940000, false],
    ["Treat Bandit",  2100000000,  800000, true ],
    ["Wag Captain",    640000000,  812000, false],
    ["Paw Patroller",  880000000,  405000, false],
    ["Drool Duke",     210000000,  152000, true ],
    ["Leash Legend",   120000000,   95000, false],
    ["Tail Chaser",     88000000,   61000, false],
    ["Bone Baron",      45000000,   30000, false]
  ];

  /* Combined score (50 + 30 = 80 max):
   * reward = score / 80 * EPOCH_POT. Same weighting as the engine. */
  function combinedScore(porchBal, mdogBal, totals) {
    var s = 0;
    if (totals.porch > 0 && porchBal > 0) s += WEIGHT_PORCH * (porchBal / totals.porch);
    if (totals.mdog > 0 && mdogBal > 0) s += WEIGHT_MDOG * (mdogBal / totals.mdog);
    return s;
  }

  function previewTotals(extra) {
    var t = { porch: 0, mdog: 0 };
    PREVIEW_SEED.forEach(function (r) { t.porch += r[1]; t.mdog += r[2]; });
    if (extra) { t.porch += extra.porch || 0; t.mdog += extra.mdog || 0; }
    return t;
  }

  function buildPreviewRows() {
    var totals = previewTotals(null);
    return PREVIEW_SEED.map(function (r, i) {
      return {
        rank: i + 1, name: r[0], porch: r[1], mdog: r[2],
        score: combinedScore(r[1], r[2], totals),
        claimed: r[3], preview: true
      };
    }).sort(function (a, b) { return b.score - a.score; })
      .map(function (r, i) { r.rank = i + 1; return r; });
  }

  /* Estimated MUSEBOOK reward for a row, from its share of the combined score. */
  function estReward(r) {
    if (!EPOCH_POT) return null; // hidden until the engine is live
    return (r.score / 80) * EPOCH_POT;
  }

  function holdingsLine(r) {
    return "PORCH " + fmt(r.porch, 0) + " · MDOG " + fmt(r.mdog, 0);
  }

  /* Compact holdings for the one-line rows — "8.4B PORCH · 2.9M MDOG".
   * The full-precision string from holdingsLine() stays in the row's title. */
  function trim1(n) {
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });
  }

  function fmtCompact(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return trim1(n / 1e9) + "B";
    if (n >= 1e6) return trim1(n / 1e6) + "M";
    if (n >= 1e3) return trim1(n / 1e3) + "K";
    return String(Math.round(n));
  }

  function holdingsShort(r) {
    return fmtCompact(r.porch) + " PORCH · " + fmtCompact(r.mdog) + " MDOG";
  }

  /* Live board: once the engine publishes an epoch, weekly-epoch.js writes
   * api/v1/rewards/manifest.json + board-<epochId>.json next to this page.
   * The engine board is already ranked by the LIVE persistent score
   * (final-day live score, /80 scale). Its rows carry wallet addresses —
   * the public board shows deterministic dog codenames only, never addresses. */
  var MANIFEST_URL = "api/v1/rewards/manifest.json";
  var CODENAMES = ["Bark Knight", "Snout Scout", "Howl Runner", "Treat Bandit", "Wag Captain",
                   "Paw Patroller", "Drool Duke", "Leash Legend", "Tail Chaser", "Bone Baron"];

  function codenameFor(addr, used) {
    var h = 0, s = String(addr).toLowerCase();
    for (var i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
    var base = CODENAMES[h % CODENAMES.length], name = base, k = 2;
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
          name: codenameFor(b.wallet, used),
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
    }).catch(function () { /* no live board yet — the example rows stay */ });
  }

  function rewardCell(r) {
    if (r.reward != null && isFinite(r.reward))
      return '<div class="lb-reward">' + fmt(r.reward, 2) + "<span>MUSEBOOK</span></div>";
    return '<div class="lb-reward">—<span>opens with epoch 1</span></div>';
  }

  /* Compact one-line rows: rank, codename (+ compact holdings on the same
   * line), score, reward, status. Tight padding, hairline dividers — many
   * rows fit on screen at once. The wallet-checker "Your pup" row keeps the
   * same shape with its "· you" marker and gold highlight, so it reads as an
   * example-board estimate, never as live board data. */
  function renderRows(rows) {
    var html = "";
    rows.forEach(function (r) {
      var mine = !!r.you;
      var statusCls = mine ? "you" : r.preview ? "prev" : r.claimed ? "done" : "open";
      var statusTxt = mine ? "Your position" : r.preview ? "Example" : r.claimed ? "Claimed" : "Claimable";
      html += '<div class="lb-row' + (mine ? " you" : "") + '">' +
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
    if (currentAddr) {
      readBalances(currentAddr, function (results) {
        estimateRank(buildPreviewRows(), results);
      });
    } else {
      boardRows = buildPreviewRows();
    renderBoard(boardRows);
    }
  }

  function estimateRank(rows, results) {
    var totals = previewTotals(results);
    var mine = {
      name: "Your pup",
      porch: results.porch || 0, mdog: results.mdog || 0,
      score: combinedScore(results.porch || 0, results.mdog || 0, totals),
      claimed: false, preview: true, you: true
    };
    // Re-score the mock rows against the same totals so the ranking is fair.
    rows.forEach(function (r) { r.score = combinedScore(r.porch, r.mdog, totals); });
    var out = rows.concat([mine]).sort(function (a, b) { return b.score - a.score; });
    out.forEach(function (r, i) { r.rank = i + 1; });
    var myRank = out.filter(function (r) { return r.you; })[0].rank;
    if (liveBoardActive) {
      /* The live board stays put — this estimate is example-board math on
       * today's balances, so it can't be slotted into the live ranking. */
      $("my-rank").textContent = "Estimated position on the example board: #" + myRank +
        ". (The live board above ranks persistent scores — the lower of each day's snapshot and the 7-day average; this estimate uses today's balances only.)";
    } else {
      renderBoard(out);
      $("my-rank").textContent = "Estimated position on the example board: #" + myRank + ".";
    }
  }

  /* Reads always go through the dedicated Robinhood Chain RPC — never through
   * the wallet's provider, so a wallet sitting on the wrong chain can't skew
   * the numbers. The wallet is only ever asked for an address. */
  function readBalances(addr, onDone) {
    var provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    var keys = ["porch", "mdog"];
    var results = {};
    var chain = Promise.resolve();
    keys.forEach(function (k) {
      chain = chain.then(function () {
        var c = new ethers.Contract(TOKENS[k].address, ERC20_ABI, provider);
        return Promise.all([c.balanceOf(addr), c.decimals()]).then(function (res) {
          results[k] = Number(ethers.formatUnits(res[0], res[1]));
        }).catch(function () { results[k] = null; });
      });
    });
    return chain.then(function () { onDone(results); });
  }

  function eligibilityText(results) {
    var lines = [];
    ["porch", "mdog"].forEach(function (k) {
      var t = TOKENS[k];
      var bal = results[k];
      if (bal === null) { lines.push("<li><strong>" + t.symbol + ":</strong> couldn't read balance — try again.</li>"); return; }
      var ok = bal >= t.min;
      lines.push("<li><strong>" + t.symbol + ":</strong> " + fmt(bal, 0) +
        (ok ? " — meets the " + fmt(t.min, 0) + " minimum ✓" : " — below the " + fmt(t.min, 0) + " minimum") + "</li>");
    });
    return "<ul>" + lines.join("") + "</ul>";
  }

  function setStatus(msg) { $("status").textContent = msg; }

  function afterBalances(addr, results, note) {
    $("eligibility").innerHTML = eligibilityText(results);
    estimateRank(buildPreviewRows(), results);
    setStatus("Done. " + note);
  }

  function onConnect() {
    setStatus("Your wallet will pop up its own standard connect prompt asking to share your address — that's the safe, familiar one. Nothing is signed, no transaction.");
    if (window.ethereum) {
      window.ethereum.request({ method: "eth_requestAccounts" }).then(function (accounts) {
        if (!accounts || !accounts.length) { setStatus("No wallet account shared."); return; }
        currentAddr = accounts[0];
        readBalances(currentAddr, function (results) {
          afterBalances(currentAddr, results, "Balances read live from Robinhood Chain. Board rows are example data.");
        });
      }).catch(function () { setStatus("Wallet connection cancelled — you can also paste an address."); });
    } else {
      setStatus("No wallet found in this browser — paste an address below to check it.");
    }
  }

  function onLookup() {
    var v = $("addr-input").value.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(v)) { setStatus("That doesn't look like an address — 0x plus 40 hex characters."); return; }
    setStatus("Reading balances… (read-only)");
    currentAddr = v;
    readBalances(v, function (results) {
      afterBalances(v, results, "Balances read live from Robinhood Chain. Board rows are example data.");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    boardRows = buildPreviewRows();
    renderBoard(boardRows);
    loadLiveBoard(); // replaces the example rows once the engine publishes an epoch
    $("connect-btn").addEventListener("click", onConnect);
    $("lookup-btn").addEventListener("click", onLookup);
  });
})();
