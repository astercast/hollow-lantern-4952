#!/bin/bash
# sync_docs.sh — full mirror of site/ -> docs/ (GitHub Pages serves the public
# site from /docs). The site is public (no passcode gate): mirror everything.
set -e
cd ~/workspace/muse-dog-lol

# Pages, scripts, styles
cp site/*.html docs/
cp site/*.js docs/
cp site/*.css docs/

# Images and root assets (skip package files, vercel.json, node_modules)
cp site/*.png site/*.jpg site/*.jpeg site/*.webp site/*.svg site/*.ico docs/ 2>/dev/null || true
cp site/CNAME docs/ 2>/dev/null || true

# Art
mkdir -p docs/art
cp site/art/* docs/art/ 2>/dev/null || true

# Rewards fixtures served next to the pages
mkdir -p docs/data/v1/rewards
cp site/data/v1/rewards/*.json docs/data/v1/rewards/ 2>/dev/null || true

# Rewards claim data for the claim panel (populated at wiring time, after
# funding + root publication): manifest.json + claims-<epochId>.json, served
# from the same relative path site/claim.js fetches.
if [ -f site/api/v1/rewards/manifest.json ]; then
  mkdir -p docs/api/v1/rewards
  cp site/api/v1/rewards/manifest.json docs/api/v1/rewards/
  cp site/api/v1/rewards/claims-*.json docs/api/v1/rewards/ 2>/dev/null || true
fi

echo "docs/ full mirror:"
ls docs/
