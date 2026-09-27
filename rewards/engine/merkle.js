/* Merkle tree builder for the rewards claim flow.
 *
 * MUST match contracts/RewardsDistributor.sol exactly:
 *   leaf  = keccak256(abi.encode(epochId, index, account, amount)) double-hashed:
 *           keccak256(bytes.concat(inner))
 *   parent = sortedPairHash(left, right): the smaller bytes32 first
 *   odd layer: last node promoted unchanged
 *
 * Cross-checked by forge test RewardsDistributor.t.sol (testJSEngineFixture),
 * which verifies JS-generated roots + proofs against the on-chain verifier.
 */
'use strict';

const { ethers } = require('ethers');

function leafHash(epochId, index, account, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'address', 'uint256'],
      [BigInt(epochId), BigInt(index), ethers.getAddress(account), BigInt(amount)]
    )
  );
  return ethers.keccak256(ethers.concat([inner]));
}

function pairHash(a, b) {
  const ba = BigInt(a), bb = BigInt(b);
  const [x, y] = ba <= bb ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([x, y]));
}

/* leaves: [{index, account, amount}] -> {root, layers, proofs: Map(index -> proof[])} */
function buildTree(leaves) {
  if (!leaves.length) throw new Error('no leaves');
  let layer = leaves.map((l) => leafHash(l.epochId, l.index, l.account, l.amount));
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 < layer.length ? pairHash(layer[i], layer[i + 1]) : layer[i]);
    }
    layers.push(next);
    layer = next;
  }
  const proofs = new Map();
  leaves.forEach((l, i) => {
    const proof = [];
    let idx = i;
    for (let d = 0; d < layers.length - 1; d++) {
      const lyr = layers[d];
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sib < lyr.length) proof.push(lyr[sib]);
      idx = Math.floor(idx / 2);
    }
    proofs.set(l.index, proof);
  });
  return { root: layers[layers.length - 1][0], proofs };
}

module.exports = { leafHash, pairHash, buildTree };
