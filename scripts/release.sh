#!/bin/bash
# Cuts a release: bumps the version, builds the DMG, pushes, and publishes it on GitHub.
# Usage: npm run release            (patch bump: 1.0.0 -> 1.0.1)
#        npm run release -- minor   (or major, or an exact version like 1.2.0)
#        npm run release -- current (publish the version already in package.json)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=jeanraymonddaher/branchline
TOKEN="$(gh auth token --user "${REPO%%/*}" 2>/dev/null || true)"
[ -n "$TOKEN" ] && export GH_TOKEN="$TOKEN"
[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first."; exit 1; }
BUMP="${1:-patch}"
if [ "$BUMP" != current ]; then npm version "$BUMP" -m "Release %s" >/dev/null; fi
V="$(node -p "require('./package.json').version")"
git rev-parse -q --verify "refs/tags/v$V" >/dev/null || git tag "v$V"
npm run dist
git push origin HEAD "v$V"
gh release create "v$V" "dist/Branchline-$V-universal.dmg" --repo "$REPO" --title "Branchline $V" --generate-notes
echo "Released v$V. The other Macs will offer the update on next launch."
