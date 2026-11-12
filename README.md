# Branchline

A dark, graph-first Git client for macOS with profile switching. It drives the `git` CLI already on the machine.

## Install on another Mac

Needs the GitHub CLI signed in to the account that owns this repo (`brew install gh && gh auth login`). Then run:

```
gh api repos/jeanraymonddaher/branchline/contents/scripts/install.sh -H "Accept: application/vnd.github.raw" | bash
```

This downloads the latest release, puts Branchline in Applications and opens it. The app is not notarized; the script clears the macOS quarantine flag so it opens normally.

Also needs `git` (Xcode command line tools).

## Updates

Branchline checks GitHub for a newer release when it starts and offers "Update and Restart". You can also use Branchline → Check for Updates….

To publish a new version from the development Mac:

```
npm run release            # 1.0.0 -> 1.0.1, builds, pushes, publishes
npm run release -- minor   # or major, or an exact version
```

## Develop

```
npm install
npm start          # run from source
npm run dist       # build dist/Branchline-<version>-universal.dmg
npm run icon       # regenerate build/icon.png
npm run release    # publish a new version (see Updates)
```

- `src/main.js` — Electron main process: runs git/gh, file watching, menus.
- `src/renderer/graph.js` — lane layout and per-row drawing of the commit graph.
- `src/renderer/git.js` — git commands and parsing.
- `src/renderer/app.js` — the UI.

Settings, tabs and profiles are stored in `~/Library/Application Support/Branchline/state.json`.
