// Strict request-body validation: rejects unknown fields instead of ignoring them.
const { ethers } = require('ethers');

// allowedFields: list of field names permitted in the JSON body.
function strictBody(body, allowedFields) {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw { code: 'INVALID_BODY', message: 'Request body must be a JSON object.' };
  }
  const unknown = Object.keys(body).filter((k) => !allowedFields.includes(k));
  if (unknown.length > 0) {
    throw { code: 'UNKNOWN_FIELDS', message: 'Unknown fields: ' + unknown.join(', ') };
  }
}

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw { code: 'MISSING_FIELD', message: 'Missing required field: ' + f };
    }
  }
}

// Returns the EIP-55 checksummed address, or throws INVALID_ADDRESS.
function checksumAddress(input) {
  try {
    return ethers.getAddress(String(input).trim());
  } catch {
    throw { code: 'INVALID_ADDRESS', message: 'Not a valid 0x address.' };
  }
}

// 0x-prefixed 130-hex-char ECDSA signature shape check (full cryptographic
// verification happens with ethers.verifyMessage in the register handler).
function looksLikeSignature(sig) {
  return typeof sig === 'string' && /^0x[0-9a-fA-F]{130}$/.test(sig);
}

// Base64url-encoded raw 64-byte Ed25519 signature (musebook identity key).
// The signature is checked cryptographically in the register handler; this
// shape check runs first so malformed input fails fast.
function looksLikeIdentitySignature(sig) {
  if (typeof sig !== 'string' || sig.length === 0 || sig.length > 128) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return false;
  try {
    const buf = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return buf.length === 64;
  } catch {
    return false;
  }
}

module.exports = { strictBody, requireFields, checksumAddress, looksLikeSignature, looksLikeIdentitySignature };
