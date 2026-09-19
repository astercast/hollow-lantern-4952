// End-to-end rehearsal of the sponsored-mint path on a LOCAL Anvil chain.
//   node e2e-claim-anvil.js
// Spins up anvil, deploys Muse Dogs, issues a real EIP-712 voucher through the
// HTTP API, submits it through the relayer queue, and verifies the NFT lands
// on the claimant. Nothing leaves this machine; all keys are throwaways.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { generateKeyPairSync, createPrivateKey, createHash, sign: cryptoSign } = require('node:crypto');

const { signVoucher, recoverVoucherSigner } = require('./lib/voucher');
const { Relayer } = require('./lib/relayer');
const { hash } = require('./lib/hash');

const ANVIL_PORT = 8545;
const RPC = 'http://127.0.0.1:' + ANVIL_PORT;
const CHAIN_ID = 31337;
// Foundry lives outside PATH in this environment; resolve the binaries.
const foundryBin = (name) => {
  const p = path.join(process.env.HOME || '/home/hatch', '.foundry', 'bin', name);
  return fs.existsSync(p) ? p : name;
};
const ANVIL_BIN = foundryBin('anvil');
const CAST_BIN = foundryBin('cast');
const API_PORT = 3458;
const BASE = 'http://127.0.0.1:' + API_PORT;
// Anvil's default test account #0, derived from its public test mnemonic.
// Local throwaway only — never a real key.
const RELAYER_KEY = ethers.Wallet.fromPhrase(
  'test test test test test test test test test test test junk'
).privateKey;
const SALT = 'e2e-test-salt';

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const WL_PATH = path.join(__dirname, 'data', 'whitelist.json');
// Throwaway Ed25519 musebook identity keys for the e2e muses, mirroring the
// real flow: the voucher endpoint demands the same proof bundle as
// registration (challenge + wallet signature + musebook identity signature +
// PoW), so the registry stub must know these test identities.
const REG_STUB_PATH = path.join(__dirname, 'data', 'e2e-identity-stub.json');
function makeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyB64: publicKey.export({ format: 'jwk' }).x,
    privateKey: createPrivateKey({ key: privateKey.export({ format: 'jwk' }), format: 'jwk' }),
  };
}
const e2eIdentities = { 'e2e-muse': makeIdentity(), 'e2e-muse-self': makeIdentity() };
function identitySig(ident, message) {
  return cryptoSign(null, Buffer.from(message, 'utf8'), ident.privateKey).toString('base64url');
}
// Tiny proof-of-work solver (server difficulty is 2 in tests: ~256 hashes).
function solvePow(nonce, difficulty) {
  const prefix = '0'.repeat(difficulty);
  let i = 0;
  for (;;) {
    const salt = 's' + i;
    if (createHash('sha256').update(nonce + salt).digest('hex').startsWith(prefix)) return salt;
    i++;
  }
}

// Backups + child processes live at module scope so the cleanup in
// restoreAll() runs on EVERY exit path (success, failure, hard exit).
let dbBackup = null;
let wlBackup = null;
const procs = [];
const killAll = () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
process.on('exit', killAll);

function restoreAll() {
  killAll();
  // Brief pause so killed servers can't still be writing when we restore.
  const end = Date.now() + 500;
  while (Date.now() < end) { /* busy-wait, keeps it synchronous for the exit handler */ }
  if (dbBackup) fs.writeFileSync(DB_PATH, dbBackup);
  else { try { fs.unlinkSync(DB_PATH); } catch { /* none */ } }
  if (wlBackup) fs.writeFileSync(WL_PATH, wlBackup);
  else { try { fs.unlinkSync(WL_PATH); } catch { /* none */ } }
  try { fs.unlinkSync(REG_STUB_PATH); } catch { /* temp stub */ }
}

let n = 0;
function ok(label) { n++; console.log('ok ' + n + ' - ' + label); }

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

