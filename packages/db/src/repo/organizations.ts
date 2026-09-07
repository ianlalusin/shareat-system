/**
 * The only place SQL is written for `organizations`. T-228 / DEF-195.
 *
 * ⛔ **Until this file existed, nothing in the codebase had ever created an organization.** No
 * `insert(organizations)` in `packages/domain`, `packages/db` or `apps/erp`; no migration inserts
 * one; and `scripts/dev-seed.ts:68` *selects* the first active org and throws if there is none.
 * Whatever put the dev rows there was a person typing SQL — the same shape as T-222's stores, one
 * tier up. Production held zero organizations on 2026-09-06 and
 * `shareat-finding-observation.service` exited 1 nightly because of it.
 *
 * ⚠️ There is deliberately **no `deleteOrganization`**. An org is the root of every scoped table;
 * `stores.org_id` is `on delete restrict` and every other scoped row hangs off it. Deactivation is
 * the only lifecycle this project offers anywhere with history behind it (T-160 for rooms, T-222
 * for stores), and an org has more history behind it than either.
 */
import { eq, sql as dsql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { Tx } from '../client';
import { organizations } from '../../schema/organizations';
import { personRoles } from '../../schema/access';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { seedExpenseCategories } from '../../seed/expense-categories';

export interface OrganizationRow {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
}

const COLUMNS = {
  id: organizations.id,
  name: organizations.name,
  code: organizations.code,
  isActive: organizations.isActive,
} as const;

/**
 * ⚠️ `code` is `unique` **across all organizations**, not per anything — there is nothing above an
 * org to scope it by. That is what makes a double-run of the bootstrap a refusal rather than a
 * duplicate, so the constraint is load-bearing, not decoration.
 */
export async function getOrgByCode(tx: Tx, code: string): Promise<OrganizationRow | undefined> {
  const [row] = await tx.select(COLUMNS).from(organizations).where(eq(organizations.code, code)).limit(1);
  return row;
}

export async function insertOrganization(
  tx: Tx,
  input: { code: string; name: string },
): Promise<OrganizationRow> {
  const [row] = await tx
    .insert(organizations)
    .values({ code: input.code, name: input.name })
    .returning(COLUMNS);
  if (!row) throw new Error('insertOrganization: insert returned no row');
  return row;
}

/**
 * Whether this org holds **any** `person_roles` row at all — every role, revoked included.
 *
 * ⛔ Deliberately broader than `accessRepo.hasActiveAdmin`, which only sees *active* `admin` rows.
 * That narrower question is the wrong one for `createFirstAdmin`: after the sole admin is demoted
 * or revoked, `hasActiveAdmin` says "no admin here" and the bootstrap would happily mint a second
 * first-admin with a NULL grantor — the back door the refusal exists to close. An org that has
 * ever had a role has an authority chain, and a new link in it belongs to `/admin/users`.
 */
export async function orgHasAnyRole(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: personRoles.id })
    .from(personRoles)
    .where(eq(personRoles.orgId, orgId))
    .limit(1);
  return row !== undefined;
}

/**
 * The postgres.js client bound to `tx`'s transaction.
 *
 * ⛔ **This is the one place in the codebase that reaches through the Drizzle handle, and it is
 * here rather than in a service because it is driver knowledge, not business logic.** The two
 * reference-data seeds are written against postgres.js's tagged-template API and predate any
 * caller that needed them inside a transaction; `Tx` is a Drizzle transaction and the two types
 * are unrelated. Rewriting the seeds against Drizzle would be a second seeding path over the same
 * data — a second source of truth for a chart that grows (T-123 added 2160 and 4500).
 *
 * ⚠️ It is the same handle Drizzle itself uses: `PostgresJsTransaction.transaction()` calls
 * `this.session.client.savepoint(...)` (drizzle-orm/postgres-js/session.js), so this is Drizzle's
 * own access path, not a hole in it. Pinned by `drizzle-orm@0.38.4`.
 *
 * ⭐ **Two ways an upgrade could break this, and both are caught.** If the field moves, the guard
 * below throws by name. If it survives but starts handing back the *pool* client instead of the
 * transaction's, nothing throws and the chart would quietly be seeded outside the transaction that
 * owns the org row — the dangerous case, and the one **T-228 case 6** catches: it forces a rollback
 * and asserts zero `accounts` rows remain, which only holds if the seeds really ran inside `tx`.
 */
function txClient(tx: Tx): postgres.Sql {
  const client = (tx as unknown as { session?: { client?: unknown } }).session?.client;
  if (typeof client !== 'function') {
    throw new Error(
      'organizationsRepo: could not reach the postgres.js client behind this transaction. ' +
        'drizzle-orm changed its internals; see this function and T-228 before working around it.',
    );
  }
  return client as postgres.Sql;
}

export interface ReferenceDataSeeded {
  accountsSeeded: number;
  categoriesSeeded: number;
}

