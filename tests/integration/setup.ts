/**
 * Integration tests run against a REAL PostgreSQL, never a mock
 * (PROJECT_BIBLE.md §9 rule 3).
 *
 * They point at TEST_DATABASE_URL, which is truncated between runs — so it must never
 * be a database holding real data. This guard makes that mistake impossible rather than
 * merely discouraged.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

/**
 * T-400 — opt-in parallel workers, one database each. With `INTEGRATION_WORKERS` > 1 (and the
 * clones made by `scripts/make-integration-worker-dbs.mjs`), each vitest worker points
 * `TEST_DATABASE_URL` at `<base>_w<VITEST_POOL_ID>` BEFORE anything reads it. About 374 test
 * files open their own `postgres(TEST_DATABASE_URL)` seeding connection and follow only if the
 * variable itself changes. Unset or `1`: untouched, one shared database, serial as before.
 * ⛔ A worker silently sharing a database is the failure to prevent, so a bad pool id throws.
 */
const integrationWorkers = Number(process.env.INTEGRATION_WORKERS ?? 1);
if (integrationWorkers > 1) {
  const rawPoolId = process.env.VITEST_POOL_ID;
  const poolId = Number(rawPoolId);
  if (!rawPoolId || !Number.isInteger(poolId) || poolId < 1 || poolId > integrationWorkers) {
    throw new Error(
      `INTEGRATION_WORKERS=${integrationWorkers} needs VITEST_POOL_ID in 1..${integrationWorkers}; ` +
        `got ${rawPoolId === undefined ? 'nothing' : JSON.stringify(rawPoolId)}.`,
    );
  }
  // This file runs once per TEST FILE, but process.env belongs to the worker PROCESS, which runs
  // many files. Rewriting TEST_DATABASE_URL in place would give `_w1_w1` on the second file, so
  // derive from the base URL, remembered the first time.
  process.env.INTEGRATION_BASE_DATABASE_URL ??= process.env.TEST_DATABASE_URL;
  const base = process.env.INTEGRATION_BASE_DATABASE_URL;
  if (base) {
    // `new URL()`, never string surgery; the query string survives.
    const worker = new URL(base);
    worker.pathname = `${worker.pathname}_w${poolId}`;
    process.env.TEST_DATABASE_URL = worker.toString();
  }
}

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests need a real, disposable Postgres. ' +
      'See .env.example.',
  );
}

if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run integration tests against ${url.replace(/:\/\/[^@]*@/, '://***@')} — ` +
      'the database name must contain "_test". These tests TRUNCATE tables.',
  );
}

/**
 * T-251 / DEF-218 Contract 1+2 — the restricted harness role.
 *
 * ⛔ **`TEST_DATABASE_URL` stays the admin/bypass role and is deliberately NOT changed.** Every
 * test file's own raw `postgres(url)` fixture-seeding connection uses it directly to set up
 * scenario data, and rewriting ~70 files' fixtures to go through a principal is a different and
 * much larger task that nobody has asked for.
 *
 * What changes is `DATABASE_URL` — what `@shareat/db`'s `transaction()`/`getDb()` resolve — which
 * becomes a **non-superuser, non-BYPASSRLS, table-non-owning** role. A query that forgets its
 * principal is then refused loudly (`42501`) instead of quietly succeeding because the connecting
 * role happened to bypass RLS. That is the whole of DEF-218.
 *
 * ⭐ **ON BY DEFAULT as of 2026-09-12 — DEF-218 IS CLOSED.** This was opt-in from T-251 until the
 * red set it exposed was measured and repaired. It was: 623 red tests across 43 files (T-265) down
 * to 19, then to zero once bible row 194's three cross-org subsystems and Ian's bootstrap ruling
 * (row 195) were routed through `systemTransaction()` — T-267, T-268, T-269.
 *
 * ⛔ **The evidence for this flip, because a gate this important is not flipped on a hunch:** one
 * clean full-suite run, single invocation, quiet machine, migration 0142 applied —
 * **116 files / 2747 tests / 0 failed (1642s), 2026-09-12.** ⚠️ Not a composite of partial runs:
 * the same suite had already been seen green in two halves plus re-runs, and that was deliberately
 * judged insufficient, because "it was green in parts" is how a project inherits a belief it never
 * actually measured.
 *
 * ⚠️ **The reason it was opt-in matters and has not changed:** arming this suite-wide turns every
 * pre-existing unprincipalled path red at once, and shipping a permanently red gate is worse than
 * the defect — it teaches the next person to say "that red is expected". It is armed now precisely
 * because there is nothing left for it to turn red.
 *
 * To opt OUT for one run — debugging a fixture, bisecting an unrelated failure:
 *
 *     INTEGRATION_RESTRICTED_ROLE=0 npx vitest run --project integration
 *
 * ⛔ A green run with the flag set to `0` proves nothing about tenancy. If you opt out to get a
 * suite green, say so out loud; do not let it become the way the suite is run.
 *
 * ⚠️ `SYSTEM_DATABASE_URL` is pointed at the admin connection whenever the flag is on, so
 * `systemTransaction()`'s enumerable cross-org call sites (scheduler bookkeeping, first-run
 * bootstrap) keep the owner connection they have always had. Without this, arming the role turns
 * every scheduled job into a SILENT no-op — `listOrgsToRun` returns zero organisations rather than
 * erroring — which is the wrong failure direction and the exact trap T-251's spec was written to
 * avoid.
 *
 * The role is provisioned once per Postgres instance, not per lane database: see
 * `~/.claude/skills/orchestrator/tools/make-test-dbs.mjs`. Its password is a fixed, non-secret,
 * test-only constant, matching `ci.yml`'s existing plaintext `POSTGRES_PASSWORD: postgres`.
 */
export const RESTRICTED_TEST_ROLE = 'shareat_test_runner';
/** Test-only constant, deliberately not a secret. Keep in step with the provisioning script. */
export const RESTRICTED_TEST_PASSWORD = 'shareat_test_runner';

// ⭐ Opt-OUT, not opt-in — DEF-218 closed 2026-09-12. Only an explicit '0' disarms it, so a
// missing or misspelled variable arms the role rather than silently disarming it. That
// direction is deliberate: the failure mode of this flag must be "too strict", never
// "quietly not testing tenancy at all".
if (process.env.INTEGRATION_RESTRICTED_ROLE !== '0') {
  // `new URL()`, never string surgery — a password may legitimately contain `@`.
  const restricted = new URL(url);
  restricted.username = RESTRICTED_TEST_ROLE;
  restricted.password = RESTRICTED_TEST_PASSWORD;
  process.env.DATABASE_URL = restricted.toString();
  process.env.SYSTEM_DATABASE_URL = url;
} else {
  process.env.DATABASE_URL = url;
}
