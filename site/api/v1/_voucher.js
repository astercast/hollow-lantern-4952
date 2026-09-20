// EIP-712 mint vouchers for gasless no-connect minting.
//
// A voucher is a permission slip signed by the project's voucher key
// (MUSEDOG_VOUCHER_KEY, server-side only, never in the repo). It authorizes
// one Bankr address to mint Muse Dogs via the relayer.
//
//   MintVoucher = { recipient, mintType, nonce, expiry }
//
// mintType: 0 = COMMUNITY (max 3/address, 380 cap), 1 = HOLDER (max 3/address, 100 cap).
// The NFT contract (Robinhood Chain, 4663) recovers the signer from the
// EIP-712 signature and only mints when it matches the trusted voucher
// signer. The relayer (a funded backend EOA holding MUSEDOG_RELAYER_KEY)
// submits the mint transaction and pays gas, so the muse and the human
// never connect or sign anything on-chain.
//
// This MUST match contracts/src/MuseDogs.sol exactly:
//   typehash keccak256("MintVoucher(address recipient,uint8 mintType,uint256 nonce,uint256 expiry)")
//   domain: name "Muse Dogs", version "1", chainId 4663, verifyingContract = deployed NFT.
// A voucher signed under any other type or domain reverts with BadVoucherSignature.
//
// Uses ethers v6 (see site/package.json).

const { Wallet, TypedDataEncoder, verifyTypedData, getAddress } = require("ethers");

const VOUCHER_TYPES = {
  MintVoucher: [
    { name: "recipient", type: "address" },
    { name: "mintType", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

const MINT_TYPE = {
  COMMUNITY: 0,
  HOLDER: 1,
};

const DOMAIN_NAME = "Muse Dogs";
const DOMAIN_VERSION = "1";
const CHAIN_ID = 4663; // Robinhood Chain

// verifyingContract is the deployed NFT contract. Unknown until deploy;
// pass it in — every signer and verifier must use the same one.
function domain(verifyingContract) {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: getAddress(verifyingContract),
  };
}

function voucherKey() {
  const k = process.env.MUSEDOG_VOUCHER_KEY || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("MUSEDOG_VOUCHER_KEY is not configured");
  }
  return k;
}

function voucherSignerAddress() {
  return new Wallet(voucherKey()).address;
}

function normalizeVoucher(value) {
  const mintType = Number(value.mintType);
  if (mintType !== MINT_TYPE.COMMUNITY && mintType !== MINT_TYPE.HOLDER) {
    throw new Error("mintType must be 0 (COMMUNITY) or 1 (HOLDER)");
  }
  return {
    recipient: getAddress(value.recipient),
    mintType,
    nonce: BigInt(value.nonce),
    expiry: BigInt(value.expiry),
  };
}

// value = { recipient, mintType, nonce, expiry }
async function signVoucher(verifyingContract, value) {
  const wallet = new Wallet(voucherKey());
  return wallet.signTypedData(domain(verifyingContract), VOUCHER_TYPES, normalizeVoucher(value));
}

// Returns the recovered signer address, or null on garbage input.
function recoverVoucherSigner(verifyingContract, value, signature) {
  try {
    return verifyTypedData(domain(verifyingContract), VOUCHER_TYPES, normalizeVoucher(value), signature);
  } catch {
    return null;
  }
}

function isVoucherSignedBy(verifyingContract, trustedSigner, value, signature) {
  const recovered = recoverVoucherSigner(verifyingContract, value, signature);
  return (
    recovered !== null &&
    recovered.toLowerCase() === String(trustedSigner).toLowerCase()
  );
}

// Canonical digest of a voucher (what the contract's ecrecover runs over).
function voucherDigest(verifyingContract, value) {
  return TypedDataEncoder.hash(domain(verifyingContract), VOUCHER_TYPES, normalizeVoucher(value));
}

module.exports = {
  VOUCHER_TYPES,
  MINT_TYPE,
  CHAIN_ID,
  domain,
  voucherSignerAddress,
  signVoucher,
  recoverVoucherSigner,
  isVoucherSignedBy,
  voucherDigest,
};
