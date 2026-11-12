import { h, put, icon, toast, menu, menuAt, closeMenu, form, confirmBox, debounce } from './ui.js';
import * as G from './git.js';
import { layout, rowSvg, laneColor, laneX, ROW, LANE, NODE_R, setCompact } from './graph.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const short = (sha) => (sha || '').slice(0, 6);
const cap = (n) => (n > 99 ? '99+' : String(n));
const base = (p) => p.split('/').filter(Boolean).pop() || p;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let INFO = { version: '', home: '' };
let S = {
  tabs: [],
  active: 0,
  profiles: [],
  profileId: null,
  recent: [],
  cloneDir: null,
  avatarMap: {},
  settings: { avatars: true, limit: 2000, pullMode: 'ff', fileView: 'path', refW: 150, graphW: null, compact: false, smart: false, cols: { ref: true, graph: true, msg: true, author: false, date: false, sha: false } },
};
const repos = new Map();
const save = debounce(() => api.storeSave(S), 250);
const R = () => (S.tabs[S.active] ? repos.get(S.tabs[S.active].path) : null);

function newRepo(path) {
  return {
    path,
    data: null,
    rows: [],
    index: new Map(),
    bySha: new Map(),
    refMap: new Map(),
    selected: null,
    multi: new Set(),
    anchor: null,
    view: null,
    limit: S.settings.limit,
    undo: [],
    redo: [],
    msg: { summary: '', desc: '', amend: false },
    open: { local: true, remote: true, tags: true, stashes: true },
    folders: {},
    files: new Map(),
    version: 0,
    scrollTop: 0,
    busy: false,
    pending: null,
    search: null,
  };
}

// ------------------------------------------------------------ data refresh
async function refresh(path, { statusOnly = false } = {}) {
  const r = repos.get(path);
  if (!r) return;
  if (r.busy) {
    r.pending = r.pending === 'full' || !statusOnly ? 'full' : 'status';
    return;
  }
  r.busy = true;
  let changed = true;
  try {
    if (statusOnly && r.data) {
      const st = await G.loadStatus(path);
      if (st.raw === r.data.status.raw) changed = false;
      else if (st.head.sha !== r.data.head.sha || st.head.branch !== r.data.head.branch) {
        r.data = await G.loadRepo(path, r.limit, r.data);
      } else {
        const wasDirty = isDirty(r);
        r.data.status = st;
        r.data.head = st.head;
        r.data.same = wasDirty === isDirty(r);
      }
    } else {
      const first = !r.data;
      r.data = await G.loadRepo(path, r.limit, r.data);
      if (first && r.data.gitDir) api.watch(path, r.data.gitDir);
      if (first && S.settings.avatars) {
        G.githubAvatars(path).then((found) => {
          const fresh = Object.entries(found).filter(([e, u]) => S.avatarMap[e] !== u);
          if (!fresh.length) return;
          for (const [e, u] of fresh) (S.avatarMap[e] = u), G.setAvatar(e, u);
          save();
          r.version++;
          r.rightSig = null;
          if (r === R()) renderRepo();
        });
      }
    }
    if (changed) await rebuild(r);
  } catch (e) {
    console.log('refresh error', e.message, e.stack);
  } finally {
    r.busy = false;
  }
  if (r.pending) {
    const p = r.pending;
    r.pending = null;
    return refresh(path, { statusOnly: p === 'status' });
  }
  if (changed && r === R()) renderRepo();
}

const isDirty = (r) => {
  const st = r.data.status;
  return st.staged.length + st.unstaged.length + st.conflicted.length > 0;
};

async function rebuild(r) {
  const d = r.data;
  const dirty = isDirty(r);
  const hadWip = r.rows[0]?.commit.wip;
  if (!d.same || !!hadWip !== dirty || !r.rows.length) {
    const list = dirty ? [{ sha: 'WIP', parents: d.head.sha ? [d.head.sha] : [], wip: true }, ...d.commits] : [...d.commits];
    // Stashes appear in the graph just above the commit they were made on.
    const stashRows = [];
    for (const s of d.stashes) {
      const at = list.findIndex((c) => c.sha === s.parents[0]);
      if (at < 0) continue;
      const row = { sha: s.sha, parents: [s.parents[0]], stash: s, author: 'Stash', email: '', at: s.ct, ct: s.ct, subject: s.msg, body: '' };
      list.splice(at, 0, row);
      stashRows.push(row);
    }
    const g = layout(list);
    r.rows = g.rows;
    r.maxCol = g.maxCol;
    r.index = new Map(r.rows.map((row, i) => [row.commit.sha, i]));
    r.bySha = new Map([...d.commits, ...stashRows].map((c) => [c.sha, c]));
    r.refMap = buildRefMap(d);
    r.version++;
    if (S.settings.avatars) await G.resolveAvatars([...new Set(d.commits.map((c) => c.email))]);
  }
  for (const s of [...r.multi]) if (!r.index.has(s)) r.multi.delete(s);
  if (!r.selected || !r.index.has(r.selected)) {
    r.selected = dirty ? 'WIP' : d.head.sha;
    updateSelection();
  }
  if (r.view && r.view.mode !== 'commit') {
    const list = r.view.mode === 'staged' ? d.status.staged : [...d.status.unstaged, ...d.status.conflicted];
    const f = list.find((x) => x.path === r.view.file.path);
    if (f) r.view.file = f;
    else r.view = null;
  }
}

function buildRefMap(d) {
  const m = new Map();
  const add = (sha, name, patch) => {
    let arr = m.get(sha);
    if (!arr) m.set(sha, (arr = []));
    let g = arr.find((x) => x.name === name && !!x.tag === !!patch.tag);
    if (!g) arr.push((g = { name }));
    Object.assign(g, patch);
  };
  for (const l of d.refs.locals) add(l.sha, l.name, { local: l, head: l.head });
  for (const x of d.refs.remotes) add(x.sha, x.short, { remote: x });
  for (const t of d.refs.tags) add(t.sha, t.name, { tag: t });
  if (!d.head.branch && d.head.sha) add(d.head.sha, 'HEAD', { head: true, detached: true });
  const rank = (g) => (g.head ? 0 : g.local ? 1 : g.remote ? 2 : 3);
  for (const arr of m.values()) arr.sort((a, b) => rank(a) - rank(b));
  return m;
}

// ------------------------------------------------------------ git operations
function gitError(title, res) {
  toast('').error(title, ((res.stderr || '') + (res.stdout ? '\n' + res.stdout : '')).trim().slice(0, 3000));
}

// Run a git command with a progress toast, then refresh. Returns the result or null on failure.
async function op(label, args, opts = {}) {
  const r = opts.repo || R();
  if (!r) return null;
  const t = toast(label + '…', { spin: true });
  const res = await G.git(r.path, args, opts);
  if (res.code !== 0) {
    t.close();
    if (!opts.silentFail) gitError(label + ' failed', res);
    await refresh(r.path);
    return opts.silentFail ? { failed: true, ...res } : null;
  }
  t.done(label + ' — done');
  await refresh(r.path);
  return res;
}

// Quiet variant for frequent actions (stage, unstage).
async function run(args, opts) {
  const r = R();
  const res = await G.git(r.path, args, opts);
  if (res.code !== 0) gitError('Git error', res);
  await refresh(r.path);
  return res.code === 0;
}

function pushUndo(r, entry) {
  r.undo.push(entry);
  r.redo = [];
  renderToolbar();
}
async function undo() {
  const r = R();
  const e = r?.undo.pop();
  if (!e) return;
  if (await op('Undo ' + e.label, e.undo)) r.redo.push(e);
  renderToolbar();
}
async function redo() {
  const r = R();
  const e = r?.redo.pop();
  if (!e) return;
  if (await op('Redo ' + e.label, e.redo)) r.undo.push(e);
  renderToolbar();
}

async function checkout(ref) {
  const r = R();
  const prev = r.data.head.branch || r.data.head.sha;
  let args;
  let target;
  if (ref.type === 'remote') {
    const local = r.data.refs.locals.find((l) => l.name === ref.short);
    target = ref.short;
    args = local ? ['checkout', ref.short] : ['checkout', '--track', ref.name];
  } else {
    target = ref.name || ref.sha;
    args = ['checkout', target];
  }
  if (target === r.data.head.branch) return;
  if ((await op('Checkout ' + (ref.name || short(ref.sha)), args)) && prev) {
    pushUndo(r, { label: 'checkout', undo: ['checkout', prev], redo: ['checkout', target] });
  }
}

async function fetchAll() {
  await op('Fetch all', ['fetch', '--all', '--prune', '--tags']);
}
const PULL = {
  fetch: { label: 'Fetch All', args: ['fetch', '--all', '--prune', '--tags'] },
  ff: { label: 'Pull (fast-forward if possible)', args: ['pull', '--no-rebase', '--ff'] },
  'ff-only': { label: 'Pull (fast-forward only)', args: ['pull', '--ff-only'] },
  rebase: { label: 'Pull (rebase)', args: ['pull', '--rebase'] },
};
async function pull(mode = S.settings.pullMode) {
  const p = PULL[mode] || PULL.ff;
  await op(p.label, p.args);
}
async function push(branch) {
  const r = R();
  const d = r.data;
  const b = branch || d.refs.locals.find((l) => l.head);
  if (!b) return toast('Check out a branch before pushing.');
  if (!d.remotes.length) return toast('This repository has no remote.');
  const remote = b.upstream ? b.upstream.split('/')[0] : d.remotes.includes('origin') ? 'origin' : d.remotes[0];
  const args = b.upstream && !b.gone ? ['push', remote, b.name] : ['push', '-u', remote, b.name];
  const res = await op('Push ' + b.name, args, { silentFail: true });
  if (res && res.failed) {
    if (/rejected|non-fast-forward|fetch first/i.test(res.stderr)) {
      const ok = await confirmBox(
        'Push rejected',
        `The remote branch has commits that ${b.name} does not. Pull first, or force push to overwrite the remote branch (uses --force-with-lease).`,
        'Force Push',
        true
      );
      if (ok) await op('Force push ' + b.name, [...args, '--force-with-lease']);
    } else gitError('Push failed', res);
  }
}
async function createBranch(at) {
  const v = await form({
    title: 'Create branch',
    message: at ? `New branch at ${short(at)}` : null,
    fields: [
      { name: 'name', label: 'Branch name', required: true, placeholder: 'feature/my-branch' },
      { name: 'checkout', label: 'Check out the new branch', type: 'checkbox', value: true },
    ],
    ok: 'Create Branch',
  });
  if (!v) return;
  const r = R();
  const name = v.name.replace(/\s+/g, '-');
  const prev = r.data.head.branch || r.data.head.sha;
  const args = v.checkout ? ['checkout', '-b', name] : ['branch', name];
  if (at) args.push(at);
  if ((await op('Create branch ' + name, args)) && v.checkout && prev) {
    pushUndo(r, { label: 'checkout', undo: ['checkout', prev], redo: ['checkout', name] });
  }
}
async function stash() {
  const r = R();
  if (!isDirty(r)) return toast('Nothing to stash.');
  await op('Stash', ['stash', 'push', '--include-untracked']);
}
async function pop() {
  const r = R();
  if (!r.data.stashes.length) return toast('No stashes to pop.');
  await op('Pop stash', ['stash', 'pop']);
}
async function mergeInto(name) {
  await op(`Merge ${name} into ${R().data.head.branch}`, ['merge', '--no-edit', name]);
}
async function rebaseOnto(name) {
  await op(`Rebase ${R().data.head.branch} onto ${name}`, ['rebase', '--autostash', name]);
}
async function resetTo(sha, mode) {
  const r = R();
  if (mode === 'hard') {
    const ok = await confirmBox('Reset hard', `Move ${r.data.head.branch || 'HEAD'} to ${short(sha)} and discard all uncommitted changes? This cannot be undone.`, 'Reset Hard', true);
    if (!ok) return;
  }
  const before = r.data.head.sha;
  if ((await op(`Reset (${mode}) to ${short(sha)}`, ['reset', '--' + mode, sha])) && mode !== 'hard') {
    pushUndo(r, { label: 'reset', undo: ['reset', '--' + mode, before], redo: ['reset', '--' + mode, sha] });
  }
}