async function waitFor(fn, label, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - start > timeoutMs) throw new Error('timeout: ' + label);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Full muse proof bundle for the voucher endpoint: challenge, wallet
// signature, musebook identity signature, proof of work. Same wall as
// registration — a human cannot produce the identity signature.
async function getVoucher(muse_id, wallet, idemKey) {
  const ident = e2eIdentities[muse_id];
  if (!ident) throw new Error('no test identity for ' + muse_id);
  const c = await api('POST', '/api/v1/challenge', { muse_id, address: wallet.address });
  if (c.status !== 200) throw new Error('challenge failed: ' + JSON.stringify(c.json));
  const salt = solvePow(c.json.nonce, c.json.proof_of_work.difficulty);
  const sig = await wallet.signMessage(c.json.message);
  const vr = await api('POST', '/api/v1/community-voucher', {
    muse_id,
    address: wallet.address,
    challenge_id: c.json.challenge_id,
    signature: sig,
    musebook_signature: identitySig(ident, c.json.message),
    pow_result: salt,
    idempotency_key: idemKey,
  });
  if (vr.status !== 200) throw new Error('voucher failed: ' + JSON.stringify(vr.json));
  return vr.json;
}

async function main() {
  // Back up anything the run will overwrite; restoreAll() puts it back on
  // EVERY exit path (see module scope above).
  dbBackup = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  wlBackup = fs.existsSync(WL_PATH) ? fs.readFileSync(WL_PATH) : null;
  try { fs.unlinkSync(DB_PATH); } catch { /* fresh */ }
  // Registry stub for the test muses (TEST_MODE reads this instead of the network).
  const regDoc = {};
  for (const [muse_id, ident] of Object.entries(e2eIdentities)) {
    regDoc[muse_id] = { muse_id, name: muse_id, public_key: ident.publicKeyB64, key_alg: 'ed25519', id_verified: true };
  }
  fs.writeFileSync(REG_STUB_PATH, JSON.stringify(regDoc));

  // 1. Start anvil. A 5s block time makes the "submitted but not confirmed"
  // window hittable for the restart-recovery case.
  const anvil = spawn(ANVIL_BIN, ['--port', String(ANVIL_PORT), '--block-time', '5', '--silent'], { stdio: 'ignore' });
  procs.push(anvil);
  const provider = new ethers.JsonRpcProvider(RPC);
  await waitFor(async () => (await provider.getNetwork()).chainId === 31337n, 'anvil up');
  ok('anvil is up on chain 31337');

  // 2. Deploy Muse Dogs.
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'out', 'MuseDog.sol', 'MuseDog.json'), 'utf8'));
  const owner = new ethers.Wallet(RELAYER_KEY, provider);
  const voucherSignerWallet = ethers.Wallet.createRandom();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const contract = await factory.deploy(owner.address, voucherSignerWallet.address, '', ethers.ZeroAddress, 0);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  ok('Muse Dogs deployed at ' + contractAddress);

  // 3. Relayer boots against the local chain and reads the on-chain signer.
  const relayer = new Relayer({
    rpcUrl: RPC,
    privateKey: RELAYER_KEY,
    contractAddress,
    chainId: CHAIN_ID,
  });
  await relayer.init();
  if (relayer.onChainVoucherSigner.toLowerCase() !== voucherSignerWallet.address.toLowerCase()) {
    throw new Error('on-chain signer mismatch');
  }
  ok('relayer initialized; on-chain voucher signer matches deploy key');

  // 4. Direct relayer path: sign, preflight, submit, confirm.
  const claimant1 = ethers.Wallet.createRandom().address;
  const mkVoucher = (over) => ({
    chainId: CHAIN_ID,
    contract: contractAddress,
    claimant: over && over.claimant ? over.claimant : claimant1,
    nonce: (over && over.nonce) || BigInt('0x' + require('crypto').randomBytes(32).toString('hex')).toString(10),
    expiresAt: (over && over.expiresAt) || Math.floor(Date.now() / 1000) + 3600,
  });
  const signArgs = (v) => ({ chainId: v.chainId, contractAddress: v.contract, claimant: v.claimant, nonce: v.nonce, expiresAt: v.expiresAt });
  const v1 = mkVoucher();
  const sig1 = await signVoucher(voucherSignerWallet.privateKey, signArgs(v1));
  const pre = await relayer.preflight(v1, sig1);
  if (pre.remaining !== '100') throw new Error('expected 100 remaining, got ' + pre.remaining);
  ok('preflight passes; 100 claims remaining');
  const { hash: txHash } = await relayer.submit(v1, sig1);
  const receipt = await relayer.waitForReceipt(txHash);
  if (receipt.status !== 'confirmed' || receipt.tokenId !== '0') throw new Error('bad receipt: ' + JSON.stringify(receipt));
  if ((await contract.ownerOf(0)).toLowerCase() !== claimant1.toLowerCase()) throw new Error('ownerOf(0) mismatch');
  ok('claim confirmed on-chain: tx ' + txHash.slice(0, 18) + '…, token #0 -> claimant');

  // 5. Negative: same voucher again -> NONCE_CONSUMED.
  let code = null;
  try { await relayer.preflight(v1, sig1); } catch (e) { code = e.code; }
  if (code !== 'NONCE_CONSUMED') throw new Error('expected NONCE_CONSUMED, got ' + code);
  ok('double-spend rejected: NONCE_CONSUMED');

  // 6. Negative: expired voucher.
  const vExp = mkVoucher({ expiresAt: Math.floor(Date.now() / 1000) - 60 });
  const sigExp = await signVoucher(voucherSignerWallet.privateKey, signArgs(vExp));
  code = null;
  try { await relayer.preflight(vExp, sigExp); } catch (e) { code = e.code; }
  if (code !== 'VOUCHER_EXPIRED') throw new Error('expected VOUCHER_EXPIRED, got ' + code);
  ok('expired voucher rejected: VOUCHER_EXPIRED');

  // 7. Negative: wrong signer.
  const vBad = mkVoucher();
  const sigBad = await signVoucher(ethers.Wallet.createRandom().privateKey, signArgs(vBad));
  code = null;
  try { await relayer.preflight(vBad, sigBad); } catch (e) { code = e.code; }
  if (code !== 'BAD_VOUCHER_SIGNATURE') throw new Error('expected BAD_VOUCHER_SIGNATURE, got ' + code);
  ok('wrong-signer voucher rejected: BAD_VOUCHER_SIGNATURE');

  // 8. HTTP layer: temp whitelist, boot the API with the relayer enabled.
  process.env.HASH_SALT = SALT;
  fs.writeFileSync(WL_PATH, JSON.stringify([
    { identity_hash: hash('e2e-muse'), approved_at: '2026-09-19', reason: 'e2e test' },
    { identity_hash: hash('e2e-muse-self'), approved_at: '2026-09-19', reason: 'e2e self-submit test' },
  ]));
  const startServer = () => spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      TEST_MODE: '1',
      HASH_SALT: SALT,
      NFT_CHAIN_ID: String(CHAIN_ID),
      CONTRACT_ADDRESS: contractAddress,
      VOUCHER_SIGNER_KEY: voucherSignerWallet.privateKey,
      MUSEBOOK_REGISTRY_STUB_FILE: REG_STUB_PATH,
      RELAYER_ENABLED: '1',
      RELAYER_RPC_URL: RPC,
      RELAYER_PRIVATE_KEY: RELAYER_KEY,
    },
    stdio: 'ignore',
  });
  let server = startServer();
  procs.push(server);
  await waitFor(async () => {
    const r = await api('GET', '/api/v1/mint/stats');
    return r.status === 200 && r.json.relayer === true ? true : null;
  }, 'api up with relayer');
  ok('API up; relayer enabled');

  // 9. Issue a voucher over HTTP and verify the signature cryptographically.
  const claimant2 = ethers.Wallet.createRandom();
  const { voucher, eip712_signature, claim_calldata } = await getVoucher('e2e-muse', claimant2, 'e2e-key-1');
  if (!claim_calldata || !claim_calldata.startsWith('0x2ada8a32')) throw new Error('bad claim_calldata');
  const recovered = recoverVoucherSigner({
    chainId: voucher.chainId, contractAddress: voucher.contract,
    claimant: voucher.claimant, nonce: voucher.nonce, expiresAt: voucher.expiresAt,
  }, eip712_signature);
  if (recovered.toLowerCase() !== voucherSignerWallet.address.toLowerCase()) {
    throw new Error('HTTP voucher signature does not recover the on-chain signer');
  }
  ok('HTTP voucher issued; EIP-712 signature recovers the on-chain signer');

  // 10. Submit through the relayer queue over HTTP; poll to confirmed.
  const sr = await api('POST', '/api/v1/claim/submit', {
    voucher, eip712_signature, idempotency_key: 'e2e-claim-1',
  });
  if (sr.status !== 202 || !sr.json.job_id) throw new Error('claim submit failed: ' + JSON.stringify(sr.json));
  const jobId = sr.json.job_id;
  const job = await waitFor(async () => {
    const r = await api('GET', '/api/v1/claim/status/' + jobId);
    return r.json && (r.json.status === 'confirmed' || r.json.status === 'failed') ? r.json : null;
  }, 'claim confirmed', 60000);
  if (job.status !== 'confirmed') throw new Error('job failed: ' + JSON.stringify(job));
  if (job.token_id !== '1') throw new Error('expected token #1, got ' + job.token_id);
  if ((await contract.ownerOf(1)).toLowerCase() !== claimant2.address.toLowerCase()) throw new Error('ownerOf(1) mismatch');
  if (!job.explorer_url) throw new Error('missing explorer_url');
  ok('HTTP relayer claim confirmed: token #1 -> claimant, explorer link present');

  // 11. Duplicate submit of the same voucher -> same job, no second tx.
  const dup = await api('POST', '/api/v1/claim/submit', {
    voucher, eip712_signature, idempotency_key: 'e2e-claim-2',
  });
  // Duplicate (same voucher, new idempotency key): 200 replay, same job, no second tx.
  if (dup.status !== 200 || dup.json.duplicate !== true || dup.json.job_id !== jobId) {
    throw new Error('duplicate submit misbehaved: ' + JSON.stringify(dup.json));
  }
  ok('duplicate voucher submit returns the same job (no second transaction)');

  // 12. Live counter moved: 100 -> 98.
  const stats = await api('GET', '/api/v1/mint/stats');
  if (stats.json.claims_remaining !== '98') throw new Error('counter wrong: ' + JSON.stringify(stats.json));
  ok('mint stats show 98 claims remaining');

  // 13. Paused mint: pause the contract; the relayer must reject with MINT_PAUSED.
  const pauseClaimant = ethers.Wallet.createRandom().address;
  const vPause = mkVoucher({ claimant: pauseClaimant });
  const sigPause = await signVoucher(voucherSignerWallet.privateKey, signArgs(vPause));
  await (await contract.pause()).wait();
  const statsPaused = await api('GET', '/api/v1/mint/stats');
  if (statsPaused.json.paused !== true) throw new Error('expected paused=true in mint stats');
  const sp = await api('POST', '/api/v1/claim/submit', {
    voucher: vPause, eip712_signature: sigPause, idempotency_key: 'e2e-claim-pause',
  });
  if (sp.status !== 202 || !sp.json.job_id) throw new Error('paused submit not accepted: ' + JSON.stringify(sp.json));
  const jobPause = await waitFor(async () => {
    const r = await api('GET', '/api/v1/claim/status/' + sp.json.job_id);
    return r.json && r.json.status === 'failed' ? r.json : null;
  }, 'paused job settles as failed', 30000);
  if (!jobPause.error || jobPause.error.code !== 'MINT_PAUSED') {
    throw new Error('expected MINT_PAUSED, got ' + JSON.stringify(jobPause));
  }
  await (await contract.unpause()).wait();
  const statsUnpaused = await api('GET', '/api/v1/mint/stats');
  if (statsUnpaused.json.paused !== false) throw new Error('expected paused=false after unpause');
  ok('paused mint: stats report paused, claim job fails cleanly with MINT_PAUSED');

  // 14. Wrong contract: voucher bound to a different address is rejected at the edge.
  const vWC = mkVoucher({ claimant: ethers.Wallet.createRandom().address });
  const sigWC = await signVoucher(voucherSignerWallet.privateKey, signArgs(vWC));
  vWC.contract = ethers.Wallet.createRandom().address; // tamper after signing
  const rwc = await api('POST', '/api/v1/claim/submit', {
    voucher: vWC, eip712_signature: sigWC, idempotency_key: 'e2e-claim-wrong-contract',
  });
  if (rwc.status !== 400 || !rwc.json || rwc.json.error !== 'WRONG_CONTRACT') {
    throw new Error('expected 400 WRONG_CONTRACT, got ' + rwc.status + ' ' + JSON.stringify(rwc.json));
  }
  ok('voucher for a different contract rejected: WRONG_CONTRACT');

  // 15. Wrong chain: voucher for another chainId is rejected at the edge.
  const vWCh = mkVoucher({ claimant: ethers.Wallet.createRandom().address });
  const sigWCh = await signVoucher(voucherSignerWallet.privateKey, signArgs(vWCh));
  vWCh.chainId = 4663; // tamper after signing
  const rwch = await api('POST', '/api/v1/claim/submit', {
    voucher: vWCh, eip712_signature: sigWCh, idempotency_key: 'e2e-claim-wrong-chain',
  });
  if (rwch.status !== 400 || !rwch.json || rwch.json.error !== 'WRONG_CHAIN') {
    throw new Error('expected 400 WRONG_CHAIN, got ' + rwch.status + ' ' + JSON.stringify(rwch.json));
  }
  ok('voucher for the wrong chain rejected: WRONG_CHAIN');

  // 16. Existing claimant: a fresh voucher for an address that already claimed
  // must fail with ALREADY_CLAIMED — one claim per address. (Signed locally:
  // the HTTP voucher endpoint correctly refuses a second voucher per address.)
  const vAgain = mkVoucher({ claimant: claimant2.address });
  const sigAgain = await signVoucher(voucherSignerWallet.privateKey, signArgs(vAgain));
  const sa = await api('POST', '/api/v1/claim/submit', {
    voucher: vAgain, eip712_signature: sigAgain, idempotency_key: 'e2e-claim-again',
  });
  if (sa.status !== 202 || !sa.json.job_id) throw new Error('re-claim submit not accepted: ' + JSON.stringify(sa.json));
  const jobAgain = await waitFor(async () => {
    const r = await api('GET', '/api/v1/claim/status/' + sa.json.job_id);
    return r.json && r.json.status === 'failed' ? r.json : null;
  }, 're-claim job settles as failed', 30000);
  if (!jobAgain.error || jobAgain.error.code !== 'ALREADY_CLAIMED') {
    throw new Error('expected ALREADY_CLAIMED, got ' + JSON.stringify(jobAgain));
  }
  ok('second claim for an already-claimed address rejected: ALREADY_CLAIMED');

  // 17. Self-submit: take the exact claim_calldata from a voucher response and
  // send it with cast, using the claimant's own key — no relayer involved.
  const claimant3 = ethers.Wallet.createRandom();
  const vSelf = await getVoucher('e2e-muse-self', claimant3, 'e2e-key-self');
  const selfCalldata = vSelf.claim_calldata;
  if (!selfCalldata || !selfCalldata.startsWith('0x2ada8a32')) throw new Error('bad self-submit claim_calldata');
  // The claimant pays their own gas — fund them (anvil only; deployer has the ETH).
  await (await owner.sendTransaction({ to: claimant3.address, value: ethers.parseEther('0.01') })).wait();
  let castOut = '';
  try {
    castOut = execFileSync(CAST_BIN, [
      'send', '--rpc-url', RPC, '--private-key', claimant3.privateKey, contractAddress, selfCalldata,
    ], { encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    throw new Error('cast send failed: ' + (e.stdout || '') + (e.stderr || '') + String(e.message).slice(0, 200));
  }
  if (!/transactionHash/i.test(castOut)) throw new Error('cast send produced no transaction: ' + castOut.slice(0, 300));
  if ((await contract.ownerOf(2)).toLowerCase() !== claimant3.address.toLowerCase()) {
    throw new Error('ownerOf(2) mismatch after self-submit');
  }
  ok('self-submit via cast send: token #2 minted straight to the claimant, relayer bypassed');

  // 18. Restart recovery: submit via the API, SIGKILL the server after the tx
  // is broadcast (job 'submitted') but before the receipt is confirmed, then
  // restart and verify the job settles on the SAME tx hash — no re-broadcast.
  const claimant4 = ethers.Wallet.createRandom().address;
  const vR = mkVoucher({ claimant: claimant4 });
  const sigR = await signVoucher(voucherSignerWallet.privateKey, signArgs(vR));
  const sr2 = await api('POST', '/api/v1/claim/submit', {
    voucher: vR, eip712_signature: sigR, idempotency_key: 'e2e-claim-restart',
  });
  if (sr2.status !== 202 || !sr2.json.job_id) throw new Error('restart submit not accepted: ' + JSON.stringify(sr2.json));
  const jobIdR = sr2.json.job_id;
  // Tight poll: catch the job in 'submitted' (broadcast done, receipt pending).
  // The 5s anvil block time keeps this window hittable. NOTE: we read db.json
  // directly here instead of GET /claim/status, because the status endpoint
  // itself re-checks receipts for 'submitted' jobs — polling it would settle
  // the job before we can kill the server.
  const dbJob = () => {
    try {
      const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      return (db.claim_jobs || []).find((j) => j.job_id === jobIdR) || null;
    } catch { return null; } // mid-write read; retry
  };
  let seenSubmitted = null;
  {
    const start = Date.now();
    while (Date.now() - start < 90000) {
      const j = dbJob();
      if (j && j.status === 'submitted' && j.tx_hash) { seenSubmitted = j; break; }
      if (j && (j.status === 'confirmed' || j.status === 'failed')) break; // window missed
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!seenSubmitted) throw new Error('could not catch the job in submitted state (window missed)');
  const txHashBefore = seenSubmitted.tx_hash;
  server.kill('SIGKILL'); // hard kill mid-flight, before confirmation is persisted
  await new Promise((r) => setTimeout(r, 1000));
  server = startServer(); // restart; claim_jobs persist in db.json
  procs.push(server);
  await waitFor(async () => {
    const r = await api('GET', '/api/v1/mint/stats');
    return r.status === 200 && r.json.relayer === true ? true : null;
  }, 'api restarted with relayer');
  // The status endpoint re-checks receipts for 'submitted' jobs, so polling it
  // drives the recovery: the job must confirm on the original tx hash.
  const jobR = await waitFor(async () => {
    const r = await api('GET', '/api/v1/claim/status/' + jobIdR);
    return r.json && (r.json.status === 'confirmed' || r.json.status === 'failed') ? r.json : null;
  }, 'job recovers after restart', 120000);
  if (jobR.status !== 'confirmed') throw new Error('restart recovery failed: ' + JSON.stringify(jobR));
  if (jobR.tx_hash !== txHashBefore) {
    throw new Error('tx hash changed across restart — double broadcast suspected: ' + jobR.tx_hash + ' vs ' + txHashBefore);
  }
  if (jobR.token_id !== '3') throw new Error('expected token #3, got ' + jobR.token_id);
  if ((await contract.ownerOf(3)).toLowerCase() !== claimant4.toLowerCase()) {
    throw new Error('ownerOf(3) mismatch after restart recovery');
  }
  ok('restart after broadcast: job recovered on the same tx, token #3 confirmed, no re-broadcast');

  // 19. Final counter: tokens #0,#1,#2,#3 minted -> 96 remaining.
  const statsFinal = await api('GET', '/api/v1/mint/stats');
  if (statsFinal.json.claims_remaining !== '96') {
    throw new Error('final counter wrong: ' + JSON.stringify(statsFinal.json));
  }
  ok('final mint stats show 96 claims remaining');

  console.log('\nAll ' + n + ' E2E checks passed on local anvil.');
  restoreAll();
}

main().catch((e) => {
  console.error('E2E FAILED:', e);
  restoreAll();
  process.exit(1);
});
