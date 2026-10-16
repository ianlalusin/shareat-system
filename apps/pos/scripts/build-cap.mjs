// Static export for the Capacitor APK: same as `next build`, with BUILD_TARGET=capacitor (no cross-env needed).
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, BUILD_TARGET: 'capacitor' },
});
process.exit(r.status ?? 1);
