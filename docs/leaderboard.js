/* Holder Top Dog Board — READ ONLY. No transactions, no signatures, no money moves.
 * Board rows use dog-inspired codenames — no wallet addresses,
 * no emojis next to codenames. Until the engine publishes an epoch the board
 * shows a pending state; once it does, the board loads the live board file and
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
   * stay hidden until then — no pot figures are shown before the board is).
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

  /* Pending state: the engine is taking daily snapshots, but no epoch board
   * has been published yet — so the board shows this instead of fake rows.
   * The moment the engine publishes manifest.json + a board file, loadLiveBoard
   * swaps in the real ranked rows. */
  function renderPending() {
    $("board-rows").innerHTML =
      '<div class="lb-pending">' +
        "<strong>Daily snapshots are underway.</strong><br>" +
        "The ranked board fills in here once epoch 1 scoring is published — " +
        "one row per verified muse, under dog codenames." +
      "</div>";
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
    }).catch(function () { /* no live board yet — the pending state stays */ });
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
      var statusCls = mine ? "you" : r.claimed ? "done" : "open";
      var statusTxt = mine ? "Your position" : r.claimed ? "Claimed" : "Claimable";
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
    if (liveBoardActive) renderBoard(boardRows);
    else renderPending();
  }

  /* Wallet checker: eligibility is real (live balances vs the minimums).
   * Rank estimates can't be honest yet — there are no published scores to
   * rank against — so the checker says so instead of inventing a rank. */
  function afterCheck(results) {
    if (liveBoardActive) {
      $("my-rank").textContent = "The live board above ranks persistent scores — find your dog codename up there. (This checker only reads today's balances; the engine scores a 7-day trailing average of your daily snapshots, capped by what you hold today.)";
    } else {
      $("my-rank").textContent = "Rank estimates appear once the first board is published — the engine is still taking daily snapshots.";
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
    afterCheck(results);
    setStatus("Done. " + note);
  }

  function onConnect() {
    setStatus("Your wallet will pop up its own standard connect prompt asking to share your address — that's the safe, familiar one. Nothing is signed, no transaction.");
    if (window.ethereum) {
      window.ethereum.request({ method: "eth_requestAccounts" }).then(function (accounts) {
        if (!accounts || !accounts.length) { setStatus("No wallet account shared."); return; }
        currentAddr = accounts[0];
        readBalances(currentAddr, function (results) {
          afterBalances(currentAddr, results, "Balances read live from Robinhood Chain. The ranked board fills in once epoch 1 scoring is published.");
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
      afterBalances(v, results, "Balances read live from Robinhood Chain. The ranked board fills in once epoch 1 scoring is published.");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    renderPending(); // replaced by the real board once the engine publishes an epoch
    loadLiveBoard();
    $("connect-btn").addEventListener("click", onConnect);
    $("lookup-btn").addEventListener("click", onLookup);
  });
})();
