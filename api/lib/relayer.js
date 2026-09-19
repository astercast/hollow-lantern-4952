// Muse Dogs — claim relayer.
//
// Why this exists: most muses hold their wallet in Bankr, and Bankr's API
// has no documented arbitrary contract-call endpoint. A muse with a voucher
// but no way to send claim() would be stuck. The relayer closes that gap.
//
// Trust design (this is why a relayer is safe here):
//   - claim() is permissionless and the NFT ALWAYS goes to the voucher's
//     claimant. The relayer cannot redirect, split, or steal anything.
//   - The worst the relayer can do is censor (not submit) — which is
//     visible on-chain and has a documented fallback (self-submit calldata).
//   - The relayer key holds only gas money. If it is drained, top it up;
//     no NFTs or user funds are ever at risk.
//   - One voucher per identity/address bounds griefing: at most 100 txs.
//   - The voucher signature is re-verified against the ON-CHAIN
//     voucherSigner() before every submission — the chain is the source of
//     truth, not our config.
//
// Operational design:
//   - Serial queue: one transaction at a time, explicit pending-nonce
//     management, so nonces can never gap or collide.
//   - Idempotent by voucher nonce: re-submitting the same voucher returns
//     the existing job, never a second transaction.
//   - Preflight before every submission: expiry, signature, on-chain nonce/
//     claim state, pause state, remaining claims. Doomed txs never get sent.
//   - Crash recovery: jobs stuck in queued/validating/submitted are picked
//     back up on restart; submitted ones get their receipt re-checked.
const { ethers } = require('ethers');
const {
  validateVoucherShape,
  recoverVoucherSigner,
  isExpired,
} = require('./voucher');

const CLAIM_ABI = [
  'function claim(address claimant, uint256 nonce, uint256 expiresAt, bytes signature)',
  'function voucherSigner() view returns (address)',
  'function consumedNonce(uint256) view returns (bool)',
  'function hasClaimed(address) view returns (bool)',
  'function communityClaimsRemaining() view returns (uint256)',
  'function paused() view returns (bool)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'event CommunityClaimed(address indexed claimant, uint256 indexed tokenId, uint256 nonce)',
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// All errors are Error instances with a machine-readable `code` — the API
// layer maps `code` onto the response, and `job.error` stays JSON-safe.
function verr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Pure: build the exact transaction the relayer will send.
function buildClaimCalldata(voucher, signature) {
  const iface = new ethers.Interface(CLAIM_ABI);
  return iface.encodeFunctionData('claim', [
    ethers.getAddress(voucher.claimant),
    BigInt(voucher.nonce),
    BigInt(voucher.expiresAt),
    signature,
  ]);
}

// Pure: decode a receipt's CommunityClaimed event -> tokenId (or null).
function tokenIdFromReceipt(receipt) {
  const iface = new ethers.Interface(CLAIM_ABI);
  for (const log of receipt.logs || []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === 'CommunityClaimed') {
        return parsed.args.tokenId.toString();
      }
    } catch {
      // Not our event; keep scanning.
    }
  }
  return null;
}

class Relayer {
  constructor({ rpcUrl, privateKey, contractAddress, chainId }) {
    if (!rpcUrl) throw verr('RELAYER_MISCONFIGURED', 'RELAYER_RPC_URL is not set.');
    if (!privateKey) throw verr('RELAYER_MISCONFIGURED', 'RELAYER_PRIVATE_KEY is not set.');
    this.rpcUrl = rpcUrl;
    this.privateKey = privateKey;
    this.contractAddress = ethers.getAddress(contractAddress);
    this.chainId = Number(chainId);
    this._ready = false;
  }

