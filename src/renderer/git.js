// Git data access: every call shells out to the git CLI through the main process.
const api = window.api;

export const git = (cwd, args, opts) => api.git(cwd, args, opts);

export async function gitOut(cwd, args, opts) {
  const r = await git(cwd, args, opts);
  return r.code === 0 ? r.stdout : '';
}

const NOLOCK = { env: { GIT_OPTIONAL_LOCKS: '0' } };

export async function loadStatus(path) {
  const r = await git(path, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], NOLOCK);
  const st = { raw: r.stdout, staged: [], unstaged: [], conflicted: [], head: { sha: null, branch: null, upstream: null, ahead: 0, behind: 0 } };
  const toks = r.stdout.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.startsWith('# branch.oid ')) st.head.sha = t.slice(13) === '(initial)' ? null : t.slice(13);
    else if (t.startsWith('# branch.head ')) st.head.branch = t.slice(14) === '(detached)' ? null : t.slice(14);
    else if (t.startsWith('# branch.upstream ')) st.head.upstream = t.slice(18);
    else if (t.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(t);
      if (m) (st.head.ahead = +m[1]), (st.head.behind = +m[2]);
    } else if (t[0] === '1' || t[0] === '2') {
      const parts = t.split(' ');
      const xy = parts[1];
      const ren = t[0] === '2';
      const path_ = parts.slice(ren ? 9 : 8).join(' ');
      const orig = ren ? toks[++i] : null;
      if (xy[0] !== '.') st.staged.push({ path: path_, status: xy[0], orig });
      if (xy[1] !== '.') st.unstaged.push({ path: path_, status: xy[1], orig: null });
    } else if (t[0] === 'u') {
      st.conflicted.push({ path: t.split(' ').slice(10).join(' '), status: 'U' });
    } else if (t[0] === '?') {
      st.unstaged.push({ path: t.slice(2), status: '?' });
    }
  }
  return st;
}

function parseRefs(out) {
  const locals = [];
  const remotes = [];
  const tags = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, sha, peeled, upstream, track, head] = line.split('\x1f');
    if (ref.startsWith('refs/heads/')) {
      const a = /ahead (\d+)/.exec(track);
      const b = /behind (\d+)/.exec(track);
      locals.push({
        type: 'local',
        name: ref.slice(11),
        sha,
        upstream: upstream || null,
        ahead: a ? +a[1] : 0,
        behind: b ? +b[1] : 0,
        gone: /gone/.test(track),
        head: head === '*',
      });
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13);
      if (name.endsWith('/HEAD')) continue;
      const slash = name.indexOf('/');
      remotes.push({ type: 'remote', name, remote: name.slice(0, slash), short: name.slice(slash + 1), sha });
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ type: 'tag', name: ref.slice(10), sha: peeled || sha });
    }
  }
  return { locals, remotes, tags };
}

function parseLog(out) {
  const commits = [];
  const recs = out.split('\x1e');
  for (let i = 1; i < recs.length; i++) {
    const f = recs[i].split('\x1f');
    commits.push({
      sha: f[0],
      parents: f[1] ? f[1].split(' ') : [],
      author: f[2],
      email: f[3],
      at: +f[4],
      ct: +f[5],
      committer: f[6],
      cemail: f[7],
      subject: f[8],
      body: (f[9] || '').trim(),
    });
  }
  return commits;
}

export async function loadRepo(path, limit, prev, hidden = []) {
  const fmt = '%(refname)%1f%(objectname)%1f%(*objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)';
  const [refsOut, logOut, status, stashOut, remotesOut, ident, gitDir] = await Promise.all([
    gitOut(path, ['for-each-ref', '--format=' + fmt, 'refs/heads', 'refs/remotes', 'refs/tags'], NOLOCK),
    gitOut(
      path,
      ['log', '--date-order', '--exclude=refs/stash', '--exclude=refs/notes/*', ...hidden.map((x) => '--exclude=' + x), '--all', 'HEAD', '-n', String(limit), '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%cn%x1f%ce%x1f%s%x1f%b'],
      NOLOCK
    ),
    loadStatus(path),
    gitOut(path, ['stash', 'list', '--format=%gd%x1f%H%x1f%s%x1f%P%x1f%ct'], NOLOCK),
    gitOut(path, ['remote'], NOLOCK),
    gitOut(path, ['var', 'GIT_AUTHOR_IDENT'], NOLOCK),
    prev?.gitDir || gitOut(path, ['rev-parse', '--absolute-git-dir']).then((s) => s.trim()),
  ]);
  const same = prev && prev.rawLog === logOut && prev.rawRefs === refsOut && prev.rawStash === stashOut;
  const refs = same ? prev.refs : parseRefs(refsOut);
  const commits = same ? prev.commits : parseLog(logOut);
  const im = /^(.*) <(.*)> \d+ [+-]\d+/.exec(ident.trim());
  return {
    gitDir,
    rawLog: logOut,
    rawRefs: refsOut,
    rawStash: stashOut,
    same,
    refs,
    commits,
    status,
    head: status.head,
    stashes: stashOut
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, sha, msg, parents, ct] = l.split('\x1f');
        return { ref, sha, msg, parents: (parents || '').split(' ').filter(Boolean), ct: +ct };
      }),
    remotes: remotesOut.split('\n').filter(Boolean),
    ident: im ? { name: im[1], email: im[2] } : null,
    op: gitDir ? await api.repoOp(gitDir) : null,
  };
}

