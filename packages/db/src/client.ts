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
  __shareat_system_sql?: Sql;
  __shareat_system_db?: ReturnType<typeof drizzle<typeof schema>>;
};

function createClient(): Sql {
  const { DATABASE_URL, DATABASE_POOL_MAX } = env();

  return postgres(DATABASE_URL, {
    max: DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    // TLS comes from the URL's own `sslmode` — DEF-344. Do NOT add an `ssl` key here: it
    // OVERRIDES whatever the connection string says (postgres.js precedence: explicit option >
    // URL sslmode > PGSSL env var > default false). packages/db/migrate.ts is the reference.
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

function createSystemClient(): Sql {
  const { SYSTEM_DATABASE_URL, DATABASE_URL, DATABASE_POOL_MAX } = env();
  return postgres(SYSTEM_DATABASE_URL ?? DATABASE_URL, {
    max: DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    // TLS comes from the URL's own `sslmode` — DEF-344. See createClient() above.
    onnotice: () => {},
  });
}

/** The system connection's raw postgres.js client. Prefer `systemTransaction`. */
export function getSystemSql(): Sql {
  if (!globalForDb.__shareat_system_sql) {
    globalForDb.__shareat_system_sql = createSystemClient();
  }
  return globalForDb.__shareat_system_sql;
}

export function getSystemDb() {
  if (!globalForDb.__shareat_system_db) {
    globalForDb.__shareat_system_db = drizzle(getSystemSql(), { schema });
  }
  return globalForDb.__shareat_system_db;
}

/**
 * Runs `fn` on the SYSTEM connection — bible §13 row 185. Reserved for the enumerable set of
 * operations that must see or act across every organisation, because no single org's principal
 * can express them:
 *
 *   - `runJobForOrg` / `closeFailedRun` (scheduler bookkeeping — a run row exists before any
 *     per-org principal is meaningful to it)
 *   - `listOrgsToRun` (the scheduler must enumerate every org before it can scope to one)
 *   - `bootstrapOrganization`'s two callers: `scripts/bootstrap-org.ts` and
 *     `apps/erp/src/app/setup/actions.ts` (row 185's named exception — there is no principal
 *     before the first organisation exists)
 *   - the till-event **org resolution** in `runInboxRelayJobs` (row 194 subsystem 1) — the read
 *     that DISCOVERS which org a store belongs to cannot be scoped to that org; the org is its
 *     output, not its input
 *   - the **bootstrap existence question** `anyOrganizationExists`, in `setup/lib.ts` and
 *     `sign-in/lib.ts` (**Ian's ruling, 2026-09-12**, T-267) — *"has this system been set up at
 *     all?"* is asked before any org exists, and it now uses the same door bootstrap's WRITE
 *     already used. ⚠️ Three sites asked this bare; `bootstrap-org.ts:158` is the third and
 *     contradicted itself, guarding with an unprincipalled read before a privileged write
 *   - the **ETL pipeline** — `packages/etl/src/run.ts` (6 sites) and `repo/etl.ts`'s
 *     `startRun`/`finishRun` (row 194 subsystem 3, DEF-289). ⚠️ Different in kind from the
 *     others: `etl_runs`, `etl_source_documents`, `etl_quarantine`, `etl_reconciliation` and
 *     `audit_log` carry FORCE RLS with **zero policies** (migration `0011:142-160`), so no
 *     principal can ever satisfy them. Elsewhere on this list a principal is merely *wrong*;
 *     here it is **unsatisfiable**. ⛔ Never add a policy to those tables to make the app role
 *     work — they hold captured production PII and a policy that admits the app role admits
 *     every tenant
 *
 * ⛔ **Not a general escape hatch.** The list grows only by a NAMED RULING recorded in the bible,
 * never by analogy — row 185 closed it at three, row 194 admitted three subsystems after a day of
 * arming the lock produced them, and 2026-09-12 admitted the bootstrap question. If new code thinks
 * it needs this, that is a design question for whoever is adding it: raise it, don't reach for this
 * function because a neighbour did.
 *
 * ⚠️ `tests/unit/system-transaction-callers.test.ts` fails the build if any file outside the
 * closed caller list calls it — and as of **DEF-295** that sentence is finally true. Until
 * 2026-09-12 it scanned two of the repo's nine source roots, so `packages/etl/src`, `scripts/` and
 * five others could call this freely with nothing going red. A closed list nothing can see is not
 * closed.
 *
 * ⚠️ With `SYSTEM_DATABASE_URL` unset, this is byte-for-byte `transaction()` — same connection,
 * same credentials. It diverges only where something explicitly sets that variable (the
 * integration test harness, per `docs/tasks/251-def-218-integration-harness-role.md` — not
 * production, not local dev, until a separate, later decision says otherwise).
 */
export async function systemTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getSystemDb().transaction(fn);
}

/**
 * ⭐ **The authentication door — bible §13 row 194, DEF-288.** A transaction for the handful of
 * reads and writes that must happen BEFORE anyone knows which organisation is acting.
 *
 * ## Why this exists as its own name rather than a sixth `systemTransaction()` caller
 *
 * ⛔ **Authentication is a CIRCULARITY, not an exception granted for convenience.** Signing in is
 * the act of discovering which organisation you belong to. RLS wants that organisation declared —
 * `app_current_org()` — before it will show you the row that says which organisation you belong
 * to. `person_credentials` and `sessions` both carry FORCE RLS with `_via_person` policies
 * (migration `0018:69-80`) that resolve org through `persons`. With no principal that function
 * returns NULL, `org_id = NULL` is NULL, and nothing matches. **`withOrgPrincipal` is not merely
 * wrong on these paths — it is unexpressible.**
 *
 * ⚠️ **What that would have cost, measured rather than imagined:** with `DATABASE_URL` tightened
 * and these paths unfixed, PIN sign-in returns *"that PIN is not valid for this store"*, Firebase
 * sign-in returns *"not linked to a person"*, EVERY authenticated request returns *"Not signed
 * in"*, and sign-out silently does nothing. Not degraded — the whole application unusable, at
 * once. It fails CLOSED, so it is an availability wall and never a leak.
 *
 * ## ⛔ The closed list, and it is FOUR lookups — not "the auth package"
 *
 *   - `findActiveCredentialByLookupHash`  (PIN sign-in)
 *   - `findActiveCredentialByExternalId`  (Firebase sign-in)
 *   - `findLiveByTokenHash`               (every authenticated request, and sign-out's read)
 *   - `endSession`                        (sign-out's write)
 *
 * ⭐ **The moment a session resolves, the actor's organisation is known and everything downstream
 * goes back through `withOrgPrincipal`.** This door is for the gap before that fact exists, and
 * `tests/unit/auth-transaction-callers.test.ts` fails the build if any file outside
 * `packages/auth/src/sessions.ts` calls it.
 *
 * ⚠️ It is the same privileged connection `systemTransaction()` uses — deliberately a different
 * NAME rather than a different socket. Row 194's point is that *"crosses organisations because it
 * is a scheduler"* and *"…because it is establishing who you are"* are different permissions that
 * must stay separately greppable; collapsing them into one list is how the second one stops being
 * visible.
 */
export async function authTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getSystemDb().transaction(fn);
}

/** Scripts and tests only, mirrors closeDb(). */
export async function closeSystemDb(): Promise<void> {
  if (globalForDb.__shareat_system_sql) {
    await globalForDb.__shareat_system_sql.end({ timeout: 5 });
    globalForDb.__shareat_system_sql = undefined;
    globalForDb.__shareat_system_db = undefined;
  }
}
