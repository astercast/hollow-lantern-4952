# Robinhood Chain (4663) RPC Provider Research
Date: 2026-09-18 · For: Muse Dogs NFT project (~/workspace/muse-dog-lol)
Method: public docs, provider chain lists, and community write-ups only. No accounts created, nothing paid.

## Recommendation (two independent production providers)
1. **Alchemy** — `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` · free 30M CU/mo, 25 RPS, no credit card. Robinhood's officially recommended provider.
2. **Chainstack** — HTTPS endpoint issued in the Chainstack console · free Developer tier 3M RU/mo, 25 RPS. First-class Robinhood Chain protocol support since launch.
Backup (keyless, no account): **dRPC** `https://robinhood.drpc.org` or **PublicNode** `https://robinhood-rpc.publicnode.com`.

## Official public RPC
`https://rpc.mainnet.chain.robinhood.com` — rate-limited; returns HTTP 429 on wide `eth_getLogs` scans. No published numeric limit (community probing suggests keeping it to a few rps). No archive data, no WebSocket (JSON-RPC polling only), load-balanced across replicas (no read-your-writes: a read right after a write can hit a stale replica). Fine for light use; not for production.

## SUPPORTED providers

### Alchemy ✅
- Endpoint: `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` (testnet: `https://robinhood-testnet.g.alchemy.com/v2/{API_KEY}`)
- Docs: alchemy.com robinhood-chain-api-quickstart; Robinhood's own docs recommend Alchemy.
- Free tier: 30M compute units/month, 25 requests/sec, no credit card required.
- WebSocket available; webhooks, gas sponsorship, Data API also live on this chain.

### QuickNode ✅
- Endpoint: per-endpoint URL issued in the QuickNode dashboard (select "Robinhood" as the chain when creating the endpoint; URL looks like `https://<name>.quiknode.pro/<token>/`). No chain slug in the URL.
- Support confirmed by QuickNode's own /chains/robinhood page (archive nodes, Debug API, 17+ regions, 99.99% SLA) and Robinhood's docs.
- Free tier: $0 trial — 10M API credits, 15 RPS (note: QuickNode's $0 tier is a 1-month trial, not a permanent free plan; paid Build starts at $49/mo).

### Chainstack ✅
- Endpoint: HTTPS node endpoint issued in the Chainstack console (Global Node deployment for geo-balanced access).
- First-class Robinhood Chain protocol at launch (mainnet 4663 + testnet 46630), Nitro-native `debug_*` enabled, archive available from Growth plan.
- Free Developer tier: 3M request units/month at 25 RPS. Growth $49/mo (20M RU, 250 RPS) unlocks archive + debug/trace. SOC 2 Type II, ISO 27001.

### dRPC ✅
- Endpoint: `https://robinhood.drpc.org` (standard dRPC public-endpoint pattern; chain listed on drpc.org/chainlist as "Robinhood", chain ID 4663 / 0x1237, with HTTP + WSS + archive + MEV).
- Named by Robinhood's own docs as a supported production provider.
- Free: dRPC offers free public/community endpoints usable without an account; keyed paid tiers add higher limits.

### Validation Cloud / Blockdaemon ✅ (named in Robinhood's own docs)
- Robinhood's documentation names Alchemy, QuickNode, Blockdaemon, dRPC, and Validation Cloud as supported production RPC providers. Independent free-tier details not verified for these two in this pass.

### Others independently supporting the chain
- **PublicNode (AllNodes)** — `https://robinhood-rpc.publicnode.com` (HTTPS + WSS), verified live and added to DefiLlama chainlist. Free, keyless.
- **RouteMesh** — free public/community endpoints (per Chainstack comparison article).
- **GetBlock** — listed as supporting Robinhood Chain independently of Robinhood's list (per Chainstack article); shared-node free tiers exist, exact endpoint/price not verified here.
- **Infura** — one community RPC guide lists Infura as supporting Robinhood Chain mainnet; not in Robinhood's official named list. Endpoint would be `https://robinhood-mainnet.infura.io/v3/{API_KEY}` (pattern unconfirmed for this chain).

## NOT supported / unavailable

### Ankr ❌ (not confirmed)
- No Robinhood Chain entry found in Ankr's supported-chains documentation; one independent research pass (Jul 2026) explicitly flagged Ankr support for chain 4663 as "could not be confirmed". Treat as unsupported until Ankr announces otherwise.

### Blast API (Bware Labs) ❌ — service no longer exists
- Blast has been **deprecated**; Bware Labs was **acquired by Alchemy**. blastapi.io now redirects users to migrate to Alchemy. Not an option. (Note: some community guides still list "BlastAPI" as a Robinhood RPC option — that guidance is stale.)

### Chainbase ❌ (not found)
- No Robinhood Chain listing found in Chainbase materials. Chainbase is primarily a blockchain data/indexing API, not a general JSON-RPC node provider — it is not in the node-RPC provider conversation for this chain.

## Sources
- Alchemy quickstart docs (alchemy.com/overviews/launch-a-memecoin-on-robinhood-chain)
- QuickNode /chains/robinhood + /docs/robinhood/quickstart
- Chainstack "Top 7 Robinhood Chain RPC Providers in 2026" comparison
- dRPC chainlist (drpc.org/chainlist)
- DefiLlama chainlist PR #2960 (publicnode endpoints)
- Robinhood docs (docs.robinhood.com/chain) — names Alchemy, QuickNode, Blockdaemon, dRPC, Validation Cloud
- nuthatch RFC-0050 (nightswatchhq/nuthatch) — Alchemy, QuickNode, Blockdaemon, dRPC, Validation Cloud, Chainstack, Dwellir, Goldsky
- nirholas/learn-robinhood-chain, robinhood-toolkit, robinhood-chain-cli (community tooling + 429 observations)
- deathnoir/friar research digest (Ankr unconfirmed; public RPC rate limit undocumented)
