#!/bin/bash
# Installs or updates Branchline from the latest GitHub release.
# First install on a new Mac (needs: brew install gh && gh auth login):
#   gh api repos/jeanraymonddaher/branchline/contents/scripts/install.sh -H "Accept: application/vnd.github.raw" | bash
set -euo pipefail
REPO=jeanraymonddaher/branchline
APP=/Applications/Branchline.app
command -v gh >/dev/null || { echo "GitHub CLI missing. Run: brew install gh && gh auth login"; exit 1; }
# With several gh accounts, use the one that owns the repo.
TOKEN="$(gh auth token --user "${REPO%%/*}" 2>/dev/null || true)"
[ -n "$TOKEN" ] && export GH_TOKEN="$TOKEN"
TMP="$(mktemp -d)"
echo "Downloading the latest Branchline…"
gh release download --repo "$REPO" --pattern '*.dmg' --dir "$TMP"
DMG="$(ls "$TMP"/*.dmg | head -1)"
MNT="$(mktemp -d)"
hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$DMG"
trap 'hdiutil detach -quiet "$MNT" || true; rm -rf "$TMP"' EXIT
[ -d "$MNT/Branchline.app" ] || { echo "The release has no Branchline.app in it"; exit 1; }
osascript -e 'quit app "Branchline"' 2>/dev/null || true
sleep 1
rm -rf "$APP.new"
cp -R "$MNT/Branchline.app" "$APP.new"
rm -rf "$APP"
mv "$APP.new" "$APP"
xattr -cr "$APP"
open "$APP"
echo "Installed $(defaults read "$APP/Contents/Info" CFBundleShortVersionString)."
