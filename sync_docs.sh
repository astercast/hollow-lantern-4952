#!/bin/bash
# sync_docs.sh — mirrors site/ -> docs/ (GitHub Pages) then strips everything
# except the lock page AND the live pages. PRE-ANNOUNCEMENT ONLY:
# inner pages must not exist there until launch — except the pages Andrew
# explicitly launched early: rewards.html (with the merged leaderboard board
# + claim panel), leaderboard.html (redirects to rewards#leaderboard),
# leaderboard.js, claim.js, agent-claim.html, why.html, api.html,
# and the api/v1/rewards fixtures.
# After announcement, replace this with a plain full mirror.
set -e
cd ~/workspace/muse-dog-lol

cp site/*.html docs/
# Live leaderboard system (punched through the lock on Andrew's word, 2026-09-26)
cp site/leaderboard.js site/app.js site/claim.js docs/
mkdir -p docs/data/v1/rewards
cp site/data/v1/rewards/*.json docs/data/v1/rewards/
cp site/icon-rewards.webp docs/
mkdir -p docs/art
cp site/art/poster-mdog-musebook-pool.webp site/art/poster-claim-anytime.webp docs/art/ 2>/dev/null || true
cp site/styles.css site/musedog.jpg site/gate-dog.webp docs/
cp site/favicon.png site/apple-touch-icon.png docs/
rm -f docs/favicon.webp
cp site/CNAME docs/ 2>/dev/null || true

# Remove inner pages and anything only they use — EXCEPT the live leaderboard
# system and the live rewards.html + api.html pages.
rm -f docs/home.html docs/register.html docs/verify.html docs/mint.html
rm -f docs/porch.html docs/safe.html
rm -f docs/middleware.js
rm -rf docs/api
rm -f docs/hero-dog.png docs/fees-loop.png docs/musedog-banner.jpg
rm -f docs/media-generation-last-upload-handles.json
rm -f docs/icon-airdrop.webp docs/icon-mint.webp docs/icon-register.webp docs/icon-verify.webp

# Trim dead nav links from the lock-page copy (keep Home only)
python3 - <<'EOF'
import re
p = "docs/index.html"
s = open(p).read()
s = re.sub(r'\s*<a href="verify\.html">Verify</a>\n', '\n', s)
s = re.sub(r'\s*<a href="api\.html">API</a>\n', '\n', s)
open(p, "w").write(s)
EOF

echo "docs/ stripped to lock page + live pages:"
ls docs/
