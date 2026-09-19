# Muse Dogs — Arweave Storage Plan

Status: **locked by Andrew, 2026-09-18.** Nothing has been uploaded yet — Andrew's art picks and the final 500-row token manifest come first.

## Decision

All 500 images and all 500 metadata JSON files live on **Arweave** (pay once, stored forever). Fully-on-chain storage was rejected: 500 full-resolution images would cost an enormous amount of storage gas.

## What gets uploaded

- **500 images** — final PNG/JPG art, one per token ID (0–499), exactly the images Andrew approves.
- **500 metadata JSON files** — flat structure (no rarity tiers), each with: name, description, `image` (Arweave TXID of the artwork), attributes (same schema for every token, unique values).
- Naming: `images/0.png … 499.png`, `metadata/0.json … 499.json`.

## Tooling options

- **Bundlr / Irys (recommended):** bundles the ~1,000 files into one Arweave transaction, funded with ETH/MATIC/SOL. Cheapest and simplest — one payment, one upload job.
- **Arweave CLI (`arweave-deploy` / `ardrive`):** uploads files individually; fine for small batches but slower for 1,000 files.
- **Gateway:** `https://arweave.net/<txid>` — the contract's `baseURI` points at the manifest root so `tokenURI(n)` resolves to `https://arweave.net/<manifest>/<n>.json`.

## Manifest approach

One **Arweave path manifest** is the primary method:

1. Upload all images + metadata with Bundlr/Irys as a data bundle.
2. Publish a single manifest transaction mapping `/0.json … /499.json` (and `/images/...`) to their TXIDs.
3. `baseURI` = `https://arweave.net/<manifest-txid>/` → `tokenURI(42)` = `https://arweave.net/<manifest-txid>/42.json`.

Fallback: if the manifest approach hits tooling issues, record per-file TXIDs directly in the 500-row token manifest and use a baseURI pointing at the metadata bundle root. Either way, the 500-row token manifest is the source of truth for token ID → image.

## Cost estimation (do this once art is final)

1. Sum total bytes of the 500 final images + 500 JSON files.
2. Get a live Bundlr/Irys quote for that byte count (their CLI/API returns a price for the bundle).
3. Typical scale: ~500 images × ~1–2 MB + 500 × ~2 KB JSON ≈ 0.5–1 GB → on the order of a few dollars in AR (verify at upload time; prices move).
4. Fund the Bundlr/Irys node, upload, confirm every TXID resolves on `arweave.net` before touching the contract.

**Do not upload anything now** — wait for Andrew's final art picks and the locked 500-row manifest.

## Setting baseURI on the contract

1. Contract deploys with a placeholder `initialBaseURI` (off-chain docs only; nothing is minted before the real URI is set).
2. After the Arweave upload is verified: multisig owner calls `setBaseURI("https://arweave.net/<manifest-txid>/")` (emits `BaseURIUpdated`).
3. After mint completes (or whenever Andrew decides the metadata is final): owner calls `freezeMetadata()` — one-way, permanent. Never freeze before verifying every token's `tokenURI` resolves.

## Sequencing with immediate reveal

Because the reveal is immediate, the Arweave upload **must complete before mint opens**. Order:

1. Andrew picks final 500 art → 500-row token manifest locked.
2. Generate 500 metadata JSONs → upload images + metadata to Arweave → verify.
3. Deploy contract (placeholder baseURI) → `setBaseURI(manifest URL)` → spot-check `tokenURI(n)` on testnet/anvil.
4. Open holder airdrops / community claims.
5. `freezeMetadata()` when the collection is done minting out.
