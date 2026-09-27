/* Validates engine/tickmath.js against the proven Python keeper math
 * on the live PORCH/MUSEBOOK position #3344714 at the latest block. */
'use strict';
const { ethers } = require('ethers');
const cfg = require('./config');
const { getAmountsForLiquidity } = require('./tickmath');
const { decodeInfo } = require('./snapshot');

const POSM_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
];
const SV_ABI = ['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'];
const coder = ethers.AbiCoder.defaultAbiCoder();

async function main() {
  const p = new ethers.JsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID, { staticNetwork: true });
  const posm = new ethers.Contract(cfg.POSM, POSM_ABI, p);
  const sv = new ethers.Contract(cfg.STATEVIEW, SV_ABI, p);
  const id = 3344714;
  const [key, info] = await posm.getPoolAndPositionInfo(id);
  const liq = await posm.getPositionLiquidity(id);
  const pid = ethers.keccak256(coder.encode(
    ['tuple(address,address,uint24,int24,address)'],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
  const { tickLower, tickUpper } = decodeInfo(info);
  const [sqrtP] = await sv.getSlot0(pid);
  const { amount0, amount1 } = getAmountsForLiquidity(sqrtP, tickLower, tickUpper, liq);
  console.log(JSON.stringify({
    poolId: pid, tickLower, tickUpper,
    currency0: key.currency0, currency1: key.currency1,
    amount0: ethers.formatUnits(amount0, 18), amount1: ethers.formatUnits(amount1, 18),
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
