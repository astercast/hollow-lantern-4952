# Deploying the RewardsDistributor — click-by-click (Andrew)

The contract is built and tested. This machine can't sign a contract
deployment, so the deploy signature comes from your wallet. Easiest path
is Remix in a browser with MetaMask. Desktop is easier than phone, but
MetaMask mobile's built-in browser works too.

## What you're deploying

- Contract: `RewardsDistributor.sol` — the MUSEBOOK holder-rewards claim
  contract. No dependencies, no proxy.
- Constructor takes two addresses: the MUSEBOOK token and the owner
  (your wallet — the owner publishes epoch roots and funds claims).
- Source (exact file I built and tested):
  https://raw.githubusercontent.com/astercast/hollow-lantern-4952/main/rewards/contracts/RewardsDistributor.sol

## Before you start

1. The wallet you connect needs a little ETH **on Robinhood Chain** for
   gas (deploy is ~8.9 KB of init code — a few cents). If your wallet has
   no Robinhood-Chain ETH, move a small amount over first.
2. Add Robinhood Chain to MetaMask (Settings → Networks → Add network):
   - Network name: `Robinhood Chain`
   - RPC URL: `https://rpc.mainnet.chain.robinhood.com`
   - Chain ID: `4663`
   - Currency symbol: `ETH`
   - Block explorer: `https://robinhoodchain.blockscout.com`

## The clicks

1. Open **remix.ethereum.org** in the browser.
2. Left sidebar → **File explorer** → click the "new file" icon, name it
   `RewardsDistributor.sol`.
3. Paste the contract source from the link above into the file.
4. Left sidebar → **Solidity compiler** (the "S" icon) → click
   **Compile RewardsDistributor.sol**. Wait for the green check.
5. Left sidebar → **Deploy & run transactions** (the Ethereum icon).
6. At the top, **Environment** → choose **Injected Provider - MetaMask**.
   MetaMask will pop up — connect your wallet and make sure the network
   at the top says **Robinhood Chain** (chain 4663).
7. Under "Deploy", you'll see two constructor fields. Fill them in order:
   - `_musebook`: `0x91A2DAe9699f0B82540B5886b0d8759C22820bA3`
   - `_owner`: paste **your own wallet address** (the one you connected).
8. Click the orange **Deploy** button.
9. MetaMask pops up with the signature request — this is the one that
   launches the contract. **Review it (it should say "contract
   interaction" / deployment on chain 4663), then Confirm.**
10. After it mines, Remix shows the deployed contract under "Deployed
    Contracts". **Copy the contract address and send it to me** — I'll
    verify the on-chain bytecode matches the build byte-for-byte before
    anything else happens.

## What happens after (not now)

- Epoch 1 runs 2026-09-28 → 2026-10-04. On Monday 2026-10-05 the epoch is
  scored, the Merkle root is built, and I'll hand you a second signing
  session: (1) transfer 1/8 of treasury MUSEBOOK into the contract,
  (2) call `publishRoot` with the epoch root. Same wallet, same Remix
  page — different clicks, and I'll walk you through them then.
- Nothing is live until you deploy. The site still has `DISTRIBUTOR = null`
  and the passcode gate stays up throughout.

## If something looks wrong

Stop and tell me what the screen says — don't guess through a signing
prompt. The safe states are: nothing deployed (no harm done), or
deployed with the wrong constructor args (we redeploy — costs a few
cents, no user funds involved yet).
