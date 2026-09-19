// LIVE MDOG/USD price checker for the Muse Dogs registration API.
// The $10 holder threshold is meaningless without a real price, so this
// module fetches MDOG/USD from two independent sources and only returns a
// price when they agree:
//
//   Source A (independent market data): Dexscreener's REST API, priceUsd for
//   the MDOG contract on Robinhood Chain. Dexscreener aggregates its own
//   indexed DEX data; it does not read our RPCs. The deepest-liquidity
//   MDOG pair is used (currently MDOG/META, deeper than our own thin pool).
//
//   Source B (self-verifiable on-chain): the project's own Uniswap V4
//   MDOG/ETH pool, read via StateView.getSlot0(poolId) through BOTH RPC
//   providers (same dual-RPC agreement rule as lib/rpc.js), converted to
//   USD with an ETH/USD reference rate (CoinGecko, keyless).
//
// Fail-closed rules (a price error is NEVER an eligibility approval):
//   - either source fails / times out / returns a non-positive price
//     => PRICE_UNAVAILABLE (retryable)
//   - sources disagree beyond PRICE_MAX_DEVIATION_PCT (default 20)
//     => PRICE_DISAGREEMENT (retryable)
//   - the on-chain leg's two RPCs disagree on price beyond 1%
//     => PRICE_DISAGREEMENT (retryable)
//   - cached price older than PRICE_MAX_AGE_MS (default 5 min) is never
//     served; a failed refetch fails closed instead of serving stale data.
// Every returned price carries the block number and fetch timestamp so each
// eligibility decision records exactly which price it used.
//
// Env knobs (all optional; defaults are safe for this project):
//   TEST_MODE=1            => stub, price = MOCK_MDOG_USD_PRICE (default 0.01)
//   MOCK_MDOG_USD_PRICE    => test-mode price
//   RPC_URL_1 / RPC_URL_2  => dual RPC providers for the on-chain leg
//   MDOG_CONTRACT          => token address (default MDOG on Robinhood Chain)
//   MDOG_POOL_ID           => V4 pool id (default the project's MDOG/ETH pool)
//   V4_STATEVIEW           => StateView contract (default Robinhood Chain)
//   MDOG_DECIMALS          => default 18
//   PRICE_MAX_AGE_MS       => cache staleness ceiling, default 300000
//   PRICE_MAX_DEVIATION_PCT=> max source disagreement, default 20
const { ethers } = require('ethers');

const CHAIN_ID = 4663;
const MDOG_DEFAULT = '0x4CAF2e6eC0fCBef77314566A9884643512EF8bfC';
const POOL_ID_DEFAULT = '0x2c4b65a41f07637153dab0ca3d9e4ccd91b7a310c3091a032c9f6a430a355d75';
const STATEVIEW_DEFAULT = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/search?q=';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
const FETCH_TIMEOUT_MS = 12000;
const BLOCK_TOLERANCE = 5;

function pick(name, env) {
  return env[name] !== undefined ? env[name] : process.env[name];
}

function cfg(env) {
  return {
    testMode: env.TEST_MODE === '1',
    mockPrice: pick('MOCK_MDOG_USD_PRICE', env),
    rpc1: pick('RPC_URL_1', env),
    rpc2: pick('RPC_URL_2', env),
    mdog: (pick('MDOG_CONTRACT', env) || MDOG_DEFAULT).toLowerCase(),
    poolId: pick('MDOG_POOL_ID', env) || POOL_ID_DEFAULT,
    stateView: pick('V4_STATEVIEW', env) || STATEVIEW_DEFAULT,
    mdogDecimals: Number(pick('MDOG_DECIMALS', env) || 18),
    maxAgeMs: Number(pick('PRICE_MAX_AGE_MS', env) || 300000),
    maxDeviationPct: Number(pick('PRICE_MAX_DEVIATION_PCT', env) || 20),
  };
}

function msg(e) {
  return (e && (e.message || e.msg)) || String(e);
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'musedog-price-check/0.1', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- Source A: Dexscreener -------------------------------------------------
// Deepest-liquidity MDOG pair on Robinhood Chain. priceUsd is Dexscreener's
// own market quote, independent of our RPC infrastructure.
async function dexscreenerPrice(c) {
  const data = await fetchJson(DEXSCREENER_URL + c.mdog);
  const pairs = (data && data.pairs) || [];
  const mdogPairs = pairs.filter(
    (p) =>
      p.chainId === 'robinhood' &&
      p.baseToken &&
      String(p.baseToken.address).toLowerCase() === c.mdog &&
      Number(p.priceUsd) > 0
  );
  if (mdogPairs.length === 0) {
    throw new Error('no robinhood MDOG pair with a price returned');
  }
  mdogPairs.sort((a, b) => Number(b.liquidity && b.liquidity.usd || 0) - Number(a.liquidity && a.liquidity.usd || 0));
  const best = mdogPairs[0];
  return { price_usd: Number(best.priceUsd), pair: best.pairAddress };
}

// --- Source B: on-chain V4 pool --------------------------------------------
// StateView.getSlot0(poolId) -> (sqrtPriceX96, tick, protocolFee, lpFee).
// In V4, currency0 < currency1 by address; native ETH is address(0), so
// currency0 = ETH, currency1 = MDOG, and 1.0001^tick = raw MDOG per raw ETH.
// Adjusted for decimals: MDOG/ETH = 1.0001^tick * 10^(dETH - dMDOG).
const GET_SLOT0_SELECTOR = ethers.id('getSlot0(bytes32)').slice(0, 10);

function mdogPerEthFromTick(tick, mdogDecimals) {
  return Math.pow(1.0001, Number(tick)) * Math.pow(10, 18 - mdogDecimals);
}

async function slot0Read(rpcUrl, c) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), ms))]);
  const net = await withTimeout(provider.getNetwork(), FETCH_TIMEOUT_MS);
  if (Number(net.chainId) !== CHAIN_ID) {
    throw new Error('wrong chain ' + Number(net.chainId));
  }
  const data = GET_SLOT0_SELECTOR + c.poolId.replace(/^0x/, '');
  const [res, block] = await withTimeout(
    Promise.all([provider.call({ to: c.stateView, data }), provider.getBlockNumber()]),
    FETCH_TIMEOUT_MS
  );
  const [sqrtP, tick] = ethers.AbiCoder.defaultAbiCoder().decode(['uint160', 'int24', 'uint24', 'uint24'], res);
  void sqrtP; // tick is the numerically stable price source
  return { tick: Number(tick), block: Number(block) };
}

