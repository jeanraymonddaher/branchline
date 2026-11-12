# Branchline

A dark, graph-first Git client for macOS with profile switching. It drives the `git` CLI already on the machine.

## Install on another Mac

Paste this into Terminal:

```
curl -fsSL https://raw.githubusercontent.com/jeanraymonddaher/branchline/main/scripts/install.sh | bash
```

This downloads the latest release, puts Branchline in Applications and opens it. The app is not notarized; the script clears the macOS quarantine flag so it opens normally.

Needs `git` (Xcode command line tools). Cloning from the GitHub list also needs the GitHub CLI signed in (`brew install gh && gh auth login`).

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