// The first-parent chain from HEAD: what "the current branch's commits" means for squash.
function headChain(r) {
  const chain = [];
  let c = r.bySha.get(r.data.head.sha);
  while (c) {
    chain.push(c);
    c = c.parents.length ? r.bySha.get(c.parents[0]) : null;
  }
  return chain;
}
// Returns the selected commits newest-first when they are a squashable run, else a reason string.
function squashable(r, shas) {
  if (shas.length < 2) return 'Select two or more commits';
  const chain = headChain(r);
  const pos = shas.map((s) => chain.findIndex((c) => c.sha === s));
  if (pos.some((p) => p < 0)) return 'Commits must be on the current branch';
  pos.sort((a, b) => a - b);
  if (pos[pos.length - 1] - pos[0] !== pos.length - 1) return 'Commits must be consecutive';
  const run = chain.slice(pos[0], pos[pos.length - 1] + 1);
  if (chain.slice(0, pos[pos.length - 1] + 1).some((c) => c.parents.length > 1)) return 'Cannot squash across a merge commit';
  if (!run[run.length - 1].parents.length) return 'Cannot squash the root commit';
  return run;
}
async function squash(shas) {
  const r = R();
  const run_ = squashable(r, shas);
  if (typeof run_ === 'string') return toast(run_);
  const oldest = run_[run_.length - 1];
  const ok = await confirmBox(
    `Squash ${run_.length} commits`,
    `The commits will be combined into "${oldest.subject}". This rewrites history on ${r.data.head.branch || 'HEAD'}; if they were already pushed you will need to force push.`,
    'Squash'
  );
  if (!ok) return;
  const targets = run_.slice(0, -1).map((c) => c.sha.slice(0, 7)).join('|');
  await op(`Squash ${run_.length} commits`, ['rebase', '-i', '--autostash', oldest.parents[0]], {
    env: { GIT_SEQUENCE_EDITOR: `sed -i '' -E 's/^pick (${targets})/squash \\1/'` },
  });
}
async function cherryPick(shas) {
  const r = R();
  const ordered = [...shas].sort((a, b) => r.index.get(b) - r.index.get(a));
  await op(ordered.length > 1 ? `Cherry pick ${ordered.length} commits` : 'Cherry pick ' + short(ordered[0]), ['cherry-pick', ...ordered]);
}
async function deleteBranch(b) {
  const ok = await confirmBox('Delete branch', `Delete local branch ${b.name}?`, 'Delete', true);
  if (!ok) return;
  const res = await op('Delete ' + b.name, ['branch', '-d', b.name], { silentFail: true });
  if (res && res.failed) {
    if (/not fully merged/.test(res.stderr)) {
      if (await confirmBox('Branch not merged', `${b.name} has commits that are not merged anywhere else. Delete it anyway?`, 'Force Delete', true)) {
        await op('Delete ' + b.name, ['branch', '-D', b.name]);
      }
    } else gitError('Delete failed', res);
  }
}
async function continueOp(kind, action) {
  const args = kind === 'merge' ? (action === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit']) : [kind, '--' + action];
  await op(`${action === 'abort' ? 'Abort' : action === 'skip' ? 'Skip' : 'Continue'} ${kind}`, args);
}

// staging
const withOrig = (fs) => fs.flatMap((f) => (f.orig ? [f.path, f.orig] : [f.path]));
const stage = (fs) => run(['add', '-A', '--', ...fs.map((f) => f.path)]);
const stageAll = () => run(['add', '-A']);
const unstage = (fs) => (R().data.head.sha ? run(['reset', '-q', 'HEAD', '--', ...withOrig(fs)]) : run(['rm', '--cached', '-q', '--', ...withOrig(fs)]));
const unstageAll = () => (R().data.head.sha ? run(['reset', '-q', 'HEAD']) : run(['rm', '--cached', '-r', '-q', '.']));
async function discard(fs) {
  const r = R();
  const what = fs.length === 1 ? fs[0].path : plural(fs.length, 'file');
  if (!(await confirmBox('Discard changes', `Discard all changes to ${what}? This cannot be undone.`, 'Discard', true))) return;
  const untracked = fs.filter((f) => f.status === '?');
  const tracked = fs.filter((f) => f.status !== '?');
  if (untracked.length) await api.trash(untracked.map((f) => r.path + '/' + f.path));
  if (tracked.length) await run(['restore', '--worktree', '--', ...tracked.map((f) => f.path)]);
  else await refresh(r.path);
}
async function discardAll() {
  const r = R();
  if (!(await confirmBox('Discard all changes', 'Discard every uncommitted change in this repository, including new files? This cannot be undone.', 'Discard All', true))) return;
  if (r.data.head.sha) await G.git(r.path, ['reset', '--hard', 'HEAD']);
  await op('Discard all changes', ['clean', '-fd']);
}
async function doCommit() {
  const r = R();
  const m = r.msg;
  const st = r.data.status;
  if (!st.staged.length && !m.amend) {
    if (st.unstaged.length) await stageAll();
    return;
  }
  if (!m.summary.trim()) return $('csum')?.focus();
  const before = r.data.head.sha;
  const args = ['commit', '-m', m.summary.trim()];
  if (m.desc.trim()) args.push('-m', m.desc.trim());
  if (m.amend) args.push('--amend');
  const res = await G.git(r.path, args);
  if (res.code !== 0) {
    gitError('Commit failed', res);
    return refresh(r.path);
  }
  r.msg = { summary: '', desc: '', amend: false };
  r.rightSig = null;
  const now = (await G.gitOut(r.path, ['rev-parse', 'HEAD'])).trim();
  if (before && now) pushUndo(r, { label: 'commit', undo: ['reset', '--soft', before], redo: ['reset', '--soft', now] });
  toast('Committed ' + short(now));
  await refresh(r.path);
}

// ------------------------------------------------------------ tabs
async function openRepo(path, { quiet = false } = {}) {
  const res = await G.git(path, ['rev-parse', '--show-toplevel']);
  if (res.code !== 0) {
    if (!quiet) toast('').error('Not a Git repository', path);
    return false;
  }
  const top = res.stdout.trim();
  let i = S.tabs.findIndex((t) => t.path === top);
  if (i < 0) {
    S.tabs.push({ path: top, name: base(top) });
    i = S.tabs.length - 1;
  }
  S.recent = [top, ...S.recent.filter((p) => p !== top)].slice(0, 12);
  activate(i);
  return true;
}
function activate(i) {
  const cur = R();
  if (cur) cur.scrollTop = $('gscroll').scrollTop;
  S.active = i;
  save();
  const t = S.tabs[i];
  if (t && !repos.has(t.path)) repos.set(t.path, newRepo(t.path));
  renderAll();
  if (t) refresh(t.path);
}
function closeTab(i) {
  const t = S.tabs[i];
  if (!t) return;
  api.unwatch(t.path);
  repos.delete(t.path);
  S.tabs.splice(i, 1);
  activate(Math.max(0, Math.min(S.active > i ? S.active - 1 : S.active, S.tabs.length - 1)));
}
async function pickRepo() {
  const dir = await api.pickDir('Open a repository');
  if (dir) openRepo(dir);
}
function renderTabs() {
  put($('tabs'), 
    ...S.tabs.map((t, i) =>
      h(
        'div',
        {
          class: 'tab' + (i === S.active ? ' active' : ''),
          title: t.path,
          draggable: 'true',
          ondragstart: (e) => {
            drag = { tab: i };
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', t.name);
          },
          ondragend: () => {
            drag = null;
            clearDrop();
          },
          ondragover: (e) => {
            if (!drag || drag.tab == null) return;
            e.preventDefault();
            clearDrop();
            if (drag.tab === i) return;
            const b = e.currentTarget.getBoundingClientRect();
            e.currentTarget.classList.add(e.clientX < b.left + b.width / 2 ? 'drop-before' : 'drop-after');
          },
          ondrop: (e) => {
            if (!drag || drag.tab == null) return;
            e.preventDefault();
            const b = e.currentTarget.getBoundingClientRect();
            moveTab(drag.tab, i, e.clientX >= b.left + b.width / 2);
          },
          onclick: () => i !== S.active && activate(i),
          onauxclick: (e) => e.button === 1 && closeTab(i),
          oncontextmenu: (e) =>
            menu(e.clientX, e.clientY, [
              { label: 'Close tab', action: () => closeTab(i) },
              { label: 'Close other tabs', action: () => [...S.tabs.keys()].reverse().forEach((j) => j !== i && closeTab(j)) },
              '-',
              { label: 'Reveal in Finder', action: () => api.reveal(t.path) },
              { label: 'Copy path', action: () => api.copy(t.path) },
            ]),
        },
        icon('branch', 12),
        h('span', { class: 'tname' }, t.name),
        h('span', { class: 'tclose', onclick: (e) => (e.stopPropagation(), closeTab(i)) }, icon('close', 10))
      )
    ),
    h('div', { class: 'tab add', title: 'Open or clone a repository', onclick: (e) => menuAt(e.currentTarget, addMenu()) }, icon('plus', 14))
  );
}
// ---- drag and drop: tabs reorder, files move between Unstaged and Staged, folders from Finder open.
let drag = null;
function clearDrop() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after, .dropzone')) el.classList.remove('drop-before', 'drop-after', 'dropzone');
}
function moveTab(from, to, after) {
  clearDrop();
  let at = to + (after ? 1 : 0);
  if (from < at) at--;
  if (at === from) return;
  const activePath = S.tabs[S.active] && S.tabs[S.active].path;
  const [t] = S.tabs.splice(from, 1);
  S.tabs.splice(at, 0, t);
  S.active = Math.max(0, S.tabs.findIndex((x) => x.path === activePath));
  save();
  renderTabs();
}
function wireDrops() {
  const zoneOf = (e) => {
    const z = e.target.closest && e.target.closest('#right .fsec[data-zone]');
    return z && drag && drag.file && z.dataset.zone !== drag.mode ? z : null;
  };
  const fromFinder = (e) => !drag && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragover', (e) => {
    const z = zoneOf(e);
    if (z) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!z.classList.contains('dropzone')) (clearDrop(), z.classList.add('dropzone'));
    } else if (fromFinder(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    } else if (drag && drag.file) clearDrop();
  });
  addEventListener('drop', async (e) => {
    const z = zoneOf(e);
    if (z) {
      e.preventDefault();
      const { file, mode } = drag;
      drag = null;
      clearDrop();
      return mode === 'unstaged' ? stage([file]) : unstage([file]);
    }
    if (fromFinder(e)) {
      e.preventDefault();
      for (const f of e.dataTransfer.files) {
        const p = api.pathFor(f);
        if (p) await openRepo(p);
      }
    }
  });
}