async function onchainPrice(c) {
  if (!c.rpc1 || !c.rpc2) {
    throw new Error('no RPC providers configured for the on-chain price leg');
  }
  let a, b;
  try {
    a = await slot0Read(c.rpc1, c);
  } catch (e) {
    throw new Error('provider 1 slot0 failed: ' + msg(e));
  }
  try {
    b = await slot0Read(c.rpc2, c);
  } catch (e) {
    throw new Error('provider 2 slot0 failed: ' + msg(e));
  }
  if (Math.abs(a.block - b.block) > BLOCK_TOLERANCE) {
    throw { code: 'PRICE_DISAGREEMENT', retryable: true, message: 'Pool RPCs disagree on block height.' };
  }
  const pa = mdogPerEthFromTick(a.tick, c.mdogDecimals);
  const pb = mdogPerEthFromTick(b.tick, c.mdogDecimals);
  const dev = Math.abs(pa - pb) / ((pa + pb) / 2);
  if (dev > 0.01) {
    throw { code: 'PRICE_DISAGREEMENT', retryable: true, message: 'Pool RPCs disagree on pool price.' };
  }
  const mdogPerEth = (pa + pb) / 2;
  // ETH/USD reference (keyless). Single reference by design; any failure
  // here fails the whole price closed rather than guessing.
  let ethUsd;
  try {
    const cg = await fetchJson(COINGECKO_URL);
    ethUsd = Number(cg && cg.ethereum && cg.ethereum.usd);
  } catch (e) {
    throw new Error('ETH/USD reference failed: ' + msg(e));
  }
  if (!(ethUsd > 0)) throw new Error('ETH/USD reference returned no price');
  return { price_usd: ethUsd / mdogPerEth, block: Math.min(a.block, b.block), eth_usd: ethUsd };
}

// --- agreement + cache ------------------------------------------------------
function agreeOnPrice(a, b, maxDeviationPct) {
  const dev = Math.abs(a - b) / ((a + b) / 2);
  if (dev > maxDeviationPct / 100) {
    throw {
      code: 'PRICE_DISAGREEMENT',
      retryable: true,
      message:
        'Price sources disagree (' + (dev * 100).toFixed(1) + '% > ' + maxDeviationPct + '%): ' +
        'dexscreener=$' + a + ' on-chain=$' + b + '. No eligibility decision made.',
    };
  }
}

let cache = null; // { price_usd, block, sources, fetched_at_ms }

function _clearCache() {
  cache = null;
}

async function getMdogUsdPrice(env) {
  const c = cfg(env);
  if (c.testMode) {
    const p = Number(c.mockPrice !== undefined ? c.mockPrice : '0.01');
    if (!(p > 0)) {
      throw { code: 'PRICE_UNAVAILABLE', retryable: true, message: 'MOCK_MDOG_USD_PRICE is not a positive number.' };
    }
    return {
      price_usd: p,
      block: null,
      sources: ['test-stub'],
      fetched_at: new Date().toISOString(),
      age_ms: 0,
    };
  }
  const now = Date.now();
  if (cache && now - cache.fetched_at_ms <= c.maxAgeMs) {
    return {
      price_usd: cache.price_usd,
      block: cache.block,
      sources: cache.sources,
      fetched_at: new Date(cache.fetched_at_ms).toISOString(),
      age_ms: now - cache.fetched_at_ms,
    };
  }
  let dex, chain;
  try {
    dex = await dexscreenerPrice(c);
  } catch (e) {
    _clearCache();
    throw { code: 'PRICE_UNAVAILABLE', retryable: true, message: 'Dexscreener price leg failed: ' + msg(e) };
  }
  try {
    chain = await onchainPrice(c);
  } catch (e) {
    _clearCache();
    if (e && e.code === 'PRICE_DISAGREEMENT') throw e;
    throw { code: 'PRICE_UNAVAILABLE', retryable: true, message: 'On-chain price leg failed: ' + msg(e) };
  }
  agreeOnPrice(dex.price_usd, chain.price_usd, c.maxDeviationPct);
  const price = (dex.price_usd + chain.price_usd) / 2;
  cache = {
    price_usd: price,
    block: chain.block,
    sources: ['dexscreener', 'v4-pool-dual-rpc'],
    fetched_at_ms: now,
  };
  return {
    price_usd: price,
    block: chain.block,
    sources: cache.sources,
    fetched_at: new Date(now).toISOString(),
    age_ms: 0,
  };
}

module.exports = { getMdogUsdPrice, _agreeOnPrice: agreeOnPrice, _mdogPerEthFromTick: mdogPerEthFromTick, _clearCache };
