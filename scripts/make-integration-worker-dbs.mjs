#!/usr/bin/env node
/**
 * make-integration-worker-dbs.mjs — T-400: one database per integration-test worker.
 *
 *     node scripts/make-integration-worker-dbs.mjs 4
 *
 * Clones the migrated test database (TEST_DATABASE_URL) into `<base>_w1` .. `<base>_wN` with
 * `CREATE DATABASE ... TEMPLATE`, so each vitest worker can run against its own copy
 * (`tests/integration/setup.ts` picks the clone from VITEST_POOL_ID when INTEGRATION_WORKERS > 1).
 *
 * Run it AFTER `provision-test-role.mjs` and `db:migrate`: the clones carry the schema, data and
 * per-database grants of the base, and nothing may be connected to the base while it is the
 * template. Re-running drops and recreates every clone (WITH FORCE), so it is idempotent.
 *
 * Per-database settings are NOT copied by TEMPLATE, so `client_min_messages = warning` (silences
 * the `truncate cascades to table` NOTICE flood, T-400 section 5) is set on the base and every clone.
 *
 * Refuses a base name without `_test`, like setup.ts. Never prints a URL; names and counts only.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const n = Number(process.argv[2]);
if (!Number.isInteger(n) || n < 1 || n > 16) {
  console.error('Usage: node scripts/make-integration-worker-dbs.mjs <N>   (N is an integer, 1..16)');
  process.exit(1);
}

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error('TEST_DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

// new URL(), never string surgery — the password may legitimately contain '@'.
const base = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));

if (!base.includes('_test')) {
  console.error('Refusing to run: the base database name must contain "_test".');
  process.exit(1);
}

/** Every identifier is checked against ^[a-z0-9_]+$ before it is quoted into DDL. */
const q = (name) => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unsafe database identifier');
  return `"${name}"`;
};

// Connect to the server's `postgres` maintenance database as the URL's user.
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
adminUrl.search = '';

const sql = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });

try {
  const clones = [];
  for (let i = 1; i <= n; i++) {
    const name = `${base}_w${i}`;
    await sql.unsafe(`DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${q(name)} TEMPLATE ${q(base)}`);
    clones.push(name);
    console.log(`${name}: created`);
  }
  for (const name of [base, ...clones]) {
    await sql.unsafe(`ALTER DATABASE ${q(name)} SET client_min_messages = warning`);
  }
  console.log(
    `${clones.length} worker databases ready; client_min_messages=warning set on ${clones.length + 1}`,
  );
} catch (err) {
  console.error(`make-integration-worker-dbs failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
