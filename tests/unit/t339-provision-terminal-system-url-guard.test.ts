import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * T-339 slice 3 (DEF-337) — `provision-terminal.ts` checks only `DATABASE_URL`, then calls
 * `systemTransaction`, which silently falls back to `DATABASE_URL` when `SYSTEM_DATABASE_URL` is
 * unset or blank. Post the 2026-09-12 role swap, an unset value means every store looks missing
 * under the RLS-enforcing role — not "not production, not local dev".
 *
 * Spawn precedent: `packages/db/tests/db-generate-retired.test.ts:36-37`.
 *
 * Each spawn sets `DATABASE_URL` to an unreachable address, so a missing guard fails on a
 * connection error that never names `SYSTEM_DATABASE_URL` — the red this test proves.
 */
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'provision-terminal.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const UNREACHABLE_DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(env: Record<string, string | undefined>, cwd: string) {
  return spawnSync(process.execPath, [tsxCli, scriptPath, '--store=NOPE', '--uid=x'], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

describe('provision-terminal refuses without SYSTEM_DATABASE_URL (DEF-337)', () => {
  // ⚠️ Explicit vitest test timeouts below (60_000, matching spawnSync's own `timeout: 60_000`
  // above — precedent `packages/db/tests/db-generate-retired.test.ts`): spawning `tsx` per test
  // is slow, and under full-suite load these four regularly exceed vitest's default 5000ms test
  // timeout despite the underlying spawn succeeding well inside it. That is a test-runner budget
  // problem, not a sign the guard is slow.
  it(
    "red: SYSTEM_DATABASE_URL='' is refused, naming the variable, not a connection error",
    () => {
      const r = run({ DATABASE_URL: UNREACHABLE_DATABASE_URL, SYSTEM_DATABASE_URL: '' }, repoRoot);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/SYSTEM_DATABASE_URL is not set/);
      expect(r.stderr).not.toMatch(/no store with code/);
    },
    60_000,
  );

  it(
    "red: SYSTEM_DATABASE_URL='   ' (whitespace-only) is refused, naming the variable",
    () => {
      const r = run({ DATABASE_URL: UNREACHABLE_DATABASE_URL, SYSTEM_DATABASE_URL: '   ' }, repoRoot);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/SYSTEM_DATABASE_URL is not set/);
      expect(r.stderr).not.toMatch(/no store with code/);
    },
    60_000,
  );

  it(
    'red: SYSTEM_DATABASE_URL absent (and no .env.local to supply it) is refused, naming the variable',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 't339-provision-terminal-'));
      tempDirs.push(dir);
      const env: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        // No .env.local in `dir` to supply this (or SYSTEM_DATABASE_URL) — the env contract
        // (packages/core/src/env.ts) still requires it regardless of this test's own env var.
        SESSION_SECRET: 'a'.repeat(32),
      };
      delete env.SYSTEM_DATABASE_URL;
      const r = run(env, dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/SYSTEM_DATABASE_URL is not set/);
      expect(r.stderr).not.toMatch(/no store with code/);
    },
    60_000,
  );

  it(
    'negative half: a real (if unreachable) SYSTEM_DATABASE_URL is not refused by this guard',
    () => {
      const r = run(
        { DATABASE_URL: UNREACHABLE_DATABASE_URL, SYSTEM_DATABASE_URL: UNREACHABLE_DATABASE_URL },
        repoRoot,
      );
      // The guard must not fire unconditionally — the connection error itself varies by machine,
      // so only assert the guard's own message is ABSENT.
      expect(r.stderr).not.toMatch(/SYSTEM_DATABASE_URL is not set/);
      // Positive control: prove the script actually got PAST the guard and reached the DB lookup,
      // rather than this being a vacuous pass from some earlier, unrelated failure.
      expect(r.stderr).toMatch(/ECONNREFUSED|connect|no store with code/);
    },
    60_000,
  );
});

