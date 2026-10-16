// Static export for the Capacitor APK: same as `next build`, with BUILD_TARGET=capacitor (no cross-env needed).
// The bundled app reaches v1's server for its few online-only calls (T-422 ruling 3); the base can be overridden.
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    BUILD_TARGET: 'capacitor',
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE || 'https://app.shareat.net',
  },
});
process.exit(r.status ?? 1);
