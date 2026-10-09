/* Muse Dogs — holder rewards claim engine (real).
 *
 * How it works:
 *   1. Each weekly epoch, the scoring engine publishes epoch-<id>.json and
 *      claims-<id>.json under api/v1/rewards/ (see rewards/engine/).
 *   2. The user signs fund + publishRoot himself; epoch-pipeline.js activate
 *      verifies the root on-chain and writes manifest.json {published:true}.
 *   3. This page reads the manifest — distributor address and live-ness come
 *      from there, so the claim UI activates itself the moment a root exists.
 *      There is no hardcoded address and no manual flip, ever.
 *   4. Holder connects (standard wallet prompt — address only, no
 *      signature, no approval), finds their leaf + proof in the claims file,
 *      and calls claim(epochId, index, account, amount, proof).
 *   5. The contract verifies the proof and sends $MUSEBOOK. Pull only — the
 *      claimer pays their own gas. Claiming never asks for a token approval
 *      and never moves anything OUT of the holder's wallet.
 *
 * Until the manifest says published:true, the claim buttons stay disabled
 * and the page says so plainly.
 */

(function () {
  'use strict';

  var CHAIN_ID = 4663; // Robinhood Chain
  var RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

  // Live-ness comes from manifest.json, written by the epoch pipeline only
  // after the root is confirmed on-chain. Never hardcoded, never a manual flip.
  var DISTRIBUTOR = null;
  var PUBLISHED = false;
  var API_BASE = 'api/v1/rewards/';

  // Minimal ABI for the distributor. NOTE: the contract has no isClaimed() —
  // the public claimedAmount mapping getter is the truth (fully claimed when
  // it reaches the allocation). claimableNow is the contract's own view of
  // what's unlocked right now (discrete 1/7-per-day steps from publish).
  var DIST_ABI = [
    'function claim(uint256 epochId, uint256 index, address account, uint256 amount, bytes32[] proof)',
    'function claimedAmount(uint256 epochId, uint256 index) view returns (uint256)',
    'function claimableNow(uint256 epochId, uint256 index, uint256 allocation) view returns (uint256)',
    'function epochUnclaimed(uint256 epochId) view returns (uint256)',
    'function latestEpoch() view returns (uint256)'
  ];

  function isLive() { return !!DISTRIBUTOR && PUBLISHED; }

  // Manifest is the single source of truth: { latestEpochId, distributor,
  // published, publishedTx, root, ... }. published is true only after
  // epoch-pipeline.js activate verifies the root on-chain.
  function loadManifest() {
    return apiGet('manifest.json').then(function (m) {
      DISTRIBUTOR = (m && m.distributor) || null;
      PUBLISHED = !!(m && m.published);
      return m || null;
    }).catch(function () {
      DISTRIBUTOR = null; PUBLISHED = false; return null;
    });
  }

  function getWallet() { return window.ethereum || null; }

  // Standard connection: the wallet's own familiar popup. Address only —
  // no signature, no approval, no transaction. Only ever called from a
  // user click — the page never auto-prompts on load.
  function connect() {
    var eth = getWallet();
    if (!eth) return Promise.resolve(null);
    return eth.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      return accounts && accounts[0] ? accounts[0] : null;
    }).catch(function () { return null; });
  }

  // Already-authorized account without prompting (eth_accounts never pops up).
  function connectedAccount() {
    var eth = getWallet();
    if (!eth) return Promise.resolve(null);
    return eth.request({ method: 'eth_accounts' }).then(function (accounts) {
      return accounts && accounts[0] ? accounts[0] : null;
    }).catch(function () { return null; });
  }

  var CHAIN_HEX = '0x1237'; // 4663
  var CHAIN_PARAMS = {
    chainId: CHAIN_HEX,
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: [RPC_URL],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com']
  };

  // Ask the wallet to switch to Robinhood Chain (adds it if missing) —
  // the recognized EIP-3326 / EIP-3085 flow, instead of a manual-switch note.
  function ensureChain() {
    var eth = getWallet();
    if (!eth) return Promise.resolve(false);
    return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_HEX }] })
      .then(function () { return true; })
      .catch(function (err) {
        if (err && err.code === 4902) {
          return eth.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS] })
            .then(function () { return true; })
            .catch(function () { return false; });
        }
        return false;
      });
  }

  function apiGet(path) {
    return fetch(API_BASE + path, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('api ' + r.status);
      return r.json();
    });
  }

  // Latest published epoch: manifest.json -> { latestEpochId: N }.
  function latestEpoch() {
    return apiGet('manifest.json').then(function (m) { return m.latestEpochId; });
  }

  function myClaim(address, epochId) {
    return apiGet('claims-' + epochId + '.json').then(function (data) {
      var lower = String(address).toLowerCase();
      var claims = Array.isArray(data) ? data : (data.claims || []);
      for (var i = 0; i < claims.length; i++) {
        if (String(claims[i].account).toLowerCase() === lower) return claims[i];
      }
      return null;
    });
  }

  // Read-only provider that always talks to Robinhood Chain directly,
  // so a wallet sitting on the wrong network can't mislead the page.
  function readProvider() {
    return new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
  }

  function distRead() {
    return new ethers.Contract(DISTRIBUTOR, DIST_ABI, readProvider());
  }

  // Send the claim transaction from the holder's wallet.
  // Shows the exact amount and the registered wallet it pays FIRST; the
  // wallet then previews the decoded claim() call before anything is sent.
  // claim() is permissionless: anyone may submit it for any account, and the
  // $MUSEBOOK always lands in the REGISTERED wallet — the connected wallet
  // pays gas only and receives nothing. Claiming never asks for a token
  // approval and never moves anything OUT of the holder's wallet.
  function claim() {
    return loadManifest().then(function () {
      if (!isLive()) return { ok: false, reason: 'not-live' };
      return connect().then(function (address) {
        if (!address) return { ok: false, reason: 'no-wallet' };
        return latestEpoch().then(function (epochId) {
        return myClaim(address, epochId).then(function (c) {
          if (!c) return { ok: false, reason: 'no-claim', epochId: epochId };
          var provider = new ethers.BrowserProvider(getWallet());
          return provider.getNetwork().then(function (net) {
            var onChain = Number(net.chainId) === CHAIN_ID;
            var ready = onChain ? Promise.resolve(true) : ensureChain();
            return ready.then(function (switched) {
              if (!switched) return { ok: false, reason: 'wrong-chain' };
              return provider.getSigner().then(function (signer) {
                var dist = new ethers.Contract(DISTRIBUTOR, DIST_ABI, signer);
                // Pre-check: already claimed? (claimedAmount reaches the allocation)
                return distRead().claimedAmount(epochId, c.index).then(function (paid) {
                  var done = false;
                  try { done = BigInt(paid.toString()) >= BigInt(c.amount); } catch (e) { done = false; }
                  if (done) return { ok: false, reason: 'already-claimed', epochId: epochId };
                  // Decoded contract call — the wallet preview shows claim()
                  // with its parameters, not opaque hex data.
                  return dist.claim(epochId, c.index, c.account, c.amount, c.proof).then(function (tx) {
                    return { ok: true, hash: tx.hash, amount: c.amount, epochId: epochId, account: c.account };
                  });
                });
              });
            });
          });
        });
      });
    });
    });
  }

  function fmt(n) {
    try { return Number(ethers.formatUnits(n, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
    catch (e) { return '—'; }
  }

  // Fill the claim panel: pot, epoch, and (once connected) the holder's share.
  // Never prompts for a wallet on its own — it only reads an already-
  // authorized account (eth_accounts). The user connects via the button.
  // Vesting: the contract unlocks 1/7 per day, so the panel shows both the
  // total allocation and what's claimable RIGHT NOW (claimableNow on-chain).
  function refresh() {
    return loadManifest().then(function (m) {
      if (!isLive()) return false;
      var epochId = m.latestEpochId;
      return Promise.all([
        apiGet('epoch-' + epochId + '.json'),
        distRead().epochUnclaimed(epochId).catch(function () { return null; })
      ]).then(function (res) {
        var epoch = res[0], unclaimed = res[1];
        setText('claim-epoch', 'Epoch ' + epoch.epochId);
        setText('claim-pot', fmt(epoch.pot) + ' $MUSEBOOK');
        setText('claim-unclaimed', unclaimed === null ? '—' : fmt(unclaimed) + ' $MUSEBOOK');
        setText('claim-root', String(epoch.root).slice(0, 18) + '…');
        setText('claim-dist', 'Claim contract: ' + DISTRIBUTOR);
        var nn = document.getElementById('claim-notlive-note');
        if (nn) nn.style.display = 'none';
        var connectBtn = document.querySelector('[data-connect-wallet]');
        return connectedAccount().then(function (address) {
          if (!address) {
            setText('claim-mine', 'Connect a wallet to see your share.');
            if (connectBtn) connectBtn.style.display = '';
            return true;
          }
          if (connectBtn) connectBtn.style.display = 'none';
          return myClaim(address, epochId).then(function (c) {
            if (!c) { setText('claim-mine', 'No claim for this wallet in epoch ' + epochId + '.'); return true; }
            return Promise.all([
              distRead().claimedAmount(epochId, c.index),
              distRead().claimableNow(epochId, c.index, c.amount).catch(function () { return null; })
            ]).then(function (rr) {
              var paid = rr[0], now = rr[1];
              var done = false;
              try { done = BigInt(paid.toString()) >= BigInt(c.amount); } catch (e) { done = false; }
              var where = ' It pays the registered wallet ' + shortAddr(c.account) + ' — the connected wallet only pays gas.';
              var line;
              if (done) {
                line = 'Claimed. ' + fmt(c.amount) + ' $MUSEBOOK received.' + where;
              } else if (now === null) {
                line = 'You can claim ' + fmt(c.amount) + ' $MUSEBOOK total.' + where;
              } else {
                line = fmt(now) + ' $MUSEBOOK claimable now, of ' + fmt(c.amount) +
                  ' total (unlocks 1/7 per day).' + where;
              }
              setText('claim-mine', line);
              var btn = document.querySelector('[data-claim-rewards]');
              if (btn && !done) { btn.disabled = false; btn.removeAttribute('title'); }
              return true;
            });
          });
        });
      });
    }).catch(function () { return false; });
  }

  function shortAddr(a) {
    a = String(a || '');
    return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function wireButtons() {
    var connectBtns = document.querySelectorAll('[data-connect-wallet]');
    Array.prototype.forEach.call(connectBtns, function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!isLive()) return;
        setText('claim-status', 'Waiting for your wallet… (address only — nothing is signed)');
        connect().then(function (address) {
          if (!address) { setText('claim-status', 'No wallet connected.'); return; }
          setText('claim-status', '');
          refresh();
        });
      });
    });
    var buttons = document.querySelectorAll('[data-claim-rewards]');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!isLive()) return;
        btn.disabled = true;
        setText('claim-status', 'Check your wallet to confirm the claim…');
        claim().then(function (res) {
          if (res.ok) {
            setText('claim-status', 'Claim sent: ' + res.hash);
          } else if (res.reason === 'no-claim') {
            setText('claim-status', 'No claim for this wallet this epoch.');
          } else if (res.reason === 'already-claimed') {
            setText('claim-status', 'Already claimed for this epoch.');
          } else if (res.reason === 'wrong-chain') {
            setText('claim-status', 'Couldn\'t switch to Robinhood Chain — approve the network switch in your wallet and try again.');
          } else if (res.reason === 'no-wallet') {
            setText('claim-status', 'No wallet connected.');
          }
          btn.disabled = false;
          refresh();
        }).catch(function (err) {
          setText('claim-status', 'Claim failed: ' + (err && err.message ? err.message : err));
          btn.disabled = false;
        });
      });
    });
  }

  function init() {
    wireButtons();
    refresh();
    window.RewardsClaim = {
      isLive: isLive,
      connect: connect,
      claim: claim,
      refresh: refresh,
      myClaim: myClaim,
      latestEpoch: latestEpoch,
      distributor: function () { return DISTRIBUTOR; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
