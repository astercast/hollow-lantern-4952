// Dual-RPC MDOG balance check on Robinhood Chain.
// Rules:
//  - Both providers must answer, report chainId 4663, and agree on balance.
//  - Balances are compared at roughly the same block (tolerance 5 blocks).
//  - Any disagreement, lag, or outage => fail closed (never auto-approve).
// In TEST_MODE=1 the RPC calls are stubbed with env values so the flow can
// be exercised without a live node. Without RPC URLs configured and without
// TEST_MODE, every check fails closed with RPC_UNAVAILABLE.
const { ethers } = require('ethers');

const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const CHAIN_ID = 4663;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('rpc timeout')), ms)),
  ]);
}

async function readProvider(url, token, address) {
  const provider = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
  const net = await withTimeout(provider.getNetwork(), 12000);
  if (Number(net.chainId) !== CHAIN_ID) {
    throw { code: 'WRONG_CHAIN', message: 'Provider reported chain ' + Number(net.chainId) };
  }
  const contract = new ethers.Contract(token, ERC20_ABI, provider);
  const [balance, block] = await withTimeout(
    Promise.all([contract.balanceOf(address), provider.getBlockNumber()]),
    15000
  );
  return { balance: balance.toString(), block: Number(block) };
}

function stubbedResult() {
  return {
    balance: process.env.MOCK_MDOG_BALANCE || '0',
    block: Number(process.env.MOCK_BLOCK || '1000000'),
  };
}

async function checkBalance(address, env) {
  if (env.TEST_MODE === '1') {
    // Test stub: same answer from "both providers" so agreement holds.
    const a = stubbedResult();
    const b = stubbedResult();
    return agreed(a, b);
  }
  const url1 = env.RPC_URL_1;
  const url2 = env.RPC_URL_2;
  if (!url1 || !url2) {
    throw { code: 'RPC_UNAVAILABLE', retryable: true, message: 'No RPC providers configured.' };
  }
  let a, b;
  try {
    a = await readProvider(url1, env.MDOG_CONTRACT, address);
  } catch (err) {
    throw { code: 'RPC_UNAVAILABLE', retryable: true, message: 'Provider 1 failed: ' + (err.message || err) };
  }
  try {
    b = await readProvider(url2, env.MDOG_CONTRACT, address);
  } catch (err) {
    throw { code: 'RPC_UNAVAILABLE', retryable: true, message: 'Provider 2 failed: ' + (err.message || err) };
  }
  return agreed(a, b);
}

function agreed(a, b) {
  if (a.balance !== b.balance) {
    throw { code: 'RPC_DISAGREEMENT', retryable: true, message: 'Providers disagree on balance.' };
  }
  if (Math.abs(a.block - b.block) > 5) {
    throw { code: 'RPC_DISAGREEMENT', retryable: true, message: 'Providers disagree on block height.' };
  }
  return { balance_raw: a.balance, block: Math.min(a.block, b.block) };
}

module.exports = { checkBalance, CHAIN_ID };
