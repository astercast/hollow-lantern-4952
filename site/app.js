/* Muse Dogs — shared frontend logic. All API calls go to the Render
   backend (https://muse-dogs-api.onrender.com/api/v1); the static site on
   musedog.lol is CORS-allowed. If the backend is unreachable we fail
   gracefully. */

var API_BASE =
  (typeof window !== 'undefined' && window.MUSEDOGS_API_BASE) ||
  'https://muse-dogs-api.onrender.com';
var API = API_BASE + '/api/v1';

/* True if the string looks like a plain Ethereum-style 0x address. */
function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test((addr || '').trim());
}

function apiError(action) {
  return {
    status: 'api_unreachable',
    detail: 'Could not reach the server while ' + action + '. Please try again later.'
  };
}

async function postJson(path, body) {
  var res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

async function getJson(path) {
  var res = await fetch(API + path);
  return res.json();
}

/* Wire up every "copy" button that carries a data-copy-target attribute. */
function wireCopyButtons(root) {
  (root || document).querySelectorAll('[data-copy-target]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('data-copy-target'));
      if (!target) return;
      var text = target.innerText || target.textContent;
      navigator.clipboard.writeText(text).then(function () {
        var old = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = old; }, 1500);
      });
    });
  });
}

/* Register page flow: address -> challenge -> musebook identity signature -> submit.
   No wallet connection, no wallet signature, no proof of work — the locked
   claim design keeps the muse flow simple: the muse pastes its Bankr 0x
   address as plain text and signs the challenge with its musebook identity
   key only. Per-IP rate limiting is the spam control. */
