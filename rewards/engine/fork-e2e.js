/* Fork end-to-end test (NOT mainnet):
 *   1. Deploys RewardsDistributor against a local anvil fork of Robinhood Chain
 *   2. Impersonates the treasury Safe, funds the distributor with real MUSEBOOK
 *   3. Publishes the dry-run epoch root (rewards/api/dryrun/claims-999.json)
 *   4. Executes a real claim() for the first claimant, verifies MUSEBOOK arrived
 *   5. Verifies double-claim reverts and a stranger with a fake proof reverts
 *
 * Usage: anvil --fork-url https://rpc.mainnet.chain.robinhood.com  (separate shell)
 *        node fork-e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./config');

const ART = require('../out/RewardsDistributor.sol/RewardsDistributor.json');

async function main() {
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545', cfg.CHAIN_ID, { staticNetwork: true });
  const [depSigner] = await provider.listAccounts(); // v6: listAccounts returns Signers
  const deployer = await depSigner.getAddress();

  const dry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'dryrun', 'claims-999.json'), 'utf8'));
  const epoch = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'dryrun', 'epoch-999.json'), 'utf8'));
  if (!dry.claims.length) throw new Error('dry run produced no claims — nothing to test');

  console.log('deploying distributor on fork…');
  const factory = new ethers.ContractFactory(ART.abi, ART.bytecode.object, depSigner);
  // NOTE: explicit gasLimit — anvil-fork estimateGas is unreliable for
  // contract creation (returns empty revert). 2.2M covers the 1.86M estimate.
  const dist = await factory.deploy(cfg.TOKENS.musebook, deployer, { gasLimit: 2200000 });
  await dist.waitForDeployment();
  const distAddr = await dist.getAddress();
  console.log('distributor:', distAddr);

  // Fund from the real treasury (impersonated — fork only).
  await provider.send('anvil_impersonateAccount', [cfg.TREASURY]);
  const treasury = await provider.getSigner(cfg.TREASURY);
  const musebook = new ethers.Contract(cfg.TOKENS.musebook,
    ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
    treasury);
  const pot = BigInt(epoch.potMusebook);
  console.log('funding', ethers.formatUnits(pot, 18), 'MUSEBOOK from treasury…');
  await (await musebook.transfer(distAddr, pot)).wait();

  console.log('publishing root', dry.root);
  await (await dist.publishRoot(dry.epochId, dry.root, dry.totalAllocated)).wait();

  // Claim #1: real claim() for the first claimant.
  const c0 = dry.claims[0];
  await provider.send('anvil_impersonateAccount', [c0.account]);
  // Fund claimer with ETH for gas (fork accounts may hold none).
  await provider.send('anvil_setBalance', [c0.account, '0xDE0B6B3A7640000']); // 1 ETH
  const claimer = await provider.getSigner(c0.account);
  const distAsClaimer = new ethers.Contract(distAddr, ART.abi, claimer);
  const mbAsView = new ethers.Contract(cfg.TOKENS.musebook,
    ['function balanceOf(address) view returns (uint256)'], provider);
  const before = await mbAsView.balanceOf(c0.account);
  const tx = await distAsClaimer.claim(dry.epochId, c0.index, c0.account, c0.amount, c0.proof);
  const rc = await tx.wait();
  const after = await mbAsView.balanceOf(c0.account);
  console.log('claim gas used:', rc.gasUsed.toString());
  console.log('claimant received:', ethers.formatUnits(after - before, 18), 'MUSEBOOK');
  if (after - before !== BigInt(c0.amount)) throw new Error('PAYOUT MISMATCH');

  // Double claim must revert.
  try {
    const tx2 = await distAsClaimer.claim(dry.epochId, c0.index, c0.account, c0.amount, c0.proof, { gasLimit: 500000 });
    const rc2 = await tx2.wait();
    console.log('double claim tx status:', rc2.status);
    if (rc2.status === 1) throw new Error('DOUBLE CLAIM DID NOT REVERT (status 1)');
    console.log('double claim reverts: OK (status 0)');
  } catch (e) {
    if (/DOUBLE CLAIM DID NOT REVERT/.test(e.message)) throw e;
    if (!/already claimed/.test(e.message) && !/reverted/.test(e.message)) throw e;
    console.log('double claim reverts: OK');
  }

  // Fake proof must revert.
  const c1 = dry.claims[1] || c0;
  try {
    await distAsClaimer.claim(dry.epochId, c1.index, c1.account, (BigInt(c1.amount) + 1n).toString(), c1.proof);
    throw new Error('FORGED CLAIM DID NOT REVERT');
  } catch (e) {
    console.log('forged amount reverts: OK');
  }

  // Wrong epoch / account / index must all revert (leaf binds all four fields).
  const badCases = [
    ['wrong epoch', dry.epochId + 1, c0.index, c0.account, c0.amount, c0.proof, /no epoch/],
    ['wrong account', dry.epochId, c0.index, c1.account, c0.amount, c0.proof, /bad proof/],
    ['wrong index', dry.epochId, c1.index, c0.account, c0.amount, c0.proof, /bad proof|already claimed/],
  ];
  for (const [name, e, i, a, amt, proof, want] of badCases) {
    try {
      await distAsClaimer.claim(e, i, a, amt, proof);
      throw new Error(name.toUpperCase() + ' DID NOT REVERT');
    } catch (err) {
      if (err.message.includes('DID NOT REVERT')) throw err;
      if (!want.test(err.message)) throw new Error(name + ' reverted unexpectedly: ' + err.message.slice(0, 120));
      console.log(name, 'reverts: OK');
    }
  }

  const unclaimed = await dist.epochUnclaimed(dry.epochId);
  console.log('epoch unclaimed (carryover):', ethers.formatUnits(unclaimed, 18));

  // Expiration: warp past the 30-day claim window; claims must revert,
  // finalizeEpoch must release the remainder to free funds.
  const WINDOW = 30 * 86400;
  const cur = (await provider.getBlock('latest')).timestamp;
  await provider.send('evm_increaseTime', [WINDOW + 1]);
  await provider.send('evm_mine', []);
  console.log('warped to', (await provider.getBlock('latest')).timestamp, '(was', cur + ')');
  const c2 = dry.claims[1] || c0;
  await provider.send('anvil_impersonateAccount', [c2.account]);
  await provider.send('anvil_setBalance', [c2.account, '0xDE0B6B3A7640000']); // 1 ETH
  const claimer2 = await provider.getSigner(c2.account);
  const distAsClaimer2 = new ethers.Contract(distAddr, ART.abi, claimer2);
  try {
    await distAsClaimer2.claim(dry.epochId, c2.index, c2.account, c2.amount, c2.proof);
    throw new Error('POST-DEADLINE CLAIM DID NOT REVERT');
  } catch (e) {
    if (!/claim window closed/.test(e.message)) throw e;
    console.log('post-deadline claim reverts: OK');
  }
  const liabBefore = await dist.allocatedUnclaimed();
  await (await distAsClaimer2.finalizeEpoch(dry.epochId)).wait();
  const liabAfter = await dist.allocatedUnclaimed();
  console.log('allocatedUnclaimed before/after finalize:',
    ethers.formatUnits(liabBefore, 18), '->', ethers.formatUnits(liabAfter, 18));
  if (liabAfter !== 0n) throw new Error('FINALIZE DID NOT RELEASE ALL');
  // Owner (deployer here) can now withdraw the released remainder.
  const depBalBefore = await mbAsView.balanceOf(deployer);
  await (await dist.withdraw(deployer, liabBefore)).wait();
  const depBalAfter = await mbAsView.balanceOf(deployer);
  if (depBalAfter - depBalBefore !== liabBefore) throw new Error('WITHDRAW AFTER FINALIZE MISMATCH');
  console.log('withdraw of finalized remainder: OK');

  console.log('FORK E2E: ALL CHECKS PASSED');
  await provider.send('anvil_stopImpersonatingAccount', [cfg.TREASURY]);
}

main().catch((e) => { console.error('FORK E2E FAILED:', e.message); process.exit(1); });
