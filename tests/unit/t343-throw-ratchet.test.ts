/**
 * T-343 S1 — R8: the raw `throw new Error(` ratchet. docs/tasks/343-def-417-human-readable-refusals.md
 * §S1: "count `throw new Error(` in `packages/domain/src`, `packages/auth/src`,
 * `packages/db/src/repo` (excl. tests) `<= CEILING` measured at HEAD (≈736) and written in; later
 * slices lower it. Green on arrival; record the number."
 *
 * Measured directly against HEAD `8ecc97b` (grep -rE 'throw new Error\(' over the three directories,
 * excluding `*.test.ts` and any `tests/` subdirectory): **736**. CEILING is written as exactly that
 * measured number, so this test is GREEN on arrival — its job from here on is to fail the moment a
 * NEW raw `throw new Error(` is added to these three trees, and to force whoever lowers it (S5+) to
 * touch this one line rather than silently drifting.
 *
 * ⛔ Pure `fs` traversal, not a shelled-out `grep` — this repo runs on Windows (PowerShell primary),
 * and a Bash-only command here would be a portability trap the CI runner does not share.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const TARGET_DIRS = ['packages/domain/src', 'packages/auth/src', 'packages/db/src/repo'];

/** Measured at HEAD 8ecc97b (2026-09-25) — see this file's header. Lower it as later slices (S5+)
 *  convert raw throws to `refuse(...)`/`recordGone(...)`; never raise it. */
const CEILING = 736;

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function countRawThrowNewError(): number {
  let total = 0;
  for (const relDir of TARGET_DIRS) {
    const abs = resolve(repoRoot, relDir);
    for (const file of collectTsFiles(abs)) {
      const text = readFileSync(file, 'utf8');
      const matches = text.match(/throw new Error\(/g);
      if (matches) total += matches.length;
    }
  }
  return total;
}

describe('T-343 R8 — the raw throw-new-Error ratchet never rises', () => {
  it(`packages/domain/src + packages/auth/src + packages/db/src/repo have at most ${CEILING} raw 'throw new Error(' sites`, () => {
    const count = countRawThrowNewError();
    // Printed so a lane lowering the ceiling later has the real number, not a guess.
    // eslint-disable-next-line no-console
    console.log(`T-343 ratchet: ${count} raw 'throw new Error(' sites (ceiling ${CEILING})`);
    expect(count).toBeLessThanOrEqual(CEILING);
  });
});
