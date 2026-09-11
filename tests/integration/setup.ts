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
 * ⚠️ **OFF BY DEFAULT, and that is a deliberate, temporary, tracked state — not a permanent
 * escape hatch.** Arming it suite-wide turns every pre-existing unprincipalled path red at once,
 * and this project has already ruled that shipping a permanently red gate is worse than the
 * defect, because it teaches the next person to say "that red is expected". So the flip is opt-in
 * until the red set is measured and repaired, then the default flips and DEF-218 closes.
 *
 *     INTEGRATION_RESTRICTED_ROLE=1 npx vitest run --project integration
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

if (process.env.INTEGRATION_RESTRICTED_ROLE === '1') {
  // `new URL()`, never string surgery — a password may legitimately contain `@`.
  const restricted = new URL(url);
  restricted.username = RESTRICTED_TEST_ROLE;
  restricted.password = RESTRICTED_TEST_PASSWORD;
  process.env.DATABASE_URL = restricted.toString();
  process.env.SYSTEM_DATABASE_URL = url;
} else {
  process.env.DATABASE_URL = url;
}
