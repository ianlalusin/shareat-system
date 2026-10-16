// Static export for the Capacitor APK: same as `next build`, with BUILD_TARGET=capacitor (no cross-env needed).
// The bundled app reaches v1's server for its few online-only calls (T-422 ruling 3); the base can be overridden.
//
// T-424 Ruling 1 (v1's build-capacitor.mjs pattern): a static export cannot carry route handlers or middleware, and the APK must hold none of the
// POS v2 server. So `src/app/api`, `src/middleware.ts` and `src/server` (the server code and its tests, which import the route files) are moved
// aside for the export and ALWAYS put back (finally), even if the build fails. No client file imports any of them (tests/unit/pos-v2-server-boundary.test.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stashDir = join(root, '.cap-stash');
const targets = [
  { from: join(root, 'src', 'app', 'api'), to: join(stashDir, 'app-api') },
  { from: join(root, 'src', 'middleware.ts'), to: join(stashDir, 'middleware.ts') },
  { from: join(root, 'src', 'server'), to: join(stashDir, 'server') },
];

function stash() {
  mkdirSync(stashDir, { recursive: true });
  for (const t of targets) if (existsSync(t.from)) renameSync(t.from, t.to);
}
function restore() {
  for (const t of targets) if (existsSync(t.to) && !existsSync(t.from)) renameSync(t.to, t.from);
  if (existsSync(stashDir)) rmSync(stashDir, { recursive: true, force: true });
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
      NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || 'https://app.shareat.net',
    },
  });
  status = r.status ?? 1;
} finally {
  restore();
}
process.exit(status);
