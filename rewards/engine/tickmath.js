/* Uniswap V3/V4 concentrated-liquidity math (BigInt port).
 * Used to credit LP-held PORCH/MDOG toward holder scores at snapshot blocks.
 * Validated against the proven Python keeper math (see engine/README).
 */
'use strict';

const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

function mulDiv(a, b, d) { return (a * b) / d; }

/* getSqrtRatioAtTick — exact port of Uniswap V3 TickMath. */
function getSqrtRatioAtTick(tick) {
  if (tick < -887272 || tick > 887272) throw new Error('tick out of range');
  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  if ((absTick & 2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef1237cf3c7fd43cn) >> 128n;
  if ((absTick & 8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e1f5c16bba10b1328n) >> 128n;
  if ((absTick & 16) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c92664n) >> 128n;
  if ((absTick & 32) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254cn) >> 128n;
  if ((absTick & 64) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326bdb0n) >> 128n;
  if ((absTick & 128) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c305n) >> 128n;
  if ((absTick & 256) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3an) >> 128n;
  if ((absTick & 512) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815en) >> 128n;
  if ((absTick & 1024) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b7fn) >> 128n;
  if ((absTick & 2048) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6n) >> 128n;
  if ((absTick & 4096) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa58n) >> 128n;
  if ((absTick & 8192) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061n) >> 128n;
  if ((absTick & 16384) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32fn) >> 128n;
  if ((absTick & 32768) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 65536) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de6b8a5e5cn) >> 128n;
  if ((absTick & 131072) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 262144) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfen) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // back to Q64.96 -> Q96: divide by 2^32 with rounding up
  return ((ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n));
}

function getAmount0ForLiquidity(sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (L << 96n) * (sqrtB - sqrtA) / sqrtB / sqrtA;
}

function getAmount1ForLiquidity(sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (L * (sqrtB - sqrtA)) >> 96n;
}

/* Underlying token amounts for a position at a given price. */
function getAmountsForLiquidity(sqrtP, tickLower, tickUpper, liquidity) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  if (sqrtP <= sqrtA) {
    return { amount0: getAmount0ForLiquidity(sqrtA, sqrtP, liquidity), amount1: 0n };
  } else if (sqrtP < sqrtB) {
    return {
      amount0: getAmount0ForLiquidity(sqrtP, sqrtB, liquidity),
      amount1: getAmount1ForLiquidity(sqrtA, sqrtP, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) };
}

module.exports = { getSqrtRatioAtTick, getAmountsForLiquidity };
