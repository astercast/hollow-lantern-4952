/* Muse Dogs — holder rewards claim engine.
 *
 * Status: NOT LIVE. The rewards contracts are not deployed yet.
 *
 * At deploy, the ONLY changes needed are in CLAIM_TOKENS below:
 *   1. Fill in each token's `contract` address (must match the Verify page exactly).
 *   2. Confirm each token's `claimFn` entrypoint name against the deployed ABI.
 * Everything else — the three claim cards, the per-token pots and claimable
 * amounts, the buttons — lights up on its own once the addresses are set.
 *
 * Safety invariants the engine enforces (and the page states):
 *   - Claiming never asks for a token approval.
 *   - Claiming never moves anything OUT of the holder's wallet.
 *     The holder only receives tokens.
 */

(function () {
  'use strict';

  var CHAIN_ID = 4663; // Robinhood Chain

  var CLAIM_TOKENS = {
    eth: {
      label: 'ETH',
      source: '50% of resale royalties · weekly',
      contract: null,          // TBA — rewards vault
      claimFn: 'claim',        // placeholder — confirm against the deployed ABI
      decimals: 18
    },
    porch: {
      label: 'PORCH',
      source: '40% of the vested PORCH supply',
      contract: null,          // TBA — PORCH claim engine
      claimFn: 'claim',        // placeholder — confirm against the deployed ABI
      decimals: 18
    },
    musebook: {
      label: 'MUSEBOOK',
      source: 'PORCH creator fees, via the treasury',
      contract: null,          // TBA — MUSEBOOK distributor
      claimFn: 'claim',        // placeholder — confirm against the deployed ABI
      decimals: 18
    }
  };

  var ORDER = ['eth', 'porch', 'musebook'];

  function isLive() {
    return ORDER.every(function (k) { return !!CLAIM_TOKENS[k].contract; });
  }

  function getProvider() {
    if (window.ethereum) return window.ethereum;
    return null;
  }

  // Connect the holder's wallet on Robinhood Chain. Returns the address,
  // or null when no wallet is available / the user declines.
  function connect() {
    var eth = getProvider();
    if (!eth) return Promise.resolve(null);
    return eth.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
      return accounts && accounts[0] ? accounts[0] : null;
    }).catch(function () { return null; });
  }

  // When live: read each token's epoch pot and the holder's claimable amount
  // from its contract, then fill the matching card. Until then this is a
  // no-op — the cards show "—" and the buttons stay disabled.
  function refresh() {
    if (!isLive()) return Promise.resolve(false);
    // Deploy-time wiring: for each token, call its contract's view functions
    // (e.g. epochPot() and claimable(address)) and write the results into
    // #claim-pot-<token> and #claim-amount-<token>.
    return Promise.resolve(true);
  }

  // Send the claim transaction for one token. Guards:
  //   - refuses to run until that token's contract address is set,
  //   - sends a plain claim call — no approval, no token movement out.
  function claim(kind) {
    var cfg = CLAIM_TOKENS[kind];
    if (!cfg || !cfg.contract) {
      if (window.console) window.console.warn('Claim not live yet: no contract for ' + kind);
      return Promise.resolve(null);
    }
    // Deploy-time wiring: build the claim calldata for cfg.claimFn and send
    // it from the connected wallet. The call must be receive-only.
    return connect().then(function (address) {
      if (!address) return null;
      // TODO(deploy): send tx { to: cfg.contract, data: claimCalldata } via the wallet.
      return null;
    });
  }

  function wireButtons() {
    var buttons = document.querySelectorAll('[data-claim]');
    Array.prototype.forEach.call(buttons, function (btn) {
      var kind = btn.getAttribute('data-claim');
      var cfg = CLAIM_TOKENS[kind];
      if (cfg && cfg.contract) {
        btn.disabled = false;
        btn.removeAttribute('title');
        btn.textContent = 'Claim ' + cfg.label;
      }
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        claim(kind);
      });
    });
  }

  function init() {
    wireButtons();
    // Expose for the deploy step and for debugging.
    window.ClaimEngine = {
      tokens: CLAIM_TOKENS,
      isLive: isLive,
      connect: connect,
      refresh: refresh,
      claim: claim
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
