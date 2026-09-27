/* Muse Dogs — holder rewards claim engine (real).
 *
 * How it works:
 *   1. Each weekly epoch, the scoring engine publishes epoch-<id>.json and
 *      claims-<id>.json under api/v1/rewards/ (see rewards/engine/).
 *   2. The treasury Safe funds the RewardsDistributor contract and publishes
 *      the epoch's merkle root on-chain via publishRoot().
 *   3. This page: holder connects (standard wallet prompt — address only, no
 *      signature, no approval), finds their leaf + proof in the claims file,
 *      and calls claim(epochId, index, account, amount, proof).
 *   4. The contract verifies the proof and sends MUSEBOOK. Pull only — the
 *      claimer pays their own gas. Claiming never asks for a token approval
 *      and never moves anything OUT of the holder's wallet.
 *
 * Until DISTRIBUTOR is set (the contract is deployed but epoch 1 is not
 * yet funded and no root is published), the claim buttons stay disabled
 * and the page says so plainly.
 */

(function () {
  'use strict';

  var CHAIN_ID = 4663; // Robinhood Chain
  var RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

  var DISTRIBUTOR = null; // Deployed at 0xc050c5d452a9733a2d951c97166eb3ca7b78e90b — stays null until epoch 1 is funded and the first root publishes
  var API_BASE = 'api/v1/rewards/';

  // Minimal ABI for the distributor.
  var DIST_ABI = [
    'function claim(uint256 epochId, uint256 index, address account, uint256 amount, bytes32[] proof)',
    'function isClaimed(uint256 epochId, uint256 index) view returns (bool)',
    'function epochUnclaimed(uint256 epochId) view returns (uint256)',
    'function latestEpoch() view returns (uint256)'
  ];

  function isLive() { return !!DISTRIBUTOR; }

  function getWallet() { return window.ethereum || null; }

  // Standard connection: the wallet's own familiar popup. Address only —
  // no signature, no approval, no transaction.
  function connect() {
    var eth = getWallet();
    if (!eth) return Promise.resolve(null);
    return eth.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      return accounts && accounts[0] ? accounts[0] : null;
    }).catch(function () { return null; });
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
  // Shows the exact amount first; the wallet previews the tx before signing.
  function claim() {
    if (!isLive()) return Promise.resolve({ ok: false, reason: 'not-live' });
    return connect().then(function (address) {
      if (!address) return { ok: false, reason: 'no-wallet' };
      return latestEpoch().then(function (epochId) {
        return myClaim(address, epochId).then(function (c) {
          if (!c) return { ok: false, reason: 'no-claim', epochId: epochId };
          var provider = new ethers.BrowserProvider(getWallet());
          return provider.send('eth_requestAccounts', []).then(function () {
            return provider.getNetwork().then(function (net) {
              if (Number(net.chainId) !== CHAIN_ID) {
                return { ok: false, reason: 'wrong-chain' };
              }
              var signer = provider.getSigner();
              var dist = new ethers.Contract(DISTRIBUTOR, DIST_ABI, signer);
              // Pre-check: already claimed?
              return distRead().isClaimed(epochId, c.index).then(function (done) {
                if (done) return { ok: false, reason: 'already-claimed', epochId: epochId };
                return signer.sendTransaction({
                  to: DISTRIBUTOR,
                  data: dist.interface.encodeFunctionData('claim', [
                    epochId, c.index, c.account, c.amount, c.proof
                  ])
                }).then(function (tx) {
                  return { ok: true, hash: tx.hash, amount: c.amount, epochId: epochId };
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
  function refresh() {
    if (!isLive()) return Promise.resolve(false);
    return latestEpoch().then(function (epochId) {
      return Promise.all([
        apiGet('epoch-' + epochId + '.json'),
        distRead().epochUnclaimed(epochId).catch(function () { return null; })
      ]).then(function (res) {
        var epoch = res[0], unclaimed = res[1];
        setText('claim-epoch', 'Epoch ' + epoch.epochId);
        setText('claim-pot', fmt(epoch.pot) + ' MUSEBOOK');
        setText('claim-unclaimed', unclaimed === null ? '—' : fmt(unclaimed) + ' MUSEBOOK');
        setText('claim-root', String(epoch.root).slice(0, 18) + '…');
        var nn = document.getElementById('claim-notlive-note');
        if (nn) nn.style.display = 'none';
        return connect().then(function (address) {
          if (!address) { setText('claim-mine', 'Connect a wallet to see your share.'); return true; }
          return myClaim(address, epochId).then(function (c) {
            if (!c) { setText('claim-mine', 'No claim for this wallet in epoch ' + epochId + '.'); return true; }
            return distRead().isClaimed(epochId, c.index).then(function (done) {
              setText('claim-mine', done
                ? 'Claimed. ' + fmt(c.amount) + ' MUSEBOOK received.'
                : 'You can claim ' + fmt(c.amount) + ' MUSEBOOK.');
              var btn = document.querySelector('[data-claim-rewards]');
              if (btn && !done) { btn.disabled = false; btn.removeAttribute('title'); }
              return true;
            });
          });
        });
      });
    }).catch(function () { return false; });
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function wireButtons() {
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
            setText('claim-status', 'Switch your wallet to Robinhood Chain and try again.');
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
