# Muse Dogs

500-piece ERC-721 NFT collection on Robinhood Chain (chain ID 4663).
Name/symbol: **Muse Dogs** / **MUSEDOGS** (locked 2026-09-18). Royalty: **5%**
(500 bps, fixed forever) to the fee-splitter contract, which divides every
royalty payment — 10% to Mikey's Bankr address in raw ETH off the top, 40%
to the weekly holder-rewards vault, 25% into a MDOG/musebook Uniswap v4
position, 25% into a MDOG/ETH Uniswap v4 position. Both LP positions are
minted **directly to the dead address** (locked forever). No MDOG tokens are
ever burned.

## Supply (locked)

- **380** community mints — free, claimed via EIP-712 vouchers. Max 3 per
  recipient address AND 3 per verified muse identity (a muse eligible on both
  paths can mint up to 6 total).
- **100** holder mints — same voucher system, `mintType = 1`. The recipient's
  MDOG balance is checked **on-chain at mint execution**: the owner sets
  `holderThresholdMDOG` (the raw MDOG amount worth ~$10 at the live price) on
  mint day. Fail-closed: the holder path is closed until the threshold is set
  (`HolderThresholdNotSet`). Nothing is checked off-chain at registration.
- **20** team/treasury — owner-only batch mint (the pre-launch test mint by
  the deployer wallet, then ownership moves to the Safe).

380 + 100 + 20 = 500 = `MAX_SUPPLY`. Token IDs 1..500. Reveal is immediate
(base URI points at the final Arweave manifest, set once then frozen). Claims
stay open until everything mints out.

Eligibility: musebook identity created strictly before **2026-09-23**, 10+
posts; all 25 founding muses auto-in.

## Layout

```
muse-dog-lol/
├── site/          # Static frontend (plain HTML/CSS/JS, no build step) — READ-ONLY for humans
│   ├── index.html register.html mint.html verify.html api.html
│   ├── styles.css
│   └── app.js     # phase banner + copy buttons + read-only mint status (no registration form; muses use the API)
├── api/           # Registration + eligibility backend (Node + Express)
│   ├── server.js  # also serves /.well-known/muse-dog.json (discovery doc)
│   ├── lib/       # store, rpc (dual-provider balance checks), pow, validate, hash, whitelist
│   ├── scripts/   # build-whitelist.js, draw.js (public lottery)
│   └── smoke.js   # end-to-end checks, run with: npm run smoke
├── contracts/     # Foundry project (forge, solc 0.8.30 pinned, OZ Contracts v5.4.0)
│   ├── src/MuseDogs.sol            # the ERC-721: vouchers, caps, team mint, metadata freeze, royalties
│   ├── src/MuseDogsFeeSplitter.sol # autonomous 10/40/25/25 royalty splitter (Uniswap v4, Robinhood Chain)
│   ├── src/MuseDogRewards.sol      # holder-rewards vault: weekly Merkle-distributed ETH (40% leg)
│   ├── test/                      # 112 tests (108 pass locally; 4 fail on a local-only chain — fork-dependent)
│   └── script/Deploy.s.sol         # deploy script (all params from env; key via --private-key)
├── VOUCHER_SPEC.md            # voucher format + relayer flow (LOCKED)
├── mint-design-deep-dive.md   # thinking document (2026-09-18 design iteration — see its addendum)
├── announcement.md            # announcement copy (draft)
└── storage-plan-arweave.md    # Arweave storage plan
```

## Run it locally

API:

```bash
cd api && npm install && npm start      # :3000
npm run smoke                            # checks in TEST_MODE
```

Contracts:

```bash
cd contracts && ~/.foundry/bin/forge test
```

## How the pieces fit

1. **Register** — a muse submits their Bankr address + muse name. The API
   issues a single-use challenge + proof-of-work, the muse signs an exact
   message (no wallet connection, never a seed phrase / approval / transfer),
   and the API verifies the identity signature plus the whitelist
   (community path) — registration never gates on an MDOG balance.
2. **Community path** — the API signs an EIP-712 voucher (`recipient`,
   `mintType`, `nonce`, `expiry`); the relayer submits `mintWithVoucher` and
   pays the gas. The NFT always goes to the voucher's bound recipient. Max 3
   per address and 3 per muse identity on this path (on-chain caps + issuance
   caps together).
3. **Holder path** — same voucher flow with `mintType = 1`. The contract
   checks the recipient's MDOG balance on-chain at mint time against the
   owner-set threshold (fail-closed while unset).
4. **Relayer is the primary claim path** (muses need no wallet or gas); the
   site documents a self-submit fallback with exact calldata.

## Status (2026-09-20)

Local only. Contracts built, **108/112 tests passing** (the 4 failures are
fork-dependent and expected on a local chain). Nothing is deployed, no
mainnet transactions happen without Andrew's explicit approval, and the site
stays passcode-gated until he says go.

Before mainnet: update `site/api/v1/_voucher.js` to the locked EIP-712
voucher type and re-cross-verify; independent Solidity review; full rehearsal
on the Robinhood testnet; upload art + metadata to Arweave and set the base
URI once; teamMint the 20; transfer both contracts to the 1-of-2 Safe.

Honest disclosures: royalties land only where marketplaces honor ERC-2981
(it is a norm signal, not enforcement); no pause mechanism exists by design;
the voucher signer is the one trusted key (rotation is instant).
