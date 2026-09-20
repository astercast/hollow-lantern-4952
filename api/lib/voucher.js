// Muse Dogs — EIP-712 voucher signing and verification.
// The on-chain struct is MintVoucher(address recipient,uint8 mintType,
// uint256 nonce,uint256 expiry) with domain EIP712("Muse Dogs", "1"),
// exactly as contracts/src/MuseDogs.sol defines it. This module is the
// single source of truth for that shape: the API signs here, the relayer
// verifies here, and the frontend displays exactly these fields before
// anyone signs anything.
//
// mintType: 0 = COMMUNITY (380 cap, 3 per address),
//           1 = HOLDER (100 cap, 3 per address).
// Nonces are per-recipient on-chain (usedNonces[recipient][nonce]).
//
// The signature binds: chain id + contract address + recipient + mintType +
// nonce + expiry. A voucher stolen from one site cannot be replayed anywhere
// else, and it can never mint to a different address than `recipient`.
const { ethers } = require('ethers');

// Errors carry a machine-readable `code` (the API maps it to the response)
// and a human message. Always Error instances, never plain objects.
function verr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const VOUCHER_TYPES = {
  MintVoucher: [
    { name: 'recipient', type: 'address' },
    { name: 'mintType', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
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
    recipient: ethers.getAddress(voucher.recipient),
    mintType: Number(voucher.mintType),
    nonce: BigInt(voucher.nonce).toString(10),
    expiry: BigInt(voucher.expiry).toString(10),
  };
}

// Structural validation only — no crypto. Throws { code, message }.
function validateVoucherShape(voucher, { chainId, contractAddress } = {}) {
  if (!voucher || typeof voucher !== 'object') {
    throw verr('BAD_VOUCHER', 'Voucher must be an object.');
  }
  let recipient;
  try {
    recipient = ethers.getAddress(voucher.recipient);
  } catch {
    throw verr('BAD_VOUCHER', 'Voucher recipient is not a valid address.');
  }
  const mintType = Number(voucher.mintType);
  if (!Number.isInteger(mintType) || mintType < 0 || mintType > 1) {
    throw verr('BAD_VOUCHER', 'Voucher mintType must be 0 (COMMUNITY) or 1 (HOLDER).');
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
  let expiry;
  try {
    expiry = BigInt(voucher.expiry);
  } catch {
    throw verr('BAD_VOUCHER', 'Voucher expiry is not a uint256.');
  }
  if (expiry <= 0n || expiry >= 2n ** 256n) {
    throw verr('BAD_VOUCHER', 'Voucher expiry is out of range.');
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
  return { recipient, mintType, nonce: nonce.toString(10), expiry: expiry.toString(10) };
}

// Sign a voucher with the voucher-signer key. Returns the 0x signature.
async function signVoucher(signerPrivateKey, { chainId, contractAddress, recipient, mintType, nonce, expiry }) {
  if (!signerPrivateKey || typeof signerPrivateKey !== 'string' || !signerPrivateKey.startsWith('0x')) {
    throw verr('VOUCHER_SIGNER_UNAVAILABLE', 'Voucher signer key is not configured.');
  }
  const wallet = new ethers.Wallet(signerPrivateKey);
  const domain = domainFor(chainId, contractAddress);
  const value = voucherValue({ recipient, mintType, nonce, expiry });
  return wallet.signTypedData(domain, VOUCHER_TYPES, value);
}

// Recover the signer address for a voucher + signature. Throws on bad input.
function recoverVoucherSigner({ chainId, contractAddress, recipient, mintType, nonce, expiry }, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw verr('BAD_SIGNATURE', 'Voucher signature is malformed.');
  }
  const domain = domainFor(chainId, contractAddress);
  const value = voucherValue({ recipient, mintType, nonce, expiry });
  return ethers.verifyTypedData(domain, VOUCHER_TYPES, value, signature);
}

// True when the voucher is past expiry (with a small clock-skew buffer).
function isExpired(expiry, nowSec = Math.floor(Date.now() / 1000), skewSec = 60) {
  return BigInt(expiry) <= BigInt(nowSec - skewSec);
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
