#!/bin/bash
# sync_docs.sh — mirrors site/ -> docs/ (GitHub Pages) then strips everything
# except the lock page. PRE-ANNOUNCEMENT ONLY: GitHub Pages cannot run the
# edge middleware, so inner pages must not exist there until launch.
# After announcement, replace this with a plain full mirror.
set -e
cd ~/workspace/muse-dog-lol

cp site/*.html docs/
cp site/styles.css site/musedog.jpg site/gate-dog.webp docs/
cp site/favicon.png site/apple-touch-icon.png docs/
rm -f docs/favicon.webp
cp site/CNAME docs/ 2>/dev/null || true

# Remove inner pages and anything only they use
rm -f docs/home.html docs/register.html docs/verify.html docs/rewards.html docs/api.html docs/mint.html
rm -f docs/app.js docs/middleware.js
rm -rf docs/api
rm -f docs/hero-dog.png docs/fees-loop.png docs/musedog-banner.jpg
rm -f docs/media-generation-last-upload-handles.json
rm -f docs/icon-airdrop.webp docs/icon-mint.webp docs/icon-register.webp docs/icon-rewards.webp docs/icon-verify.webp

# Trim dead nav links from the lock-page copy (keep Home only)
python3 - <<'EOF'
import re
p = "docs/index.html"
s = open(p).read()
s = re.sub(r'\s*<a href="verify\.html">Verify</a>\n', '\n', s)
s = re.sub(r'\s*<a href="api\.html">API</a>\n', '\n', s)
open(p, "w").write(s)
EOF

echo "docs/ stripped to lock page only:"
ls docs/