  async init() {
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl, this.chainId, { staticNetwork: true });
    const net = await this.provider.getNetwork();
    if (Number(net.chainId) !== this.chainId) {
      throw verr('WRONG_CHAIN', 'Relayer RPC reports chain ' + Number(net.chainId) + ', expected ' + this.chainId + '.');
    }
    const code = await this.provider.getCode(this.contractAddress);
    if (!code || code === '0x') {
      throw verr('NO_CONTRACT', 'No contract code at ' + this.contractAddress + ' on chain ' + this.chainId + '.');
    }
    this.wallet = new ethers.Wallet(this.privateKey, this.provider);
    this.contract = new ethers.Contract(this.contractAddress, CLAIM_ABI, this.provider);
    this.onChainVoucherSigner = await this.contract.voucherSigner();
    if (this.onChainVoucherSigner === ZERO_ADDRESS) {
      throw verr('NO_VOUCHER_SIGNER', 'Contract has no voucher signer set.');
    }
    this._ready = true;
    return {
      relayerAddress: this.wallet.address,
      contractAddress: this.contractAddress,
      chainId: this.chainId,
      voucherSigner: this.onChainVoucherSigner,
    };
  }

  _needReady() {
    if (!this._ready) throw verr('RELAYER_NOT_READY', 'Relayer is not initialized.');
  }

  // Full pre-submission check. Throws { code, message } on anything that
  // would make the transaction revert or be invalid. Cheap checks first.
  async preflight(voucher, signature) {
    this._needReady();
    validateVoucherShape(voucher, { chainId: this.chainId, contractAddress: this.contractAddress });
    if (isExpired(voucher.expiresAt)) {
      throw verr('VOUCHER_EXPIRED', 'Voucher expired at ' + voucher.expiresAt + '.');
    }
    let recovered;
    try {
      recovered = recoverVoucherSigner(
        {
          chainId: this.chainId,
          contractAddress: this.contractAddress,
          claimant: voucher.claimant,
          nonce: voucher.nonce,
          expiresAt: voucher.expiresAt,
        },
        signature
      );
    } catch (e) {
      throw verr(e.code || 'BAD_SIGNATURE', e.message || 'Voucher signature invalid.');
    }
    if (recovered.toLowerCase() !== this.onChainVoucherSigner.toLowerCase()) {
      throw verr('BAD_VOUCHER_SIGNATURE', "Voucher was not signed by the contract's voucher signer.");
    }
    const [consumed, claimed, paused, remaining] = await Promise.all([
      this.contract.consumedNonce(BigInt(voucher.nonce)),
      this.contract.hasClaimed(ethers.getAddress(voucher.claimant)),
      this.contract.paused(),
      this.contract.communityClaimsRemaining(),
    ]);
    if (paused) throw verr('MINT_PAUSED', 'Minting is paused on-chain.');
    if (consumed) throw verr('NONCE_CONSUMED', 'This voucher was already used.');
    if (claimed) throw verr('ALREADY_CLAIMED', 'This address already claimed.');
    if (remaining === 0n) throw verr('CLAIMS_EXHAUSTED', 'All community claims are taken.');
    return { recovered, remaining: remaining.toString() };
  }

  // Preflight + send. Returns { hash }. The receipt is tracked separately.
  async submit(voucher, signature) {
    await this.preflight(voucher, signature);
    const data = buildClaimCalldata(voucher, signature);
    const signerContract = new ethers.Contract(this.contractAddress, CLAIM_ABI, this.wallet);
    const gasEstimate = await signerContract.claim.estimateGas(
      ethers.getAddress(voucher.claimant),
      BigInt(voucher.nonce),
      BigInt(voucher.expiresAt),
      signature
    );
    const gasLimit = (gasEstimate * 120n) / 100n; // 20% buffer
    const feeData = await this.provider.getFeeData();
    const nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
    const txRequest = {
      to: this.contractAddress,
      data,
      gasLimit,
      nonce,
      chainId: this.chainId,
    };
    if (feeData.maxFeePerGas) {
      txRequest.maxFeePerGas = feeData.maxFeePerGas;
      txRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 0n;
    } else if (feeData.gasPrice) {
      txRequest.gasPrice = feeData.gasPrice;
    }
    const tx = await this.wallet.sendTransaction(txRequest);
    return { hash: tx.hash };
  }

  // Wait for a receipt and extract the minted token id. Throws on revert.
  async waitForReceipt(hash, timeoutMs = 120000) {
    this._needReady();
    const receipt = await this.provider.waitForTransaction(hash, 1, timeoutMs);
    if (!receipt) throw verr('RECEIPT_TIMEOUT', 'No receipt within timeout for ' + hash + '.');
    if (receipt.status !== 1) throw verr('TX_REVERTED', 'Claim transaction reverted: ' + hash + '.');
    return {
      hash,
      status: 'confirmed',
      blockNumber: Number(receipt.blockNumber),
      tokenId: tokenIdFromReceipt(receipt),
    };
  }
}

// --- Serial claim queue ----------------------------------------------------
// One job per voucher nonce. Jobs move:
//   queued -> validating -> submitted -> confirmed | failed
// Only network-level failures retry (3 attempts, backoff); validation
// failures (bad sig, expired, already claimed) fail immediately.

const MAX_ATTEMPTS = 3;

class ClaimQueue {
  constructor({ relayer, store }) {
    this.relayer = relayer;   // Relayer instance (may be null if disabled)
    this.store = store;       // { list(), upsert(job) } — persistence
    this.running = false;
    this._pumpScheduled = false;
  }

  list() {
    return this.store.list();
  }

  get(jobId) {
    return this.store.list().find((j) => j.job_id === jobId) || null;
  }

  byNonce(nonce) {
    const n = BigInt(nonce).toString(10);
    return this.store.list().find((j) => BigInt(j.voucher.nonce).toString(10) === n) || null;
  }

