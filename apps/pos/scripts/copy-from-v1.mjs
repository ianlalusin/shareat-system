// T-422 (PC-3): reproducible copy of POS v1's floor screens into apps/pos.
//
//   node apps/pos/scripts/copy-from-v1.mjs --repo <path> --commit <sha> [--out <dir>] [--dry-run]
//
// Reads ONLY through `git -C <repo> show|ls-tree <sha>:...` (never the working tree, never a checkout).
// Starts at the kept routes (docs/tasks/422-pos-v2-copy-v1.md Ruling 1), follows every static and
// dynamic import that resolves into src/, then adds the tests whose subject is in the closure, the
// public/ files the closure references, and a few config files. Node built-ins only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// --- Ruling 1: kept routes (directory under src/app; '' = the root page) -------------------------
const KEPT_ROUTE_DIRS = [
  '', 'login', 'signup', 'forgot-password', 'pending', 'support', 'change-password', 'account', 'settings',
  'cashier', 'cashier/handover', 'cashier/receipts', 'cashier/sessions', 'kitchen', 'kitchen/history', 'server',
  'refill', 'receipts', 'receipt', 'pins', 'print/session-pin', 'reservations', 'reservations/details',
];
// Ruling 6d: v1's /admin/online-orders is a floor screen and moves to /online-orders.
const MOVED = { 'src/app/admin/online-orders/page.tsx': 'src/app/online-orders/page.tsx' };
const SPECIAL = ['page', 'layout', 'template', 'loading', 'error', 'global-error', 'not-found', 'default'];
const APP_ROOT_FILES = [
  'src/app/layout.tsx', 'src/app/providers.tsx', 'src/app/globals.css', 'src/app/not-found.tsx',
  'src/app/error.tsx', 'src/app/global-error.tsx', 'src/app/icon.ico', 'src/app/icon.png', 'src/app/icon.svg',
  'src/app/apple-icon.png',
];
const CONFIG_FILES = ['tailwind.config.ts', 'postcss.config.mjs', 'components.json'];
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.json', '.css'];
const CODE = /\.(ts|tsx)$/;
const TEXT = /\.(ts|tsx|js|jsx|json|css|mjs|webmanifest|html|svg|md)$/;

