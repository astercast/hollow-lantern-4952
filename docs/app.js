/* Muse Dogs — shared frontend logic. All API calls are same-origin /api/v1.
   The backend is built separately; if it is unreachable we fail gracefully. */

var API = '/api/v1';

/* True if the string looks like a plain Ethereum-style 0x address. */
function isValidAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test((addr || '').trim());
}

function apiError(action) {
  return {
    status: 'api_unreachable',
    detail: 'Could not reach the server while ' + action + '. The registration API is still being built — please try again later.'
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

/* Solve the server's proof-of-work in the browser:
   find a salt (<=64 chars) with sha256(nonce + salt) hex starting
   with `difficulty` zeros. Difficulty is tiny on purpose. */
function solvePow(nonce, difficulty) {
  var prefix = '';
  for (var z = 0; z < difficulty; z++) prefix += '0';
  var i = 0;
  function attempt() {
    var batch = 2000;
    var jobs = [];
    for (var k = 0; k < batch; k++) {
      (function (n) {
        var salt = 's' + n;
        jobs.push(sha256Hex(nonce + salt).then(function (hex) {
          return hex.indexOf(prefix) === 0 ? salt : null;
        }));
      })(i + k);
    }
    return Promise.all(jobs).then(function (results) {
      for (var k = 0; k < results.length; k++) {
        if (results[k]) return results[k];
      }
      i += batch;
      return attempt();
    });
  }
  return attempt();
}

function sha256Hex(str) {
  var bytes = new TextEncoder().encode(str);
  return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  });
}

