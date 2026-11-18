#!/usr/bin/env node
/**
 * census-write.mjs - T-604 S4: `npm run census:write` re-measures every census pin in one command.
 *
 *   npm run census:write
 *
 * What it does, in order:
 *   1. `npm run toc`                          (the bible and POSTING-PATTERNS tables of contents)
 *   2. docs/production-caller-baseline.txt    (names that gained a caller are removed; a new name needs approval)
 *   3. docs/ui-review/PAGES.md                (a row is appended for every page.tsx that has none, status "not reviewed")
 *   4. the unit census tests with CENSUS_WRITE=1, one worker (touch targets, form width and grid, editable record, submit label,
 *      typed forms, live check, throw ceilings, pages ledger, toc, production callers)
 *
 * Ratchets only tighten here: a LOWER count is written. A higher count or a new entry is NOT written; it prints
 * `NEEDS APPROVAL: <file> <key> <old> -> <new>` and the command exits non-zero (BOSS ruling, T-604 R2). Put every such line in the
 * PR description. Refuses to run in CI (CI must never rewrite its own baselines).
 *
 * Not automated (a person decides each): the same-org census (t398), register rows (register-row-shape).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CI) {
  console.error('census:write refuses to run in CI.');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'census-'));
const reportFile = path.join(tmp, 'report.txt');
writeFileSync(reportFile, '');
const env = { ...process.env, CENSUS_WRITE: '1', CENSUS_REPORT: reportFile };
const approvals = [];
const approve = (file, key, from, to) => {
  const line = `NEEDS APPROVAL: ${file} ${key} ${from} -> ${to}`;
  console.log(line);
  approvals.push(line);
};
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;
}

let failed = false;

// 1. tables of contents
console.log('== toc');
if (run(npm, ['run', 'toc']) !== 0) failed = true;

// 2. production-caller baseline: removals only
console.log('== production callers');
{
  const file = 'docs/production-caller-baseline.txt';
  const out = execFileSync('node', ['scripts/production-caller-census.mjs', '--names'], { cwd: root, encoding: 'utf8', env });
  const current = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const raw = readFileSync(path.join(root, file), 'utf8');
  const base = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const n of current) if (!base.includes(n)) approve(file, n, 'absent', 'present');
  const kept = base.filter((n) => current.includes(n));
  if (kept.length !== base.length) {
    writeFileSync(path.join(root, file), `${kept.join('\n')}\n`);
    console.log(`${file}: ${base.length - kept.length} removed`);
  }
}

// 3. pages ledger: append only
console.log('== pages ledger');
{
  const file = 'docs/ui-review/PAGES.md';
  const appDir = path.join(root, 'apps', 'erp', 'src', 'app');
  const pages = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'page.tsx') pages.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(appDir);
  const routeOf = (f) =>
    '/' +
    path
      .relative(appDir, path.join(root, f))
      .split(path.sep)
      .join('/')
      .replace(/\/?page\.tsx$/, '')
      .split('/')
      .filter((s) => s && !(s.startsWith('(') && s.endsWith(')')))
      .join('/');
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
  const have = new Set(lines.filter((l) => l.startsWith('| /')).map((l) => l.split('|')[2]?.trim()));
  const rows = pages.filter((f) => !have.has(f)).map((f) => `| ${routeOf(f)} | ${f} | - | not reviewed | - | - | new page, not reviewed |`);
  if (rows.length > 0) {
    const last = lines.map((l) => l.startsWith('| /')).lastIndexOf(true);
    lines.splice(last + 1, 0, ...rows);
    writeFileSync(path.join(root, file), lines.join('\n'));
    console.log(`${file}: ${rows.length} row(s) appended (status "not reviewed")`);
  }
}

// 4. the unit census tests, write mode
console.log('== census tests');
const tests = [
  'apps/erp/tests/action-link-sweep.test.ts',
  'apps/erp/tests/t384-s2-full-width.test.ts',
  'apps/erp/tests/t384-s3-lock-and-save-guard.test.ts',
  'apps/erp/tests/t389-keep-typing-guard.test.ts',
  'apps/erp/tests/t440-s2-live-check-guard.test.ts',
  'tests/unit/t343-throw-ratchet.test.ts',
  'tests/unit/production-caller-ratchet.test.ts',
  'apps/erp/tests/t589-pages-ledger.test.ts',
  'tests/unit/toc-freshness.test.ts',
].filter((t) => existsSync(path.join(root, t)));
if (run(npx, ['vitest', 'run', '--project', 'unit', '--maxWorkers=1', ...tests]) !== 0) failed = true;

for (const line of readFileSync(reportFile, 'utf8').split('\n').filter(Boolean)) if (!approvals.includes(line)) approvals.push(line);
rmSync(tmp, { recursive: true, force: true });

console.log('');
if (approvals.length > 0) {
  console.log('Put these in the PR description (a raise or a new entry is a human decision):');
  for (const l of [...new Set(approvals)]) console.log(l);
}
process.exit(approvals.length > 0 || failed ? 1 : 0);