function fail(msg) {
  process.stderr.write(`copy-from-v1: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const a = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--repo') a.repo = argv[++i];
    else if (k === '--commit') a.commit = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else fail(`unknown argument ${k}`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.commit) fail('--commit <sha> is required (the copy is pinned to a commit; it never reads the working tree)');
if (!args.repo) fail('--repo <path> is required');
const repo = resolve(args.repo);
const out = resolve(args.out ?? join(here, '..'));

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
let commit;
try {
  commit = git('rev-parse', '--verify', `${args.commit}^{commit}`).toString('utf8').trim();
} catch {
  fail(`commit ${args.commit} not found in ${repo}`);
}
const files = new Set(git('ls-tree', '-r', '--name-only', '-z', commit).toString('utf8').split('\0').filter(Boolean));
const cache = new Map();
const blob = (p) => {
  if (!cache.has(p)) cache.set(p, git('show', `${commit}:${p}`));
  return cache.get(p);
};
const textCache = new Map();
const text = (p) => {
  if (!textCache.has(p)) textCache.set(p, blob(p).toString('utf8'));
  return textCache.get(p);
};

// --- import closure -----------------------------------------------------------------------------
function specifiers(src) {
  const found = [];
  for (const re of [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    let m;
    while ((m = re.exec(src)) !== null) if (m[1]) found.push(m[1]);
  }
  return found;
}

function norm(p) {
  const parts = [];
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') parts.pop();
    else parts.push(s);
  }
  return parts.join('/');
}

function resolveSpec(spec, from) {
  let base;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) base = norm(`${dirname(from)}/${spec}`);
  else return undefined;
  for (const e of EXTS) if (files.has(base + e)) return base + e;
  for (const i of ['index.ts', 'index.tsx']) if (files.has(`${base}/${i}`)) return `${base}/${i}`;
  return undefined;
}

const roots = [];
for (const d of KEPT_ROUTE_DIRS) for (const s of SPECIAL) for (const e of ['.tsx', '.ts']) roots.push(`src/app/${d ? d + '/' : ''}${s}${e}`);
roots.push(...Object.keys(MOVED), ...APP_ROOT_FILES);
// the online-orders page sits next to v1's admin layout/error files; only its own page moves.
const reached = new Set();
const stack = roots.filter((r) => files.has(r));
while (stack.length) {
  const f = stack.pop();
  if (reached.has(f)) continue;
  reached.add(f);
  if (!CODE.test(f)) continue;
  for (const spec of specifiers(text(f))) {
    const r = resolveSpec(spec, f);
    if (r && !reached.has(r)) stack.push(r);
  }
}

// --- tests whose subject is in the closure ------------------------------------------------------
const copied = new Set(reached);
const skippedTests = [];
for (const f of [...files].filter((x) => /^src\/.*\.test\.(ts|tsx)$/.test(x))) {
  const dir = dirname(f);
  const stem = f.slice(0, -(f.endsWith('.tsx') ? '.test.tsx'.length : '.test.ts'.length));
  const subjectBases = [stem, `${dirname(dir)}/${stem.slice(dir.length + 1)}`].filter((_, i) => i === 0 || dir.endsWith('__tests__'));
  const subject = subjectBases.some((b) => ['.ts', '.tsx'].some((e) => reached.has(b + e)) || ['index.ts', 'index.tsx'].some((i) => reached.has(`${b}/${i}`)));
  if (!subject) continue;
  // Everything the test imports must already be in the closure; otherwise it tests code we did not copy.
  const missing = specifiers(text(f)).map((s) => resolveSpec(s, f)).filter((r) => r && !reached.has(r) && !copied.has(r));
  if (missing.length) skippedTests.push(`${f} (imports uncopied ${[...new Set(missing)].join(', ')})`);
  else copied.add(f);
}

// --- public/ files the closure references, then config files ------------------------------------
const publicFiles = [...files].filter((f) => f.startsWith('public/'));
const refText = () => [...copied].filter((f) => TEXT.test(f)).map((f) => text(f)).join('\n');
const publicKept = new Set();
for (let changed = true; changed; ) {
  changed = false;
  const corpus = refText();
  for (const p of publicFiles) {
    if (publicKept.has(p)) continue;
    const url = '/' + p.slice('public/'.length);
    if (corpus.includes(`"${url}`) || corpus.includes(`'${url}`) || corpus.includes('`' + url) || corpus.includes(`(${url}`)) {
      publicKept.add(p);
      copied.add(p);
      changed = true;
    }
  }
}
for (const c of CONFIG_FILES) if (files.has(c)) copied.add(c);

const dest = (p) => MOVED[p] ?? p;
const list = [...copied].map(dest).sort();

if (args.dryRun) {
  process.stdout.write(list.join('\n') + (list.length ? '\n' : ''));
  process.exit(0);
}

for (const p of [...copied].sort()) {
  const target = join(out, dest(p));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, blob(p));
}

// V1-COPY.md: regenerate the header, keep the hand-edit log below the marker.
const MARK = '<!-- HAND-EDITS: kept by copy-from-v1.mjs when it is re-run; edit below this line -->';
const docPath = join(out, 'V1-COPY.md');
let keep = `${MARK}\n`;
if (existsSync(docPath)) {
  const old = readFileSync(docPath, 'utf8');
  const i = old.indexOf(MARK);
  if (i !== -1) keep = old.slice(i);
}
const header = [
  '# V1-COPY: where this code came from',
  '',
  `- Source: POS v1 (\`shareat-hub-v2\` app), commit \`${commit.slice(0, 7)}\` (${commit}).`,
  `- Copied: ${new Date().toISOString().slice(0, 10)}, ${copied.size} files (import closure of the kept routes, T-422 Ruling 4).`,
  '- Re-run: `node apps/pos/scripts/copy-from-v1.mjs --repo <POS repo> --commit <sha>` (reads git objects only, never the working tree).',
  `- Tests not copied because they import code outside the closure (${skippedTests.length}):`,
  ...(skippedTests.length ? skippedTests.map((t) => `  - ${t}`) : ['  - none']),
  '',
].join('\n');
writeFileSync(docPath, `${header}\n${keep}`);
process.stdout.write(`copied ${copied.size} files from ${commit.slice(0, 7)} into ${out}\n`);