const addMenu = () => [
  { label: 'Open a repository…', icon: 'folder', hint: '⌘O', action: pickRepo },
  { label: 'Clone from GitHub…', icon: 'cloud', hint: '⇧⌘O', action: cloneDialog },
  ...(S.recent.filter((p) => !S.tabs.some((t) => t.path === p)).length ? ['-', { header: 'Recent' }] : []),
  ...S.recent
    .filter((p) => !S.tabs.some((t) => t.path === p))
    .slice(0, 8)
    .map((p) => ({ label: base(p), hint: p.replace(INFO.home, '~'), action: () => openRepo(p) })),
];

// ------------------------------------------------------------ profiles
const hue = (s) => [...(s || 'x')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
const colorFor = (s) => `hsl(${hue(s)} 45% 42%)`;
const initials = (name) =>
  (name || '?')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
const activeProfile = () => S.profiles.find((p) => p.id === S.profileId) || S.profiles[0];

async function initProfiles() {
  const name = (await G.gitOut(null, ['config', '--global', 'user.name'])).trim();
  const email = (await G.gitOut(null, ['config', '--global', 'user.email'])).trim();
  if (!S.profiles.length) {
    S.profiles = [{ id: 'p' + Date.now(), label: name || 'Default', name, email }];
    S.profileId = S.profiles[0].id;
  } else {
    // Follow a change made outside the app when it matches a known profile.
    const match = S.profiles.find((p) => p.name === name && p.email === email);
    const cur = activeProfile();
    if (match && (cur.name !== name || cur.email !== email)) S.profileId = match.id;
  }
  save();
}
async function switchProfile(p) {
  const a = await G.git(null, ['config', '--global', 'user.name', p.name]);
  const b = await G.git(null, ['config', '--global', 'user.email', p.email]);
  if (a.code || b.code) return gitError('Could not switch profile', a.code ? a : b);
  S.profileId = p.id;
  save();
  renderTitleRight();
  toast(`Profile: ${p.label} — commits are now authored as ${p.name} <${p.email}>`);
  const r = R();
  if (r) refresh(r.path);
}
async function editProfile(p) {
  const v = await form({
    title: p ? 'Edit profile' : 'New profile',
    message: 'Switching to a profile sets your global Git author name and email.',
    fields: [
      { name: 'label', label: 'Profile name', value: p?.label, required: true, placeholder: 'Work' },
      { name: 'name', label: 'Git author name', value: p?.name, required: true, placeholder: 'Jane Doe' },
      { name: 'email', label: 'Git author email', value: p?.email, required: true, placeholder: 'jane@example.com' },
    ],
    ok: p ? 'Save' : 'Create Profile',
  });
  if (!v) return;
  if (p) {
    Object.assign(p, v);
    if (p.id === S.profileId) return switchProfile(p);
  } else {
    p = { id: 'p' + Date.now(), ...v };
    S.profiles.push(p);
    if (await confirmBox('Switch profile', `Switch to ${p.label} now?`, 'Switch')) return switchProfile(p);
  }
  save();
  renderTitleRight();
}
async function deleteProfile(p) {
  if (!(await confirmBox('Delete profile', `Delete the profile ${p.label}? Your Git configuration is not changed.`, 'Delete', true))) return;
  S.profiles = S.profiles.filter((x) => x !== p);
  save();
  renderTitleRight();
}
function profileMenu(anchor) {
  const cur = activeProfile();
  menuAt(
    anchor,
    [
      { header: 'Profiles' },
      ...S.profiles.map((p) => ({ label: p.label, hint: p.email, check: p === cur, action: () => p !== cur && switchProfile(p) })),
      '-',
      { label: 'New profile…', icon: 'plus', action: () => editProfile(null) },
      { label: `Edit ${cur.label}…`, icon: 'pencil', action: () => editProfile(cur) },
      ...S.profiles.filter((p) => p !== cur).map((p) => ({ label: `Delete ${p.label}…`, danger: true, icon: 'trash', action: () => deleteProfile(p) })),
    ],
    { right: true, minWidth: 280 }
  );
}
function renderTitleRight() {
  const p = activeProfile();
  put($('tb-right'), 
    h('button', { class: 'iconbtn', title: 'Preferences', onclick: settingsDialog }, icon('gear', 17)),
    h(
      'button',
      { class: 'iconbtn', id: 'profile-btn', title: `${p.name} <${p.email}>`, onclick: (e) => profileMenu(e.currentTarget) },
      h('span', { class: 'pavatar', style: { background: colorFor(p.email) } }, initials(p.label)),
      h('span', {}, p.label),
      icon('chevDown', 10)
    )
  );
}
async function settingsDialog() {
  const s = S.settings;
  const v = await form({
    title: 'Preferences',
    fields: [
      { name: 'avatars', type: 'checkbox', label: 'Show author avatars (loads from Gravatar and GitHub)', value: s.avatars },
      { name: 'limit', type: 'number', label: 'Commits to load at a time', value: s.limit },
      { name: 'pullMode', type: 'select', label: 'Default pull action', value: s.pullMode, options: Object.entries(PULL).map(([value, p]) => ({ value, label: p.label })) },
    ],
    ok: 'Save',
  });
  if (!v) return;
  s.avatars = v.avatars;
  s.limit = Math.max(200, Math.min(20000, +v.limit || 2000));
  s.pullMode = v.pullMode;
  save();
  for (const r of repos.values()) {
    r.limit = s.limit;
    r.version++;
  }
  const r = R();
  if (r) refresh(r.path);
}

// ------------------------------------------------------------ clone
function cloneDialog() {
  let all = [];
  let picked = null;
  const list = h('div', { class: 'ghlist' }, h('div', { class: 'dnote' }, 'Loading your GitHub repositories…'));
  const search = h('input', { placeholder: 'Search your GitHub repositories', spellcheck: 'false' });
  const url = h('input', { placeholder: 'https://github.com/owner/repo.git  or  owner/repo', spellcheck: 'false' });
  const dest = h('input', { value: S.cloneDir || INFO.home + '/Projects', spellcheck: 'false' });
  const close = () => back.remove();
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = all.filter((x) => !q || x.full_name.toLowerCase().includes(q)).slice(0, 300);
    put(list, 
      ...(items.length
        ? items.map((x) =>
            h(
              'div',
              {
                class: 'ghitem' + (picked === x ? ' on' : ''),
                onclick: () => {
                  picked = x;
                  url.value = x.full_name;
                  draw();
                },
                ondblclick: go,
              },
              h('span', { class: 'gn' }, x.full_name),
              x.private ? h('span', { class: 'gp' }, 'private') : null,
              h('span', { class: 'gd' }, x.description || '')
            )
          )
        : [h('div', { class: 'dnote' }, all.length ? 'No matching repositories.' : list.dataset.msg || 'No repositories found.')])
    );
  };
  async function go() {
    const src = url.value.trim();
    if (!src) return url.focus();
    const name = base(src.replace(/\.git$/, '').replace(/[:]/g, '/'));
    const parent = dest.value.trim().replace(/\/+$/, '');
    const target = parent + '/' + name;
    S.cloneDir = parent;
    save();
    close();
    const t = toast(`Cloning ${name}…`, { spin: true });
    const isSlug = /^[\w.-]+\/[\w.-]+$/.test(src);
    let res = isSlug ? await api.gh(['repo', 'clone', src, target]) : await G.git(null, ['clone', src, target]);
    if (res.code !== 0 && isSlug) res = await G.git(null, ['clone', `https://github.com/${src}.git`, target]);
    if (res.code !== 0) return t.close(), gitError('Clone failed', res);
    t.done(`Cloned ${name}`);
    openRepo(target);
  }
  const back = h(
    'div',
    { class: 'modal-back', onmousedown: (e) => e.target === back && close(), onkeydown: (e) => e.key === 'Escape' && close() },
    h(
      'div',
      { class: 'modal wide' },
      h('div', { class: 'mtitle' }, 'Clone from GitHub'),
      search,
      list,
      h('label', { class: 'frow' }, h('span', { class: 'flabel' }, 'Repository'), url),
      h(
        'label',
        { class: 'frow' },
        h('span', { class: 'flabel' }, 'Clone into folder'),
        h(
          'div',
          { class: 'pathrow' },
          dest,
          h('button', { class: 'btn', onclick: async (e) => (e.preventDefault(), (dest.value = (await api.pickDir('Clone into')) || dest.value)) }, 'Browse…')
        )
      ),
      h('div', { class: 'mbtns' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: go }, 'Clone'))
    )
  );
  search.addEventListener('input', draw);
  url.addEventListener('input', () => ((picked = null), draw()));
  document.body.append(back);
  search.focus();
  Promise.all([1, 2, 3].map((p) => api.gh(['api', `user/repos?per_page=100&sort=pushed&page=${p}`]))).then((pages) => {
    if (pages[0].code !== 0) {
      list.dataset.msg = 'Could not list repositories. Install the GitHub CLI and run “gh auth login”, or paste a repository URL below.';
    } else {
      for (const p of pages) {
        try {
          all.push(...JSON.parse(p.stdout).map(({ full_name, description, private: priv }) => ({ full_name, description, private: priv })));
        } catch {}
      }
    }
    draw();
  });
}

