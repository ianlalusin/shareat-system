/**
 * Shared, server-only data helpers for the expenses screens (docs/tasks/122-expenses.md).
 *
 * ## ✅ The auth stand-in is GONE (T-138, 2026-08-25)
 *
 * This file used to open with a long warning: there was no session bridge, so the acting person
 * travelled as an unsigned form field, *"a KNOWING, TEMPORARY departure from bible §7.1."*
 *
 * **It is no longer temporary and no longer a departure.** `apps/erp/src/lib/session.ts` resolves
 * the actor from an httpOnly session cookie, and `tests/unit/no-client-supplied-actor.test.ts`
 * fails the build if any server boundary reads a person id out of client input again.
 *
 * ⭐ **Note what did NOT change to make that true**: not one line of `packages/domain`. The domain
 * always took `(tx, actor, …)` and never asked where the actor came from — which is exactly why
 * swapping a dropdown for a real session was a boundary change and not a rewrite.
 */
import { asc, and, eq, isNull } from 'drizzle-orm';
import { sql as dsql } from 'drizzle-orm';
import { getDb, schema, transaction, expensesRepo, journalRepo, APP_ROLE, type Tx } from '@shareat/db';

export interface OrgOption {
  id: string;
  name: string;
  code: string;
}

export interface StoreOption {
  id: string;
  name: string;
  code: string;
}

export interface PersonOption {
  id: string;
  displayName: string;
  role: 'super_admin' | 'admin' | 'manager' | 'staff' | null;
}

export interface CategoryOption {
  id: string;
  group: 'OPEX' | 'COGS' | 'CAPEX' | 'PERSONAL';
  category: string;
  accountCode: string | null;
}

export async function listOrgs(): Promise<OrgOption[]> {
  const db = getDb();
  return db
    .select({ id: schema.organizations.id, name: schema.organizations.name, code: schema.organizations.code })
    .from(schema.organizations)
    .where(eq(schema.organizations.isActive, true))
    .orderBy(asc(schema.organizations.name));
}

export async function listStores(orgId: string): Promise<StoreOption[]> {
  const db = getDb();
  return db
    .select({ id: schema.stores.id, name: schema.stores.name, code: schema.stores.code })
    .from(schema.stores)
    .where(eq(schema.stores.orgId, orgId))
    .orderBy(asc(schema.stores.name));
}

/** Everyone in the org who currently holds an active role — the pool "acting as" picks
 *  from. See this file's top comment: this is a stand-in for a real signed-in session. */
export async function listActingPersons(orgId: string): Promise<PersonOption[]> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.persons.id, displayName: schema.persons.displayName, role: schema.personRoles.role })
    .from(schema.persons)
    .innerJoin(
      schema.personRoles,
      and(eq(schema.personRoles.personId, schema.persons.id), isNull(schema.personRoles.revokedAt)),
    )
    .where(and(eq(schema.persons.orgId, orgId), eq(schema.persons.isActive, true)))
    .orderBy(asc(schema.persons.displayName));
  return rows;
}

export async function listCategoriesGrouped(orgId: string): Promise<CategoryOption[]> {
  return transaction((tx) => expensesRepo.listCategories(tx, orgId));
}

export async function categoryLabel(orgId: string, categoryId: string): Promise<string> {
  const cats = await listCategoriesGrouped(orgId);
  const c = cats.find((x) => x.id === categoryId);
  return c ? `${c.group} — ${c.category}` : categoryId;
}

/**
 * Runs `fn` inside one Drizzle transaction with the RLS 'staff' principal applied for
 * `orgId` — mirrors `packages/auth/tests/integration/authorize.test.ts`'s `asPerson`
 * exactly, so every mutation this app makes runs under the SAME real RLS every other
 * caller does (bible row 112), never the unrestricted owner connection. This is
 * apps/erp's first production use of the principal — every screen before this one only
 * ever READ, off the owner connection, and never needed it.
 */
export async function withOrgPrincipal<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export { journalRepo };
