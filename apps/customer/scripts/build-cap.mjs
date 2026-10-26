// Static export for the Capacitor APK: same as `next build`, with BUILD_TARGET=capacitor (no cross-env needed).
// The bundled app reaches v1's server for its few online-only calls (T-422 ruling 3); the base can be overridden.
//
// T-424 Ruling 1 (v1's build-capacitor.mjs pattern): a static export cannot carry route handlers or middleware, and the APK must hold none of the
// POS v2 server. So `src/app/api`, `src/middleware.ts` and `src/server` (the server code and its tests, which import the route files) are moved
// aside for the export and ALWAYS put back (finally), even if the build fails. No client file imports any of them (tests/unit/pos-v2-server-boundary.test.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stashDir = join(root, '.cap-stash');
const targets = [
  { from: join(root, 'src', 'app', 'api'), to: join(stashDir, 'app-api') },
  { from: join(root, 'src', 'server'), to: join(stashDir, 'server') },
];

function checkedPath(candidate) {
  const absolute = resolve(candidate);
  const inside = relative(root, absolute);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new Error('build-cap: refusing a source move outside the customer workspace.');
  }
  // Do not follow a generated symlink/junction while merging or moving source.
  for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
      throw new Error('build-cap: refusing a source move through a symbolic link.');
    }
  }
  return absolute;
}
function entry(candidate) {
  try { return lstatSync(candidate); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function stash() {
  mkdirSync(stashDir, { recursive: true });
  for (const t of targets) if (entry(t.from)) renameSync(checkedPath(t.from), checkedPath(t.to));
}
function restoreEntry(from, to) {
  checkedPath(from);
  checkedPath(to);
  const saved = entry(from);
  if (!saved) return;
  const current = entry(to);
  if (!current) { renameSync(from, to); return; }
  // A collision is preserved on both sides for manual review. Only real
  // directories are traversed; files and symbolic links are never overwritten.
  if (!saved.isDirectory() || !current.isDirectory()) return;
  for (const name of readdirSync(from)) restoreEntry(join(from, name), join(to, name));
  if (readdirSync(from).length === 0) rmdirSync(from);
}
function restore() {
  for (const t of targets) restoreEntry(t.to, t.from);
  if (!entry(stashDir)) return;
  if (readdirSync(stashDir).length !== 0) {
    throw new Error('build-cap: saved source remains in .cap-stash. Both versions were preserved; review them before building again.');
  }
  rmdirSync(checkedPath(stashDir));
}

let status = 1;
try {
  // A crashed earlier run may have left files in the stash: put them back first so nothing is lost.
  if (existsSync(stashDir)) {
    console.warn('build-cap: WARNING - found a .cap-stash left by a crashed earlier run; restoring it before building.');
    restore();
  }
  stash();
  const r = spawnSync('npx', ['next', 'build'], {
    stdio: 'inherit',
    shell: true,
    cwd: root,
    env: {
      ...process.env,
      BUILD_TARGET: 'capacitor',
    },
  });
  status = r.status ?? 1;
} finally {
  restore();
}
process.exit(status);
