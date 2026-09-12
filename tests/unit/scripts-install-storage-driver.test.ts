/**
 * T-277 — DEF-308: a standalone script that reaches a storage-touching domain export without
 * installing the real driver crashes on every organisation on its first real night — found by
 * smoketesting `scripts/orphan-file-sweep.ts` (T-272), not by any gate. `resolveStorageDriver()`
 * refuses the in-memory fallback when a bucket is configured, and the ONLY thing that installs the
 * real one is the Next.js app's own boot hook (`apps/erp/src/instrumentation.ts`), which no
 * standalone script runs. `docs/tasks/277-def-308-def-307-storage-driver-bootstrap.md`.
 *
 * ⛔ **This guard's population is ONE FILE TODAY, stated plainly rather than implied by breadth.**
 * `STORAGE_TOUCHING_CALLS` below is a hand-maintained list of call names reachable from `scripts/`
 * that reach `resolveStorageDriver()` — NOT a transitive-closure analysis. `scripts/
 * orphan-file-sweep.ts` calling `runOrphanFileSweep` (which calls `sweepOrphanedFiles` internally)
 * is the only match right now. This is the same declaration-list convention
 * `scheduler-jobs-have-callers.test.ts`'s `KNOWN_JOB_NAMES` already uses, for the same reason: a
 * transitive check would need real import resolution across files, which nothing in this test
 * family does. **Extend this list by hand the day a second job entry reaches storage** — a
 * low-level export added to `files/index.ts` (join `uploadFile`/`readFileUrl`/`sweepOrphanedFiles`)
 * or a new scheduler entry that wraps one (join `runOrphanFileSweep`). A guard with a population of
 * one whose header implied breadth would be this week's fifth instance of DEF-295/304/309/310's own
 * shape; this one says its size out loud instead.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * Hand-maintained, not derived — see the file header. The three low-level domain exports that
 * reach `resolveStorageDriver()` (`packages/domain/src/files/index.ts`), plus the one scheduler
 * entry point known to wrap one (`runOrphanFileSweep`, `packages/domain/src/scheduler/index.ts`).
 */
const STORAGE_TOUCHING_CALLS = ['uploadFile', 'readFileUrl', 'sweepOrphanedFiles', 'runOrphanFileSweep'];

/** The two ways a script can legitimately install the real driver — the shared helper, or the raw
 *  call it wraps (kept for `scripts/orphan-file-sweep.ts`'s pre-T-277 shape and any future script
 *  that has a reason to call `setStorageDriver` directly). */
const BOOTSTRAP_CALLS = ['installScriptStorageDriver', 'setStorageDriver'];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.includes('/tests/');

function scriptFiles(): string[] {
  return trackedFiles().filter((f) => f.startsWith('scripts/') && f.endsWith('.ts') && !isTest(f));
}

function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const read = (repoRelative: string) => codeOnly(readFileSync(path.join(repoRoot, repoRelative), 'utf8'));

/** Requires an actual CALL (open paren), not just an import — a name imported for its type and
 *  never invoked would otherwise read as "storage-touching" or "bootstrapped" wrongly. */
function callsAnyOf(names: string[], source: string): boolean {
  return names.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
}

/**
 * Confession list, same discipline as every other guard's EXEMPT — a script named here must state
 * WHY it reaches a storage-touching call without a bootstrap call of its own, e.g. because it is
 * called only from a runtime that already installed one.
 */
const EXEMPT: Record<string, string> = {};

describe('T-277 — every scripts/*.ts calling a storage-touching export installs the real driver first', () => {
  const scripts = scriptFiles();
  const withStorage = scripts.filter((f) => callsAnyOf(STORAGE_TOUCHING_CALLS, read(f)));

  it('⭐ finds the scripts and a non-empty storage-touching population (a scan of nothing passes silently)', () => {
    expect(scripts.length).toBeGreaterThan(5);
    expect(withStorage.length).toBeGreaterThanOrEqual(1);
  });

  it('⛔ every storage-touching script installs the real driver, or is a written exemption', () => {
    const missing = withStorage
      .filter((f) => !callsAnyOf(BOOTSTRAP_CALLS, read(f)) && EXEMPT[f] === undefined)
      .map(
        (f) =>
          `${f} calls a storage-touching export (${STORAGE_TOUCHING_CALLS.join('/')}) but never ` +
          `installs a real driver (${BOOTSTRAP_CALLS.join('/')}) — resolveStorageDriver() throws ` +
          'the moment FIREBASE_STORAGE_BUCKET is set, on every org, on the first real run (DEF-308).',
      )
      .sort();
    expect(missing).toEqual([]);
  });

  it('⚠️ no exemption outlives its reason — a script that DOES bootstrap must be deleted from EXEMPT', () => {
    const stale = Object.keys(EXEMPT)
      .filter((f) => !withStorage.includes(f) || callsAnyOf(BOOTSTRAP_CALLS, read(f)))
      .sort();
    expect(stale).toEqual([]);
  });
});
