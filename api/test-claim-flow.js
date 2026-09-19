// Unit tests for the voucher + relayer claim flow. Plain node, no framework:
//   node test-claim-flow.js
// All keys are random throwaways; nothing touches a real chain.
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  signVoucher,
  recoverVoucherSigner,
  validateVoucherShape,
  isExpired,
} = require('./lib/voucher');
const { buildClaimCalldata, ClaimQueue } = require('./lib/relayer');

const CHAIN = 4663;
const CONTRACT = '0x1111111111111111111111111111111111111111';

function testKey() {
  return ethers.Wallet.createRandom().privateKey;
}

async function run() {
  let n = 0;
  const ok = (name) => { n++; console.log('ok ' + n + ' - ' + name); };

  // 1. Sign/verify round trip.
  const signerKey = testKey();
  const signerAddr = new ethers.Wallet(signerKey).address;
  const claimant = ethers.Wallet.createRandom().address;
  const voucher = {
    chainId: CHAIN,
    contract: CONTRACT,
    claimant,
    nonce: '123456789012345678901234567890',
    expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
  };
  const signArgs = {
    chainId: voucher.chainId,
    contractAddress: voucher.contract,
    claimant: voucher.claimant,
    nonce: voucher.nonce,
    expiresAt: voucher.expiresAt,
  };
  const sig = await signVoucher(signerKey, signArgs);
  const recArgs = (v) => ({
    chainId: v.chainId,
    contractAddress: v.contract,
    claimant: v.claimant,
    nonce: v.nonce,
    expiresAt: v.expiresAt,
  });
  assert.match(sig, /^0x[0-9a-fA-F]{130}$/);
  const recovered = recoverVoucherSigner(recArgs(voucher), sig);
  assert.equal(recovered.toLowerCase(), signerAddr.toLowerCase());
  ok('EIP-712 sign/verify round trip');

  // 2. Tampered claimant -> different signer (contract would reject).
  const tampered = { ...voucher, claimant: ethers.Wallet.createRandom().address };
  const recoveredTampered = recoverVoucherSigner(recArgs(tampered), sig);
  assert.notEqual(recoveredTampered.toLowerCase(), signerAddr.toLowerCase());
  ok('tampered voucher does not recover the signer');

  // 3. Wrong chain id -> different signer.
  const wrongChain = { ...voucher, chainId: 9999 };
  assert.notEqual(recoverVoucherSigner(recArgs(wrongChain), sig).toLowerCase(), signerAddr.toLowerCase());
  ok('wrong chain id does not recover the signer');

  // 4. Malformed signature throws BAD_SIGNATURE.
  assert.throws(
    () => recoverVoucherSigner(recArgs(voucher), '0x1234'),
    (e) => e.code === 'BAD_SIGNATURE',
    'expected BAD_SIGNATURE'
  );
  ok('malformed signature throws BAD_SIGNATURE');

  // 5. Shape validation (raw voucher shape uses `contract`).
  const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  validateVoucherShape(voucher, { chainId: CHAIN, contractAddress: CONTRACT });
  assert.equal(codeOf(() => validateVoucherShape({ ...voucher, claimant: 'nope' }, {})), 'BAD_VOUCHER');
  assert.equal(codeOf(() => validateVoucherShape(voucher, { chainId: 1 })), 'WRONG_CHAIN');
  assert.equal(codeOf(() => validateVoucherShape(voucher, { contractAddress: '0x2222222222222222222222222222222222222222' })), 'WRONG_CONTRACT');
  ok('voucher shape validation (bad address / wrong chain / wrong contract)');

  // 6. Expiry.
  assert.equal(isExpired(String(Math.floor(Date.now() / 1000) - 100)), true);
  assert.equal(isExpired(String(Math.floor(Date.now() / 1000) + 3600)), false);
  ok('expiry check');

  // 7. Calldata encoding: selector + round-trip decode.
  const data = buildClaimCalldata(voucher, sig);
  const expectedSelector = ethers.id('claim(address,uint256,uint256,bytes)').slice(0, 10);
  assert.equal(data.slice(0, 10), expectedSelector);
  const iface = new ethers.Interface(['function claim(address claimant, uint256 nonce, uint256 expiresAt, bytes signature)']);
  const decoded = iface.decodeFunctionData('claim', data);
  assert.equal(decoded.claimant.toLowerCase(), claimant.toLowerCase());
  assert.equal(decoded.nonce.toString(), voucher.nonce);
  assert.equal(decoded.expiresAt.toString(), voucher.expiresAt);
  assert.equal(decoded.signature.toLowerCase(), sig.toLowerCase());
  ok('claim calldata encodes/decodes (selector ' + expectedSelector + ')');

  // 8. Queue: idempotent by nonce.
  const memStore = () => {
    const arr = [];
    return {
      list: () => arr.slice(),
      upsert: (job) => {
        const i = arr.findIndex((j) => j.job_id === job.job_id);
        if (i >= 0) arr[i] = job; else arr.push(job);
      },
    };
  };
  const fakeRelayer = {
    async submit() { return { hash: '0x' + 'ab'.repeat(32) }; },
    async waitForReceipt(hash) { return { hash, status: 'confirmed', blockNumber: 42, tokenId: '7' }; },
  };
  const q = new ClaimQueue({ relayer: fakeRelayer, store: memStore() });
  const v1 = { ...voucher, nonce: '111' };
  const v2 = { ...voucher, nonce: '222' };
  const r1 = q.enqueue({ voucher: v1, signature: sig, idempotencyKey: 'k1' });
  const r1b = q.enqueue({ voucher: v1, signature: sig, idempotencyKey: 'k1' });
  assert.equal(r1b.duplicate, true);
  assert.equal(r1b.job.job_id, r1.job.job_id);
  const r2 = q.enqueue({ voucher: v2, signature: sig, idempotencyKey: 'k2' });
  assert.equal(r2.duplicate, false);
  assert.notEqual(r2.job.job_id, r1.job.job_id);
  ok('queue is idempotent by voucher nonce');

  const waitFor = async (queue, jobId, want, timeoutMs = 15000) => {
    const start = Date.now();
    for (;;) {
      const job = queue.get(jobId);
      if (want.includes(job.status)) return job;
      if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for ' + jobId + ' -> ' + want);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const done1 = await waitFor(q, r1.job.job_id, ['confirmed', 'failed']);
  assert.equal(done1.status, 'confirmed');
  assert.equal(done1.token_id, '7');
  assert.equal(done1.tx_hash, '0x' + 'ab'.repeat(32));
  ok('queue processes a job to confirmed with token id');

  // 9. Terminal validation failure: no retry, attempts stays 1.
  const failRelayer = {
    async submit() { throw { code: 'VOUCHER_EXPIRED', message: 'Voucher expired.' }; },
    async waitForReceipt() { throw new Error('should not be called'); },
  };
  const q2 = new ClaimQueue({ relayer: failRelayer, store: memStore() });
  const rf = q2.enqueue({ voucher: { ...voucher, nonce: '333' }, signature: sig, idempotencyKey: 'k3' });
  const failed = await waitFor(q2, rf.job.job_id, ['failed']);
  assert.equal(failed.attempts, 1);
  assert.equal(failed.error.code, 'VOUCHER_EXPIRED');
  ok('terminal failure fails fast without retry');

  // 10. Transient failure retries, then succeeds.
  let tries = 0;
  const flakyRelayer = {
    async submit() {
      tries++;
      if (tries === 1) throw { code: 'NETWORK_DOWN', message: 'boom' };
      return { hash: '0x' + 'cd'.repeat(32) };
    },
    async waitForReceipt(hash) { return { hash, status: 'confirmed', blockNumber: 43, tokenId: '8' }; },
  };
  const q3 = new ClaimQueue({ relayer: flakyRelayer, store: memStore() });
  const rr = q3.enqueue({ voucher: { ...voucher, nonce: '444' }, signature: sig, idempotencyKey: 'k4' });
  const retried = await waitFor(q3, rr.job.job_id, ['confirmed', 'failed'], 30000);
  assert.equal(retried.status, 'confirmed');
  assert.equal(retried.attempts, 2);
  ok('transient failure retries and confirms');

  console.log('\nAll ' + n + ' claim-flow unit tests passed.');
}

run().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
