/**
 * Database connection and the transaction helper.
 *
 * PROJECT_BIBLE.md §4.3: repositories are the ONLY place SQL is written, and services own
 * transactions. Nothing above the repository layer imports this client directly —
 * actions call services, services call repositories, repositories use `tx`.
 *
 * Connections are created LAZILY, on first use. Importing this module must never open a
 * socket or read a secret, because Next.js evaluates modules at build time: an
 * import-time connection turns `next build` into something that needs production
 * credentials, which is both wrong and a way to leak them into CI.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@shareat/core/env';
import * as schema from '@shareat/db/schema';

type Sql = ReturnType<typeof postgres>;

/**
 * Next.js dev hot-reload re-evaluates modules, which would open a new pool each time and
 * exhaust the managed cluster's connection limit. Cache on globalThis outside production.
 */
const globalForDb = globalThis as unknown as {
  __shareat_sql?: Sql;
  __shareat_db?: ReturnType<typeof drizzle<typeof schema>>;
};

function createClient(): Sql {
  const { DATABASE_URL, DATABASE_POOL_MAX, NODE_ENV } = env();

  return postgres(DATABASE_URL, {
    max: DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    // DO Managed Postgres requires TLS. Local dev has no cert to verify.
    ssl: NODE_ENV === 'production' ? 'require' : false,
    // Money is numeric(14,2) and MUST NOT round-trip through a JS float.
    // postgres.js returns numeric as a string by default — keep it that way.
    // See PROJECT_BIBLE.md §6 and §12 landmine 25 (v1 used floats everywhere).
    onnotice: () => {},
  });
}

/** The raw postgres.js client. Prefer `db`; use this only for health checks and DDL. */
export function getSql(): Sql {
  if (!globalForDb.__shareat_sql) {
    globalForDb.__shareat_sql = createClient();
  }
  return globalForDb.__shareat_sql;
}

export function getDb() {
  if (!globalForDb.__shareat_db) {
    globalForDb.__shareat_db = drizzle(getSql(), { schema });
  }
  return globalForDb.__shareat_db;
}

export type Database = ReturnType<typeof getDb>;

/**
 * A transaction handle. Every repository function takes one of these, so it is impossible
 * to write outside a transaction by accident.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A transaction or the base connection, for read paths that need no transaction. */
export type Executor = Database | Tx;

/**
 * Run work inside a single transaction.
 *
 * Every mutating service function goes through this, or documents why it cannot
 * (bible §4.3). Accounting invariants — balanced entries, minimum two lines,
 * closed-period rejection — are enforced by DEFERRED constraint triggers, so they fire at
 * COMMIT. A violation therefore surfaces here as a thrown error and rolls the whole unit
 * back: source document, journal entry, and audit row together.
 */
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

/** Close the pool. Scripts and tests only — never call this from request code. */
export async function closeDb(): Promise<void> {
  if (globalForDb.__shareat_sql) {
    await globalForDb.__shareat_sql.end({ timeout: 5 });
    globalForDb.__shareat_sql = undefined;
    globalForDb.__shareat_db = undefined;
  }
}