// ------------------------------------------------------------ toolbar
function tbtn(ico, title, action, disabled) {
  return h('button', { class: 'iconbtn', title, disabled: !!disabled, onclick: action }, icon(ico, 20));
}
const dirtyCount = (d) => d.status.staged.length + d.status.unstaged.length + d.status.conflicted.length;
function renderToolbar() {
  const r = R();
  const bar = $('toolbar');
  if (!r || !r.data) return put(bar, );
  const d = r.data;
  const headName = d.head.branch || (d.head.sha ? `HEAD (${short(d.head.sha)})` : 'no commits yet');
  put(bar, 
    h(
      'div',
      {
        class: 'crumb repo',
        title: r.path,
        onclick: (e) =>
          menuAt(e.currentTarget, [
            ...S.tabs.map((t, i) => ({ label: t.name, check: i === S.active, action: () => activate(i) })),
            '-',
            { label: 'Reveal in Finder', icon: 'folder', action: () => api.reveal(r.path) },
            ...addMenu(),
          ]),
      },
      h('span', { class: 't' }, base(r.path)),
      icon('chevDown', 10)
    ),
    h('span', { class: 'crumbsep' }, icon('chevRight', 14)),
    h(
      'div',
      {
        class: 'crumb',
        title: 'Switch branch',
        onclick: (e) =>
          menuAt(
            e.currentTarget,
            d.refs.locals.map((b) => ({ label: b.name, check: b.head, action: () => checkout(b) }))
          ),
      },
      h('span', { class: 't' }, headName),
      icon('chevDown', 10)
    ),
    h(
      'div',
      { class: 'tcenter' },
      tbtn('undo', r.undo.length ? 'Undo ' + r.undo[r.undo.length - 1].label : 'Undo', undo, !r.undo.length),
      tbtn('redo', r.redo.length ? 'Redo ' + r.redo[r.redo.length - 1].label : 'Redo', redo, !r.redo.length),
      h(
        'div',
        { class: 'grp' },
        tbtn('pull', PULL[S.settings.pullMode].label, () => pull()),
        h(
          'button',
          {
            class: 'iconbtn dd',
            title: 'Pull options',
            onclick: (e) =>
              menuAt(
                e.currentTarget,
                Object.entries(PULL).map(([k, p]) => ({
                  label: p.label,
                  check: k === S.settings.pullMode,
                  action: () => {
                    S.settings.pullMode = k;
                    save();
                    renderToolbar();
                    pull(k);
                  },
                }))
              ),
          },
          icon('chevDown', 10)
        )
      ),
      tbtn('push', 'Push', () => push()),
      tbtn('branch', 'Create branch', () => createBranch()),
      tbtn('stash', dirtyCount(d) ? 'Stash' : 'Nothing to stash', stash, !dirtyCount(d)),
      tbtn('pop', 'Pop stash', pop, !d.stashes.length)
    ),
    h('div', { class: 'tright' }, tbtn('refresh', 'Fetch all', fetchAll), tbtn('search', 'Search commits (⌘F)', () => toggleSearch(true)))
  );
}

// ------------------------------------------------------------ left panel
function tree(items, nameOf) {
  const root = { dirs: new Map(), leaves: [] };
  for (const it of items) {
    const parts = nameOf(it).split('/');
    let n = root;
    for (const p of parts.slice(0, -1)) {
      if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), leaves: [] });
      n = n.dirs.get(p);
    }
    n.leaves.push({ leaf: parts[parts.length - 1], it });
  }
  return root;
}
function renderTree(r, node, depth, key, mkLeaf, out) {
  const entries = [...[...node.dirs].map(([name, n]) => ({ name, n })), ...node.leaves.map((l) => ({ name: l.leaf, l }))].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
  for (const e of entries) {
    const pad = 30 + depth * 16 + 'px';
    if (e.n) {
      const k = key + '/' + e.name;
      const closed = r.folders[k];
      out.push(
        h(
          'div',
          {
            class: 'ritem',
            style: { paddingLeft: pad },
            onclick: () => {
              r.folders[k] = !closed;
              renderLeft();
            },
          },
          icon('folder', 13),
          h('span', { class: 'nm' }, e.name)
        )
      );
      if (!closed) renderTree(r, e.n, depth + 1, k, mkLeaf, out);
    } else out.push(mkLeaf(e.l.it, e.name, pad));
  }
}
function section(r, key, title, ico, count, body) {
  const open = r.open[key];
  return [
    h(
      'div',
      {
        class: 'sec',
        onclick: () => {
          r.open[key] = !open;
          renderLeft();
        },
      },
      icon(open ? 'chevDown' : 'chevRight', 12),
      icon(ico, 14),
      h('span', {}, title),
      h('span', { class: 'cnt' }, String(count))
    ),
    ...(open ? [h('div', { class: 'secbody', 'data-key': key }, body())] : []),
  ];
}
function renderLeft() {
  const r = R();
  const box = $('refs');
  if (!r || !r.data) return put(box, ), put($('viewing'), );
  const d = r.data;
  const q = $('filter').value.trim().toLowerCase();
  const match = (name) => !q || name.toLowerCase().includes(q);
  put($('viewing'), icon('commit', 14), h('span', {}, 'Viewing ', h('b', {}, String(d.commits.length))));
  const jump = (sha) => selectSha(sha, true);

  const localLeaf = (b, name, pad) =>
    h(
      'div',
      {
        class: 'ritem' + (b.head ? ' cur' : ''),
        style: { paddingLeft: pad },
        title: b.name + (b.upstream ? `  →  ${b.upstream}` : ''),
        onclick: () => jump(b.sha),
        ondblclick: () => checkout(b),
        oncontextmenu: (e) => refMenu(e, { local: b, name: b.name }),
      },
      b.head ? h('span', { class: 'cb' }, icon('check', 11)) : null,
      icon('branch', 12),
      h('span', { class: 'nm' }, name),
      b.ahead || b.behind ? h('span', { class: 'ab' }, [b.ahead ? cap(b.ahead) + '↑' : '', b.behind ? cap(b.behind) + '↓' : ''].filter(Boolean).join(' ')) : null
    );
  const remoteLeaf = (b, name, pad) =>
    h(
      'div',
      {
        class: 'ritem',
        style: { paddingLeft: pad },
        title: b.name,
        onclick: () => jump(b.sha),
        ondblclick: () => checkout(b),
        oncontextmenu: (e) => refMenu(e, { remote: b, name: b.short }),
      },
      icon('branch', 12),
      h('span', { class: 'nm' }, name)
    );

  const locals = d.refs.locals.filter((b) => match(b.name));
  const remotes = d.refs.remotes.filter((b) => match(b.name));
  const tags = d.refs.tags.filter((t) => match(t.name));
  const stashes = d.stashes.filter((s) => match(s.msg));
  const forceOpen = !!q;
  const saved = { ...r.open };
  if (forceOpen) r.open = { local: true, remote: true, tags: true, stashes: true };

  const scrolls = Object.fromEntries([...box.querySelectorAll('.secbody')].map((el) => [el.dataset.key, el.scrollTop]));
  put(box, 
    ...section(r, 'local', 'LOCAL', 'laptop', locals.length, () => {
      const out = [];
      renderTree(r, tree(locals, (b) => b.name), 0, 'L', localLeaf, out);
      return out.length ? out : [h('div', { class: 'empty' }, 'No local branches')];
    }),
    ...section(r, 'remote', 'REMOTE', 'cloud', remotes.length, () => {
      const out = [];
      for (const rem of d.remotes) {
        const k = 'R/' + rem;
        const closed = r.folders[k];
        out.push(
          h(
            'div',
            {
              class: 'ritem',
              style: { paddingLeft: '30px' },
              onclick: () => {
                r.folders[k] = !closed;
                renderLeft();
              },
            },
            icon('globe', 13),
            h('span', { class: 'nm' }, rem)
          )
        );
        if (!closed)
          renderTree(
            r,
            tree(
              remotes.filter((b) => b.remote === rem),
              (b) => b.short
            ),
            1,
            k,
            remoteLeaf,
            out
          );
      }
      return out.length ? out : [h('div', { class: 'empty' }, 'No remotes')];
    }),
    ...(!d.refs.tags.length ? [] : section(r, 'tags', 'TAGS', 'tag', tags.length, () =>
      tags.length
        ? tags.map((t) =>
            h(
              'div',
              { class: 'ritem', style: { paddingLeft: '30px' }, title: t.name, onclick: () => jump(t.sha), oncontextmenu: (e) => refMenu(e, { tag: t, name: t.name }) },
              icon('tag', 12),
              h('span', { class: 'nm' }, t.name)
            )
          )
        : [h('div', { class: 'empty' }, 'No tags')]
    )),
    ...section(r, 'stashes', 'STASHES', 'box', stashes.length, () =>
      stashes.length
        ? stashes.map((s) =>
            h(
              'div',
              { class: 'ritem', style: { paddingLeft: '30px' }, title: s.msg, ondblclick: () => op('Apply stash', ['stash', 'apply', s.ref]), oncontextmenu: (e) => stashMenu(e, s) },
              icon('box', 12),
              h('span', { class: 'nm' }, s.msg)
            )
          )
        : [h('div', { class: 'empty' }, 'No stashes')]
    )
  );
  if (forceOpen) r.open = saved;
  if (box.dataset.path === r.path) for (const el of box.querySelectorAll('.secbody')) el.scrollTop = scrolls[el.dataset.key] || 0;
  box.dataset.path = r.path;
}
function stashMenu(e, s) {
  e.preventDefault();
  menu(e.clientX, e.clientY, [
    { label: 'Apply stash', action: () => op('Apply stash', ['stash', 'apply', s.ref]) },
    { label: 'Pop stash', action: () => op('Pop stash', ['stash', 'pop', s.ref]) },
    '-',
    {
      label: 'Delete stash',
      danger: true,
      action: async () => (await confirmBox('Delete stash', `Delete "${s.msg}"? This cannot be undone.`, 'Delete', true)) && op('Delete stash', ['stash', 'drop', s.ref]),
    },
  ]);
}

// Context menu for a ref group: {name, local?, remote?, tag?}
function refMenu(e, g) {
  e.preventDefault();
  e.stopPropagation();
  const r = R();
  const cur = r.data.head.branch;
  const items = [];
  const target = g.local ? g.local.name : g.remote ? g.remote.name : g.tag ? g.tag.name : null;
  if (!target) return;
  const isCur = g.local && g.local.head;
  if (g.local || g.remote) {
    if (!isCur) items.push({ label: `Checkout ${g.name}`, action: () => checkout(g.local || g.remote) });
    if (cur && !isCur) {
      items.push({ label: `Merge ${g.name} into ${cur}`, action: () => mergeInto(target) });
      items.push({ label: `Rebase ${cur} onto ${g.name}`, action: () => rebaseOnto(target) });
    }
    items.push('-');
  }
  if (g.local) {
    const b = g.local;
    if (isCur) items.push({ label: 'Pull', action: () => pull() });
    items.push({ label: b.upstream && !b.gone ? 'Push' : 'Push and set upstream', action: () => push(b) });
    items.push({ label: 'Create branch here…', action: () => createBranch(b.name) });
    items.push({
      label: `Rename ${b.name}…`,
      action: async () => {
        const v = await form({ title: 'Rename branch', fields: [{ name: 'name', label: 'New name', value: b.name, required: true }], ok: 'Rename' });
        if (v && v.name !== b.name) op('Rename branch', ['branch', '-m', b.name, v.name]);
      },
    });
    if (!isCur) items.push({ label: `Delete ${b.name}`, danger: true, action: () => deleteBranch(b) });
  }
  if (g.remote) {
    const b = g.remote;
    if (!g.local) items.push({ label: 'Create branch here…', action: () => createBranch(b.name) });
    items.push({
      label: `Delete ${b.name}`,
      danger: true,
      action: async () =>
        (await confirmBox('Delete remote branch', `Delete ${b.short} on ${b.remote}? This removes the branch for everyone.`, 'Delete Remote Branch', true)) &&
        op('Delete ' + b.name, ['push', b.remote, '--delete', b.short]),
    });
  }
  if (g.tag) {
    const t = g.tag;
    items.push({ label: `Checkout ${t.name}`, action: () => checkout({ type: 'tag', name: t.name }) });
    if (r.data.remotes.length) items.push({ label: `Push ${t.name} to ${r.data.remotes[0]}`, action: () => op('Push tag', ['push', r.data.remotes[0], 'refs/tags/' + t.name]) });
    items.push({
      label: `Delete ${t.name} locally`,
      danger: true,
      action: async () => (await confirmBox('Delete tag', `Delete the tag ${t.name} locally?`, 'Delete', true)) && op('Delete tag', ['tag', '-d', t.name]),
    });
  }
  items.push('-', { label: 'Copy name', icon: 'copy', action: () => api.copy(target) });
  menu(e.clientX, e.clientY, items);
}

