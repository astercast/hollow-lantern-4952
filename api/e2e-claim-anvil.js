// End-to-end rehearsal of the sponsored-mint path on a LOCAL Anvil chain.
//   node e2e-claim-anvil.js
// Spins up anvil, deploys Muse Dogs, issues a real EIP-712 MintVoucher through
// the HTTP API, submits it through the relayer queue, and verifies the NFT
// lands on the voucher's recipient. Nothing leaves this machine; all keys are
// throwaways.
//
// Voucher shape (matches contracts/src/MuseDogs.sol exactly):
//   MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)
// Entry point: mintWithVoucher(address,uint8,uint256,uint256,bytes) = 0x7b5fa519
// Token IDs are 1-based. Nonces are per-recipient. No pause mechanism exists.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { generateKeyPairSync, createPrivateKey, sign: cryptoSign } = require('node:crypto');

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
// mintWithVoucher(address,uint8,uint256,uint256,bytes)
const MINT_SELECTOR = '0x7b5fa519';

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const WL_PATH = path.join(__dirname, 'data', 'whitelist.json');
// Throwaway Ed25519 musebook identity keys for the e2e muses, mirroring the
// real flow: the voucher endpoint demands the identity proof (challenge +
// musebook identity signature). No wallet signature, no proof of work — the
// muse pastes its Bankr address as plain text and signs with its musebook
// identity key only.
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

