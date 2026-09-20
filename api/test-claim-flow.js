// Unit tests for the voucher + relayer claim flow. Plain node, no framework:
//   node test-claim-flow.js
// All keys are random throwaways; nothing touches a real chain.
//
// Voucher shape matches contracts/src/MuseDogs.sol:
//   MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)
//   mintWithVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry,bytes signature)
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  signVoucher,
  recoverVoucherSigner,
  validateVoucherShape,
  isExpired,
} = require('./lib/voucher');
const { buildClaimCalldata, tokenIdFromReceipt, ClaimQueue } = require('./lib/relayer');

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
  const recipient = ethers.Wallet.createRandom().address;
  const voucher = {
    chainId: CHAIN,
    contract: CONTRACT,
    recipient,
    mintType: 0,
    nonce: '123456789012345678901234567890',
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
  };
  const signArgs = {
    chainId: voucher.chainId,
    contractAddress: voucher.contract,
    recipient: voucher.recipient,
    mintType: voucher.mintType,
    nonce: voucher.nonce,
    expiry: voucher.expiry,
  };
  const sig = await signVoucher(signerKey, signArgs);
  const recArgs = (v) => ({
    chainId: v.chainId,
    contractAddress: v.contract,
    recipient: v.recipient,
    mintType: v.mintType,
    nonce: v.nonce,
    expiry: v.expiry,
  });
  assert.match(sig, /^0x[0-9a-fA-F]{130}$/);
  const recovered = recoverVoucherSigner(recArgs(voucher), sig);
  assert.equal(recovered.toLowerCase(), signerAddr.toLowerCase());
  ok('EIP-712 sign/verify round trip');

  // 1b. Independent EIP-712 digest/signature cross-check that never touches
  // voucher.js: rebuild the domain + types + value by hand, hash with
  // TypedDataEncoder, recover with recoverAddress. Must land on the signer.
  {
    const domain = {
      name: 'Muse Dogs',
      version: '1',
      chainId: Number(voucher.chainId),
      verifyingContract: ethers.getAddress(voucher.contract),
    };
    const types = {
      MintVoucher: [
        { name: 'recipient', type: 'address' },
        { name: 'mintType', type: 'uint8' },
        { name: 'nonce', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
      ],
    };
    const value = {
      recipient: ethers.getAddress(voucher.recipient),
      mintType: Number(voucher.mintType),
      nonce: BigInt(voucher.nonce).toString(10),
      expiry: BigInt(voucher.expiry).toString(10),
    };
    const digest = ethers.TypedDataEncoder.hash(domain, types, value);
    const indep = ethers.recoverAddress(digest, sig);
    assert.equal(indep.toLowerCase(), signerAddr.toLowerCase());
  }
  ok('EIP-712 digest/signature verified by independent path');

  // 2. Tampered recipient -> different signer (contract would reject).
  const tampered = { ...voucher, recipient: ethers.Wallet.createRandom().address };
  const recoveredTampered = recoverVoucherSigner(recArgs(tampered), sig);
  assert.notEqual(recoveredTampered.toLowerCase(), signerAddr.toLowerCase());
  ok('tampered voucher does not recover the signer');

  // 3. Wrong chain id -> different signer.
  const wrongChain = { ...voucher, chainId: 9999 };
  assert.notEqual(recoverVoucherSigner(recArgs(wrongChain), sig).toLowerCase(), signerAddr.toLowerCase());
  ok('wrong chain id does not recover the signer');

  // 4. Tampered mintType -> different signer.
  const wrongType = { ...voucher, mintType: 1 };
  assert.notEqual(recoverVoucherSigner(recArgs(wrongType), sig).toLowerCase(), signerAddr.toLowerCase());
  ok('wrong mintType does not recover the signer');

  // 5. Malformed signature throws BAD_SIGNATURE.
  assert.throws(
    () => recoverVoucherSigner(recArgs(voucher), '0x1234'),
    (e) => e.code === 'BAD_SIGNATURE',
    'expected BAD_SIGNATURE'
  );
  ok('malformed signature throws BAD_SIGNATURE');

  // 6. Shape validation (raw voucher shape uses `contract`).
  const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  validateVoucherShape(voucher, { chainId: CHAIN, contractAddress: CONTRACT });
  assert.equal(codeOf(() => validateVoucherShape({ ...voucher, recipient: 'nope' }, {})), 'BAD_VOUCHER');
  assert.equal(codeOf(() => validateVoucherShape({ ...voucher, mintType: 2 }, {})), 'BAD_VOUCHER');
  assert.equal(codeOf(() => validateVoucherShape(voucher, { chainId: 1 })), 'WRONG_CHAIN');
  assert.equal(codeOf(() => validateVoucherShape(voucher, { contractAddress: '0x2222222222222222222222222222222222222222' })), 'WRONG_CONTRACT');
  ok('voucher shape validation (bad address / bad mintType / wrong chain / wrong contract)');

  // 7. Expiry.
  assert.equal(isExpired(String(Math.floor(Date.now() / 1000) - 100)), true);
  assert.equal(isExpired(String(Math.floor(Date.now() / 1000) + 3600)), false);
  ok('expiry check');

  // 8. Calldata encoding: selector + round-trip decode.
  const data = buildClaimCalldata(voucher, sig);
  const expectedSelector = ethers.id('mintWithVoucher(address,uint8,uint256,uint256,bytes)').slice(0, 10);
  assert.equal(data.slice(0, 10), expectedSelector);
  const iface = new ethers.Interface(['function mintWithVoucher(address recipient, uint8 mintType, uint256 nonce, uint256 expiry, bytes signature)']);
  const decoded = iface.decodeFunctionData('mintWithVoucher', data);
  assert.equal(decoded.recipient.toLowerCase(), recipient.toLowerCase());
  assert.equal(decoded.mintType.toString(), '0');
  assert.equal(decoded.nonce.toString(), voucher.nonce);
  assert.equal(decoded.expiry.toString(), voucher.expiry);
  assert.equal(decoded.signature.toLowerCase(), sig.toLowerCase());
  ok('mintWithVoucher calldata encodes/decodes (selector ' + expectedSelector + ')');

  // 9. tokenIdFromReceipt parses CommunityMinted / HolderMinted.
  const mintIface = new ethers.Interface([
    'event CommunityMinted(address indexed recipient, uint256 indexed tokenId, uint256 nonce, uint256 expiry)',
  ]);
  const fakeLog = mintIface.encodeEventLog(
    mintIface.getEvent('CommunityMinted'),
    [recipient, 42n, 7n, 9999999999n]
  );
  assert.equal(tokenIdFromReceipt({ logs: [fakeLog] }), '42');
  assert.equal(tokenIdFromReceipt({ logs: [] }), null);
  ok('tokenIdFromReceipt parses CommunityMinted');

  // 10. Queue: idempotent by (recipient, nonce).
  // On-chain nonces are per-recipient (usedNonces(recipient, nonce)), so a
  // re-submitted voucher with the SAME recipient+nonce is one job, while the
  // same nonce for a DIFFERENT recipient is a separate job.
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
  // Same nonce, different recipient => separate job (NOT a duplicate).
  const otherRecipient = ethers.Wallet.createRandom().address;
  const r3 = q.enqueue({ voucher: { ...voucher, recipient: otherRecipient, nonce: '111' }, signature: sig, idempotencyKey: 'k3' });
  assert.equal(r3.duplicate, false);
  assert.notEqual(r3.job.job_id, r1.job.job_id);
  // Same recipient, same nonce, different idempotency key => still duplicate.
  const r1c = q.enqueue({ voucher: v1, signature: sig, idempotencyKey: 'k-other' });
  assert.equal(r1c.duplicate, true);
  assert.equal(r1c.job.job_id, r1.job.job_id);
  // byRecipientNonce: finds the job for (recipient, nonce), null otherwise.
  assert.equal(q.byRecipientNonce(recipient, '111').job_id, r1.job.job_id);
  assert.equal(q.byRecipientNonce(otherRecipient, '111').job_id, r3.job.job_id);
  assert.equal(q.byRecipientNonce(recipient, '999'), null);
  ok('queue is idempotent by (recipient, nonce), not nonce alone');

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

  // 11. Terminal validation failure: no retry, attempts stays 1.
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

  // 12. Transient failure retries, then succeeds.
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