  enqueue({ voucher, signature, idempotencyKey }) {
    if (!this.relayer) {
      throw verr('RELAYER_DISABLED', 'The claim relayer is not enabled.');
    }
    const existing = this.byNonce(voucher.nonce);
    if (existing) return { job: existing, duplicate: true };
    const now = new Date().toISOString();
    const job = {
      job_id: 'claim_' + BigInt(voucher.nonce).toString(16).slice(0, 12) + '_' + Date.now().toString(36),
      voucher: {
        chainId: Number(voucher.chainId),
        contract: ethers.getAddress(voucher.contract),
        claimant: ethers.getAddress(voucher.claimant),
        nonce: BigInt(voucher.nonce).toString(10),
        expiresAt: BigInt(voucher.expiresAt).toString(10),
      },
      signature,
      idempotency_key: idempotencyKey || null,
      status: 'queued',
      attempts: 0,
      tx_hash: null,
      token_id: null,
      block_number: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.store.upsert(job);
    this._schedule();
    return { job, duplicate: false };
  }

  // Crash recovery: requeue anything that never reached a terminal state.
  // 'submitted' jobs get their receipt re-checked instead of re-sent.
  recover() {
    let recovered = 0;
    for (const job of this.store.list()) {
      if (['queued', 'validating'].includes(job.status)) {
        job.status = 'queued';
        job.updated_at = new Date().toISOString();
        this.store.upsert(job);
        recovered++;
      }
    }
    if (recovered > 0) this._schedule();
    return recovered;
  }

  // Public: re-check the receipt for a job stuck in 'submitted'.
  // Called on status polls so a job never sits unknown forever.
  async checkSubmitted(jobId) {
    const job = this.get(jobId);
    if (job && job.status === 'submitted' && job.tx_hash) {
      await this._settleSubmitted(job);
    }
    return this.get(jobId);
  }

  _schedule() {
    if (this.running || this._pumpScheduled) return;
    this._pumpScheduled = true;
    setImmediate(() => {
      this._pumpScheduled = false;
      this._pump().catch((e) => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), relayer_queue_error: String(e && e.message || e) }));
      });
    });
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.store.list().find((j) => j.status === 'queued');
        if (!next) break;
        await this._process(next);
      }
      // Re-check receipts for jobs stuck in 'submitted' (e.g. after a restart).
      for (const job of this.store.list().filter((j) => j.status === 'submitted' && j.tx_hash)) {
        await this._settleSubmitted(job);
      }
    } finally {
      this.running = false;
    }
  }

  _update(job, patch) {
    Object.assign(job, patch, { updated_at: new Date().toISOString() });
    this.store.upsert(job);
  }

  _fail(job, code, message) {
    this._update(job, { status: 'failed', error: { code, message } });
  }

  async _process(job) {
    this._update(job, { status: 'validating' });
    job.attempts += 1;
    try {
      const { hash } = await this.relayer.submit(job.voucher, job.signature);
      this._update(job, { status: 'submitted', tx_hash: hash, error: null });
      await this._settleSubmitted(job);
    } catch (e) {
      const code = e.code || 'SUBMIT_FAILED';
      const message = e.message || 'Submission failed.';
      // Validation failures are terminal — retrying cannot fix them.
      const terminal = [
        'BAD_VOUCHER', 'WRONG_CHAIN', 'WRONG_CONTRACT', 'BAD_SIGNATURE',
        'BAD_VOUCHER_SIGNATURE', 'VOUCHER_EXPIRED', 'NONCE_CONSUMED',
        'ALREADY_CLAIMED', 'MINT_PAUSED', 'CLAIMS_EXHAUSTED',
      ].includes(code);
      if (!terminal && job.attempts < MAX_ATTEMPTS) {
        const backoffMs = 2000 * job.attempts;
        this._update(job, { status: 'queued', error: { code, message, retry_in_ms: backoffMs } });
        await new Promise((r) => setTimeout(r, backoffMs));
        this._schedule();
      } else {
        this._fail(job, code, message);
      }
    }
  }

  async _settleSubmitted(job) {
    try {
      const receipt = await this.relayer.waitForReceipt(job.tx_hash);
      this._update(job, {
        status: 'confirmed',
        token_id: receipt.tokenId,
        block_number: receipt.blockNumber,
        error: null,
      });
    } catch (e) {
      const code = e.code || 'RECEIPT_FAILED';
      if (code === 'RECEIPT_TIMEOUT') {
        // Still unknown — leave as submitted; the next recover() pass or a
        // status poll will retry the receipt check.
        this._update(job, { error: { code, message: e.message } });
      } else {
        this._fail(job, code, e.message || 'Receipt check failed.');
      }
    }
  }
}

module.exports = { Relayer, ClaimQueue, buildClaimCalldata, tokenIdFromReceipt, CLAIM_ABI };
