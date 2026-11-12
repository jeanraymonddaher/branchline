const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, net } = require('electron');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const DEV = !app.isPackaged;
if (DEV && process.env.BL_USERDATA) app.setPath('userData', process.env.BL_USERDATA);

let win = null;
const watchers = new Map();

// Apps launched from Finder get a minimal PATH. Hooks and credential helpers
// (gh, node, git-lfs) need the PATH the user's login shell has.
let envPath = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');
function loadLoginPath() {
  const sh = process.env.SHELL || '/bin/zsh';
  execFile(sh, ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 8000, encoding: 'utf8' }, (err, out) => {
    const m = out && out.match(/__P__([\s\S]*?)__P__/);
    if (m && m[1]) envPath = m[1] + ':/opt/homebrew/bin:/usr/local/bin';
  });
}

function runGit(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PATH: envPath,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      LC_ALL: 'en_US.UTF-8',
      ...(opts.env || {}),
    };
    let child;
    try {
      child = spawn('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
        cwd: cwd || os.homedir(),
        env,
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e.message) });
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e.message) }));
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    );
    if (opts.stdin != null) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

const storeFile = () => path.join(app.getPath('userData'), 'state.json');

ipcMain.handle('git', (e, cwd, args, opts) => runGit(cwd, args, opts));
ipcMain.handle('gh', (e, args, cwd) =>
  new Promise((resolve) => {
    execFile('gh', args, { cwd: cwd || os.homedir(), env: { ...process.env, PATH: envPath, GH_PROMPT_DISABLED: '1' }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: stdout || '', stderr: stderr || (err ? String(err.message) : '') })
    );
  })
);
ipcMain.handle('store:load', () => {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('store:save', (e, data) => {
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(data, null, 2));
});
ipcMain.handle('pickDir', async (e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pickDirs', async (e, title) => {
  const r = await dialog.showOpenDialog(win, { title, message: 'Select one or more repositories, or a folder that contains them', buttonLabel: 'Open', properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
// Git repositories directly inside a folder (for opening a whole projects folder at once).
ipcMain.handle('childRepos', (e, dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && fs.existsSync(path.join(dir, d.name, '.git')))
      .map((d) => path.join(dir, d.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
});
ipcMain.handle('repoOp', (e, gitDir) => {
  const has = (f) => fs.existsSync(path.join(gitDir, f));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
});
ipcMain.handle('watch', (e, repoPath, gitDir) => {
  if (watchers.has(repoPath)) return;
  let timer = null;
  try {
    const w = fs.watch(gitDir, { recursive: true }, (ev, file) => {
      if (!file || file.startsWith('objects') || file.endsWith('.lock')) return;
      clearTimeout(timer);
      timer = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('repo-changed', repoPath), 350);
    });
    w.on('error', () => {});
    watchers.set(repoPath, w);
  } catch {}
});
ipcMain.handle('unwatch', (e, repoPath) => {
  const w = watchers.get(repoPath);
  if (w) w.close();
  watchers.delete(repoPath);
});
ipcMain.handle('trash', async (e, files) => {
  for (const f of files) {
    try {
      await shell.trashItem(f);
    } catch {
      fs.rmSync(f, { recursive: true, force: true });
    }
  }
});
ipcMain.handle('terminal', (e, dir) => spawn('open', ['-a', 'Terminal', dir], { detached: true }).unref());
ipcMain.handle('reveal', (e, file) => shell.showItemInFolder(file));
ipcMain.handle('copy', (e, text) => clipboard.writeText(String(text)));
ipcMain.handle('info', () => ({ version: app.getVersion(), home: os.homedir(), devOpen: DEV ? process.env.BL_OPEN || null : null }));

// ---- updates: releases live on GitHub; download the DMG and swap the app.
const REPO = 'jeanraymonddaher/branchline';
// The repo is public, so the check and download need no sign-in.
async function latestRelease() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'Branchline', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((x) => x.name.endsWith('.dmg'));
  return { version: String(rel.tag_name).replace(/^v/, ''), url: asset && asset.browser_download_url, name: asset && asset.name };
}
function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
let updating = false;
async function checkForUpdates(manual) {
  if (updating) return;
  let rel;
  try {
    rel = await latestRelease();
  } catch (e) {
    if (manual) dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates', detail: String(e.message).slice(0, 400) });
    return;
  }
  const latest = rel.version;
  if (!rel.url || !isNewer(latest, app.getVersion())) {
    if (manual) dialog.showMessageBox(win, { message: 'Branchline is up to date', detail: `Version ${app.getVersion()} is the latest.` });
    return;
  }
  const { response } = await dialog.showMessageBox(win, {
    message: `Branchline ${latest} is available`,
    detail: `You have ${app.getVersion()}. Updating downloads the new version and restarts the app.`,
    buttons: ['Update and Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) installUpdate(rel);
}
async function installUpdate(rel) {
  if (DEV) return dialog.showMessageBox(win, { message: 'Running from source', detail: 'Updates only install into the packaged app.' });
  updating = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchline-update-'));
  const dmg = rel.name;
  try {
    const res = await net.fetch(rel.url, { headers: { 'User-Agent': 'Branchline' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(path.join(dir, dmg)));
  } catch (e) {
    updating = false;
    return dialog.showMessageBox(win, { type: 'warning', message: 'Update download failed', detail: String(e.message).slice(0, 400) });
  }
  const target = path.resolve(process.execPath, '..', '..', '..');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
MNT="$(mktemp -d)"
hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$1" || { open "$2"; exit 1; }
if [ -d "$MNT/Branchline.app" ]; then
  rm -rf "$2.new"
  cp -R "$MNT/Branchline.app" "$2.new" && rm -rf "$2" && mv "$2.new" "$2"
  xattr -cr "$2"
fi
hdiutil detach -quiet "$MNT"
open "$2"
`
  );
  spawn('/bin/bash', [script, path.join(dir, dmg), target], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

function send(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', cmd);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => checkForUpdates(true) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Repositories…', accelerator: 'Cmd+O', click: () => send('open') },
        { label: 'Clone Repository…', accelerator: 'Cmd+Shift+O', click: () => send('clone') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'Cmd+W', click: () => send('close-tab') },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: () => send('settings') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Repository',
      submenu: [
        { label: 'Fetch All', accelerator: 'Cmd+Shift+F', click: () => send('fetch') },
        { label: 'Pull', accelerator: 'Cmd+Shift+L', click: () => send('pull') },
        { label: 'Push', accelerator: 'Cmd+Shift+P', click: () => send('push') },
        { type: 'separator' },
        { label: 'New Branch…', accelerator: 'Cmd+B', click: () => send('branch') },
        { label: 'Search Commits', accelerator: 'Cmd+F', click: () => send('search') },
        { label: 'Refresh', accelerator: 'Cmd+R', click: () => send('refresh') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: (DEV && +process.env.BL_W) || 1560,
    height: (DEV && +process.env.BL_H) || 940,
    minWidth: 980,
    minHeight: 560,
    backgroundColor: '#1b1d23',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => (win = null));

  if (DEV) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
    if (process.env.BL_SHOT) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      win.webContents.once('did-finish-load', async () => {
        await sleep(+process.env.BL_WAIT || 3000);
        if (process.env.BL_EVAL) {
          try {
            const out = await win.webContents.executeJavaScript(fs.readFileSync(process.env.BL_EVAL, 'utf8'));
            if (out !== undefined) console.log('EVAL:', JSON.stringify(out));
          } catch (err) {
            console.log('EVALERR', err.message);
          }
          await sleep(1500);
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.BL_SHOT, img.toPNG());
        app.quit();
      });
    }
  }
}

app.whenReady().then(() => {
  loadLoginPath();
  buildMenu();
  createWindow();
  if (!DEV) setTimeout(() => checkForUpdates(false), 8000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