function commitMenu(e, r, c) {
  e.preventDefault();
  if (c.wip) {
    return menu(e.clientX, e.clientY, [
      { label: 'Stage all changes', action: stageAll },
      { label: 'Stash all changes', action: stash },
      '-',
      { label: 'Discard all changes', danger: true, action: discardAll },
    ]);
  }
  if (c.stash) return stashMenu(e, c.stash);
  const cur = r.data.head.branch || 'HEAD';
  if (r.multi.size > 1 && r.multi.has(c.sha)) {
    const shas = [...r.multi];
    const sq = squashable(r, shas);
    return menu(e.clientX, e.clientY, [
      { label: `Cherry pick ${shas.length} commits`, action: () => cherryPick(shas) },
      { label: `Squash ${shas.length} commits`, disabled: typeof sq === 'string', hint: typeof sq === 'string' ? sq : '', action: () => squash(shas) },
    ]);
  }
  const chain = headChain(r);
  const pos = chain.findIndex((x) => x.sha === c.sha);
  const isHead = c.sha === r.data.head.sha;
  const items = [
    { label: 'Checkout this commit', disabled: isHead, action: () => checkout({ type: 'commit', sha: c.sha }) },
    { label: 'Create branch here…', icon: 'branch', action: () => createBranch(c.sha) },
    '-',
    { label: 'Cherry pick commit', disabled: pos >= 0, action: () => cherryPick([c.sha]) },
    { label: 'Revert commit', action: () => op('Revert ' + short(c.sha), ['revert', '--no-edit', ...(c.parents.length > 1 ? ['-m', '1'] : []), c.sha]) },
    { label: `Rebase ${cur} onto this commit`, disabled: pos >= 0 || !r.data.head.branch, action: () => rebaseOnto(c.sha) },
    pos > 0 ? { label: `Squash the ${pos + 1} commits from HEAD down to here`, action: () => squash(chain.slice(0, pos + 1).map((x) => x.sha)) } : null,
    '-',
    { header: `Reset ${cur} to this commit` },
    { label: 'Soft — keep all changes staged', action: () => resetTo(c.sha, 'soft') },
    { label: 'Mixed — keep changes in the working directory', action: () => resetTo(c.sha, 'mixed') },
    { label: 'Hard — discard all changes', danger: true, action: () => resetTo(c.sha, 'hard') },
    '-',
    {
      label: 'Create tag here…',
      icon: 'tag',
      action: async () => {
        const v = await form({
          title: 'Create tag',
          fields: [
            { name: 'name', label: 'Tag name', required: true, placeholder: 'v1.0.0' },
            { name: 'msg', label: 'Message (optional, makes an annotated tag)' },
          ],
          ok: 'Create Tag',
        });
        if (v) op('Create tag ' + v.name, v.msg ? ['tag', '-a', v.name, '-m', v.msg, c.sha] : ['tag', v.name, c.sha]);
      },
    },
    { label: 'Copy commit SHA', icon: 'copy', action: () => (api.copy(c.sha), toast('Copied ' + short(c.sha))) },
    { label: 'Copy commit message', action: () => api.copy(c.subject + (c.body ? '\n\n' + c.body : '')) },
  ];
  menu(e.clientX, e.clientY, items);
}

// ------------------------------------------------------------ graph
const gv = { version: -1, path: null, els: new Map() };

function relDate(at) {
  const s = Date.now() / 1000 - at;
  const d = Math.floor(s / 86400);
  if (s < 3600) return 'just now';
  if (d < 1) return plural(Math.floor(s / 3600), 'hour') + ' ago';
  if (d < 2) return 'yesterday';
  if (d < 7) return d + ' days ago';
  if (d < 31) return plural(Math.floor(d / 7), 'week') + ' ago';
  if (d < 365) return plural(Math.floor(d / 30.5), 'month') + ' ago';
  return plural(Math.floor(d / 365), 'year') + ' ago';
}

function refLabel(g) {
  return h(
    'span',
    {
      class: 'lbl' + (g.head ? ' head' : ''),
      title: [g.local && g.local.name, g.remote && g.remote.name, g.tag && 'tag: ' + g.tag.name].filter(Boolean).join('\n'),
      ondblclick: (e) => {
        e.stopPropagation();
        if (g.local || g.remote) checkout(g.local || g.remote);
      },
      oncontextmenu: (e) => refMenu(e, g),
    },
    g.head ? icon('check', 11) : null,
    h('span', { class: 'nm' }, g.name),
    g.local ? icon('laptop', 12) : null,
    g.remote ? icon('globe', 11, 'rico') : null,
    g.tag ? icon('tag', 12) : null
  );
}

function avatarNode(c, cls = 'node', style = null) {
  const n = h('div', { class: cls, style: { ...(style || {}), background: colorFor(c.email) } }, initials(c.author));
  const url = S.settings.avatars && G.avatarUrl(c.email);
  if (url) {
    const img = h('img', { src: url, draggable: 'false' });
    img.addEventListener('error', () => {
      G.avatarFailed(c.email);
      img.remove();
    });
    n.append(img);
  }
  return n;
}

function buildRow(r, i) {
  const row = r.rows[i];
  const c = row.commit;
  const cx = laneX(row.col);
  let groups = c.wip ? [] : r.refMap.get(c.sha) || [];
  // Smart branch visibility: keep local branches, HEAD and tags; hide remote-only branch labels.
  if (S.settings.smart) groups = groups.filter((g) => g.local || g.tag || g.head);
  const isSel = r.selected === c.sha || r.multi.has(c.sha);
  const el = h('div', {
    class: 'row' + (isSel ? ' sel' : '') + (c.wip ? ' wip' : '') + (groups[0]?.head ? ' headrow' : '') + (r.search?.set.has(i) ? ' hit' : ''),
    style: { top: i * ROW + 'px', '--lane': laneColor(row.col) },
    onclick: (e) => clickRow(r, i, e),
    oncontextmenu: (e) => {
      if (!r.multi.has(c.sha)) clickRow(r, i, {});
      commitMenu(e, r, c);
    },
  });
  el.dataset.sha = c.sha;

  const refcell = h('div', { class: 'refcell' });
  if (groups.length) {
    refcell.append(
      refLabel(groups[0]),
      groups.length > 1 ? h('span', { class: 'more' }, '+' + (groups.length - 1)) : '',
      h('span', { class: 'rline' }),
      groups.length > 1 ? h('div', { class: 'extra' }, groups.slice(1).map(refLabel)) : ''
    );
  }

  const gcell = h('div', { class: 'gcell' });
  gcell.innerHTML = rowSvg(row, laneX(r.maxCol) + LANE);
  gcell.append(h('div', { class: 'band', style: { left: cx + 'px' } }));
  if (groups.length) gcell.append(h('div', { class: 'gline', style: { width: cx + 'px' } }));
  if (c.wip) gcell.append(h('div', { class: 'node wipnode', style: { left: cx - NODE_R + 'px' } }));
  else if (c.stash) gcell.append(h('div', { class: 'node stashnode', style: { left: cx - NODE_R + 'px' } }, icon('box', 12)));
  else if (c.parents.length > 1) gcell.append(h('div', { class: 'node merge', style: { left: cx - (NODE_R > 8 ? 5 : 4) + 'px' } }));
  else gcell.append(avatarNode(c, 'node', { left: cx - NODE_R + 'px' }));

  let mcell;
  if (c.wip) {
    const st = r.data.status;
    const all = [...st.staged, ...st.unstaged, ...st.conflicted];
    const uniq = new Map(all.map((f) => [f.path, f]));
    const cnt = { mod: 0, add: 0, del: 0 };
    for (const f of uniq.values()) cnt[f.status === '?' || f.status === 'A' ? 'add' : f.status === 'D' ? 'del' : 'mod']++;
    mcell = h(
      'div',
      { class: 'mcell' },
      h('span', { class: 'wipbox' }, '// WIP'),
      cnt.mod ? h('span', { class: 'wipcount c-mod' }, icon('pencil', 12), String(cnt.mod)) : null,
      cnt.add ? h('span', { class: 'wipcount c-add' }, icon('plus', 12), String(cnt.add)) : null,
      cnt.del ? h('span', { class: 'wipcount c-del' }, icon('minus', 12), String(cnt.del)) : null
    );
  } else {
    const prev = r.rows[i - 1]?.commit;
    const label = relDate(c.ct);
    const showDate = prev && !prev.wip && relDate(prev.ct) !== label;
    mcell = h(
      'div',
      { class: 'mcell' },
      h('span', { class: 'subj' }, c.subject),
      c.body ? h('span', { class: 'body' }, c.body.slice(0, 400).split(/\n+/).join(' | ')) : null
    );
    if (showDate) el.append(h('span', { class: 'datechip' }, label));
  }
  const plain = !c.wip && !c.stash;
  el.append(
    refcell,
    gcell,
    mcell,
    h('div', { class: 'acell' }, h('span', {}, plain ? c.author : '')),
    h('div', { class: 'dcell' }, h('span', {}, c.wip ? '' : fmtDate(c.ct))),
    h('div', { class: 'scell' }, plain ? short(c.sha) : '')
  );
  return el;
}

