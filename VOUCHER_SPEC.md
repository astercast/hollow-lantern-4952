# Muse Dogs — Voucher / Relayer design (no-connect gasless mint)

Status: voucher crypto DONE and cross-verified (2026-09-19). Contract built,
101 tests passing, NOT deployed. Voucher key generated (address
`0xada5b0c850ff4d80b4631c6863a075f3ca1e2fd5`, staging file until backend
build). Relayer endpoint and relayer key funding still TBA.

## The idea in one paragraph

Nobody connects a wallet. When mint opens, a human commands their muse to mint.
The muse asks our site; the site verifies the muse's identity signature (same
scheme as registration), checks the whitelist, and signs an EIP-712 **voucher**:
"address 0xABC may mint ONE (community or holder path), expires <expiry>,
serial <nonce>". One NFT per voucher; a wallet can redeem up to 3 community
vouchers + 3 holder vouchers (6 total for a muse that qualifies for both). A
backend **relayer** wallet submits each voucher to the NFT contract and pays
the gas. The NFT lands in the registered Bankr address. Bankr just receives —
its portfolio view already shows NFTs.

## Voucher format (LOCKED)

EIP-712 typed data, Robinhood Chain (chainId 4663):

```
domain: { name: "Muse Dogs", version: "1", chainId: 4663,
          verifyingContract: <deployed NFT contract> }
types:  MintVoucher { recipient: address, mintType: uint8, nonce: uint256,
                      expiry: uint256 }
```

- `recipient` — the whitelisted Bankr address, bound into the signature. A
  stolen voucher can only ever mint to its own address.
- `mintType` — 0 = COMMUNITY (380 bucket, 3 per address), 1 = HOLDER (100
  bucket, 3 per address).
- `nonce` — server-issued serial, one use only per recipient (contract tracks
  `usedNonces[recipient][nonce]`).
- `expiry` — unix timestamp; vouchers expire so a leaked signer key has a
  limited blast radius.

Reference implementation: `site/api/v1/_voucher.js` (ethers v6).
Cross-verified 2026-09-19: independent Python/eth-keys implementation produces
the identical digest `0x56f103d4…` for the same inputs and recovers the same
signer. Any Solidity EIP-712 verifier will accept these vouchers.

## Keys (server-side only — NEVER in the repo)

- `MUSEDOG_VOUCHER_KEY` — secp256k1 private key. Its address is set as the
  contract's trusted `voucherSigner` at deploy. Signs vouchers only.
- `MUSEDOG_RELAYER_KEY` — EOA that submits mint txs and pays gas. Must be
  funded with Robinhood Chain gas before mint opens.
- Both live in Vercel env vars. Generate with `openssl rand -hex 32`.

## Contract interface (built — `contracts/src/MuseDogs.sol`, not yet deployed)

- `mintWithVoucher(recipient, mintType, nonce, expiry, signature)` — anyone may
  call (the relayer does); contract recomputes the EIP-712 digest, recovers the
  signer, requires it == `voucherSigner`, requires nonce unused for that
  recipient + expiry unexpired. One NFT minted per call.
- Caps enforced ON-CHAIN per bucket: COMMUNITY `communityMinted < 380` and
  `communityMintsByAddress[recipient] < 3`; HOLDER `holderMinted < 100` and
  `holderMintsByAddress[recipient] < 3`. Hard `MAX_SUPPLY = 500`
  defense-in-depth. Buckets are independent: 380 + 100 + 20 = 500.
- `voucherSigner` — set at deploy, rotatable by owner (multisig) if compromised.
- Both public paths (community AND holder) are voucher mints. Only the 20
  team/treasury mints are a separate owner function, not vouchers.

## Relayer flow (to build)

`POST /api/v1/mint/request` (gated like the register endpoints):
1. Muse submits `muse_id` + fresh identity signature over a mint challenge
   (same challenge scheme as register, action "mint").
2. Server verifies identity sig, checks whitelist registration (community path)
   or $10 MDOG holder eligibility (holder path), checks the address hasn't
   already minted 3 on that path, checks that path's bucket supply remains
   (380 community / 100 holder, read contract).
3. Server issues nonce, signs voucher with `MUSEDOG_VOUCHER_KEY`.
4. Server submits `mintWithVoucher` via `MUSEDOG_RELAYER_KEY`, pays gas.
5. Returns tx hash. Nonce marked used on-chain; double-mint impossible even if
   two vouchers are issued (contract enforces the per-path and bucket caps).

## Replay / abuse notes

- Vouchers are single-use (nonce, per recipient) and expiring.
- Binding `recipient` in the signature means a voucher can't be redirected.
- The bucket caps (380 community / 100 holder) and 3-per-path-per-wallet caps
  are enforced ON-CHAIN, not just by the server — the server can't be tricked
  into over-minting.
- If the voucher key leaks: rotate `voucherSigner` via owner; outstanding
  vouchers die at their expiries.

## Still TBA

- NFT contract + fee-splitter + rewards vault deployment (all built and
  tested; deployment needs Andrew's explicit go-ahead).
- Safe owner addresses + Safe creation (needed before deploy — splitter owner
  and rewards publisher).
- `POST /api/v1/mint/request` endpoint + relayer submission code.
- Generating + funding `MUSEDOG_RELAYER_KEY` (voucher key already generated;
  moves to Vercel env at backend build, staging file then deleted).
- Countdown timer on the mint page (once Andrew picks the date).
- `api.html` still documents the old placeholder claim endpoints — rewrite when
  the real ones exist.
