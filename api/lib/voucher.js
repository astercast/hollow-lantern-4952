// Muse Dogs — EIP-712 voucher signing and verification.
// The on-chain struct is ClaimVoucher(address claimant,uint256 nonce,uint256 expiresAt)
// with domain EIP712("Muse Dogs", "1"). This module is the single source of
// truth for that shape: the API signs here, the relayer verifies here, and
// the frontend displays exactly these fields before anyone signs anything.
//
// The signature binds: chain id + contract address + claimant + nonce +
// expiry. A voucher stolen from one site cannot be replayed anywhere else.
const { ethers } = require('ethers');

// Errors carry a machine-readable `code` (the API maps it to the response)
// and a human message. Always Error instances, never plain objects.
function verr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const VOUCHER_TYPES = {
  ClaimVoucher: [
    { name: 'claimant', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
};

function domainFor(chainId, contractAddress) {
  return {
    name: 'Muse Dogs',
    version: '1',
    chainId: Number(chainId),
    verifyingContract: ethers.getAddress(contractAddress),
  };
}

// Canonical voucher value: exactly what goes into the typed-data signature.
function voucherValue(voucher) {
  return {
    claimant: ethers.getAddress(voucher.claimant),
    nonce: BigInt(voucher.nonce).toString(10),
    expiresAt: BigInt(voucher.expiresAt).toString(10),
  };
}

// Structural validation only — no crypto. Throws { code, message }.
function validateVoucherShape(voucher, { chainId, contractAddress } = {}) {
  if (!voucher || typeof voucher !== 'object') {
    throw verr('BAD_VOUCHER', 'Voucher must be an object.');
  }
  let claimant;
  try {
    claimant = ethers.getAddress(voucher.claimant);
  } catch {
    throw verr('BAD_VOUCHER', 'Voucher claimant is not a valid address.');
  }
  let nonce;
  try {
    nonce = BigInt(voucher.nonce);
  } catch {
    throw verr('BAD_VOUCHER', 'Voucher nonce is not a uint256.');
  }
  if (nonce < 0n || nonce >= 2n ** 256n) {
    throw verr('BAD_VOUCHER', 'Voucher nonce is out of uint256 range.');
  }
  let expiresAt;
  try {
    expiresAt = BigInt(voucher.expiresAt);
  } catch {
    throw verr('BAD_VOUCHER', 'Voucher expiresAt is not a uint256.');
  }
  if (expiresAt <= 0n || expiresAt >= 2n ** 256n) {
    throw verr('BAD_VOUCHER', 'Voucher expiresAt is out of range.');
  }
  if (chainId !== undefined && Number(voucher.chainId) !== Number(chainId)) {
    throw verr('WRONG_CHAIN', 'Voucher is for chain ' + voucher.chainId + ', expected ' + chainId + '.');
  }
  if (contractAddress !== undefined) {
    let vc;
    try {
      vc = ethers.getAddress(voucher.contract);
    } catch {
      throw verr('BAD_VOUCHER', 'Voucher contract is not a valid address.');
    }
    if (vc !== ethers.getAddress(contractAddress)) {
      throw verr('WRONG_CONTRACT', 'Voucher is for a different contract.');
    }
  }
  return { claimant, nonce: nonce.toString(10), expiresAt: expiresAt.toString(10) };
}

// Sign a voucher with the voucher-signer key. Returns the 0x signature.
async function signVoucher(signerPrivateKey, { chainId, contractAddress, claimant, nonce, expiresAt }) {
  if (!signerPrivateKey || typeof signerPrivateKey !== 'string' || !signerPrivateKey.startsWith('0x')) {
    throw verr('VOUCHER_SIGNER_UNAVAILABLE', 'Voucher signer key is not configured.');
  }
  const wallet = new ethers.Wallet(signerPrivateKey);
  const domain = domainFor(chainId, contractAddress);
  const value = voucherValue({ claimant, nonce, expiresAt });
  return wallet.signTypedData(domain, VOUCHER_TYPES, value);
}

// Recover the signer address for a voucher + signature. Throws on bad input.
function recoverVoucherSigner({ chainId, contractAddress, claimant, nonce, expiresAt }, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw verr('BAD_SIGNATURE', 'Voucher signature is malformed.');
  }
  const domain = domainFor(chainId, contractAddress);
  const value = voucherValue({ claimant, nonce, expiresAt });
  return ethers.verifyTypedData(domain, VOUCHER_TYPES, value, signature);
}

// True when the voucher is past expiry (with a small clock-skew buffer).
function isExpired(expiresAt, nowSec = Math.floor(Date.now() / 1000), skewSec = 60) {
  return BigInt(expiresAt) <= BigInt(nowSec - skewSec);
}

module.exports = {
  VOUCHER_TYPES,
  domainFor,
  voucherValue,
  validateVoucherShape,
  signVoucher,
  recoverVoucherSigner,
  isExpired,
};
