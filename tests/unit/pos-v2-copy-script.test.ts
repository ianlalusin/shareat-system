/**
 * T-422 slice T, Acceptance case 7 - behaviour of `apps/pos/scripts/copy-from-v1.mjs`, run against a
 * tiny fixture git repo built here in os.tmpdir(). Git runs ONLY inside that temp repo.
 *
 * CLI CONTRACT (defined here; the builder implements it):
 *   node apps/pos/scripts/copy-from-v1.mjs --repo <path> --commit <sha> --out <dir> [--dry-run]
 *   --repo     the v1 git repository (read only, via `git -C <repo> show|ls-tree <sha>:...`)
 *   --commit   REQUIRED. Without it the script exits non-zero and writes nothing.
 *   --out      destination root (production use: apps/pos). Files land at <out>/<path-in-repo>.
 *   --dry-run  prints the closure's file list to stdout, one repo-relative path per line (forward
 *              slashes, e.g. `src/a.ts`), and writes NOTHING (not even --out).
 * The closure starts at the kept routes' page/layout files (the fixture has only `src/app/page.tsx`)
 * and follows static + dynamic imports. The working tree is never read.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(repoRoot, 'apps', 'pos', 'scripts', 'copy-from-v1.mjs');

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 't422-'));
  tmpRoots.push(d);
  return d;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

function put(root: string, rel: string, body: string) {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, body, 'utf8');
}

/** Committed: page -> ./a -> dynamic ./b ; c is unreferenced. Optionally dirties a.ts afterwards. */
function fixture(opts: { dirty: boolean }) {
  const repo = tmp();
  git(repo, 'init', '-q');
  put(repo, 'src/app/page.tsx', "import { a } from '../a';\nexport default function P() { return a; }\n");
  put(repo, 'src/a.ts', "export const a = () => import('./b'); // COMMITTED\n");
  put(repo, 'src/b.ts', 'export const b = 1;\n');
  put(repo, 'src/c.ts', 'export const c = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  const sha = git(repo, 'rev-parse', 'HEAD');
  if (opts.dirty) {
    // Uncommitted: a.ts now also imports c and carries a marker. Reading the working tree would list c.ts.
    put(repo, 'src/a.ts', "import './c';\nexport const a = () => import('./b'); // DIRTY-EDIT\n");
    put(repo, 'src/dirty-new.ts', 'export const d = 1;\n');
  }
  return { repo, sha };
}

const run = (args: string[]) => spawnSync('node', [SCRIPT, ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 });
const listed = (stdout: string) => stdout.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean);
const has = (lines: string[], file: string) => lines.some((l) => l === file || l.endsWith('/' + file));

const walk = (d: string): string[] =>
  existsSync(d)
    ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    : [];

describe('T-422 case 7 - copy-from-v1.mjs', () => {
  it('the script exists at apps/pos/scripts/copy-from-v1.mjs. Mutant: copy done by hand, not reproducible', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('--dry-run follows static and dynamic imports and omits an unreferenced file. Mutant: closure misses import(), or copies all of src/', () => {
    const { repo, sha } = fixture({ dirty: false });
    const out = path.join(tmp(), 'out');
    const r = run(['--repo', repo, '--commit', sha, '--out', out, '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    const files = listed(r.stdout);
    expect(has(files, 'src/app/page.tsx'), files.join('|')).toBe(true);
    expect(has(files, 'src/a.ts'), files.join('|')).toBe(true);
    expect(has(files, 'src/b.ts'), 'dynamic import("./b") must be followed').toBe(true);
    expect(has(files, 'src/c.ts'), 'unreferenced file must not be listed').toBe(false);
  });

  it('--dry-run writes nothing. Mutant: dry-run copies anyway', () => {
    const { repo, sha } = fixture({ dirty: false });
    const out = path.join(tmp(), 'out');
    const r = run(['--repo', repo, '--commit', sha, '--out', out, '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(walk(out)).toEqual([]);
  });

  it('ignores uncommitted working-tree changes: no dirty import followed, no dirty file listed. Mutant: copying the dirty tree (the birthday-song WIP)', () => {
    const { repo, sha } = fixture({ dirty: true });
    const out = path.join(tmp(), 'out');
    const r = run(['--repo', repo, '--commit', sha, '--out', out, '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    const files = listed(r.stdout);
    expect(has(files, 'src/a.ts'), files.join('|')).toBe(true);
    expect(has(files, 'src/c.ts'), 'dirty a.ts imports c; the commit does not').toBe(false);
    expect(has(files, 'src/dirty-new.ts')).toBe(false);
  });

  it('a real run copies the COMMITTED content, not the dirty edit. Mutant: reads the working tree', () => {
    const { repo, sha } = fixture({ dirty: true });
    const out = path.join(tmp(), 'out');
    const r = run(['--repo', repo, '--commit', sha, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const copied = walk(out);
    const a = copied.find((f) => /[\\/]a\.ts$/.test(f));
    expect(a, copied.join('|')).toBeTruthy();
    const body = readFileSync(a!, 'utf8');
    expect(body).toContain('COMMITTED');
    expect(body).not.toContain('DIRTY-EDIT');
    expect(copied.some((f) => /[\\/]b\.ts$/.test(f))).toBe(true);
    expect(copied.some((f) => /[\\/]c\.ts$/.test(f))).toBe(false);
    expect(copied.some((f) => /[\\/]dirty-new\.ts$/.test(f))).toBe(false);
  });

  it('refuses to run without --commit (non-zero exit, nothing written). Mutant: silently falls back to HEAD / the working tree', () => {
    const { repo } = fixture({ dirty: false });
    const out = path.join(tmp(), 'out');
    const r = run(['--repo', repo, '--out', out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr, 'must be the script refusing, not node failing to find it').not.toMatch(/Cannot find module/);
    expect(walk(out)).toEqual([]);
  });
});