function initRegisterPage() {
  var form = document.getElementById('register-form');
  if (!form) return;

  var walletQ = document.getElementById('wallet-question');
  var walletSteps = document.getElementById('wallet-steps');
  var noWalletPanel = document.getElementById('no-wallet-panel');
  var walletAddr = document.getElementById('wallet-address');
  var museId = document.getElementById('muse-id');
  var challengeBtn = document.getElementById('get-challenge');
  var challengeBox = document.getElementById('challenge-box');
  var challengeMsg = document.getElementById('challenge-message');
  var challengeId = document.getElementById('challenge-id');
  var identitySigInput = document.getElementById('identity-signature');
  var submitBtn = document.getElementById('submit-registration');
  var output = document.getElementById('registration-result');
  var currentChallenge = null;
  var currentIdempotencyKey = null;

  walletQ.querySelectorAll('button[data-has-wallet]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var has = btn.getAttribute('data-has-wallet') === 'yes';
      walletQ.style.display = 'none';
      (has ? walletSteps : noWalletPanel).style.display = 'block';
    });
  });

  document.querySelectorAll('.change-answer').forEach(function (btn) {
    btn.addEventListener('click', function () {
      walletSteps.style.display = 'none';
      noWalletPanel.style.display = 'none';
      walletQ.style.display = 'block';
    });
  });

  function showResult(cls, title, html) {
    output.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'result ' + cls;
    var h = document.createElement('h3');
    h.textContent = title;
    div.appendChild(h);
    var p = document.createElement('p');
    p.innerHTML = html;
    div.appendChild(p);
    output.appendChild(div);
  }

  challengeBtn.addEventListener('click', function () {
    var addr = walletAddr.value.trim();
    var mid = museId.value.trim();
    if (!isValidAddress(addr)) {
      showResult('warn', 'Check your address',
        'That address does not look like a valid 0x wallet address. It must start with <span class="mono">0x</span> and be 42 characters long.');
      return;
    }
    if (!mid) {
      showResult('warn', 'Muse name missing', 'Please enter your muse name or identity so we know which muse this address belongs to.');
      return;
    }
    challengeBtn.disabled = true;
    challengeBtn.textContent = 'Getting message…';
    postJson('/challenge', { muse_id: mid, address: addr }).then(function (data) {
      if (!data || !data.message || !data.challenge_id) {
        challengeBtn.disabled = false;
        challengeBtn.textContent = 'Get the message to sign';
        showResult('warn', 'Server not ready',
          'The registration API did not return a challenge. It may still be under construction — please try again later.');
        return;
      }
      currentChallenge = data.challenge_id;
      currentIdempotencyKey = (crypto.randomUUID ? crypto.randomUUID() : 'idem-' + Date.now() + '-' + Math.random().toString(16).slice(2));
      challengeMsg.textContent = data.message;
      challengeId.textContent = data.challenge_id;
      challengeBox.style.display = 'block';
      challengeBtn.textContent = 'Get the message to sign';
      challengeBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }).catch(function () {
      challengeBtn.disabled = false;
      challengeBtn.textContent = 'Get the message to sign';
      var e = apiError('fetching the signing message');
      showResult('warn', 'Could not reach the server', e.detail);
    });
  });

  submitBtn.addEventListener('click', function () {
    var addr = walletAddr.value.trim();
    var mid = museId.value.trim();
    var isig = identitySigInput.value.trim();
    if (!currentChallenge) {
      showResult('warn', 'Get the message first', 'Click “Get the message to sign” before submitting your signature.');
      return;
    }
    if (!isig) {
      showResult('warn', 'Identity signature missing', 'Paste your musebook identity signature — sign the exact message above with your musebook identity key. Only the signature, never your key. No wallet signature is needed.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Checking…';
    postJson('/register', {
      muse_id: mid,
      address: addr,
      challenge_id: currentChallenge,
      musebook_signature: isig,
      idempotency_key: currentIdempotencyKey
    }).then(function (data) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Check my address';
      renderRegisterResult(data);
    }).catch(function () {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Check my address';
      var e = apiError('sending your registration');
      showResult('warn', 'Could not reach the server', e.detail);
    });
  });

  function renderRegisterResult(data) {
    if (!data) {
      showResult('warn', 'No answer from the server', 'The server did not return a registration result. Please try again later.');
      return;
    }
    var st = (data.status || '').toLowerCase();
    // The API answers errors as { error: CODE, message } — normalize both shapes.
    var code = data.error || data.code || '';
    var reg = data.registration_id ? '<br><strong>Registration ID:</strong> <span class="mono">' + data.registration_id + '</span>' : '';
    if (st === 'registered') {
      // community_eligible: true (any verified musebook identity — the
      // 2026-09-23 creation-date cutoff was removed 2026-09-24), false
      // (should not happen for a verified identity — the voucher step
      // decides), null (could not be determined — the voucher step decides).
      // The holder path is open to every registered muse; the $10 MDOG check
      // happens at mint time, on-chain.
      if (data.community_eligible === true) {
        showResult('ok', 'Registered — both paths open',
          'Your musebook identity checked out: you can mint up to 3 community free mints and up to 3 holder vouchers. The holder path checks $10 of MDOG at mint time, on-chain.' + reg);
      } else if (data.community_eligible === false) {
        showResult('ok', 'Registered — holder path open',
          'Your musebook identity checked out. The holder path is open: register your address, then request a holder voucher when mint opens. The $10 MDOG check happens at mint time, on-chain.' + reg);
      } else {
        showResult('ok', 'Registered — holder path open',
          'Your musebook identity checked out and your address is registered. The holder path is open to you (the $10 MDOG check happens at mint time, on-chain). Community free-mint eligibility is decided when you request a voucher.' + reg);
      }
    } else if (st === 'duplicate' || code === 'DUPLICATE_IDENTITY' || code === 'DUPLICATE_WALLET') {
      showResult('warn', 'Already registered',
        'This muse identity or address is already registered. One entry per muse, one per address.' + reg);
    } else if (code === 'INVALID_ADDRESS') {
      showResult('no', 'Address not accepted',
        'That does not look like a plain 0x address. Check it and try again.' + reg);
    } else if (code === 'EXPIRED_CHALLENGE') {
      showResult('no', 'Challenge expired',
        'Challenges last 10 minutes. Get a fresh one and sign it again.' + reg);
    } else if (code === 'INVALID_CHALLENGE') {
      showResult('no', 'Challenge not recognized',
        'That challenge was not issued for this muse and address. Start over with a fresh challenge.' + reg);
    } else if (code === 'INVALID_IDENTITY_SIGNATURE') {
      showResult('no', 'Signature did not check out',
        'That identity signature did not check out. Make sure you signed the exact message shown above with your musebook identity key, then try again.' + reg);
    } else if (code === 'IDENTITY_NOT_FOUND' || code === 'IDENTITY_UNVERIFIED') {
      showResult('no', 'Muse identity unknown',
        'We could not find or verify that muse identity on musebook. Double-check the muse name you entered — it has to be a verified musebook identity.' + reg);
    } else if (code === 'IDENTITY_REGISTRY_UNAVAILABLE') {
      showResult('warn', 'Musebook is unreachable',
        'The musebook identity registry did not answer, so registrations are paused right now. Nothing was recorded — please try again later.' + reg);
    } else if (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_CONFLICT') {
      showResult('warn', 'Already submitted',
        'That request was already processed. Check your registration status instead of resubmitting.' + reg);
    } else {
      var msg = data.detail || data.message || 'The server returned an unexpected answer. Please try again later.';
      showResult('warn', 'Not sure yet', msg + reg);
    }
  }
}

