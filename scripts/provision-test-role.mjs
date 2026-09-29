#!/usr/bin/env node
/**
 * provision-test-role.mjs — T-251 / DEF-218 Contract 1: the restricted integration-test
 * role, made reproducible instead of a thing someone created by hand once.
 *
 *     node scripts/provision-test-role.mjs
 *     npm run provision-test-role
 *
 * BACKGROUND (full story in `tests/integration/setup.ts`): integration tests connect as
 * `postgres`, a superuser that bypasses row-level security unconditionally. A query that
 * forgets which organisation it is acting for then succeeds silently instead of being
 * refused, so the tenancy protection migration 0011 built is never actually exercised by
 * the harness. `shareat_test_runner` is a non-superuser, non-BYPASSRLS login the tests can
 * connect as instead, so a missing principal comes back `42501` — loud, not silent.
 *
 * ⭐ ROLES ARE CLUSTER-WIDE; TABLE GRANTS ARE PER-DATABASE. This script does the cluster
 * half only: it creates the two roles once per Postgres instance and grants the membership
 * that ties them together. The per-database half — USAGE on the schema, DML on every
 * table, sequence usage, and `ALTER DEFAULT PRIVILEGES` so future tables inherit SELECT +
 * INSERT only (0169 / DEF-489 narrowed this; UPDATE/DELETE are granted per table from then
 * on) — already exists in `packages/db/migrations/0011_row_level_security.sql:66-72` and
 * MUST NOT be duplicated here: `shareat_app` membership carries into every lane database
 * automatically once that lane's own migrations have applied migration 0011.
 *
 * ⚠️ `shareat_test_runner` owns no table. Tables stay owned by whoever runs migrations —
 * migration 0011's comments record why: a table's owner bypasses RLS by default, so a
 * table owned by the restricted role would defeat the entire point of connecting as it.
 * This script never creates a table, so that invariant holds by construction; it is
 * recorded here so nobody "helpfully" changes who runs migrations without reading this.
 *
 * The password is a fixed, non-secret, test-only constant — matching `ci.yml`'s existing
 * plaintext `POSTGRES_PASSWORD: postgres` and `tests/integration/setup.ts`'s
 * `RESTRICTED_TEST_PASSWORD`. It needs no rotation story. Keep both constants in step by
 * hand; this script does not import from an app package on purpose (it must also work
 * before the workspace is built).
 *
 * Idempotent and safe to run repeatedly: each half checks `pg_roles` first, and the
 * trailing `GRANT ... TO ...` is a no-op when the membership already exists. A correct run
 * against a cluster that already has both roles reports "already present" and changes
 * nothing.
 *
 * Never prints a URL — the password may legitimately contain '@' and TEST_DATABASE_URL's
 * own password is real enough to be worth not echoing.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const APP_ROLE = 'shareat_app';
const RESTRICTED_ROLE = 'shareat_test_runner';
/** Test-only constant, deliberately not a secret. Keep in step with tests/integration/setup.ts. */
const RESTRICTED_PASSWORD = 'shareat_test_runner';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error(
    'TEST_DATABASE_URL is not set. This script provisions a role on a real, disposable ' +
      'Postgres cluster. See .env.example.',
  );
  process.exit(1);
}

// Same guard as tests/integration/setup.ts — this script creates a LOGIN role on the whole
// cluster and must not be pointable at production by accident.
if (!/shareat_test|_test(\?|$)/.test(url)) {
  console.error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name ` +
      'must contain "_test". These are the same tests that TRUNCATE tables.',
  );
  process.exit(1);
}

// new URL(), never string surgery — the password may legitimately contain '@'. Connect to
// the server's `postgres` maintenance database: roles are cluster-wide, not per-database.
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';

// onnotice: silenced. The trailing GRANT below is expected to be a harmless no-op on a
// repeat run (postgres.js otherwise prints Postgres's "already a member" NOTICE verbatim,
// which would fight with the "already present" / "membership ensured" lines above).
const sql = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });

try {
  const [{ exists: appExists }] = await sql`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
  `;
  if (!appExists) {
    // NOLOGIN — matches migration 0011's own creation of this role exactly, for the
    // clusters where 0011 has not run yet (a fresh cluster, before any lane is migrated).
    await sql.unsafe(`CREATE ROLE "${APP_ROLE}" NOLOGIN`);
    console.log(`${APP_ROLE}: created`);
  } else {
    console.log(`${APP_ROLE}: already present`);
  }

  const [{ exists: runnerExists }] = await sql`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${RESTRICTED_ROLE}) AS exists
  `;
  if (!runnerExists) {
    await sql.unsafe(
      `CREATE ROLE "${RESTRICTED_ROLE}" LOGIN PASSWORD '${RESTRICTED_PASSWORD}' ` +
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
    );
    console.log(`${RESTRICTED_ROLE}: created`);
  } else {
    console.log(`${RESTRICTED_ROLE}: already present`);
  }

  // Idempotent: granting a membership that already exists is a no-op, not an error.
  await sql.unsafe(`GRANT "${APP_ROLE}" TO "${RESTRICTED_ROLE}"`);
  console.log(`${APP_ROLE} -> ${RESTRICTED_ROLE}: membership ensured`);
} finally {
  await sql.end();
}
