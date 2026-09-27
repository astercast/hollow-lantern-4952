/* Fork end-to-end test (NOT mainnet):
 *   1. Deploys RewardsDistributor against a local anvil fork of Robinhood Chain
 *   2. Impersonates the treasury Safe, funds the distributor with real MUSEBOOK
 *   3. Publishes the dry-run epoch root (rewards/api/dryrun/claims-999.json)
 *   4. Verifies vesting: day-0 claim reverts, day-1 claim pays 1/7,
 *      day-7 claim pays the piled-up remainder (6/7), then fully-claimed reverts
 *   5. Verifies a stranger with a fake proof reverts
 *   6. Verifies expiry: post-deadline claims revert, finalizeEpoch releases
 *      the remainder, owner can withdraw it
 *
 * Time travel uses evm_setNextBlockTimestamp with ABSOLUTE timestamps
 * (evm_increaseTime is wall-clock-relative and gets swallowed when the fork
 * head runs ahead of the clock). Receipts are polled directly by hash —
 * ethers v6 tx.wait() can deadlock on block polling under anvil automine.
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
const DAY = 86400;

// Poll a receipt directly by hash (never relies on block-gated wait()).
// Transient fork-RPC transport errors are swallowed and retried.
async function waitRc(provider, tx, tries = 90) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const rc = await provider.getTransactionReceipt(tx.hash);
      if (rc) return rc;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no receipt for ' + tx.hash + (lastErr ? ' (last poll error: ' + String(lastErr).slice(0, 100) + ')' : ''));
}

// Retry an anvil control-plane send (impersonate/setBalance/evm_*).
// The public RPC behind the fork flakes with transport errors ("could not
// coalesce", too_many_data_frames); these are safe to retry.
async function sendRetry(provider, method, params, tries = 8) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await provider.send(method, params);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error('FORK E2E FAILED: ' + method + ' failed after retries: ' + String(lastErr).slice(0, 200));
}

// Warp forward N days: mines a block exactly at latest + N days.
async function warpDays(provider, n) {
  const cur = (await provider.getBlock('latest')).timestamp;
  const target = cur + n * DAY;
  await sendRetry(provider, 'evm_setNextBlockTimestamp', [target]);
  await sendRetry(provider, 'evm_mine', []); // materialize — latest block now carries `target`
  return { from: cur, to: target };
}

// Expect a claim-shaped call to revert with a reason matching `want`.
async function expectClaimRevert(contract, args, want, label) {
  try {
    await contract.claim.staticCall(...args, { gasLimit: 500000 });
  } catch (e) {
    if (!want.test(e.message)) throw new Error(label + ' reverted unexpectedly: ' + e.message.slice(0, 160));
    console.log(label, 'reverts: OK');
    return;
  }
  throw new Error(label.toUpperCase() + ' DID NOT REVERT');
}

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
  // contract creation (returns empty revert). 2.2M covers the ~1.9M estimate.
  const dist = await factory.deploy(cfg.TOKENS.musebook, deployer, { gasLimit: 2400000 });
  await waitRc(provider, dist.deploymentTransaction());
  const distAddr = await dist.getAddress();
  console.log('distributor:', distAddr);

  // Fund from the real treasury (impersonated — fork only).
  await sendRetry(provider, 'anvil_impersonateAccount', [cfg.TREASURY]);
  const treasury = await provider.getSigner(cfg.TREASURY);
  const musebook = new ethers.Contract(cfg.TOKENS.musebook,
    ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
    treasury);
  const pot = BigInt(epoch.potMusebook);
  console.log('funding', ethers.formatUnits(pot, 18), 'MUSEBOOK from treasury…');
  await waitRc(provider, await musebook.transfer(distAddr, pot));

  console.log('publishing root', dry.root);
  const pubTx = await dist.publishRoot(dry.epochId, dry.root, dry.totalAllocated);
  await waitRc(provider, pubTx);
  const pubTime = (await provider.getBlock('latest')).timestamp;
  console.log('published at', pubTime);

  // ---- vesting checks ----
  const c0 = dry.claims[0];
  await sendRetry(provider, 'anvil_impersonateAccount', [c0.account]);
  // Fund claimer with ETH for gas (fork accounts may hold none).
  await sendRetry(provider, 'anvil_setBalance', [c0.account, '0xDE0B6B3A7640000']); // 1 ETH
  const claimer = await provider.getSigner(c0.account);
  const distAsClaimer = new ethers.Contract(distAddr, ART.abi, claimer);
  const mbAsView = new ethers.Contract(cfg.TOKENS.musebook,
    ['function balanceOf(address) view returns (uint256)'], provider);
  const before = await mbAsView.balanceOf(c0.account);

  // Day 0: nothing unlocked yet.
  await expectClaimRevert(distAsClaimer,
    [dry.epochId, c0.index, c0.account, c0.amount, c0.proof], /nothing vested yet/, 'day-zero claim');

  // Day 1: exactly 1/7 unlocks.
  await warpDays(provider, 1);
  const rc1 = await waitRc(provider,
    await distAsClaimer.claim(dry.epochId, c0.index, c0.account, c0.amount, c0.proof, { gasLimit: 300000 }));
  if (rc1.status !== 1) throw new Error('DAY-1 CLAIM TX REVERTED ON CHAIN');
  const after = await mbAsView.balanceOf(c0.account);
  console.log('day-1 claim gas used:', rc1.gasUsed.toString());
  const expectDay1 = BigInt(c0.amount) / 7n;
  if (after - before !== expectDay1)
    throw new Error('DAY-1 PAYOUT MISMATCH: got ' + (after - before).toString() + ', want ' + expectDay1.toString());
  console.log('day-1 payout = 1/7: OK', '(' + ethers.formatUnits(after - before, 18) + ' MUSEBOOK)');

  // Skip days 2-6 without claiming: day-7 claim pays the piled-up remainder.
  await warpDays(provider, 6);
  const rc7 = await waitRc(provider,
    await distAsClaimer.claim(dry.epochId, c0.index, c0.account, c0.amount, c0.proof, { gasLimit: 300000 }));
  if (rc7.status !== 1) throw new Error('DAY-7 CLAIM TX REVERTED ON CHAIN');
  const afterPileup = await mbAsView.balanceOf(c0.account);
  if (afterPileup - before !== BigInt(c0.amount)) throw new Error('PILE-UP PAYOUT MISMATCH');
  console.log('day-7 pile-up payout: OK', '(' + ethers.formatUnits(afterPileup - before, 18) + ' MUSEBOOK total)');

  // Fully claimed: another claim must revert.
  await expectClaimRevert(distAsClaimer,
    [dry.epochId, c0.index, c0.account, c0.amount, c0.proof], /nothing vested yet/, 'repeat claim');

  // ---- proof checks (c1 unclaimed; proof check fires before vesting) ----
  const c1 = dry.claims[1] || c0;
  await expectClaimRevert(distAsClaimer,
    [dry.epochId, c1.index, c1.account, (BigInt(c1.amount) + 1n).toString(), c1.proof],
    /bad proof/, 'forged amount');

  // Wrong epoch / account / index must all revert (leaf binds all four fields).
  const badCases = [
    ['wrong epoch', dry.epochId + 1, c0.index, c0.account, c0.amount, c0.proof, /no epoch/],
    ['wrong account', dry.epochId, c1.index, c0.account, c1.amount, c1.proof, /bad proof/],
    ['wrong index', dry.epochId, c1.index, c0.account, c0.amount, c0.proof, /bad proof/],
  ];
  for (const [name, e, i, a, amt, proof, want] of badCases) {
    await expectClaimRevert(distAsClaimer, [e, i, a, amt, proof], want, name);
  }

  const unclaimed = await dist.epochUnclaimed(dry.epochId);
  console.log('epoch unclaimed (carryover):', ethers.formatUnits(unclaimed, 18));

  // ---- expiry: warp past the 30-day claim window ----
  const w = await warpDays(provider, 31); // publish + 7 (vested) + 31 > 30-day window
  console.log('warped to', w.to, '(was', w.from + ')');
  const c2 = dry.claims[1] || c0;
  await sendRetry(provider, 'anvil_impersonateAccount', [c2.account]);
  await sendRetry(provider, 'anvil_setBalance', [c2.account, '0xDE0B6B3A7640000']); // 1 ETH
  const claimer2 = await provider.getSigner(c2.account);
  const distAsClaimer2 = new ethers.Contract(distAddr, ART.abi, claimer2);
  await expectClaimRevert(distAsClaimer2,
    [dry.epochId, c2.index, c2.account, c2.amount, c2.proof], /claim window closed/, 'post-deadline claim');

  const liabBefore = await dist.allocatedUnclaimed();
  const finRc = await waitRc(provider, await distAsClaimer2.finalizeEpoch(dry.epochId, { gasLimit: 200000 }));
  if (finRc.status !== 1) throw new Error('FINALIZE TX REVERTED ON CHAIN');
  const liabAfter = await dist.allocatedUnclaimed();
  console.log('allocatedUnclaimed before/after finalize:',
    ethers.formatUnits(liabBefore, 18), '->', ethers.formatUnits(liabAfter, 18));
  if (liabAfter !== 0n) throw new Error('FINALIZE DID NOT RELEASE ALL');
  // Owner (deployer here) can now withdraw the released remainder.
  const depBalBefore = await mbAsView.balanceOf(deployer);
  const wdRc = await waitRc(provider, await dist.withdraw(deployer, liabBefore, { gasLimit: 200000 }));
  if (wdRc.status !== 1) throw new Error('WITHDRAW TX REVERTED ON CHAIN');
  const depBalAfter = await mbAsView.balanceOf(deployer);
  if (depBalAfter - depBalBefore !== liabBefore) throw new Error('WITHDRAW AFTER FINALIZE MISMATCH');
  console.log('withdraw of finalized remainder: OK');

  console.log('FORK E2E: ALL CHECKS PASSED');
  await sendRetry(provider, 'anvil_stopImpersonatingAccount', [cfg.TREASURY]);
}

main().catch((e) => { console.error('FORK E2E FAILED:', e.message); process.exit(1); });