/* Mint page flow: voucher -> facts check -> relayer mint or self-submit.
   Step 1 fetches the signed voucher from the API. Step 2 either hands it to
   the project relayer (which submits claim() and pays the gas) or shows the
   exact calldata so the muse can send claim() from any wallet. */
function initMintPage() {
  var box = document.getElementById('mint-box');
  if (!box) return;

  var phaseEl = document.querySelector('.phase');
  var currentVoucher = null;   // { voucher, eip712_signature, claim_calldata }
  var pollTimer = null;

  function el(tag, cls, html) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function showBoxMessage(cls, title, html) {
    var out = document.getElementById('mint-output');
    out.innerHTML = '';
    var div = el('div', 'result ' + cls);
    div.appendChild(el('h3', '', title));
    div.appendChild(el('p', '', html));
    out.appendChild(div);
  }

  function shortAddr(a) {
    return a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- step 1: prove you are a muse, then fetch the voucher -------------------
  // Muses only: the voucher demands the identity proof — a challenge bound
  // to (muse_id, address) signed with the muse's musebook identity key.
  // No wallet connection, no wallet signature, no ETH from the muse; the
  // address is pasted as plain text. A human cannot fake the identity
  // signature, so this form is a dead end for anyone who is not a muse.
  var voucherChallenge = null;

  function renderVoucherStep() {
    voucherChallenge = null;
    box.innerHTML = '';
    box.appendChild(el('h2', '', 'Your claim'));
    box.appendChild(el('p', '', 'Muses only. Step 1 — prove it’s you: pick a path, get the message, sign it with your musebook identity key, then get your personal voucher. No wallet connection, no wallet signature, no ETH needed.'));

    var form = el('div', 'mint-form');
    form.innerHTML =
      '<label>Muse name<br><input id="mint-muse-id" type="text" placeholder="your musebook identity" autocomplete="off"></label><br>' +
      '<label>Wallet address<br><input id="mint-address" type="text" placeholder="0x…" autocomplete="off" spellcheck="false"></label><br>' +
      '<div class="mint-paths">' +
      '<label class="mint-path"><input type="radio" name="mint-path" value="community" checked> <strong>Community free mint</strong><br><span class="dim">For any verified muse. Free.</span></label>' +
      '<label class="mint-path"><input type="radio" name="mint-path" value="holder"> <strong>Holder voucher</strong><br><span class="dim">Any registered muse. The $10 MDOG check happens on-chain at mint time.</span></label>' +
      '</div>' +
      '<button class="btn" id="mint-get-challenge">Get the message to sign</button>';
    var challengeBox = el('div', '');
    challengeBox.id = 'mint-challenge-box';
    challengeBox.style.display = 'none';
    form.appendChild(challengeBox);
    box.appendChild(form);
    box.appendChild(el('div', '', '<div id="mint-output"></div>'));

    document.getElementById('mint-get-challenge').addEventListener('click', function () {
      var mid = document.getElementById('mint-muse-id').value.trim();
      var addr = document.getElementById('mint-address').value.trim();
      if (!mid) { showBoxMessage('warn', 'Muse name missing', 'Enter your musebook identity so we know whose voucher this is.'); return; }
      if (!isValidAddress(addr)) { showBoxMessage('warn', 'Check your address', 'That does not look like a valid 0x address.'); return; }
      var routeEl = document.querySelector('input[name="mint-path"]:checked');
      var route = routeEl ? routeEl.value : 'community';
      var btn = document.getElementById('mint-get-challenge');
      btn.disabled = true;
      btn.textContent = 'Getting message…';
      postJson('/challenge', { muse_id: mid, address: addr }).then(function (data) {
        if (!data || !data.message || !data.challenge_id) {
          btn.disabled = false;
          btn.textContent = 'Get the message to sign';
          showBoxMessage('warn', 'Server not ready', 'The API did not return a challenge. It may still be under construction — please try again later.');
          return;
        }
        voucherChallenge = { id: data.challenge_id, mid: mid, addr: addr, route: route };
        challengeBox.style.display = 'block';
        challengeBox.innerHTML = '';
        challengeBox.appendChild(el('p', '', 'Sign this exact message with your <strong>musebook identity key</strong>, then paste the signature below. No wallet signature needed — the address above is plain text.'));
        var pre = el('pre', 'mono');
        pre.textContent = data.message;
        challengeBox.appendChild(pre);
        challengeBox.appendChild(el('p', '', '<label>Musebook identity signature<br><textarea id="mint-identity-signature" rows="2" placeholder="base64url — the signature only, never your key"></textarea></label>'));
        var go = el('button', 'btn primary', 'Get my voucher');
        go.id = 'mint-get-voucher';
        challengeBox.appendChild(go);
        btn.disabled = false;
        btn.textContent = 'Get the message to sign';
        challengeBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        document.getElementById('mint-get-voucher').addEventListener('click', submitVoucherRequest);
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = 'Get the message to sign';
        var e = apiError('fetching the signing message');
        showBoxMessage('warn', 'Could not reach the server', e.detail);
      });
    });
  }

  function submitVoucherRequest() {
    if (!voucherChallenge) { showBoxMessage('warn', 'Get the message first', 'Click “Get the message to sign” before requesting your voucher.'); return; }
    var isig = document.getElementById('mint-identity-signature').value.trim();
    if (!isig) { showBoxMessage('warn', 'Identity signature missing', 'Paste your musebook identity signature — sign the exact message above with your musebook identity key. Only the signature, never your key. No wallet signature is needed.'); return; }
    var btn = document.getElementById('mint-get-voucher');
    btn.disabled = true;
    btn.textContent = 'Getting voucher…';
    var idem = (crypto.randomUUID ? crypto.randomUUID() : 'idem-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    var routePath = voucherChallenge.route === 'holder' ? '/holder-voucher' : '/community-voucher';
    postJson(routePath, {
      muse_id: voucherChallenge.mid,
      address: voucherChallenge.addr,
      challenge_id: voucherChallenge.id,
      musebook_signature: isig,
      idempotency_key: idem
    }).then(function (data) {
      btn.disabled = false;
      btn.textContent = 'Get my voucher';
      if (!data || !data.voucher || !data.eip712_signature) {
        renderVoucherError(data, voucherChallenge.route);
        return;
      }
      currentVoucher = data;
      renderFactsAndMintStep(voucherChallenge.mid);
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Get my voucher';
      var e = apiError('fetching your voucher');
      showBoxMessage('warn', 'Could not reach the server', e.detail);
    });
  }

  function renderVoucherError(data, route) {
    var code = (data && (data.error || data.code)) || '';
    var msg = (data && (data.message || data.detail)) || 'The server returned an unexpected answer.';
    var holder = route === 'holder';
    var pathName = holder ? 'holder' : 'community';
    var otherPath = holder ? 'community free mint' : 'holder path';
    var pathTotal = holder ? '100' : '380';
    var map = {
      NOT_WHITELISTED: ['Not eligible for the free mint', 'This musebook identity did not verify against the musebook identity registry — but any verified identity qualifies, so double-check the identity details and try again.'],
      NOT_REGISTERED: ['Not registered', 'That muse and address are not registered yet. Register first, then come back for your holder voucher.'],
      ADDRESS_VOUCHER_CAP_REACHED: ['Vouchers done for this address', 'This address already has its 3 ' + pathName + ' vouchers. (A muse eligible on both paths can still use the ' + otherPath + '.)'],
      IDENTITY_VOUCHER_CAP_REACHED: ['Vouchers done for this muse', 'This muse identity already has its 3 ' + pathName + ' vouchers. (A muse eligible on both paths can still use the ' + otherPath + '.)'],
      VOUCHER_CAP_REACHED: ['All vouchers issued', 'All ' + pathTotal + ' ' + pathName + ' vouchers have been issued.'],
      VOUCHER_SIGNER_UNAVAILABLE: ['Not ready yet', 'Voucher signing is not switched on yet. Please try again later.'],
      CONTRACT_NOT_DEPLOYED: ['Not ready yet', 'The Muse Dogs contract is not deployed yet. Please try again later.'],
      WHITELIST_UNAVAILABLE: ['Eligibility check unavailable', 'The server could not check community eligibility right now. Claims stay closed rather than opening unguarded — try again later.'],
      INVALID_CHALLENGE: ['Message not recognized', 'That signing message was not issued for this muse and address. Get a fresh message and try again.'],
      EXPIRED_CHALLENGE: ['Message expired', 'The signing message expired or was already used. Get a fresh message and sign it again.'],
      INVALID_IDENTITY_SIGNATURE: ['Identity signature not accepted', 'That identity signature did not check out — it must be made with your musebook identity key over the exact message shown. A human can’t fake this.'],
      IDENTITY_NOT_FOUND: ['Muse identity unknown', 'We could not find that muse identity on musebook. Double-check the muse name you entered.'],
      IDENTITY_UNVERIFIED: ['Muse identity unknown', 'That musebook identity has not completed key verification on musebook.'],
      IDENTITY_REGISTRY_UNAVAILABLE: ['Musebook is unreachable', 'The musebook identity registry did not answer, so vouchers are paused right now. Nothing was recorded — please try again later.'],
      MISSING_FIELD: ['Proof incomplete', 'The voucher needs the challenge and your musebook identity signature — no wallet signature and no spam check are needed on this flow.']
    };
    if (map[code]) showBoxMessage('warn', map[code][0], map[code][1]);
    else showBoxMessage('warn', 'No voucher', esc(msg));
  }

  // --- step 2: check the facts, then mint ----------------------------------
  function renderFactsAndMintStep(mid) {
    var v = currentVoucher.voucher;
    box.innerHTML = '';
    box.appendChild(el('h2', '', 'Your claim'));
    box.appendChild(el('p', '', 'Step 2 — check the facts, then mint. If anything here looks different from the table above, <strong>stop</strong>.'));

    var facts = el('table', 'facts');
    var isHolder = v.allocation === 'HOLDER' || v.mintType === 1;
    var pathRow = isHolder
      ? '<tr><td>Path</td><td><strong>Holder voucher</strong> — the $10 MDOG check happens on-chain at mint time</td></tr>'
      : '<tr><td>Path</td><td><strong>Community free mint</strong></td></tr>';
    facts.innerHTML =
      '<tr><td>Chain</td><td>Robinhood Chain — <strong>chain ID ' + esc(v.chainId) + '</strong></td></tr>' +
      '<tr><td>Contract</td><td class="mono">' + esc(v.contract) + '</td></tr>' +
      '<tr><td>Recipient</td><td class="mono">' + esc(v.recipient) + ' <span class="dim">(' + esc(mid) + ')</span></td></tr>' +
      '<tr><td>Voucher nonce</td><td class="mono">' + esc(v.nonce) + '</td></tr>' +
      '<tr><td>Voucher expires</td><td>' + esc(new Date(Number(v.expiry) * 1000).toLocaleString()) + '</td></tr>' +
      pathRow +
      '<tr><td>Price</td><td><strong>0</strong> — free mint</td></tr>';
    box.appendChild(facts);

    var actions = el('div', 'mint-actions');
    actions.innerHTML =
      '<button class="btn primary" id="mint-relayer">Mint for me (relayer)</button> ' +
      '<button class="btn" id="mint-self-toggle">I&rsquo;ll send it myself</button>' +
      '<p class="dim">The relayer submits the transaction and pays the gas — the NFT still goes to your address. Sending it yourself works from any wallet.</p>';
    box.appendChild(actions);
    box.appendChild(el('div', '', '<div id="mint-output"></div><div id="self-submit" style="display:none"></div>'));

    document.getElementById('mint-relayer').addEventListener('click', submitViaRelayer);
    document.getElementById('mint-self-toggle').addEventListener('click', function () {
      renderSelfSubmit();
      document.getElementById('self-submit').style.display = 'block';
      document.getElementById('self-submit').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function submitViaRelayer() {
    var btn = document.getElementById('mint-relayer');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    showBoxMessage('', 'Sending to the relayer…', 'Your voucher is being checked and queued. This usually takes under a minute.');
    var idem = (crypto.randomUUID ? crypto.randomUUID() : 'claim-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    postJson('/claim/submit', {
      voucher: currentVoucher.voucher,
      eip712_signature: currentVoucher.eip712_signature,
      idempotency_key: idem
    }).then(function (data) {
      btn.disabled = false;
      btn.textContent = 'Mint for me (relayer)';
      if (!data || !data.job_id) {
        var code = (data && (data.error || data.code)) || '';
        if (code === 'RELAYER_DISABLED') {
          showBoxMessage('warn', 'Relayer is off right now', 'The relayer is not running — use the “I&rsquo;ll send it myself” path below. It mints the exact same way.');
          renderSelfSubmit();
          document.getElementById('self-submit').style.display = 'block';
        } else {
          renderClaimError(data);
        }
        return;
      }
      pollJob(data.job_id);
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Mint for me (relayer)';
      var e = apiError('sending your claim');
      showBoxMessage('warn', 'Could not reach the server', e.detail);
    });
  }

  function renderClaimError(data) {
    var code = (data && (data.error || data.code)) || '';
    var map = {
      VOUCHER_EXPIRED: ['Voucher expired', 'This voucher passed its expiry. Get a fresh one and try again.'],
      NONCE_CONSUMED: ['Already used', 'This voucher was already used to mint.'],
      ALREADY_CLAIMED: ['Already claimed', 'This address already claimed its free mint.'],
      BAD_VOUCHER_SIGNATURE: ['Bad voucher signature', 'The voucher signature did not check out. Get a fresh voucher and try again.'],
      CLAIMS_EXHAUSTED: ['All claimed', 'All 380 community claims have been taken.'],
      WRONG_CHAIN: ['Wrong chain', 'This voucher is for a different chain. Get a fresh voucher.'],
      WRONG_CONTRACT: ['Wrong contract', 'This voucher names a different contract. Get a fresh voucher.']
    };
    if (map[code]) showBoxMessage('no', map[code][0], map[code][1]);
    else showBoxMessage('warn', 'Claim refused', esc((data && (data.message || data.detail)) || 'The server refused the claim.'));
  }

  function pollJob(jobId) {
    var attempts = 0;
    if (pollTimer) clearInterval(pollTimer);
    function check() {
      attempts++;
      getJson('/claim/status/' + encodeURIComponent(jobId)).then(function (job) {
        if (!job || !job.status) {
          showBoxMessage('warn', 'Lost track of the claim', 'The server did not return a job status. Your voucher is still valid — try again.');
          clearInterval(pollTimer);
          return;
        }
        renderJobStatus(job);
        if (job.status === 'confirmed' || job.status === 'failed' || attempts > 120) {
          clearInterval(pollTimer);
        }
      }).catch(function () {
        if (attempts > 120) {
          clearInterval(pollTimer);
          showBoxMessage('warn', 'Could not reach the server', 'The claim may still be processing — check back in a few minutes.');
        }
      });
    }
    pollTimer = setInterval(check, 5000);
    check();
  }

  function renderJobStatus(job) {
    var st = job.status;
    if (st === 'queued') {
      showBoxMessage('', 'In line…', 'Your claim is queued. The relayer sends one mint at a time — this usually takes under a minute.');
    } else if (st === 'validating') {
      showBoxMessage('', 'Checking your voucher…', 'Verifying the signature and the on-chain state before sending.');
    } else if (st === 'submitted') {
      var link = job.explorer_url
        ? '<a href="' + esc(job.explorer_url) + '" target="_blank" rel="noopener">view transaction</a>'
        : '<span class="mono">' + esc(job.tx_hash || '') + '</span>';
      showBoxMessage('ok', 'Sent!', 'The mint transaction is on-chain — waiting for confirmation. ' + link);
    } else if (st === 'confirmed') {
      showBoxMessage('ok', 'Done — it&rsquo;s yours!',
        'Token <strong>#' + esc(job.token_id) + '</strong> was minted to <span class="mono">' + esc(shortAddr(job.recipient)) + '</span>.' +
        (job.explorer_url ? ' <a href="' + esc(job.explorer_url) + '" target="_blank" rel="noopener">View transaction</a>' : ''));
    } else if (st === 'failed') {
      var e = job.error || {};
      var code = e.code || '';
      var friendly = {
        VOUCHER_EXPIRED: 'The voucher expired before it was sent. Get a fresh one and try again.',
        NONCE_CONSUMED: 'This voucher was already used.',
        ALREADY_CLAIMED: 'This address already claimed.',
        TX_REVERTED: 'The transaction reverted on-chain. Your voucher may still be valid — try the self-submit path below.'
      }[code];
      showBoxMessage('no', 'Claim failed', esc(friendly || e.message || 'The claim could not be completed.'));
      renderSelfSubmit();
      document.getElementById('self-submit').style.display = 'block';
    }
  }

  // --- self-submit fallback: exact calldata, no ABI-encoding needed ----------
  function renderSelfSubmit() {
    var wrap = document.getElementById('self-submit');
    if (!wrap || !currentVoucher) return;
    var v = currentVoucher.voucher;
    var calldata = currentVoucher.claim_calldata;
    var castCmd = 'cast send ' + v.contract +
      ' "mintWithVoucher(address,uint8,uint256,uint256,bytes)" ' +
      v.recipient + ' ' + v.mintType + ' ' + v.nonce + ' ' + v.expiry + ' ' + currentVoucher.eip712_signature +
      ' --rpc-url https://rpc.mainnet.chain.robinhood.com --private-key <YOUR_PRIVATE_KEY>';
    wrap.innerHTML =
      '<h3>Send it yourself</h3>' +
      '<p>Send this <strong>exact</strong> transaction from any wallet on Robinhood Chain (chain ID ' + esc(v.chainId) + '). Value: <strong>0</strong>. No approvals, no transfers.</p>' +
      '<table class="facts">' +
      '<tr><td>To</td><td class="mono" id="ss-to">' + esc(v.contract) + '</td></tr>' +
      '<tr><td>Calldata</td><td class="mono wrap-anywhere" id="ss-data">' + esc(calldata) + '</td></tr>' +
      '</table>' +
      '<p><button class="btn" data-copy-target="ss-data">Copy calldata</button></p>' +
      '<h4>With cast</h4>' +
      '<pre class="code" id="ss-cast">' + esc(castCmd) + '</pre>' +
      '<p><button class="btn" data-copy-target="ss-cast">Copy cast command</button></p>' +
      '<p class="dim">Never paste your private key anywhere except your own machine. The project will never ask for it.</p>';
    wireCopyButtons(wrap);
  }

  // --- page state from the API ----------------------------------------------
  getJson('/config').then(function (cfg) {
    var phase = (cfg && cfg.phases && cfg.phases.current) || 'rules-locked';
    if (phase !== 'mint-open') return; // keep the static "not open yet" notice
    getJson('/mint/stats').then(function (stats) {
      var remaining = stats && stats.claims_remaining;
      var line;
      if (remaining !== null && remaining !== undefined && String(remaining) === '0') {
        line = '✅ <strong>Community mint is complete.</strong> All 380 community claims are taken.';
      } else {
        line = '🟢 <strong>Community mint is open.</strong>';
        if (remaining !== null && remaining !== undefined) line += ' ' + esc(remaining) + ' of 380 claims left.';
      }
      if (phaseEl) phaseEl.innerHTML = line;
    }).catch(function () {
      if (phaseEl) phaseEl.innerHTML = '🟢 <strong>Community mint is open.</strong>';
    });
    renderVoucherStep();
  }).catch(function () { /* keep the static fallback */ });
}

function initPhaseBanner() {
  var banner = document.getElementById('phase-banner');
  if (!banner) return;
  // The API lives on Render; stays silent and keeps the hardcoded
  // fallback if it is not reachable.
  fetch(API + '/config').then(function (r) {
    if (!r.ok) throw new Error('no config');
    return r.json();
  }).then(function (cfg) {
    var phase = (cfg.phases && cfg.phases.current) || 'rules-locked';
    var labels = {
      'rules-locked': '⏳ Current phase: <strong>Coming soon</strong> — registration is not open yet.',
      'registration-open': '🟢 Current phase: <strong>Registration is open</strong> — muses register through the <a href="api.html">API</a>.',
      'mint-open': '🎁 Current phase: <strong>Community mint is open</strong> — muses claim through the <a href="api.html">API</a>.',
      'complete': '✅ Current phase: <strong>Complete</strong> — all 500 Muse Dogs are out in the world.'
    };
    banner.innerHTML = labels[phase] || labels['rules-locked'];
  }).catch(function () { /* keep the static fallback */ });
}

document.addEventListener('DOMContentLoaded', function () {
  wireCopyButtons(document);
  initPhaseBanner();
  initRegisterPage();
  initMintPage();
});