/**
 * Applies the chart of accounts and the expense categories to one org, **inside `tx`**.
 *
 * ⛔ **Both are per-org and both are mandatory.** An org without its chart cannot post anything,
 * and the symptom is `postEntry` refusing with *"unknown account code"* — the engine working
 * correctly, and baffling if you assume the chart is global. It is not: every seeded row carries
 * `org_id`. The migration that seeded the chart could only ever reach orgs that existed when it
 * ran, which `seedChartOfAccounts`' own header anticipated: *"A future 'create organization' flow
 * should call this directly for a brand-new org."* This is that caller.
 *
 * Both seeds are idempotent by (org_id, code) / (org_id, category), so re-running adds only what is
 * missing — which is how an org seeded before an account existed acquires it later.
 */
export async function seedReferenceData(tx: Tx, orgId: string): Promise<ReferenceDataSeeded> {
  const sql = txClient(tx);
  const chart = await seedChartOfAccounts(sql, orgId);
  const categories = await seedExpenseCategories(sql, orgId);
  return {
    accountsSeeded: chart.headersInserted + chart.leavesInserted,
    categoriesSeeded: categories.categoriesInserted,
  };
}

// -----------------------------------------------------------------------------------------
// T-229 slice 4 — the organisation's registered identity. **DEF-208.**
// ⛔ No business rule here: who may write it, and what shape a TIN is, are
// `packages/domain/src/organizations/index.ts`'s call. The DATABASE's CHECKs are the authority
// on format (RULES §6 item 3, bible §15.11).
// -----------------------------------------------------------------------------------------

export interface OrganizationIdentityRow {
  name: string;
  code: string;
  legalName: string | null;
  tin: string | null;
  taxType: 'vat' | 'non_vat' | null;
}

export async function identityOf(tx: Tx, orgId: string): Promise<OrganizationIdentityRow | undefined> {
  const [row] = await tx
    .select({
      name: organizations.name,
      code: organizations.code,
      legalName: organizations.legalName,
      tin: organizations.tin,
      taxType: organizations.taxType,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row as OrganizationIdentityRow | undefined;
}

/** ⭐ All three fields every time — the screen owns them as a set, so an absent one is a CLEAR,
 *  never "leave alone". That is what makes a wrong TIN removable. */
export async function setIdentity(
  tx: Tx,
  orgId: string,
  input: { legalName: string | null; tin: string | null; taxType: 'vat' | 'non_vat' | null },
): Promise<void> {
  await tx
    .update(organizations)
    .set({
      legalName: input.legalName,
      tin: input.tin,
      taxType: input.taxType,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId));
}

// -----------------------------------------------------------------------------------------
// T-232 slice 2 — first-run setup. Both callers are `bootstrapOrganization`; nothing else.
// -----------------------------------------------------------------------------------------

/**
 * ⛔ **Serialises first run.** Two concurrent `/setup` submissions with DIFFERENT org codes would
 * both pass `anyOrganizationExists` and both insert — `organizations.code` is unique, which stops a
 * duplicate CODE, not a second organisation.
 *
 * The usual answer here is to lock the parent row, and there is none: on an empty database every
 * table is the empty set, and `employment.ts:131-132` already wrote that lesson down — *"a store's
 * first hire has no employment rows to lock, and `for update` over an empty set locks nothing at
 * all."* So: one advisory lock on a fixed key, taken before the check.
 *
 * ⚠️ **Transaction-scoped** (`_xact_`), so it is released at COMMIT or ROLLBACK and cannot outlive
 * the request on a pooled connection — the same property `SET LOCAL` gives the RLS principal, and
 * for the same reason.
 */
export async function lockFirstRun(tx: Tx): Promise<void> {
  // A fixed, arbitrary key. It names this one critical section and nothing else.
  await tx.execute(dsql`select pg_advisory_xact_lock(232002)`);
}

/**
 * Whether this database holds **any** organization at all — the precondition first-run setup is
 * gated on.
 *
 * ⛔ **A cross-org read with no principal, which this repo has ruled on once already.**
 * `apps/erp/src/app/expenses/lib.ts:62-66` (T-231 slice 3 / DEF-214) deleted `listOrgs()` for being
 * exactly that, and set the condition for one coming back: *"an explicit system-principal read WITH
 * a caller."* This is that — explicit, two named callers, and it returns a **boolean**, never org
 * rows, so it cannot become a cross-org listing by a later "small" change.
 *
 * ⚠️ `organizations` carries FORCE ROW LEVEL SECURITY (migration 0011:114-118), so under a role
 * that does not bypass RLS this returns `false` on a populated database — and the INSERT that
 * follows is then refused by the same policy's WITH CHECK. The failure direction is a refusal,
 * never a second organisation.
 */
export async function anyOrganizationExists(tx: Tx): Promise<boolean> {
  const [row] = await tx.select({ id: organizations.id }).from(organizations).limit(1);
  return row !== undefined;
}
