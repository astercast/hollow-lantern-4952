# Muse Dogs — contracts

Smart contracts for the Muse Dogs NFT collection: **500 ERC-721 tokens** on
Robinhood Chain (chain id 4663). Toolchain: Foundry (forge, solc 0.8.30
pinned), OpenZeppelin Contracts v5.4.0 (pinned).

**Name: `Muse Dogs`, symbol: `MUSEDOGS`** (locked 2026-09-18).
Royalty: **7%** (700 bps, fixed forever) to the fee-splitter contract.
Full design notes, trust assumptions, and the audit log: [`NOTES.md`](NOTES.md).

## Files

| Path | What it is |
|---|---|
| `src/MuseDogs.sol` | The collection (ERC-721, vouchers, team mint, metadata freeze, royalties) |
| `src/MuseDogsFeeSplitter.sol` | Royalty splitter: 10/50/20/20 of every royalty payment |
| `src/MuseDogRewards.sol` | Holder-rewards vault: weekly Merkle-distributed ETH (50% leg recipient) |
| `test/MuseDogs.t.sol` | 44 tests — vouchers, caps, freeze, royalties, reentrancy |
| `test/MuseDogsFeeSplitter.t.sol` | 19 tests — split math, accounting, fail-open, forwarding |
| `test/MuseDogRewards.t.sol` | 14 pre-existing vault tests |
| `script/Deploy.s.sol` | Deploy script (all params from env; key via `--private-key`) |

## The design, in plain words

There are 500 NFTs, split into three buckets the contract enforces on-chain —
380 + 100 + 20, and nothing can ever mint a 501st:

1. **380 community mints** — free for the claimant. The backend signs an EIP-712
   voucher (`recipient`, `mintType`, `nonce`, `expiry`); a relayer submits it
   and pays the gas. The NFT can only ever go to the voucher's recipient
   (max 3 per address). Nonces are single-use per recipient; vouchers expire.
2. **100 holder voucher mints** — same voucher system with `mintType=1`
   (max 3 per address). The MDOG check happens **on-chain at mint time**:
   the owner sets `holderThresholdMDOG` (the raw MDOG amount worth ~$10 at
   the live price) on mint day, and `mintWithVoucher` reverts unless the
   recipient holds at least that much MDOG. The path is fail-closed: until
   the threshold is set, every holder mint reverts with
   `HolderThresholdNotSet`. No balance is checked before mint.
3. **20 team/treasury mints** — owner-only batch mint. The deployer wallet
   mints these pre-launch as the end-to-end test, then transfers ownership of
   everything to the Safe multisig (two-step, so a typo can't brick it).

Token IDs are sequential: 1, 2, 3, … 500.

Every 7% resale royalty flows to the fee splitter, which divides it —
10% to Mikey's Bankr address in raw ETH, 50% to the holder-rewards vault,
20% buys MDOG + musebook via Uniswap v4 (routed through META) and mints a
full-range MDOG/musebook position **directly to the dead address**,
20% buys MDOG the same way and mints a full-range MDOG/ETH position
**directly to the dead address**. Both LP positions are locked forever on
mint. No MDOG is ever burned. `process()` is permissionless: anyone can call
it once new funds cross the threshold; the DEX legs run autonomously and
fail safe (a leg that can't complete is skipped, its ETH stays escrowed —
see `NOTES.md` §2).

Reveal is immediate: the base URI is set **exactly once** by the owner, then
frozen forever in the same call. There is no unfreeze and no silent metadata
change, ever.

## Security model (what each control is for)

- **Non-upgradeable, no proxies, no selfdestruct, no delegatecall.** The code
  that launches is the code forever.
- **Multisig owner, two-step transfer.** No single hot wallet controls
  anything after the test mint; a mistyped address can't steal ownership.
- **Voucher signer is separate from the owner.** A dedicated key with no
  other powers. Rotation is instant and public (event); outstanding vouchers
  from the old key die immediately. Blast radius of a compromise is bounded
  by the on-chain bucket caps and short voucher expiries.
- **No pause, by design.** Least privilege: minting can't be frozen by anyone,
  and nobody's NFTs can be frozen either. (Accepted residual risk — see
  `NOTES.md`.)
- **One-shot metadata freeze.** `setBaseURI` freezes atomically; `tokenURI`
  reverts until it's set, so broken metadata can never be served.
- **Royalty pinned at 7%.** No setter for the rate; the receiver is settable
  exactly once (and must be a contract, not an EOA typo).
- **Reentrancy guards + checks-effects-interactions** on every payable and
  external state-changing function. Failed ETH pushes fail *open* into
  retryable escrow buckets — a reverting recipient can never lock funds.
- **Custom errors** (no revert strings), events for every state change,
  explicit zero-address checks everywhere.

## Commands

```bash
# compile
forge build

# run tests (112 tests; 4 fork-dependent tests fail on a local-only chain,
# which is expected — see NOTES.md)
forge test

# deploy to Robinhood Chain with verification (Blockscout, no key needed)
MIKEY_BANKR=0x... REWARDS_VAULT=0x... MUSEDOG_OWNER=0x... \
MUSEDOG_VOUCHER_SIGNER=0x... PROCESS_THRESHOLD_WEI=50000000000000000 \
forge script script/Deploy.s.sol --rpc-url robinhood \
  --broadcast --verify -vvvv
# broadcast key via --private-key (or --ledger); NEVER in env files or the repo
```

## Before mainnet

See the full checklist in [`NOTES.md`](NOTES.md). The short version:

1. Update `site/api/v1/_voucher.js` to the new EIP-712 voucher type and
   re-cross-verify it (old-type vouchers will all revert otherwise).
2. Independent Solidity review — no unresolved high/criticals.
3. Full rehearsal on the Robinhood testnet (chain 46630): deploy, setBaseURI,
   teamMint 20, hand both contracts to the Safe, backend voucher + relayer
   mint, royalty `process()`, and an autonomous DEX-leg execution (or the
   fail-safe skip path if a test pool isn't configured).
4. Deploy mainnet, verify source, setBaseURI once, teamMint 20, transfer both
   contracts to the multisig, publish the canonical addresses from a verified
   channel.