function renderGraph() {
  const r = R();
  const sc = $('gscroll');
  const sp = $('gspacer');
  if (!r || !r.data) {
    put(sp, r ? h('div', { class: 'gload' }, 'Loading repository…') : '');
    sp.style.height = '0px';
    gv.els.clear();
    gv.version = -1;
    gv.path = null;
    return;
  }
  const g = $('graph');
  const cols = S.settings.cols;
  g.className = Object.keys(cols).filter((k) => cols[k]).map((k) => 'c-' + k).join(' ') + (S.settings.compact ? ' compact' : '');
  const auto = Math.max(110, Math.min(laneX(r.maxCol) + 24, 236));
  g.style.setProperty('--refw', S.settings.refW + 'px');
  g.style.setProperty('--graphw', (S.settings.graphW || auto) + 'px');
  if (gv.path !== r.path || gv.version !== r.version) {
    const switched = gv.path !== r.path;
    put(sp, );
    gv.els.clear();
    gv.path = r.path;
    gv.version = r.version;
    sp.style.height = r.rows.length * ROW + 'px';
    if (switched) sc.scrollTop = r.scrollTop || 0;
    if (!r.rows.length) put(sp, h('div', { class: 'gload' }, 'No commits yet. Make your first commit from the panel on the right.'));
  }
  const top = sc.scrollTop;
  const a = Math.max(0, Math.floor(top / ROW) - 10);
  const b = Math.min(r.rows.length, Math.ceil((top + sc.clientHeight) / ROW) + 10);
  for (const [i, el] of gv.els) {
    if (i < a || i >= b) {
      el.remove();
      gv.els.delete(i);
    }
  }
  for (let i = a; i < b; i++) {
    if (!gv.els.has(i)) {
      const el = buildRow(r, i);
      gv.els.set(i, el);
      sp.append(el);
    }
  }
  if (b >= r.rows.length - 3 && r.data.commits.length >= r.limit && !r.busy) {
    r.limit += S.settings.limit;
    refresh(r.path);
  }
}
function updateSelection() {
  const r = R();
  if (!r) return;
  for (const el of gv.els.values()) el.classList.toggle('sel', el.dataset.sha === r.selected || r.multi.has(el.dataset.sha));
}
function clickRow(r, i, e) {
  const sha = r.rows[i].commit.sha;
  if (e.shiftKey && r.anchor != null && sha !== 'WIP') {
    const [a, b] = [Math.min(r.anchor, i), Math.max(r.anchor, i)];
    r.multi = new Set(r.rows.slice(a, b + 1).filter((x) => !x.commit.wip && !x.commit.stash).map((x) => x.commit.sha));
  } else if (e.metaKey && sha !== 'WIP' && !r.rows[i].commit.stash) {
    if (!r.multi.size && r.selected && r.selected !== 'WIP') r.multi.add(r.selected);
    r.multi.has(sha) ? r.multi.delete(sha) : r.multi.add(sha);
  } else {
    r.multi = new Set();
    r.anchor = i;
  }
  r.selected = sha;
  if (r.view && r.view.mode === 'commit') r.view = null;
  if (r.view && sha !== 'WIP') r.view = null;
  updateSelection();
  renderCenter();
  renderRight();
}
function selectSha(sha, scroll) {
  const r = R();
  const i = r.index.get(sha);
  if (i == null) return toast('That commit is not loaded in the graph yet. Scroll down to load more history.');
  r.view = null;
  clickRow(r, i, {});
  if (scroll) {
    const sc = $('gscroll');
    const y = i * ROW;
    if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - ROW) sc.scrollTop = Math.max(0, y - sc.clientHeight / 2);
    renderGraph();
  }
}

function applyGraphSettings() {
  setCompact(S.settings.compact);
  save();
  for (const r of repos.values()) r.version++;
  renderGraph();
}
function columnsMenu(anchor) {
  const c = S.settings.cols;
  const col = (key, label) => ({
    label,
    check: c[key],
    action: () => {
      c[key] = !c[key];
      if (!c.ref && !c.graph && !c.msg && !c.author && !c.date && !c.sha) c.msg = true;
      applyGraphSettings();
    },
  });
  const reset = (compact) => () => {
    Object.assign(c, { ref: true, graph: true, msg: true, author: false, date: false, sha: false });
    Object.assign(S.settings, { compact, refW: compact ? 110 : 150, graphW: null });
    applyGraphSettings();
  };
  menuAt(
    anchor,
    [
      col('ref', 'Branch / Tag'),
      col('graph', 'Graph'),
      col('msg', 'Commit message'),
      col('author', 'Author'),
      col('date', 'Date / Time'),
      col('sha', 'Sha'),
      '-',
      { label: 'Compact Graph Column', check: S.settings.compact, action: () => ((S.settings.compact = !S.settings.compact), applyGraphSettings()) },
      { label: 'Smart Branch Visibility', check: S.settings.smart, action: () => ((S.settings.smart = !S.settings.smart), applyGraphSettings()) },
      '-',
      { label: 'Reset columns to default layout', action: reset(false) },
      { label: 'Reset columns to compact layout', action: reset(true) },
    ],
    { right: true, minWidth: 250 }
  );
}
function toggleSearch(on) {
  const r = R();
  if (!r) return;
  $('gsearch').hidden = !on;
  if (on) {
    $('gsearch-in').focus();
    $('gsearch-in').select();
  } else {
    r.search = null;
    r.version++;
    renderGraph();
  }
}
function runSearch(step) {
  const r = R();
  const q = $('gsearch-in').value.trim().toLowerCase();
  if (!q) {
    r.search = null;
    $('gsearch-n').textContent = '';
  } else if (!r.search || r.search.q !== q) {
    const hits = [];
    r.rows.forEach((row, i) => {
      const c = row.commit;
      if (!c.wip && (c.subject.toLowerCase().includes(q) || c.sha.startsWith(q) || c.author.toLowerCase().includes(q) || c.body.toLowerCase().includes(q))) hits.push(i);
    });
    r.search = { q, hits, set: new Set(hits), at: 0 };
  } else if (r.search.hits.length) {
    r.search.at = (r.search.at + step + r.search.hits.length) % r.search.hits.length;
  }
  r.version++;
  if (r.search && r.search.hits.length) {
    $('gsearch-n').textContent = `${r.search.at + 1} / ${r.search.hits.length}`;
    selectSha(r.rows[r.search.hits[r.search.at]].commit.sha, true);
  } else {
    if (r.search) $('gsearch-n').textContent = '0 / 0';
    renderGraph();
  }
}

// ------------------------------------------------------------ right panel
const STATUS = {
  M: ['pencil', 'c-mod', 'Modified'],
  T: ['pencil', 'c-mod', 'Type changed'],
  A: ['plus', 'c-add', 'Added'],
  '?': ['plus', 'c-add', 'Untracked'],
  D: ['minus', 'c-del', 'Deleted'],
  R: ['arrowRight', 'c-ren', 'Renamed'],
  C: ['copy', 'c-ren', 'Copied'],
  U: ['warn', 'c-con', 'Conflicted'],
};
const statusIcon = (s) => {
  const [ico, cls, title] = STATUS[s] || STATUS.M;
  const el = icon(ico, 13, cls);
  el.title = title;
  return el;
};

function fileRow(r, f, mode, label, pad) {
  const slash = f.path.lastIndexOf('/');
  const isOpen = r.view && r.view.mode === mode && r.view.file.path === f.path;
  return h(
    'div',
    {
      class: 'file' + (isOpen ? ' open' : ''),
      style: pad ? { paddingLeft: pad } : null,
      title: f.orig ? `${f.orig} → ${f.path}` : f.path,
      draggable: mode === 'commit' ? null : 'true',
      ondragstart: (e) => {
        drag = { file: f, mode };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f.path);
      },
      ondragend: () => {
        drag = null;
        clearDrop();
      },
      onclick: () => openDiff(f, mode),
      oncontextmenu: (e) => fileMenu(e, r, f, mode),
    },
    statusIcon(f.status),
    h('span', { class: 'fpath' }, label != null ? h('span', { class: 'fname' }, label) : [h('span', { class: 'fdir' }, f.path.slice(0, slash + 1)), h('span', { class: 'fname' }, f.path.slice(slash + 1))]),
    mode === 'unstaged' ? h('button', { class: 'mini green', onclick: (e) => (e.stopPropagation(), stage([f])) }, 'Stage File') : null,
    mode === 'staged' ? h('button', { class: 'mini red', onclick: (e) => (e.stopPropagation(), unstage([f])) }, 'Unstage File') : null
  );
}
function fileList(r, files, mode) {
  if (S.settings.fileView === 'path') return files.map((f) => fileRow(r, f, mode));
  const out = [];
  const walk = (node, depth) => {
    for (const [name, n] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(h('div', { class: 'fdirrow', style: { paddingLeft: 18 + depth * 16 + 'px' } }, icon('folder', 13), name));
      walk(n, depth + 1);
    }
    for (const l of node.leaves) out.push(fileRow(r, l.it, mode, l.leaf, 18 + depth * 16 + 'px'));
  };
  walk(tree(files, (f) => f.path), 0);
  return out;
}
function fileMenu(e, r, f, mode) {
  e.preventDefault();
  const abs = r.path + '/' + f.path;
  const conflict = f.status === 'U';
  menu(e.clientX, e.clientY, [
    mode === 'unstaged' && !conflict ? { label: 'Stage file', action: () => stage([f]) } : null,
    mode === 'staged' ? { label: 'Unstage file', action: () => unstage([f]) } : null,
    conflict ? { label: 'Mark resolved', action: () => stage([f]) } : null,
    conflict ? { label: 'Take ours (current branch)', action: async () => (await run(['checkout', '--ours', '--', f.path])) && stage([f]) } : null,
    conflict ? { label: 'Take theirs (incoming)', action: async () => (await run(['checkout', '--theirs', '--', f.path])) && stage([f]) } : null,
    mode === 'unstaged' && !conflict ? { label: 'Discard changes', danger: true, action: () => discard([f]) } : null,
    mode === 'unstaged' && f.status === '?'
      ? { label: 'Add to .gitignore', action: async () => (await G.git(r.path, ['rev-parse']), await appendIgnore(r, f.path)) }
      : null,
    '-',
    { label: 'Reveal in Finder', icon: 'folder', action: () => api.reveal(abs) },
    { label: 'Copy file path', icon: 'copy', action: () => api.copy(f.path) },
  ]);
}
async function appendIgnore(r, p) {
  // Uses git itself to write so no extra file API is needed.
  const cur = await G.git(r.path, ['show', ':.gitignore']);
  const res = await api.git(r.path, ['hash-object', '-w', '--stdin'], { stdin: (cur.code === 0 ? cur.stdout.replace(/\n?$/, '\n') : '') + p + '\n' });
  if (res.code !== 0) return gitError('Could not update .gitignore', res);
  await G.git(r.path, ['update-index', '--add', '--cacheinfo', '100644,' + res.stdout.trim() + ',.gitignore']);
  await G.git(r.path, ['checkout', '--', '.gitignore']);
  await refresh(r.path);
}

function viewToggle(r) {
  const set = (v) => () => {
    S.settings.fileView = v;
    save();
    r.rightSig = null;
    renderRight();
  };
  return h(
    'div',
    { class: 'rtools' },
    h(
      'div',
      { class: 'vtoggle' },
      h('button', { class: S.settings.fileView === 'path' ? 'on' : '', onclick: set('path') }, icon('list', 13), 'Path'),
      h('button', { class: S.settings.fileView === 'tree' ? 'on' : '', onclick: set('tree') }, icon('tree', 13), 'Tree')
    )
  );
}