export async function commitFiles(path, c) {
  const args = c.parents.length
    ? ['diff', '--name-status', '-M', c.parents[0], c.sha]
    : ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', c.sha];
  const out = await gitOut(path, args, NOLOCK);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const p = l.split('\t');
      return p[0][0] === 'R' || p[0][0] === 'C' ? { status: p[0][0], orig: p[1], path: p[2] } : { status: p[0][0], path: p[1] };
    });
}

export async function fileDiff(path, file, mode, commit, opts = {}) {
  // full: the whole file as context. ws: ignore whitespace changes.
  const x = [...(opts.full ? ['-U100000'] : []), ...(opts.ws ? ['-w'] : [])];
  let args;
  if (mode === 'commit') {
    args = commit.parents.length
      ? ['diff', ...x, '-M', commit.parents[0], commit.sha, '--', file.path, ...(file.orig ? [file.orig] : [])]
      : ['show', ...x, '--format=', commit.sha, '--', file.path];
  } else if (mode === 'staged') {
    args = ['diff', ...x, '--cached', '-M', '--', file.path, ...(file.orig ? [file.orig] : [])];
  } else if (file.status === '?') {
    args = ['diff', ...x, '--no-index', '--', '/dev/null', file.path];
  } else {
    args = ['diff', ...x, '--', file.path];
  }
  const r = await git(path, args, NOLOCK);
  return r.stdout;
}

export function parseDiff(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header = [];
  const hunks = [];
  let cur = null;
  let binary = false;
  for (const l of lines) {
    const m = l.startsWith('@@') ? /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l) : null;
    if (m) {
      cur = { header: l, lines: [], o: +m[1], n: +m[2] };
      hunks.push(cur);
    } else if (cur) cur.lines.push(l);
    else {
      header.push(l);
      if (/^Binary files |^GIT binary patch/.test(l)) binary = true;
    }
  }
  return { header, hunks, binary };
}

export const hunkPatch = (diff, hunk) => diff.header.join('\n') + '\n' + hunk.header + '\n' + hunk.lines.join('\n') + '\n';

// ---- avatars ----
const avatarCache = new Map();
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function resolveAvatars(emails) {
  await Promise.all(
    emails
      .filter((e) => e && !avatarCache.has(e))
      .map(async (e) => {
        const m = /^(?:(\d+)\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(e);
        let url;
        if (m && m[1]) url = `https://avatars.githubusercontent.com/u/${m[1]}?s=64`;
        else if (m) url = `https://github.com/${encodeURIComponent(m[2])}.png?size=64`;
        else url = `https://www.gravatar.com/avatar/${await sha256(e.trim().toLowerCase())}?s=64&d=404`;
        avatarCache.set(e, url);
      })
  );
}
export const setAvatar = (email, url) => avatarCache.set(email, url);

// GitHub knows the avatar for most commit emails; ask it for the repo's recent commits.
export async function githubAvatars(path) {
  const url = (await gitOut(path, ['remote', 'get-url', 'origin'])).trim();
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (!m) return {};
  const pages = await Promise.all([1, 2, 3].map((p) => api.gh(['api', `repos/${m[1]}/commits?per_page=100&page=${p}`])));
  const found = {};
  for (const pg of pages) {
    if (pg.code !== 0) continue;
    try {
      for (const c of JSON.parse(pg.stdout)) {
        const email = c.commit?.author?.email;
        if (email && c.author?.avatar_url && !found[email]) found[email] = c.author.avatar_url + (c.author.avatar_url.includes('?') ? '&' : '?') + 's=64';
      }
    } catch {}
  }
  return found;
}
export const avatarUrl = (email) => avatarCache.get(email) || null;
export const avatarFailed = (email) => avatarCache.set(email, null);