// Muse identity proof for the voucher endpoint: challenge + musebook
// Ed25519 identity signature. Same wall as registration — a human cannot
// produce the identity signature. No wallet signature, no proof of work.
async function getVoucher(muse_id, wallet, idemKey) {
  const ident = e2eIdentities[muse_id];
  if (!ident) throw new Error('no test identity for ' + muse_id);
  const c = await api('POST', '/api/v1/challenge', { muse_id, address: wallet.address });
  if (c.status !== 200) throw new Error('challenge failed: ' + JSON.stringify(c.json));
  const vr = await api('POST', '/api/v1/community-voucher', {
    muse_id,
    address: wallet.address,
    challenge_id: c.json.challenge_id,
    musebook_signature: identitySig(ident, c.json.message),
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

  // 2. Deploy Muse Dogs: (initialOwner, initialVoucherSigner, initialFeeSplitter).
  // Fee splitter is address(0) here — the royalty receiver gets wired later.
  const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'out', 'MuseDogs.sol', 'MuseDogs.json'), 'utf8'));
  const owner = new ethers.Wallet(RELAYER_KEY, provider);
  const voucherSignerWallet = ethers.Wallet.createRandom();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  const contract = await factory.deploy(owner.address, voucherSignerWallet.address, ethers.ZeroAddress);
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

  // Voucher helpers on the CURRENT MintVoucher shape:
  //   (address recipient, uint8 mintType, uint256 nonce, uint256 expiry)
  const randomNonce = () => BigInt('0x' + require('crypto').randomBytes(32).toString('hex')).toString(10);
  const mkVoucher = (over) => ({
    chainId: CHAIN_ID,
    contract: contractAddress,
    recipient: (over && over.recipient) || ethers.Wallet.createRandom().address,
    mintType: (over && over.mintType !== undefined) ? over.mintType : 0, // 0 = COMMUNITY
    nonce: (over && over.nonce) || randomNonce(),
    expiry: (over && over.expiry) || Math.floor(Date.now() / 1000) + 3600,
  });
  const signArgs = (v) => ({
    chainId: v.chainId, contractAddress: v.contract,
    recipient: v.recipient, mintType: v.mintType, nonce: v.nonce, expiry: v.expiry,
  });
  const signV = (v, key) => signVoucher(key || voucherSignerWallet.privateKey, signArgs(v));

  // 4. Direct relayer path: sign, preflight, submit, confirm. Token #1.
  const recipient1 = ethers.Wallet.createRandom().address;
  const v1 = mkVoucher({ recipient: recipient1, mintType: 0 });
  const sig1 = await signV(v1);
  const pre = await relayer.preflight(v1, sig1);
  if (pre.remaining !== '380') throw new Error('expected 380 remaining, got ' + pre.remaining);
  ok('preflight passes; 380 community mints remaining');
  const { hash: txHash } = await relayer.submit(v1, sig1);
  const receipt = await relayer.waitForReceipt(txHash);
  if (receipt.status !== 'confirmed' || receipt.tokenId !== '1') throw new Error('bad receipt: ' + JSON.stringify(receipt));
  if ((await contract.ownerOf(1)).toLowerCase() !== recipient1.toLowerCase()) throw new Error('ownerOf(1) mismatch');
  ok('claim confirmed on-chain: tx ' + txHash.slice(0, 18) + '…, token #1 -> recipient');

  // 5. Negative: same voucher again -> NONCE_CONSUMED.
  let code = null;
  try { await relayer.preflight(v1, sig1); } catch (e) { code = e.code; }
  if (code !== 'NONCE_CONSUMED') throw new Error('expected NONCE_CONSUMED, got ' + code);
  ok('double-spend rejected: NONCE_CONSUMED');

  // 6. Negative: expired voucher.
  const vExp = mkVoucher({ expiry: Math.floor(Date.now() / 1000) - 60 });
  const sigExp = await signV(vExp);
  code = null;
  try { await relayer.preflight(vExp, sigExp); } catch (e) { code = e.code; }
  if (code !== 'VOUCHER_EXPIRED') throw new Error('expected VOUCHER_EXPIRED, got ' + code);
  ok('expired voucher rejected: VOUCHER_EXPIRED');

  // 7. Negative: wrong signer.
  const vBad = mkVoucher();
  const sigBad = await signV(vBad, ethers.Wallet.createRandom().privateKey);
  code = null;
  try { await relayer.preflight(vBad, sigBad); } catch (e) { code = e.code; }
  if (code !== 'BAD_VOUCHER_SIGNATURE') throw new Error('expected BAD_VOUCHER_SIGNATURE, got ' + code);
  ok('wrong-signer voucher rejected: BAD_VOUCHER_SIGNATURE');

  // 8. Negative: tampered mintType invalidates the signature.
  const vFlip = mkVoucher({ mintType: 0 });
  const sigFlip = await signV(vFlip);
  vFlip.mintType = 1; // flip after signing
  code = null;
  try { await relayer.preflight(vFlip, sigFlip); } catch (e) { code = e.code; }
  if (code !== 'BAD_VOUCHER_SIGNATURE') throw new Error('expected BAD_VOUCHER_SIGNATURE on flipped mintType, got ' + code);
  ok('mintType tampering invalidates the voucher signature');

  // 9. Nonces are per-recipient: the SAME nonce works for two recipients.
  // Both vouchers preflight AND confirm on-chain (tokens #2 and #3).
  const sharedNonce = '999888777666555444333222111';
  const recipientA = ethers.Wallet.createRandom().address;
  const recipientB = ethers.Wallet.createRandom().address;
  const vA = mkVoucher({ recipient: recipientA, nonce: sharedNonce });
  const vB = mkVoucher({ recipient: recipientB, nonce: sharedNonce });
  const sigA = await signV(vA);
  const sigB = await signV(vB);
  await relayer.preflight(vA, sigA);
  await relayer.preflight(vB, sigB);
  const { hash: hA } = await relayer.submit(vA, sigA);
  const rA = await relayer.waitForReceipt(hA);
  const { hash: hB } = await relayer.submit(vB, sigB);
  const rB = await relayer.waitForReceipt(hB);
  if (rA.tokenId !== '2' || rB.tokenId !== '3') throw new Error('bad token ids: ' + rA.tokenId + ',' + rB.tokenId);
  if ((await contract.ownerOf(2)).toLowerCase() !== recipientA.toLowerCase()) throw new Error('ownerOf(2) mismatch');
  if ((await contract.ownerOf(3)).toLowerCase() !== recipientB.toLowerCase()) throw new Error('ownerOf(3) mismatch');
  ok('per-recipient nonces: same nonce minted tokens #2 and #3 to two recipients');

  // 10. HTTP layer: temp whitelist, boot the API with the relayer enabled.
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

  // 11. Issue a voucher over HTTP and verify the signature cryptographically.
  // The payload carries recipient / mintType / expiry (no claimant/expiresAt).
  const claimant2 = ethers.Wallet.createRandom();
  const { voucher, eip712_signature, claim_calldata } = await getVoucher('e2e-muse', claimant2, 'e2e-key-1');
  if (!claim_calldata || !claim_calldata.startsWith(MINT_SELECTOR)) {
    throw new Error('bad claim_calldata: ' + String(claim_calldata).slice(0, 20));
  }
  if (voucher.mintType !== 0 || voucher.recipient.toLowerCase() !== claimant2.address.toLowerCase()) {
    throw new Error('voucher payload wrong: ' + JSON.stringify(voucher));
  }
  const recovered = recoverVoucherSigner({
    chainId: voucher.chainId, contractAddress: voucher.contract,
    recipient: voucher.recipient, mintType: voucher.mintType,
    nonce: voucher.nonce, expiry: voucher.expiry,
  }, eip712_signature);
  if (recovered.toLowerCase() !== voucherSignerWallet.address.toLowerCase()) {
    throw new Error('HTTP voucher signature does not recover the on-chain signer');
  }
  ok('HTTP voucher issued; EIP-712 signature recovers the on-chain signer');

  // 12. Submit through the relayer queue over HTTP; poll to confirmed (token #4).
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
  if (job.token_id !== '4') throw new Error('expected token #4, got ' + job.token_id);
  if ((await contract.ownerOf(4)).toLowerCase() !== claimant2.address.toLowerCase()) throw new Error('ownerOf(4) mismatch');
  if (!job.explorer_url) throw new Error('missing explorer_url');
  ok('HTTP relayer claim confirmed: token #4 -> recipient, explorer link present');

  // 13. Duplicate submit of the same voucher -> same job, no second tx.
  const dup = await api('POST', '/api/v1/claim/submit', {
    voucher, eip712_signature, idempotency_key: 'e2e-claim-2',
  });
  // Duplicate (same voucher, new idempotency key): 200 replay, same job, no second tx.
  if (dup.status !== 200 || dup.json.duplicate !== true || dup.json.job_id !== jobId) {
    throw new Error('duplicate submit misbehaved: ' + JSON.stringify(dup.json));
  }
  ok('duplicate voucher submit returns the same job (no second transaction)');

  // 13b. Queue dedupe is by (recipient, nonce): the same nonce for a
  // DIFFERENT recipient is a separate job, not a duplicate — matching the
  // on-chain per-recipient nonces. Both confirm on-chain (tokens #5 and #6).
  const sharedQNonce = '112233445566778899001122';
  const recipientQA = ethers.Wallet.createRandom().address;
  const recipientQB = ethers.Wallet.createRandom().address;
  const vQA = mkVoucher({ recipient: recipientQA, nonce: sharedQNonce });
  const vQB = mkVoucher({ recipient: recipientQB, nonce: sharedQNonce });
  const sigQA = await signV(vQA);
  const sigQB = await signV(vQB);
  const sQA = await api('POST', '/api/v1/claim/submit', { voucher: vQA, eip712_signature: sigQA, idempotency_key: 'e2e-claim-q1' });
  const sQB = await api('POST', '/api/v1/claim/submit', { voucher: vQB, eip712_signature: sigQB, idempotency_key: 'e2e-claim-q2' });
  if (sQA.status !== 202 || sQB.status !== 202) throw new Error('queue submit failed: ' + JSON.stringify([sQA.json, sQB.json]));
  if (sQA.json.job_id === sQB.json.job_id) throw new Error('same nonce + different recipients collapsed into one queue job');
  if (sQA.json.duplicate === true || sQB.json.duplicate === true) throw new Error('second recipient wrongly flagged duplicate');
  const jobQA = await waitFor(async () => {
    const r = await api('GET', '/api/v1/claim/status/' + sQA.json.job_id);
    return r.json && (r.json.status === 'confirmed' || r.json.status === 'failed') ? r.json : null;
  }, 'queue job A confirmed', 60000);
  const jobQB = await waitFor(async () => {
    const r = await api('GET', '/api/v1/claim/status/' + sQB.json.job_id);
    return r.json && (r.json.status === 'confirmed' || r.json.status === 'failed') ? r.json : null;
  }, 'queue job B confirmed', 60000);
  if (jobQA.status !== 'confirmed' || jobQB.status !== 'confirmed') {
    throw new Error('queue jobs failed: ' + JSON.stringify([jobQA, jobQB]));
  }
  const qaTokens = [jobQA.token_id, jobQB.token_id].sort();
  if (qaTokens[0] !== '5' || qaTokens[1] !== '6') throw new Error('expected tokens #5 and #6, got ' + qaTokens);
  if ((await contract.ownerOf(jobQA.token_id)).toLowerCase() !== recipientQA.toLowerCase()) throw new Error('ownerOf QA mismatch');
  if ((await contract.ownerOf(jobQB.token_id)).toLowerCase() !== recipientQB.toLowerCase()) throw new Error('ownerOf QB mismatch');
  ok('queue dedupe by (recipient, nonce): same nonce, two recipients, tokens #5 and #6');

  // 14. Live counters moved: 380 -> 374 community, 100 holder untouched.
  const stats = await api('GET', '/api/v1/mint/stats');
  if (stats.json.claims_remaining !== '374') throw new Error('community counter wrong: ' + JSON.stringify(stats.json));
  if (stats.json.holder_remaining !== '100') throw new Error('holder counter wrong: ' + JSON.stringify(stats.json));
  ok('mint stats show 374 community / 100 holder remaining');

  // 15. Wrong contract: voucher bound to a different address is rejected at the edge.
  const vWC = mkVoucher();
  const sigWC = await signV(vWC);
  vWC.contract = ethers.Wallet.createRandom().address; // tamper after signing
  const rwc = await api('POST', '/api/v1/claim/submit', {
    voucher: vWC, eip712_signature: sigWC, idempotency_key: 'e2e-claim-wrong-contract',
  });
  if (rwc.status !== 400 || !rwc.json || rwc.json.error !== 'WRONG_CONTRACT') {
    throw new Error('expected 400 WRONG_CONTRACT, got ' + rwc.status + ' ' + JSON.stringify(rwc.json));
  }
  ok('voucher for a different contract rejected: WRONG_CONTRACT');

  // 16. Wrong chain: voucher for another chainId is rejected at the edge.
  const vWCh = mkVoucher();
  const sigWCh = await signV(vWCh);
  vWCh.chainId = 4663; // tamper after signing
  const rwch = await api('POST', '/api/v1/claim/submit', {
    voucher: vWCh, eip712_signature: sigWCh, idempotency_key: 'e2e-claim-wrong-chain',
  });
  if (rwch.status !== 400 || !rwch.json || rwch.json.error !== 'WRONG_CHAIN') {
    throw new Error('expected 400 WRONG_CHAIN, got ' + rwch.status + ' ' + JSON.stringify(rwch.json));
  }
  ok('voucher for the wrong chain rejected: WRONG_CHAIN');

  // 17. Per-address cap: 3 community mints to one recipient, the 4th reverts
  // on-chain (CommunityLimitExceeded). Tokens #7, #8, #9.
  const capRecipient = ethers.Wallet.createRandom().address;
  for (let i = 0; i < 3; i++) {
    const v = mkVoucher({ recipient: capRecipient, mintType: 0 });
    const tx = await contract.connect(owner).mintWithVoucher(v.recipient, 0, v.nonce, v.expiry, await signV(v));
    await tx.wait();
  }
  if ((await contract.ownerOf(9)).toLowerCase() !== capRecipient.toLowerCase()) throw new Error('ownerOf(9) mismatch');
  const vCap4 = mkVoucher({ recipient: capRecipient, mintType: 0 });
  let capReverted = false;
  try {
    await contract.connect(owner).mintWithVoucher.staticCall(vCap4.recipient, 0, vCap4.nonce, vCap4.expiry, await signV(vCap4));
  } catch { capReverted = true; }
  if (!capReverted) throw new Error('expected the 4th community mint to revert');
  ok('per-address community cap (3): tokens #7-#9 minted, 4th reverts');

  // 18. Self-submit: take the exact claim_calldata from a voucher response and
  // send it with cast, using the recipient's own key — no relayer involved.
  // Token #10.
  const claimant3 = ethers.Wallet.createRandom();
  const vSelf = await getVoucher('e2e-muse-self', claimant3, 'e2e-key-self');
  const selfCalldata = vSelf.claim_calldata;
  if (!selfCalldata || !selfCalldata.startsWith(MINT_SELECTOR)) throw new Error('bad self-submit claim_calldata');
  // The recipient pays their own gas — fund them (anvil only; deployer has the ETH).
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
  if ((await contract.ownerOf(10)).toLowerCase() !== claimant3.address.toLowerCase()) {
    throw new Error('ownerOf(10) mismatch after self-submit');
  }
  ok('self-submit via cast send: token #10 minted straight to the recipient, relayer bypassed');

  // 19. Holder path: a mintType=1 voucher emits HolderMinted and draws from
  // the 100-bucket, not the 380-bucket. Token #11.
  const holderRecipient = ethers.Wallet.createRandom().address;
  const vH = mkVoucher({ recipient: holderRecipient, mintType: 1 });
  const sigH = await signV(vH);
  const { hash: hH } = await relayer.submit(vH, sigH);
  const rH = await relayer.waitForReceipt(hH);
  if (rH.tokenId !== '11') throw new Error('expected token #11, got ' + rH.tokenId);
  if ((await contract.ownerOf(11)).toLowerCase() !== holderRecipient.toLowerCase()) throw new Error('ownerOf(11) mismatch');
  const statsH = await api('GET', '/api/v1/mint/stats');
  if (statsH.json.holder_remaining !== '99') throw new Error('holder counter wrong: ' + JSON.stringify(statsH.json));
  if (statsH.json.claims_remaining !== '370') throw new Error('community counter wrong: ' + JSON.stringify(statsH.json));
  ok('holder path: token #11 via mintType=1, holder 99 / community 370 remaining');

  // 20. Restart recovery: submit via the API, SIGKILL the server after the tx
  // is broadcast (job 'submitted') but before the receipt is confirmed, then
  // restart and verify the job settles on the SAME tx hash — no re-broadcast.
  // Token #12.
  const claimant4 = ethers.Wallet.createRandom().address;
  const vR = mkVoucher({ recipient: claimant4, mintType: 0 });
  const sigR = await signV(vR);
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
  if (jobR.token_id !== '12') throw new Error('expected token #12, got ' + jobR.token_id);
  if ((await contract.ownerOf(12)).toLowerCase() !== claimant4.toLowerCase()) {
    throw new Error('ownerOf(12) mismatch after restart recovery');
  }
  ok('restart after broadcast: job recovered on the same tx, token #12 confirmed, no re-broadcast');

  // 21. Final counters: 11 community mints (#1,#2,#3,#4,#5,#6,#7,#8,#9,#10,#12)
  // and 1 holder mint (#11) -> 369 community / 99 holder remaining.
  const statsFinal = await api('GET', '/api/v1/mint/stats');
  if (statsFinal.json.claims_remaining !== '369') {
    throw new Error('final community counter wrong: ' + JSON.stringify(statsFinal.json));
  }
  if (statsFinal.json.holder_remaining !== '99') {
    throw new Error('final holder counter wrong: ' + JSON.stringify(statsFinal.json));
  }
  ok('final mint stats: 369 community / 99 holder remaining');

  console.log('\nAll ' + n + ' E2E checks passed on local anvil.');
  restoreAll();
}

main().catch((e) => {
  console.error('E2E FAILED:', e);
  restoreAll();
  process.exit(1);
});