// The selected commits as one range: everything from before the oldest to the newest.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
function multiRange(r) {
  const cs = [...r.multi].map((s) => r.bySha.get(s)).filter(Boolean).sort((a, b) => r.index.get(a.sha) - r.index.get(b.sha));
  if (cs.length < 2) return null;
  const newest = cs[0];
  const oldest = cs[cs.length - 1];
  const base = oldest.parents[0] || EMPTY_TREE;
  return { sha: newest.sha, parents: [base], key: base + '..' + newest.sha, newest, oldest, range: true };
}
function fileStats(files, fs) {
  const cnt = { M: 0, A: 0, D: 0, R: 0 };
  for (const f of fs) cnt[f.status in cnt ? f.status : 'M']++;
  return h(
    'div',
    { class: 'cdstats' },
    !files ? h('span', {}, 'Loading files…') : null,
    cnt.M ? h('span', {}, icon('pencil', 13, 'c-mod'), `${cnt.M} modified`) : null,
    cnt.A ? h('span', {}, icon('plus', 13, 'c-add'), `${cnt.A} added`) : null,
    cnt.D ? h('span', {}, icon('minus', 13, 'c-del'), `${cnt.D} deleted`) : null,
    cnt.R ? h('span', {}, icon('arrowRight', 13, 'c-ren'), `${cnt.R} renamed`) : null,
    files && !fs.length ? h('span', { style: { color: 'var(--dim)' } }, 'No file changes') : null
  );
}

function renderRight() {
  const r = R();
  const box = $('right');
  if (!r || !r.data) return put(box, );
  const d = r.data;
  const sel = r.selected;
  const range = r.multi.size > 1 ? multiRange(r) : null;
  const files = range ? r.files.get(range.key) : sel && sel !== 'WIP' ? r.files.get(sel) : null;
  const sig = JSON.stringify([r.path, sel, [...r.multi], d.status.raw, S.settings.fileView, d.op, d.head, r.view && r.view.mode + r.view.file.path, files ? files.length : -1, r.msg.amend]);
  if (sig === r.rightSig && box.dataset.path === r.path) return;
  r.rightSig = sig;
  box.dataset.path = r.path;
  const act = document.activeElement;
  const focusId = act && box.contains(act) ? act.id : null;
  const caret = focusId ? act.selectionStart : 0;

  if (r.multi.size > 1) {
    const shas = [...r.multi];
    const sq = squashable(r, shas);
    if (range && !files) {
      G.commitFiles(r.path, range).then((fs) => {
        r.files.set(range.key, fs);
        if (R() === r) renderRight();
      });
    }
    const fs = files || [];
    put(box, 
      h('div', { class: 'cdhead' }, `${shas.length} commits selected`),
      range
        ? h(
            'div',
            { class: 'cdrange' },
            'Showing all changes from ',
            h('a', { title: range.oldest.subject, onclick: () => selectSha(range.oldest.sha, true) }, short(range.oldest.sha)),
            ' to ',
            h('a', { title: range.newest.subject, onclick: () => selectSha(range.newest.sha, true) }, short(range.newest.sha))
          )
        : null,
      h(
        'div',
        { class: 'cdmulti' },
        h('button', { class: 'btn', onclick: () => cherryPick(shas) }, `Cherry pick ${shas.length} commits`),
        h('button', { class: 'btn', disabled: typeof sq === 'string', title: typeof sq === 'string' ? sq : '', onclick: () => squash(shas) }, `Squash ${shas.length} commits`)
      ),
      fileStats(files, fs),
      viewToggle(r),
      h('div', { class: 'fsec' }, h('div', { class: 'flist' }, fileList(r, fs, 'commit')))
    );
  } else if (sel === 'WIP' || !sel) renderWip(r, box);
  else renderCommit(r, box, r.bySha.get(sel), files);

  if (focusId && $(focusId)) {
    $(focusId).focus();
    try {
      $(focusId).setSelectionRange(caret, caret);
    } catch {}
  }
}

