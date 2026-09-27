/* Generates test/fixture-tree.json for the forge cross-check test.
 * Uses the REAL engine merkle builder over odd-sized, unsorted input. */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildTree } = require('./merkle');

const epochId = 7;
const accounts = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444',
  '0x5555555555555555555555555555555555555555',
];
const leaves = accounts.map((account, i) => ({
  epochId,
  index: i,
  account,
  // unsorted, odd count (5), varied amounts — exercises sorting + promotion
  amount: (BigInt(100 + i * 37) * 10n ** 18n).toString(),
}));

const { root, proofs } = buildTree(leaves);
const claims = leaves.map((l) => ({ ...l, proof: proofs.get(l.index) }));
const totalAllocated = leaves.reduce((a, l) => a + BigInt(l.amount), 0n);

fs.writeFileSync(
  path.join(__dirname, '..', 'test', 'fixture-tree.json'),
  JSON.stringify({ epochId, root, totalAllocated: totalAllocated.toString(), claims }, null, 2)
);
console.log('root:', root, '| leaves:', leaves.length);
