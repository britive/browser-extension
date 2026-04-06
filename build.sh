#!/usr/bin/env bash
set -euo pipefail

# Build script for Britive Browser Extension
# Produces release-ready archives for Firefox and Chrome.

VERSION=$(grep -m1 '"version"' firefox/manifest.json | sed 's/.*: *"\(.*\)".*/\1/')

DIST_DIR="dist"
mkdir -p "$DIST_DIR"

echo "Building Britive Browser Extension v${VERSION}"
echo ""

# Firefox
FIREFOX_OUT="${DIST_DIR}/firefox-extension-${VERSION}.xpi"
rm -f "$FIREFOX_OUT"
(cd firefox && zip -qr "../${FIREFOX_OUT}" .)
echo "  Firefox: ${FIREFOX_OUT} ($(wc -c < "$FIREFOX_OUT" | tr -d ' ') bytes)"

# Chrome
CHROME_OUT="${DIST_DIR}/chrome-extension-${VERSION}.zip"
rm -f "$CHROME_OUT"
(cd chrome && zip -qr "../${CHROME_OUT}" .)
echo "  Chrome:  ${CHROME_OUT} ($(wc -c < "$CHROME_OUT" | tr -d ' ') bytes)"

echo ""
echo "Done."
