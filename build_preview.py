#!/usr/bin/env python3
"""Rebuild ~/workspace/muse-dog-lol/site-preview.html from the site sources.

The preview is a single self-contained file with ALL site pages embedded:
styles.css is inlined, local images are embedded as base64 data URIs, and
nav links switch between pages in-file (app.js <script> tags are stripped
since they need a live API).
"""
import base64
import mimetypes
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(BASE, "site")
PAGES = ["index", "register", "mint", "verify", "api"]

NAV_SCRIPT = """
<script>
document.addEventListener('click', function (e) {
  var a = e.target.closest('a[data-goto]');
  if (!a) return;
  e.preventDefault();
  var name = a.getAttribute('data-goto');
  document.querySelectorAll('.pp-page').forEach(function (p) {
    p.hidden = (p.getAttribute('data-page') !== name);
  });
  window.scrollTo(0, 0);
});
</script>
"""


def embed_images(html):
    def embed(m):
        fname = m.group(1)
        path = os.path.join(SITE, fname)
        if not os.path.exists(path):
            return m.group(0)
        mime, _ = mimetypes.guess_type(path)
        mime = mime or "image/jpeg"
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return f'src="data:{mime};base64,{b64}"'

    return re.sub(
        r'src="(musedog(?:\.jpg|-banner\.jpg|-blocks\.jpg)|hero(?:\.jpg|-dog\.png)|fees-loop\.png|favicon\.webp|icon-(?:airdrop|mint|register|verify)\.webp|gallery-\d+\.webp)"',
        embed,
        html,
    )


def main():
    with open(os.path.join(SITE, "styles.css"), encoding="utf-8") as f:
        css = f.read()

    page_divs = []
    for name in PAGES:
        with open(os.path.join(SITE, name + ".html"), encoding="utf-8") as f:
            html = f.read()
        body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
        body = embed_images(body)
        # Strip app.js (needs a live API; useless in a static preview).
        body = re.sub(r'\s*<script src="app\.js"></script>', "", body)
        # Rewrite page links to in-file navigation.
        body = re.sub(r'href="([a-z]+)\.html"', r'href="#" data-goto="\1"', body)
        hidden = "" if name == "index" else " hidden"
        page_divs.append(
            f'<div class="pp-page" data-page="{name}"{hidden}>\n{body}\n</div>'
        )

    out_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muse Dogs — site preview</title>
<style>
{css}
.pp-page[hidden] {{ display: none; }}
</style>
</head>
<body>
{''.join(page_divs)}
{NAV_SCRIPT}
</body>
</html>
"""
    out = os.path.join(BASE, "site-preview.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(out_html)
    print("wrote", out, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    main()