/**
 * /code-review finding — a NON-blank `SYSTEM_DATABASE_URL` is not enough: DEF-337's real hazard is
 * a role that connects fine but lacks `rolbypassrls`, under which every store still looks missing
 * (silently, via RLS) rather than loudly refusing. `scripts/backfill-canonical-positions.ts:108`'s
 * `currentRole()` already queries `select current_user as role` after connecting and PRINTS it for
 * exactly this reason (so a `0` count can be told apart from a wrong-role read) — but it only
 * informs, it does not refuse. DEF-337's disposition is "refuse, never warn" (RULES §1 rule 7 /
 * bible §13 row 201), so `provision-terminal.ts` needs its own check, done BEFORE trusting a
 * lookup, not after.
 *
 * ⭐ CHOSEN: a source-structure test, not a live spawn against a real non-bypass role. A genuine
 * spawn would need a login role known, in THIS environment, to have `rolbypassrls = false` against
 * whatever database `SYSTEM_DATABASE_URL` would point to — `RESTRICTED_TEST_ROLE`
 * (`tests/integration/setup.ts`) is that role for `TEST_DATABASE_URL`'s *test* database only, and
 * borrowing it here would make this test's correctness depend on that fixture's shape and
 * lifecycle (created/dropped per test run) rather than on `provision-terminal.ts`'s own text —
 * fragile in exactly the way a source-structure check (mirroring the `currentRole()` precedent
 * this file already cites) is not. If a stable, purpose-built non-bypass role/URL becomes
 * available outside the test-DB fixture lifecycle, replace this with a real spawn.
 */
describe('provision-terminal also refuses a SYSTEM_DATABASE_URL role without rolbypassrls (DEF-337)', () => {
  const scriptSource = readFileSync(scriptPath, 'utf8');

  /**
   * `main()`'s own body — not the whole file. A bare `scriptSource.search(/rolbypassrls/)`
   * matches whichever occurs FIRST in the file's TEXT, which is the SQL string literal
   * (`select rolbypassrls from pg_roles ...`) inside `assertSystemRoleBypassesRls`'s own
   * DECLARATION, well above `main()`. Declaration order is not call order — a helper can be
   * declared early and never actually invoked, or invoked in the wrong place — so this must slice
   * `main()`'s body and look for the CALL SITE, `await assertSystemRoleBypassesRls(`, not the
   * word "rolbypassrls" anywhere in the file.
   *
   * Proof this is the right thing to assert: if the call line `await
   * assertSystemRoleBypassesRls();` were deleted from `main()` (the check still declared,
   * unreachable), `mainBody.indexOf('await assertSystemRoleBypassesRls(')` becomes -1 and the
   * first assertion below fails outright — it does not silently pass by falling back to matching
   * the declaration elsewhere in the file, because `mainBody` never contains the declaration.
   */
  function mainBody(src: string): string {
    const start = src.indexOf('async function main(');
    if (start === -1) throw new Error('main() not found — script structure changed.');
    const bodyStart = src.indexOf('{', start);
    // main() is the last top-level function in this file, closed by the final top-level `}`
    // immediately before `main()\n  .catch(`. Locate that call to bound the slice precisely
    // rather than guessing a brace-depth scan for a file this test does not own.
    const callSiteStart = src.indexOf('\nmain()', bodyStart);
    if (callSiteStart === -1) throw new Error('main() invocation ("main()\\n  .catch(") not found.');
    return src.slice(bodyStart, callSiteStart);
  }

  it('red: main() actually CALLS assertSystemRoleBypassesRls() before its first store lookup', () => {
    const body = mainBody(scriptSource);

    const callIdx = body.indexOf('await assertSystemRoleBypassesRls(');
    expect(
      callIdx,
      'main() never calls assertSystemRoleBypassesRls() — declaring the check is not enough if ' +
        'nothing inside main() actually invokes it',
    ).toBeGreaterThan(-1);

    const firstLookupIdx = body.indexOf('systemTransaction((tx) => findStoreByCode(');
    expect(firstLookupIdx, 'findStoreByCode call not found inside main() — script structure changed').toBeGreaterThan(-1);

    expect(
      callIdx,
      'assertSystemRoleBypassesRls() must be CALLED before the first store lookup inside main(), ' +
        'not merely declared somewhere in the file — a lookup that already ran under the wrong ' +
        'role has already produced its silent, misleading "not found"',
    ).toBeLessThan(firstLookupIdx);
  });

  it('negative half: the check REFUSES (throws or exits non-zero) rather than merely logging, unlike backfill-canonical-positions\'s currentRole()', () => {
    const bypassCheckIdx = scriptSource.search(/rolbypassrls/);
    if (bypassCheckIdx === -1) throw new Error('no rolbypassrls check found.');
    // A window after the check wide enough to reach its own refusal, not the next unrelated block.
    const window = scriptSource.slice(bypassCheckIdx, bypassCheckIdx + 500);
    const refuses = /throw\s+new\s+Error|process\.exitCode\s*=\s*1/.test(window);
    expect(refuses, 'a rolbypassrls check that only logs (console.log/console.error with no throw ' +
      'or exit) warns instead of refusing — DEF-337\'s disposition forbids that').toBe(true);
  });
});
