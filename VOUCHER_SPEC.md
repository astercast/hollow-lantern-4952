# Muse Dogs — Voucher / Relayer design (no-connect gasless mint)

Status: voucher crypto DONE and cross-verified (2026-09-19). Contract, relayer
endpoint, and key funding are still TBA.

## The idea in one paragraph

Nobody connects a wallet. When mint opens, a human commands their muse to mint.
The muse asks our site; the site verifies the muse's identity signature (same
scheme as registration), checks the whitelist, and signs an EIP-712 **voucher**:
"address 0xABC may mint up to 3, expires <deadline>, serial <nonce>". A backend
**relayer** wallet submits that voucher to the NFT contract and pays the gas.
The NFT lands in the registered Bankr address. Bankr just receives — its
portfolio view already shows NFTs.

## Voucher format (LOCKED)

EIP-712 typed data, Robinhood Chain (chainId 4663):

```
domain: { name: "Muse Dogs", version: "1", chainId: 4663,
          verifyingContract: <deployed NFT contract> }
types:  MintVoucher { to: address, quantity: uint256, nonce: uint256,
                      deadline: uint256 }
```

- `to` — the whitelisted Bankr address, bound into the signature. A stolen
  voucher can only ever mint to its own address.
- `quantity` — 1–3, the per-wallet free-mint cap.
- `nonce` — server-issued serial, one use only (contract tracks used nonces).
- `deadline` — unix timestamp; vouchers expire so a leaked signer key has a
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

## Contract interface (to build at deploy time)

- `mintWithVoucher(to, quantity, nonce, deadline, signature)` — anyone may
  call (the relayer does); contract recomputes the EIP-712 digest, recovers the
  signer, requires it == `voucherSigner`, requires nonce unused + deadline
  unexpired, requires `communityMinted + quantity <= 380`, requires
  `balanceOf(to) + quantity <= 3`. Marks nonce used, mints sequential IDs to `to`.
- `voucherSigner` — set at deploy, rotatable by owner (multisig) if compromised.
- 100 holder-airdrop mints and 20 team/treasury mints are separate functions,
  not vouchers.

## Relayer flow (to build)

`POST /api/v1/mint/request` (gated like the register endpoints):
1. Muse submits `muse_id` + fresh identity signature over a mint challenge
   (same challenge scheme as register, action "mint").
2. Server verifies identity sig, checks whitelist registration, checks the
   address hasn't already minted 3, checks 380 supply remains (read contract).
3. Server issues nonce, signs voucher with `MUSEDOG_VOUCHER_KEY`.
4. Server submits `mintWithVoucher` via `MUSEDOG_RELAYER_KEY`, pays gas.
5. Returns tx hash. Nonce marked used on-chain; double-mint impossible even if
   two vouchers are issued (contract enforces the per-wallet and supply caps).

## Replay / abuse notes

- Vouchers are single-use (nonce) and expiring (deadline).
- Binding `to` in the signature means a voucher can't be redirected.
- The 380 cap and 3-per-wallet cap are enforced ON-CHAIN, not just by the
  server — the server can't be tricked into over-minting.
- If the voucher key leaks: rotate `voucherSigner` via owner; outstanding
  vouchers die at their deadlines.

## Still TBA

- NFT contract deployment (Solidity, with the verifier above).
- `POST /api/v1/mint/request` endpoint + relayer submission code.
- Generating + funding `MUSEDOG_VOUCHER_KEY` / `MUSEDOG_RELAYER_KEY`.
- Countdown timer on the mint page (once Andrew picks the date).
- `api.html` still documents the old placeholder claim endpoints — rewrite when
  the real ones exist.
