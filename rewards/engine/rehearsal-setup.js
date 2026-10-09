/* Rehearsal setup: deploys RewardsDistributor fresh on the local anvil fork,
 * funds it, and publishes epoch 1000 with a 2-leaf tree. Prints the
 * distributor address for the spellbook/bankr auto-claim rehearsal.
 * Throwaway anvil keys only. Never touches mainnet.
 * Usage: node rehearsal-setup.js   (anvil fork on 127.0.0.1:8545)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { buildTree } = require('./merkle.js');
const cfg = require('./config');

const ART = require('../out/RewardsDistributor.sol/RewardsDistributor.json');

async function waitRc(provider, tx) {
  for (let i = 0; i < 90; i++) {
    const rc = await provider.getTransactionReceipt(tx.hash).catch(() => null);
    if (rc) return rc;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no receipt for ' + tx.hash);
}

async function main() {
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const signer = await provider.getSigner(0);
  const deployer = await signer.getAddress();

  const factory = new ethers.ContractFactory(ART.abi, ART.bytecode, signer);
  const dist = await factory.deploy(cfg.TOKENS.musebook, deployer, { gasLimit: 2400000 });
  await waitRc(provider, dist.deploymentTransaction());
  const distAddr = await dist.getAddress();
  console.log('distributor: ' + distAddr);

  // 2-leaf epoch 1000: 7000 + 3000 MUSEBOOK.
  const leaves = [
    { epochId: 1000, index: 0, account: '0x1111111111111111111111111111111111111111', amount: ethers.parseEther('7000').toString() },
    { epochId: 1000, index: 1, account: '0x2222222222222222222222222222222222222222', amount: ethers.parseEther('3000').toString() },
  ];
  const { root, proofs } = buildTree(leaves);
  const total = ethers.parseEther('10000');

  // Fund from the impersonated treasury (same trick as fork-e2e).
  const treasury = cfg.TREASURY;
  await provider.send('anvil_impersonateAccount', [treasury]);
  await provider.send('anvil_setBalance', [treasury, '0x1000000000000000000']);
  const tSigner = await provider.getSigner(treasury);
  const mb = new ethers.Contract(cfg.TOKENS.musebook, ['function transfer(address,uint256) returns (bool)'], tSigner);
  await waitRc(provider, await mb.transfer(distAddr, total, { gasLimit: 200000 }));
  await provider.send('anvil_stopImpersonatingAccount', [treasury]);

  await waitRc(provider, await dist.publishRoot(1000, root, total, { gasLimit: 300000 }));
  console.log('published epoch 1000 root ' + root);

  const out = {
    epochId: 1000, distributor: distAddr, root, totalAllocated: total.toString(),
    pot: total.toString(), claimCount: 2, published: true,
    claims: leaves.map((l) => ({ ...l, proof: proofs.get(l.index), root, totalAllocated: total.toString() })),
  };
  fs.writeFileSync(path.join(__dirname, '..', 'api', 'epoch-1000.json'), JSON.stringify({ epochId: 1000, distributor: distAddr, root, totalAllocated: total.toString(), pot: total.toString(), claimCount: 2, published: true }, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'api', 'claims-1000.json'), JSON.stringify(out.claims, null, 2));
  console.log('wrote rewards/api/epoch-1000.json + claims-1000.json (rehearsal fixtures)');
}
main().catch((e) => { console.error('fatal: ' + (e && e.message || e)); process.exit(1); });
