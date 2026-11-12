const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  git: call('git'),
  gh: call('gh'),
  storeLoad: call('store:load'),
  storeSave: call('store:save'),
  pickDir: call('pickDir'),
  pickDirs: call('pickDirs'),
  childRepos: call('childRepos'),
  repoOp: call('repoOp'),
  watch: call('watch'),
  unwatch: call('unwatch'),
  trash: call('trash'),
  terminal: call('terminal'),
  reveal: call('reveal'),
  copy: call('copy'),
  info: call('info'),
  openUrl: call('openUrl'),
  checkUpdates: call('update:check'),
  onUpdateAvailable: (fn) => ipcRenderer.on('update-available', (e, v) => fn(v)),
  pathFor: (file) => webUtils.getPathForFile(file),
  onRepoChanged: (fn) => ipcRenderer.on('repo-changed', (e, p) => fn(p)),
  onMenu: (fn) => ipcRenderer.on('menu', (e, cmd) => fn(cmd)),
});