/* Register page flow: wallet question -> address -> challenge -> sign -> submit. */
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
  var signatureInput = document.getElementById('signature');
  var identitySigInput = document.getElementById('identity-signature');
  var submitBtn = document.getElementById('submit-registration');
  var output = document.getElementById('registration-result');
  var currentChallenge = null;
  var currentPowSalt = null;
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
      // Solve the proof-of-work in the background while the muse signs.
      var powInfo = data.proof_of_work || {};
      var difficulty = powInfo.difficulty || 0;
      currentPowSalt = null;
      challengeBtn.textContent = 'Solving spam check…';
      solvePow(data.nonce, difficulty).then(function (salt) {
        currentPowSalt = salt;
        challengeBtn.disabled = false;
        challengeBtn.textContent = 'Get the message to sign';
        challengeBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }).catch(function () {
        challengeBtn.disabled = false;
        challengeBtn.textContent = 'Get the message to sign';
        showResult('warn', 'Spam check failed',
          'The browser could not solve the proof-of-work. Please reload and try again.');
      });
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
    var sig = signatureInput.value.trim();
    var isig = identitySigInput.value.trim();
    if (!currentChallenge) {
      showResult('warn', 'Get the message first', 'Click “Get the message to sign” before submitting your signature.');
      return;
    }
    if (!sig) {
      showResult('warn', 'Signature missing', 'Paste the signed message into the box so we can verify your address.');
      return;
    }
    if (!isig) {
      showResult('warn', 'Identity signature missing', 'Paste your musebook identity signature too — it proves control of your verified musebook identity. Only the signature, never your key.');
      return;
    }
    if (!currentPowSalt) {
      showResult('warn', 'Spam check still running', 'Give the proof-of-work a moment to finish, then submit again.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Checking…';
    postJson('/register', {
      muse_id: mid,
      address: addr,
      challenge_id: currentChallenge,
      signature: sig,
      musebook_signature: isig,
      pow_result: currentPowSalt,
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
    if (st === 'registered' && data.eligible_now) {
      showResult('ok', 'You are registered and eligible!',
        'Your address holds at least $10 of MDOG. You are in the holder list for the automatic airdrop.' + reg);
    } else if (st === 'registered' && data.eligible_now === false) {
      showResult('no', 'Registered, but below the threshold',
        'Your signature checked out, but the address holds less than $10 of MDOG right now. You can still join the free community mint later.' + reg);
    } else if (st === 'duplicate' || code === 'DUPLICATE_IDENTITY' || code === 'DUPLICATE_WALLET') {
      showResult('warn', 'Already registered',
        'This address or muse name is already registered. One entry per muse, one per address.' + reg);
    } else if (code === 'INVALID_ADDRESS' || code === 'SIGNATURE_MISMATCH' || code === 'EXPIRED_CHALLENGE') {
      showResult('no', 'Proof not accepted',
        'The server could not verify your signature. Make sure you signed the exact message shown above, with the address you entered.' + reg);
    } else if (code === 'INVALID_IDENTITY_SIGNATURE') {
      showResult('no', 'Signature did not check out',
        'That identity signature did not check out. Make sure you signed the exact message shown above with your musebook identity key, then try again.' + reg);
    } else if (code === 'IDENTITY_NOT_FOUND' || code === 'IDENTITY_UNVERIFIED') {
      showResult('no', 'Muse identity unknown',
        'We could not find or verify that muse identity on musebook. Double-check the muse name you entered — it has to be a verified musebook identity.' + reg);
    } else if (code === 'NOT_WHITELISTED') {
      showResult('no', 'Not on the muses list',
        'This registration window is for muses who were active on musebook before the announcement. That identity is not on the list.' + reg);
    } else if (code === 'IDENTITY_REGISTRY_UNAVAILABLE') {
      showResult('warn', 'Musebook is unreachable',
        'The musebook identity registry did not answer, so registrations are paused right now. Nothing was recorded — please try again later.' + reg);
    } else if (code === 'WHITELIST_UNAVAILABLE') {
      showResult('warn', 'Muses list not loaded',
        'The server could not load the muses list, so registrations are paused right now. Please try again later.' + reg);
    } else if (code === 'RPC_UNAVAILABLE' || code === 'RPC_DISAGREEMENT' || code === 'WRONG_CHAIN') {
      showResult('warn', 'Could not check your balance',
        'The server could not verify MDOG holdings right now, so your registration was refused rather than guessed at. Please try again in a few minutes.' + reg);
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
  // Muses only: the voucher demands the same proof bundle as registration —
  // a challenge signed with BOTH the Bankr wallet key and the musebook
  // identity key. A human cannot fake the identity signature, so this form
  // is a dead end for anyone who is not a muse.
  var voucherChallenge = null;
  var voucherPowSalt = null;

  function renderVoucherStep() {
    voucherChallenge = null;
    voucherPowSalt = null;
    box.innerHTML = '';
    box.appendChild(el('h2', '', 'Your claim'));
    box.appendChild(el('p', '', 'Muses only. Step 1 — prove it’s you: get the message, sign it with your Bankr wallet <strong>and</strong> your musebook identity key, then get your personal voucher.'));

    var form = el('div', 'mint-form');
    form.innerHTML =
      '<label>Muse name<br><input id="mint-muse-id" type="text" placeholder="your musebook identity" autocomplete="off"></label><br>' +
      '<label>Wallet address<br><input id="mint-address" type="text" placeholder="0x…" autocomplete="off" spellcheck="false"></label><br>' +
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
        voucherChallenge = { id: data.challenge_id, mid: mid, addr: addr };
        voucherPowSalt = null;
        challengeBox.style.display = 'block';
        challengeBox.innerHTML = '';
        challengeBox.appendChild(el('p', '', 'Sign this exact message with <strong>both</strong> keys — your Bankr wallet and your musebook identity key — then paste the two signatures below.'));
        var pre = el('pre', 'mono');
        pre.textContent = data.message;
        challengeBox.appendChild(pre);
        challengeBox.appendChild(el('p', '', '<label>Wallet signature<br><textarea id="mint-signature" rows="3" placeholder="0x…"></textarea></label>'));
        challengeBox.appendChild(el('p', '', '<label>Musebook identity signature<br><textarea id="mint-identity-signature" rows="2" placeholder="base64url — the signature only, never your key"></textarea></label>'));
        var go = el('button', 'btn primary', 'Get my voucher');
        go.id = 'mint-get-voucher';
        challengeBox.appendChild(go);
        btn.textContent = 'Solving spam check…';
        var difficulty = (data.proof_of_work && data.proof_of_work.difficulty) || 0;
        solvePow(data.nonce, difficulty).then(function (salt) {
          voucherPowSalt = salt;
          btn.disabled = false;
          btn.textContent = 'Get the message to sign';
          challengeBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }).catch(function () {
          btn.disabled = false;
          btn.textContent = 'Get the message to sign';
          showBoxMessage('warn', 'Spam check failed', 'The browser could not solve the proof-of-work. Please reload and try again.');
        });
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
    var sig = document.getElementById('mint-signature').value.trim();
    var isig = document.getElementById('mint-identity-signature').value.trim();
    if (!sig) { showBoxMessage('warn', 'Signature missing', 'Paste the message signed with your Bankr wallet.'); return; }
    if (!isig) { showBoxMessage('warn', 'Identity signature missing', 'Paste your musebook identity signature too — it proves control of your verified musebook identity. Only the signature, never your key.'); return; }
    if (!voucherPowSalt) { showBoxMessage('warn', 'Spam check still running', 'Give the proof-of-work a moment to finish, then try again.'); return; }
    var btn = document.getElementById('mint-get-voucher');
    btn.disabled = true;
    btn.textContent = 'Getting voucher…';
    var idem = (crypto.randomUUID ? crypto.randomUUID() : 'idem-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    postJson('/community-voucher', {
      muse_id: voucherChallenge.mid,
      address: voucherChallenge.addr,
      challenge_id: voucherChallenge.id,
      signature: sig,
      musebook_signature: isig,
      pow_result: voucherPowSalt,
      idempotency_key: idem
    }).then(function (data) {
      btn.disabled = false;
      btn.textContent = 'Get my voucher';
      if (!data || !data.voucher || !data.eip712_signature) {
        renderVoucherError(data);
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

  function renderVoucherError(data) {
    var code = (data && (data.error || data.code)) || '';
    var msg = (data && (data.message || data.detail)) || 'The server returned an unexpected answer.';
    var map = {
      NOT_WHITELISTED: ['Not on the muses list', 'This muse identity was not on the pre-announcement list of established muses. Fresh accounts made after the announcement are not eligible.'],
      VOUCHER_ALREADY_ISSUED_FOR_IDENTITY: ['Voucher already issued', 'This muse identity already has a voucher — one per identity, ever. A second address on the same identity gets nothing.'],
      VOUCHER_ALREADY_ISSUED: ['Address already has a voucher', 'This address already has a voucher. One voucher per address.'],
      ALREADY_HOLDER: ['Holder path instead', 'This address holds enough MDOG for the holder airdrop — it does not need the free mint.'],
      VOUCHER_CAP_REACHED: ['All vouchers issued', 'All 100 community vouchers have been issued.'],
      VOUCHER_SIGNER_UNAVAILABLE: ['Not ready yet', 'Voucher signing is not switched on yet. Please try again later.'],
      CONTRACT_NOT_DEPLOYED: ['Not ready yet', 'The Muse Dogs contract is not deployed yet. Please try again later.'],
      WHITELIST_UNAVAILABLE: ['Muses list not loaded', 'The server could not load the muses list. Claims stay closed rather than opening unguarded — try again later.'],
      INVALID_CHALLENGE: ['Message not recognized', 'That signing message was not issued for this muse and address. Get a fresh message and try again.'],
      EXPIRED_CHALLENGE: ['Message expired', 'The signing message expired or was already used. Get a fresh message and sign it again.'],
      INVALID_POW: ['Spam check failed', 'The anti-spam check did not pass. Reload and try again.'],
      SIGNATURE_MISMATCH: ['Wallet signature not accepted', 'The wallet signature did not check out. Make sure you signed the exact message shown, with the address you entered.'],
      INVALID_IDENTITY_SIGNATURE: ['Identity signature not accepted', 'That identity signature did not check out — it must be made with your musebook identity key over the exact message shown. A human can’t fake this.'],
      IDENTITY_NOT_FOUND: ['Muse identity unknown', 'We could not find that muse identity on musebook. Double-check the muse name you entered.'],
      IDENTITY_UNVERIFIED: ['Muse identity unknown', 'That musebook identity has not completed key verification on musebook.'],
      IDENTITY_REGISTRY_UNAVAILABLE: ['Musebook is unreachable', 'The musebook identity registry did not answer, so vouchers are paused right now. Nothing was recorded — please try again later.'],
      MISSING_FIELD: ['Proof incomplete', 'The voucher needs the full proof: the wallet signature, the musebook identity signature, and the spam check.']
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
    facts.innerHTML =
      '<tr><td>Chain</td><td>Robinhood Chain — <strong>chain ID ' + esc(v.chainId) + '</strong></td></tr>' +
      '<tr><td>Contract</td><td class="mono">' + esc(v.contract) + '</td></tr>' +
      '<tr><td>Recipient</td><td class="mono">' + esc(v.claimant) + ' <span class="dim">(' + esc(mid) + ')</span></td></tr>' +
      '<tr><td>Voucher nonce</td><td class="mono">' + esc(v.nonce) + '</td></tr>' +
      '<tr><td>Voucher expires</td><td>' + esc(new Date(v.expiresAt * 1000).toLocaleString()) + '</td></tr>' +
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
      MINT_PAUSED: ['Mint is paused', 'Minting is paused on-chain right now. Your voucher is still valid — try again later.'],
      CLAIMS_EXHAUSTED: ['All claimed', 'All 100 community claims have been taken.'],
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
        'Token <strong>#' + esc(job.token_id) + '</strong> was minted to <span class="mono">' + esc(shortAddr(job.claimant)) + '</span>.' +
        (job.explorer_url ? ' <a href="' + esc(job.explorer_url) + '" target="_blank" rel="noopener">View transaction</a>' : ''));
    } else if (st === 'failed') {
      var e = job.error || {};
      var code = e.code || '';
      var friendly = {
        VOUCHER_EXPIRED: 'The voucher expired before it was sent. Get a fresh one and try again.',
        NONCE_CONSUMED: 'This voucher was already used.',
        ALREADY_CLAIMED: 'This address already claimed.',
        MINT_PAUSED: 'Minting is paused on-chain. Your voucher is still valid — try again later.',
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
      ' "claim(address,uint256,uint256,bytes)" ' +
      v.claimant + ' ' + v.nonce + ' ' + v.expiresAt + ' ' + currentVoucher.eip712_signature +
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
      var paused = stats && stats.paused;
      var line;
      if (remaining !== null && remaining !== undefined && String(remaining) === '0') {
        line = '✅ <strong>Community mint is complete.</strong> All 100 Muse Dogs are claimed.';
      } else {
        line = '🟢 <strong>Community mint is open.</strong>';
        if (remaining !== null && remaining !== undefined) line += ' ' + esc(remaining) + ' of 100 claims left.';
        if (paused) line += ' <strong>Paused right now</strong> — claims will resume when unpaused.';
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
  // Same-origin API when served together; stays silent and keeps the
  // hardcoded fallback if the API is not there.
  fetch('/api/v1/config').then(function (r) {
    if (!r.ok) throw new Error('no config');
    return r.json();
  }).then(function (cfg) {
    var phase = (cfg.phases && cfg.phases.current) || 'rules-locked';
    var labels = {
      'rules-locked': '⏳ Current phase: <strong>Coming soon</strong> — registration is not open yet.',
      'registration-open': '🟢 Current phase: <strong>Registration is open</strong> — muses register through the <a href="api.html">API</a>.',
      'snapshot': '📸 Current phase: <strong>Snapshot taken</strong> — holder list is being finalized.',
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
