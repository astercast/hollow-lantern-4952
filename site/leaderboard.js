/* Holder leaderboard — READ ONLY. No transactions, no signatures, no money moves.
 * Board rows use dog-inspired codenames — no wallet addresses,
 * no emojis next to codenames. Row scores are preview data until the engine is live.
 * The wallet checker reads live token balances from Robinhood Chain. */

(function () {
  "use strict";

  var CHAIN_ID = 4663;
  var RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
  var TREASURY = "0xEac12759e1Bb4A3c1455Ea3FE03b668c493BFb25";

  /* Preview epoch pot (MUSEBOOK) used for the est. reward column.
   * 50% PORCH holders / 30% MDOG holders / 20% held in treasury for future use. */
  var EPOCH_POT = 398000;
  var CLASS_WEIGHTS = { porch: 0.50, mdog: 0.30 };
  var TREASURY_RESERVE = 0.20;

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

  function fmt(n, d) {
    d = (d === undefined) ? 2 : d;
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* Deterministic mock leaderboard so the layout is stable every load.
   * [codename, class, score, claimed?] — no emojis next to codenames. */
  var PREVIEW_SEED = [
    ["Bark Knight",   "porch", 8420000000, true ],
    ["Snout Scout",   "porch", 5110000000, false],
    ["Howl Runner",   "mdog",     2940000, false],
    ["Treat Bandit",  "porch", 1200000000, true ],
    ["Wag Captain",   "mdog",      812000, false],
    ["Paw Patroller", "porch",  640000000, false],
    ["Drool Duke",    "mdog",      405000, true ],
    ["Leash Legend",  "porch",  210000000, false],
    ["Tail Chaser",   "mdog",      152000, false],
    ["Bone Baron",    "porch",   88000000, false]
  ];

  function buildPreviewRows() {
    return PREVIEW_SEED.map(function (r, i) {
      return { rank: i + 1, name: r[0], cls: r[1], score: r[2], claimed: r[3], preview: true };
    });
  }

  function classLabel(cls) {
    return cls === "mdog" ? "MDOG holders" : "PORCH holders";
  }

  function classTag(cls) {
    return '<span class="tag tag-' + cls + '">' + (cls === "mdog" ? "MDOG" : "PORCH") + "</span>";
  }

  /* Estimated MUSEBOOK reward for a row, from its share of its class score. */
  function estReward(rows, r) {
    var total = 0;
    rows.forEach(function (x) { if (x.cls === r.cls) total += x.score; });
    if (!total) return 0;
    return (r.score / total) * EPOCH_POT * (CLASS_WEIGHTS[r.cls] || 0);
  }

  function renderPodium(rows) {
    var html = "";
    rows.slice(0, 3).forEach(function (r, i) {
      html += '<div class="pod-card' + (i === 0 ? " first" : "") + '">' +
        '<div class="pod-rank">' + ["01", "02", "03"][i] + "</div>" +
        '<div class="pod-medal">' + (i + 1) + "</div>" +
        '<div class="pod-name">' + esc(r.name) + "</div>" +
        '<div class="pod-class">' + classTag(r.cls) + "</div>" +
        '<div class="pod-reward">' + fmt(estReward(rows, r), 0) + "<span>MUSEBOOK</span></div>" +
        '<div class="pod-score">score ' + fmt(r.score, 0) + "</div>" +
        "</div>";
    });
    $("podium").innerHTML = html;
  }

  function renderRows(rows) {
    var html = "";
    rows.slice(3).forEach(function (r) {
      var mine = !!r.you;
      html += '<div class="lb-row' + (mine ? " you" : "") + '">' +
        '<div class="lb-rank">' + String(r.rank).padStart(2, "0") + "</div>" +
        '<div class="lb-holder">' +
          '<span class="lb-name">' + esc(r.name) + (mine ? ' <em>· you</em>' : "") + "</span>" +
          classTag(r.cls) + "</div>" +
        '<div class="lb-meta">' +
          '<div class="lb-score">' + fmt(r.score, 0) + "<span>score</span></div>" +
          '<div class="lb-reward">' + fmt(estReward(rows, r), 0) + "<span>MUSEBOOK</span></div>" +
          '<div class="lb-status ' + (mine ? "you" : r.claimed ? "done" : "open") + '">' +
            (mine ? "Your position" : r.claimed ? "Claimed" : "Claimable") + "</div>" +
        "</div>" +
        "</div>";
    });
    $("board-rows").innerHTML = html;
  }

  function renderBoard(rows) {
    renderPodium(rows);
    renderRows(rows);
  }

  function refreshBoard() {
    if (currentAddr) {
      readBalances(currentAddr, function (results) {
        var b = bestClass(results);
        estimateRank(buildPreviewRows(), b.score, b.cls);
      });
    } else {
      boardRows = buildPreviewRows();
      renderBoard(boardRows);
    }
  }

  function estimateRank(rows, bestScore, bestClass) {
    var inserted = false;
    var out = [];
    rows.forEach(function (r) {
      if (!inserted && bestScore > r.score) {
        out.push({ name: "Your pup", cls: bestClass, score: bestScore, claimed: false, preview: true, you: true });
        inserted = true;
      }
      out.push(r);
    });
    if (!inserted) out.push({ name: "Your pup", cls: bestClass, score: bestScore, claimed: false, preview: true, you: true });
    out.forEach(function (r, i) { r.rank = i + 1; });
    renderBoard(out);
    var mine = out.filter(function (r) { return r.you; })[0];
    $("my-rank").textContent = "Estimated position on the preview board: #" + mine.rank + " (" + classLabel(mine.cls) + ").";
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
        (ok ? " — meets the proposed " + fmt(t.min, 0) + " minimum ✓" : " — below the proposed " + fmt(t.min, 0) + " minimum") + "</li>");
    });
    lines.push("<li><strong>Treasury reserve:</strong> 20% of every epoch pot is held for future use.</li>");
    return "<ul>" + lines.join("") + "</ul>";
  }

  function bestClass(results) {
    var best = { cls: "porch", score: results.porch || 0 };
    if ((results.mdog || 0) >= (results.porch || 0)) best = { cls: "mdog", score: results.mdog || 0 };
    return best;
  }

  function setStatus(msg) { $("status").textContent = msg; }

  function afterBalances(addr, results, note) {
    $("eligibility").innerHTML = eligibilityText(results);
    var b = bestClass(results);
    estimateRank(buildPreviewRows(), b.score, b.cls);
    setStatus("Done. " + note);
  }

  function onConnect() {
    setStatus("Your wallet will pop up its own standard connect prompt asking to share your address — that's the safe, familiar one. Nothing is signed, no transaction.");
    if (window.ethereum) {
      window.ethereum.request({ method: "eth_requestAccounts" }).then(function (accounts) {
        if (!accounts || !accounts.length) { setStatus("No wallet account shared."); return; }
        currentAddr = accounts[0];
        readBalances(currentAddr, function (results) {
          afterBalances(currentAddr, results, "Balances read live from Robinhood Chain. Board rows are preview data.");
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
      afterBalances(v, results, "Balances read live from Robinhood Chain. Board rows are preview data.");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    boardRows = buildPreviewRows();
    renderBoard(boardRows);
    $("connect-btn").addEventListener("click", onConnect);
    $("lookup-btn").addEventListener("click", onLookup);
  });
})();
