// T-417: which app CI jobs run. Reads changed paths on stdin (one per line) or the literal UNKNOWN.
// Prints `pos=true|false` and `customer=true|false`. Fails OPEN: UNKNOWN means both true.
// Node built-ins only, because the `changes` job runs before `npm ci`.
import { readFileSync } from 'node:fs';

const APPS = ['pos', 'customer'];
// Anything here can change every app's build, so it affects all apps.
const SHARED_EXACT = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.github/workflows/ci.yml',
  '.github/workflows/app-build.yml',
  'scripts/ci-affected-apps.mjs',
  'scripts/apk-signing-gate.mjs',
]);

const lines = readFileSync(0, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

const result = Object.fromEntries(APPS.map((a) => [a, false]));

if (lines.includes('UNKNOWN')) {
  for (const a of APPS) result[a] = true;
} else {
  for (const f of lines) {
    if (SHARED_EXACT.has(f) || f.startsWith('packages/')) {
      for (const a of APPS) result[a] = true;
      continue;
    }
    for (const a of APPS) if (f.startsWith(`apps/${a}/`)) result[a] = true;
  }
}

for (const a of APPS) console.log(`${a}=${result[a]}`);
