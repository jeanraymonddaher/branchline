#!/bin/bash
# Installs or updates Branchline from the latest GitHub release. Run on any Mac:
#   curl -fsSL https://raw.githubusercontent.com/jeanraymonddaher/branchline/main/scripts/install.sh | bash
set -euo pipefail
REPO=jeanraymonddaher/branchline
APP=/Applications/Branchline.app
URL="$(curl -fsSL -H "User-Agent: branchline-installer" "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$URL" ] || { echo "Could not find the latest release."; exit 1; }
TMP="$(mktemp -d)"
echo "Downloading $(basename "$URL")…"
curl -fL --progress-bar -o "$TMP/Branchline.dmg" "$URL"
MNT="$(mktemp -d)"
hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$TMP/Branchline.dmg"
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
echo "Installed Branchline $(defaults read "$APP/Contents/Info" CFBundleShortVersionString)."
