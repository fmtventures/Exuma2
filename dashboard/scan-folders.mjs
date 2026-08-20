/**
 * Finds your projects on disk and matches them to the board.
 *
 *   node dashboard/scan-folders.mjs ~/Projects
 *   node dashboard/scan-folders.mjs ~/Projects --write
 *
 * Run this once locally and it answers, in one pass, the questions this board
 * still has blanks for: which repo is behind peifotoshop.com, whether Pelot
 * Photos is its own codebase, what Claire 80 is, and where each tool lives so a
 * local session can open it.
 *
 * Without --write it only reports. With --write it records `localPath` on every
 * tool it matched, and nothing else.
 *
 * Matching is by git remote first (exact, owner/repo), then by folder name
 * against the tool id and name. Anything it cannot place is listed separately
 * rather than guessed at.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(here, 'registry.json');

const args = process.argv.slice(2);
const write = args.includes('--write');
const roots = args.filter((a) => !a.startsWith('--'));

if (!roots.length) {
  console.error('Usage: node dashboard/scan-folders.mjs <folder> [more folders…] [--write]');
  console.error('Example: node dashboard/scan-folders.mjs ~/Projects ~/Sites');
  process.exit(1);
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor',
  'Library', 'Applications', '.Trash', '.cache', 'venv', '__pycache__']);
const MAX_DEPTH = 3;

function git(dir, cmdArgs) {
  try {
    return execFileSync('git', ['-C', dir, ...cmdArgs], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    }).trim();
  } catch { return null; }
}

/** owner/repo out of any of the URL forms git uses. */
function ownerRepo(url) {
  if (!url) return null;
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 2 || n > 4000) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (e.isDirectory()) walk(join(d, e.name), depth + 1);
      else if (/\.(html?|js|jsx|ts|tsx|py|rb|go|php|vue|svelte)$/i.test(e.name)) n++;
    }
  };
  walk(dir, 0);
  return n;
}

function titleOf(dir) {
  for (const f of ['index.html', 'home.html', 'app.html', 'public/index.html']) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try {
      const m = readFileSync(p, 'utf8').slice(0, 20000).match(/<title>([^<]{2,120})<\/title>/i);
      if (m) return m[1].replace(/\s+/g, ' ').trim();
    } catch { /* unreadable */ }
  }
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, 'utf8'));
      if (j.description) return j.description.slice(0, 120);
      if (j.name) return j.name;
    } catch { /* malformed */ }
  }
  return null;
}

/* ---- find candidate project folders ------------------------------------- */
const found = [];
const seen = new Set();

function scan(dir, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

  const isRepo = existsSync(join(dir, '.git'));
  const hasSite = ['index.html', 'package.json', 'app.html'].some((f) => existsSync(join(dir, f)));

  if ((isRepo || hasSite) && !seen.has(dir)) {
    seen.add(dir);
    found.push({
      path: dir,
      name: basename(dir),
      isRepo,
      remote: isRepo ? ownerRepo(git(dir, ['remote', 'get-url', 'origin'])) : null,
      lastCommit: isRepo ? git(dir, ['log', '-1', '--format=%ad', '--date=short']) : null,
      lastMessage: isRepo ? git(dir, ['log', '-1', '--format=%s']) : null,
      branch: isRepo ? git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) : null,
      dirty: isRepo ? (git(dir, ['status', '--porcelain']) || '').length > 0 : null,
      title: titleOf(dir),
      files: countFiles(dir),
    });
    /* A repo's subfolders are its own business — don't descend into it. */
    if (isRepo) return;
  }

  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
    scan(join(dir, e.name), depth + 1);
  }
}

roots.forEach((r) => {
  const abs = resolve(r.replace(/^~/, process.env.HOME || '~'));
  if (!existsSync(abs)) { console.error(`Skipping, not found: ${abs}`); return; }
  if (!statSync(abs).isDirectory()) { console.error(`Skipping, not a directory: ${abs}`); return; }
  scan(abs, 0);
});

/* ---- match against the registry ----------------------------------------- */
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const matches = new Map(); // toolId -> folder
const unplaced = [];

for (const f of found) {
  let tool = null;

  if (f.remote) {
    tool = registry.tools.find((t) => t.repo && norm(t.repo) === norm(f.remote));
  }
  if (!tool) {
    tool = registry.tools.find((t) => norm(t.id) === norm(f.name) || norm(t.name) === norm(f.name));
  }

  if (tool && !matches.has(tool.id)) matches.set(tool.id, f);
  else if (tool) unplaced.push({ ...f, note: `also looks like ${tool.name}` });
  else unplaced.push(f);
}

/* ---- report ------------------------------------------------------------- */
/* Always leaves at least one space, so a full-width value cannot run into the
   next column. */
const pad = (s, n) => {
  const v = String(s == null ? '' : s);
  return v.length >= n ? v.slice(0, n - 2) + '… ' : v.padEnd(n);
};
const line = (n) => '─'.repeat(n);

console.log(`\nScanned ${roots.join(', ')} — found ${found.length} project folder(s).\n`);

console.log(`MATCHED TO THE BOARD (${matches.size})`);
console.log(line(96));
if (matches.size) {
  console.log(pad('Tool', 26) + pad('Branch', 14) + pad('Last commit', 13) + 'Path');
  for (const [id, f] of matches) {
    const t = registry.tools.find((x) => x.id === id);
    console.log(pad(t.name, 26) + pad((f.branch || '—') + (f.dirty ? '*' : ''), 14)
      + pad(f.lastCommit || '—', 13) + f.path);
  }
} else {
  console.log('  none');
}

const noFolder = registry.tools.filter((t) => !matches.has(t.id));
console.log(`\nON THE BOARD, NOT FOUND ON DISK (${noFolder.length})`);
console.log(line(96));
noFolder.forEach((t) => console.log('  ' + pad(t.name, 26) + (t.repo || 'no repo recorded')));

console.log(`\nON DISK, NOT ON THE BOARD (${unplaced.length})`);
console.log(line(96));
if (unplaced.length) {
  console.log('  These are the interesting ones — any of them could be Claire 80, the');
  console.log('  peifotoshop code, or Pelot Photos. Paste this section back to me.\n');
  unplaced.forEach((f) => {
    console.log('  ' + f.name + (f.remote ? `  [${f.remote}]` : f.isRepo ? '  [git, no remote]' : '  [not a repo]'));
    if (f.title) console.log('      title: ' + f.title);
    console.log(`      ${f.files} source file(s)${f.lastCommit ? ` · last commit ${f.lastCommit}` : ''}${f.note ? ` · ${f.note}` : ''}`);
    console.log('      ' + f.path);
  });
} else {
  console.log('  none');
}

/* ---- optionally record the paths --------------------------------------- */
if (write) {
  let n = 0;
  for (const [id, f] of matches) {
    const t = registry.tools.find((x) => x.id === id);
    if (t.localPath !== f.path) { t.localPath = f.path; n++; }
    if (!t.repo && f.remote) { t.repo = f.remote; n++; }
  }
  writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${n} field(s) into registry.json. Run \`node dashboard/build.mjs\` to rebuild.`);
} else {
  console.log('\nReport only. Re-run with --write to record these paths on the board.');
}
console.log('');
