# Muse Dogs — contracts

Smart contracts for the Muse Dogs NFT collection: 500 ERC-721 tokens on
Robinhood Chain (chain id 4663). Toolchain: Foundry (forge 1.8.x, solc 0.8.30).

**Name: `Muse Dogs`, symbol: `MUSEDOGS`** (locked 2026-09-18).
Royalty: **10%** to the project multisig (the max most marketplaces honor;
contract enforces a 1000 bps ceiling).

## Files

| Path | What it is |
|---|---|
| `src/MuseDog.sol` | The collection contract (one file, ~430 lines) |
| `test/MuseDog.t.sol` | Full test suite (caps, vouchers, pause, access control, royalties) |
| `script/Deploy.s.sol` | Deploy script (reads constructor args from env) |
| `foundry.toml` | Compiler config, RPC endpoints, Blockscout verification |

## The design, in plain words

There is exactly one contract, and it can never make more than 500 NFTs.
The 500 are split into three buckets the contract enforces on-chain:

1. **380 holder airdrops** — the project (a 2-of-3 multisig, not a person)
   mints directly to verified MDOG-holder addresses in batches of up to 100.
   Zero addresses are skipped instead of reverting, so one bad entry can't
   brick a whole batch.
2. **100 community free mints** — anyone with a signed voucher claims one
   free NFT. The minter pays only Robinhood Chain gas (a few cents); the mint
   price is zero and the function isn't payable. Each voucher is bound to one
   address, one nonce, one expiry, this chain (4663), and this contract.
   The contract remembers used nonces and which addresses already claimed,
   so a voucher can't be replayed or double-claimed.
3. **50 reserve** — waitlist refills, community prizes, collaborators
   (Mikey gets 1). Every reserve mint emits an event so it's publicly visible.

Token IDs are sequential across all buckets: 0, 1, 2, … 999.

## Security model (what each control is for)

- **Non-upgradeable, no proxies, no selfdestruct.** The code that launches is
  the code forever. No one can quietly swap in new rules later.
- **Multisig owner.** Deployment transfers ownership to a 2-of-3 multisig.
  No single hot wallet can mint, pause, or change anything.
- **Voucher signer is separate from the owner.** Vouchers are signed by a
  dedicated KMS key with no other powers. If it's ever compromised, the
  owner pauses the contract, rotates the signer, and unpauses — rotation is
  only allowed while paused, so it can never be a silent hot-swap. The
  contract also caps the damage: even a stolen signer key can't exceed the
  100-claim cap or mint outside the community bucket.
- **Pausable minting, open transfers.** If something goes wrong, minting
  stops but people can still move the NFTs they own. Nobody's assets get
  frozen.
- **One-way metadata freeze.** The base URI can be updated until launch, then
  `freezeMetadata()` locks it forever. There's no unfreeze. (Reveal is
  immediate: art is visible from the first mint — no placeholder/mystery phase.)
- **Royalties bounded at 10%.** EIP-2981 royalties can be set, lowered, or
  removed — never raised above 10%.
- **No hidden mint paths.** There is no public mint without a voucher, no
  owner free-mint beyond the caps, and the counters (`holderMinted`,
  `communityMinted`, `reserveMinted`) are public so anyone can audit supply.
- **Reentrancy guard on claims.** State is updated before the mint call, and
  the claim function is `nonReentrant`, so a malicious recipient contract
  can't re-enter to claim twice.
- **Custom errors** (not strings) keep revert data cheap and machine-readable.

## Commands

```bash
# install deps (already done: OpenZeppelin v5.4.0, pinned tag)
forge install

# compile
forge build

# run tests
forge test

# run tests with gas report
forge test --gas-report

# deploy to Robinhood testnet (chain 46630) with verification
MUSEDOG_OWNER=0x... MUSEDOG_VOUCHER_SIGNER=0x... \
  forge script script/Deploy.s.sol --rpc-url robinhood_testnet \
  --broadcast --verify -vvvv
```

## Before mainnet

1. Finalize the collection name/symbol.
2. Deploy the 2-of-3 multisig; it becomes `initialOwner`.
3. Generate the voucher-signer key in KMS; fund nothing on it (it never sends txs).
4. Deploy to testnet, run the full rehearsal (batches, vouchers, pause,
   signer rotation, reveal, direct-contract claim), verify source on Blockscout.
5. Independent Solidity review of this diff — no unresolved high/criticals.
6. Deploy mainnet, verify source, transfer anything left to the multisig,
   publish the canonical contract address from Mikey's verified Musebook identity.