function renderWip(r, box) {
  const d = r.data;
  const st = d.status;
  const n = new Set([...st.staged, ...st.unstaged, ...st.conflicted].map((f) => f.path)).size;
  const m = r.msg;
  const canCommit = (st.staged.length > 0 || m.amend) && !st.conflicted.length;
  const left = h('span', { class: 'left' + (m.summary.length > 72 ? ' over' : '') }, String(72 - m.summary.length));
  const btn = h('button', { class: 'commitbtn', onclick: doCommit });
  const setBtn = () => {
    const ready = canCommit && m.summary.trim();
    btn.className = 'commitbtn' + (ready ? ' ready' : '');
    put(btn, 
      icon('commit', 14),
      m.amend ? 'Amend Previous Commit' : st.staged.length ? `Commit changes to ${plural(st.staged.length, 'file')}` : st.unstaged.length ? 'Stage Changes to Commit' : 'Nothing to commit'
    );
  };
  setBtn();
  const banner = d.op
    ? h(
        'div',
        { class: 'banner' },
        icon('warn', 15, 'c-con'),
        h('span', {}, `${d.op[0].toUpperCase() + d.op.slice(1)} in progress` + (st.conflicted.length ? ` — ${plural(st.conflicted.length, 'conflict')}` : '')),
        h('span', { class: 'sp' }),
        d.op === 'rebase' ? h('button', { class: 'mini', onclick: () => continueOp(d.op, 'skip') }, 'Skip') : null,
        h('button', { class: 'mini red', onclick: () => continueOp(d.op, 'abort') }, 'Abort'),
        h('button', { class: 'mini green', disabled: st.conflicted.length > 0, onclick: () => continueOp(d.op, 'continue') }, 'Continue')
      )
    : null;
  put(box, 
    h(
      'div',
      { class: 'rhead' },
      h('button', { class: 'iconbtn danger', title: 'Discard all changes', disabled: !n, onclick: discardAll }, icon('trash', 14)),
      h('div', { class: 'rtitle' }, `${plural(n, 'file change')} on `, h('span', { class: 'chip' }, d.head.branch || 'HEAD'))
    ),
    viewToggle(r),
    banner,
    st.conflicted.length
      ? h(
          'div',
          { class: 'fsec small' },
          h('div', { class: 'fsech' }, icon('chevDown', 11), `Conflicted Files (${st.conflicted.length})`),
          h('div', { class: 'flist' }, fileList(r, st.conflicted, 'unstaged'))
        )
      : null,
    h(
      'div',
      { class: 'fsec', 'data-zone': 'unstaged' },
      h(
        'div',
        { class: 'fsech' },
        icon('chevDown', 11),
        `Unstaged Files (${st.unstaged.length})`,
        h('span', { class: 'sp' }),
        st.unstaged.length ? h('button', { class: 'mini green', onclick: stageAll }, 'Stage All Changes') : null
      ),
      h('div', { class: 'flist' }, fileList(r, st.unstaged, 'unstaged'))
    ),
    h(
      'div',
      { class: 'fsec', 'data-zone': 'staged' },
      h(
        'div',
        { class: 'fsech' },
        icon('chevDown', 11),
        `Staged Files (${st.staged.length})`,
        h('span', { class: 'sp' }),
        st.staged.length ? h('button', { class: 'mini red', onclick: unstageAll }, 'Unstage All Changes') : null
      ),
      h('div', { class: 'flist' }, fileList(r, st.staged, 'staged'))
    ),
    h(
      'div',
      { class: 'cbox' },
      h('div', { class: 'ctab' }, icon('commit', 15), 'Commit'),
      h(
        'label',
        { class: 'amend' },
        h('input', {
          type: 'checkbox',
          checked: m.amend,
          disabled: !d.head.sha,
          onchange: (e) => {
            m.amend = e.target.checked;
            const hc = r.bySha.get(d.head.sha);
            if (m.amend && hc && !m.summary) (m.summary = hc.subject), (m.desc = hc.body);
            renderRight();
          },
        }),
        'Amend previous commit'
      ),
      h(
        'div',
        { class: 'cmsg' },
        h(
          'div',
          { class: 'srow' },
          h('input', {
            id: 'csum',
            placeholder: 'Commit summary',
            value: m.summary,
            spellcheck: 'true',
            oninput: (e) => {
              m.summary = e.target.value;
              left.textContent = String(72 - m.summary.length);
              left.className = 'left' + (m.summary.length > 72 ? ' over' : '');
              setBtn();
            },
            onkeydown: (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && doCommit(),
          }),
          left
        ),
        h('textarea', {
          id: 'cdesc',
          placeholder: 'Description',
          value: m.desc,
          oninput: (e) => (m.desc = e.target.value),
          onkeydown: (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && doCommit(),
        })
      ),
      btn
    )
  );
}

function coauthors(c) {
  const out = [];
  for (const m of (c.body || '').matchAll(/^co-authored-by:\s*(.+?)\s*<([^>]+)>/gim)) {
    if (!out.some((a) => a.email === m[2])) out.push({ author: m[1], email: m[2] });
  }
  return out;
}
function fmtDate(at) {
  const when = new Date(at * 1000);
  return when.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' @ ' + when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function renderCommit(r, box, c, files) {
  if (!c) return put(box, );
  if (!files) {
    G.commitFiles(r.path, c).then((fs) => {
      r.files.set(c.sha, fs);
      if (R() === r && r.selected === c.sha) renderRight();
    });
  }
  const fs = files || [];
  const dateStr = fmtDate(c.at);
  put(box, 
    h(
      'div',
      { class: 'cdhead' },
      c.stash ? 'stash: ' : 'commit: ',
      h('span', { class: 'sha', title: 'Click to copy the full SHA', onclick: () => (api.copy(c.sha), toast('Copied ' + short(c.sha))) }, short(c.sha))
    ),
    h('div', { class: 'cdmsg' }, h('div', { class: 's' }, c.subject), c.body ? h('div', { class: 'b' }, c.body) : null),
    c.stash ? null : h(
      'div',
      { class: 'cdauthor' },
      avatarNode(c, 'node'),
      h('div', { class: 'who' }, h('div', { class: 'n', title: c.email }, c.author), h('div', { class: 'd' }, 'authored  ' + dateStr)),
      h(
        'div',
        { class: 'par' },
        c.parents.length ? 'parent: ' : '',
        c.parents.map((p, i) => [i ? ', ' : '', h('a', { onclick: () => selectSha(p, true) }, short(p))])
      )
    ),
    coauthors(c).length
      ? h('div', { class: 'coauthors' }, 'Co-authors:', coauthors(c).map((a) => { const n = avatarNode(a, 'node'); n.title = `${a.author} <${a.email}>`; return n; }))
      : null,
    !c.stash && c.committer && (c.committer !== c.author || c.cemail !== c.email)
      ? h(
          'div',
          { class: 'cdauthor committer' },
          avatarNode({ author: c.committer, email: c.cemail }, 'node'),
          h('div', { class: 'who' }, h('div', { class: 'n', title: c.cemail }, c.committer), h('div', { class: 'd' }, 'committed  ' + fmtDate(c.ct)))
        )
      : null,
    fileStats(files, fs),
    viewToggle(r),
    h('div', { class: 'fsec' }, h('div', { class: 'flist' }, fileList(r, fs, 'commit')))
  );
}

// ------------------------------------------------------------ diff view
function openDiff(f, mode) {
  const r = R();
  const range = mode === 'commit' && r.multi.size > 1 ? multiRange(r) : null;
  r.view = { file: f, mode, sha: range ? range.key : mode === 'commit' ? r.selected : null, range };
  r.diffSig = null;
  renderCenter();
  r.rightSig = null;
  renderRight();
}
function closeDiff() {
  const r = R();
  if (!r || !r.view) return;
  r.view = null;
  renderCenter();
  r.rightSig = null;
  renderRight();
}
async function applyHunk(d, hk, kind) {
  if (kind === 'discard' && !(await confirmBox('Discard hunk', 'Discard this change? This cannot be undone.', 'Discard', true))) return;
  const args = kind === 'stage' ? ['apply', '--cached', '-'] : kind === 'unstage' ? ['apply', '--cached', '-R', '-'] : ['apply', '-R', '-'];
  R().diffSig = null;
  await run(args, { stdin: G.hunkPatch(d, hk) });
}
async function renderDiff() {
  const r = R();
  const v = r.view;
  const box = $('diff');
  const sig = JSON.stringify([r.path, v.mode, v.sha, v.file.path, v.file.status, r.data.status.raw]);
  if (sig === r.diffSig && box.dataset.sig === sig) return;
  r.diffSig = sig;
  const text = await G.fileDiff(r.path, v.file, v.mode, v.mode === 'commit' ? v.range || r.bySha.get(v.sha) : null);
  if (R() !== r || r.view !== v) return;
  box.dataset.sig = sig;
  const d = G.parseDiff(text);
  const f = v.file;
  const canHunk = v.mode !== 'commit' && f.status !== '?' && f.status !== 'U' && !d.binary;
  const inner = h('div', { class: 'inner' });
  let count = 0;
  const MAX = 6000;
  if (d.binary) inner.append(h('div', { class: 'dnote' }, 'Binary file — no text diff to show.'));
  else if (!d.hunks.length) inner.append(h('div', { class: 'dnote' }, text.trim() ? 'No content changes (mode or rename only).' : 'No changes to show.'));
  for (const hk of d.hunks) {
    if (count > MAX) break;
    inner.append(
      h(
        'div',
        { class: 'hunkh' },
        h('span', {}, hk.header),
        h('span', { class: 'sp' }),
        canHunk && v.mode === 'unstaged' ? h('button', { class: 'mini red', onclick: () => applyHunk(d, hk, 'discard') }, 'Discard Hunk') : null,
        canHunk && v.mode === 'unstaged' ? h('button', { class: 'mini green', onclick: () => applyHunk(d, hk, 'stage') }, 'Stage Hunk') : null,
        canHunk && v.mode === 'staged' ? h('button', { class: 'mini red', onclick: () => applyHunk(d, hk, 'unstage') }, 'Unstage Hunk') : null
      )
    );
    let o = hk.o;
    let n = hk.n;
    const frag = document.createDocumentFragment();
    for (const l of hk.lines) {
      if (++count > MAX) {
        frag.append(h('div', { class: 'dnote' }, 'Diff truncated — this file is very large.'));
        break;
      }
      const ch = l[0];
      const cls = ch === '+' ? 'add' : ch === '-' ? 'del' : ch === '\\' ? 'meta' : '';
      frag.append(
        h(
          'div',
          { class: 'dl ' + cls },
          h('span', { class: 'ln' }, ch === '+' || ch === '\\' ? '' : String(o++)),
          h('span', { class: 'ln' }, ch === '-' || ch === '\\' ? '' : String(n++)),
          h('span', { class: 'tx' }, ch === '\\' ? l : (ch === '+' || ch === '-' ? ch : ' ') + ' ' + l.slice(1))
        )
      );
    }
    inner.append(frag);
  }
  const body = h('div', { class: 'dbody' }, inner);
  put(box, 
    h(
      'div',
      { class: 'dhead' },
      statusIcon(f.status),
      h('span', { class: 'dpath' }, f.orig ? `${f.orig} → ${f.path}` : f.path),
      h('span', { class: 'dmode' }, v.range ? `${short(v.range.oldest.sha)} → ${short(v.range.newest.sha)}` : v.mode === 'commit' ? 'commit ' + short(v.sha) : v.mode === 'staged' ? 'Staged' : 'Unstaged'),
      v.mode === 'unstaged' && f.status !== 'U' ? h('button', { class: 'mini green', onclick: () => stage([f]) }, 'Stage File') : null,
      v.mode === 'staged' ? h('button', { class: 'mini red', onclick: () => unstage([f]) }, 'Unstage File') : null,
      h('button', { class: 'iconbtn', title: 'Close (Esc)', onclick: closeDiff }, icon('close', 16))
    ),
    body
  );
}

// ------------------------------------------------------------ top-level render
function renderCenter() {
  const r = R();
  $('welcome').hidden = !!r;
  $('graph').hidden = !r || !!r.view;
  $('diff').hidden = !r || !r.view;
  if (!r) return renderWelcome();
  if (r.view) renderDiff();
  else renderGraph();
}
function renderWelcome() {
  put($('welcome'), 
    h('h1', {}, 'Branchline'),
    h('p', {}, 'Open a local repository or clone one from GitHub to get started.'),
    h(
      'div',
      { class: 'wbtns' },
      h('button', { class: 'btn primary', onclick: pickRepo }, 'Open a repository'),
      h('button', { class: 'btn', onclick: cloneDialog }, 'Clone from GitHub')
    ),
    S.recent.length
      ? h(
          'div',
          { class: 'recent' },
          h('div', { class: 'rh' }, 'RECENT'),
          S.recent.slice(0, 8).map((p) => h('div', { class: 'ri', onclick: () => openRepo(p) }, h('b', {}, base(p)), h('span', {}, p.replace(INFO.home, '~'))))
        )
      : null
  );
}
function renderStatus() {
  const r = R();
  const id = r?.data?.ident;
  put($('statusbar'), 
    id ? h('span', { title: 'Commits in this repository are authored as' }, `${id.name} <${id.email}>`) : null,
    h('span', { class: 'ver' }, INFO.version)
  );
}
function renderRepo() {
  renderToolbar();
  renderLeft();
  renderCenter();
  renderRight();
  renderStatus();
}
function renderAll() {
  renderTabs();
  renderTitleRight();
  const r = R();
  $('left').style.display = $('right').style.display = $('toolbar').style.display = r ? '' : 'none';
  if (r) r.rightSig = null;
  renderRepo();
}

// ------------------------------------------------------------ wiring
function wire() {
  $('filter-ico').append(icon('search', 12));
  $('gsearch-x').append(icon('close', 12));
  $('gcols').append(icon('gear', 13));
  $('gcols').addEventListener('click', (e) => columnsMenu(e.currentTarget));
  $('gscroll').addEventListener('scroll', () => requestAnimationFrame(renderGraph));
  new ResizeObserver(() => R() && !R().view && renderGraph()).observe($('gscroll'));
  $('filter').addEventListener('input', renderLeft);
  $('gsearch-in').addEventListener('input', debounce(() => runSearch(0), 150));
  $('gsearch-in').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') toggleSearch(false);
  });
  $('gsearch-x').addEventListener('click', () => toggleSearch(false));
  $('gscroll').addEventListener('keydown', (e) => {
    const r = R();
    if (!r || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const i = (r.index.get(r.selected) ?? 0) + (e.key === 'ArrowDown' ? 1 : -1);
    if (i >= 0 && i < r.rows.length) selectSha(r.rows[i].commit.sha, true);
  });
  for (const rz of document.querySelectorAll('.resizer')) {
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const key = rz.dataset.col;
      const start = e.clientX;
      const w0 = rz.parentElement.getBoundingClientRect().width;
      const move = (ev) => {
        S.settings[key] = Math.max(70, Math.min(700, w0 + ev.clientX - start));
        renderGraph();
      };
      const up = () => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        save();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    rz.addEventListener('dblclick', () => {
      S.settings[rz.dataset.col] = rz.dataset.col === 'refW' ? 150 : null;
      save();
      renderGraph();
    });
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      if (!document.querySelector('.modal-back')) closeDiff();
    }
    if (e.key === 'f' && e.metaKey && e.altKey) $('filter').focus();
    // With a file diff open, up/down step through the files in the right panel.
    const r = R();
    if (r && r.view && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !document.querySelector('.modal-back, .menu')) {
      const rows = [...document.querySelectorAll('#right .file')];
      const at = rows.findIndex((el) => el.classList.contains('open'));
      const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
      e.preventDefault();
      if (at < 0 || !next) return;
      const idx = rows.indexOf(next);
      next.click();
      document.querySelectorAll('#right .file')[idx]?.scrollIntoView({ block: 'nearest' });
    }
  });
  addEventListener('focus', () => R() && refresh(R().path));
  setInterval(() => document.hasFocus() && R() && R().data && refresh(R().path, { statusOnly: true }), 4000);
  api.onRepoChanged((p) => repos.has(p) && refresh(p));
  api.onMenu((cmd) => {
    const r = R();
    const need = (fn) => r && r.data && fn();
    ({
      open: pickRepo,
      clone: cloneDialog,
      settings: settingsDialog,
      'close-tab': () => S.tabs.length && closeTab(S.active),
      fetch: () => need(fetchAll),
      pull: () => need(pull),
      push: () => need(push),
      branch: () => need(createBranch),
      search: () => need(() => toggleSearch(true)),
      refresh: () => need(() => refresh(r.path)),
    })[cmd]?.();
  });
}

async function init() {
  INFO = await api.info();
  const stored = await api.storeLoad();
  if (stored) S = { ...S, ...stored, settings: { ...S.settings, ...(stored.settings || {}), cols: { ...S.settings.cols, ...((stored.settings || {}).cols || {}) } } };
  for (const [e, u] of Object.entries(S.avatarMap || {})) G.setAvatar(e, u);
  setCompact(S.settings.compact);
  wire();
  await initProfiles();
  // Drop tabs whose folders no longer exist.
  const ok = await Promise.all(S.tabs.map((t) => G.git(t.path, ['rev-parse', '--git-dir']).then((x) => x.code === 0)));
  S.tabs = S.tabs.filter((t, i) => ok[i]);
  S.active = Math.max(0, Math.min(S.active, S.tabs.length - 1));
  if (INFO.devOpen) {
    for (const p of INFO.devOpen.split(':')) await openRepo(p, { quiet: true });
  } else activate(S.active);
 wireDrops();
  window.__app = { moveTab, columnsMenu, applyGraphSettings, S: () => S, R, repos, openRepo, selectSha, openDiff, refresh, squash, squashable, headChain, cloneDialog, profileMenu, commitMenu, activate, checkout, cherryPick, resetTo, stash, pop, mergeInto, rebaseOnto, undo, redo, stage, unstage, stageAll, doCommit, switchProfile, applyHunk, push, pull, createBranch, G };
}
init();
