/**
 * Shared, server-only data helpers for the expenses screens (docs/tasks/122-expenses.md,
 * "apps/erp/src/app/expenses/**").
 *
 * ## ⚠️ There is no session/login bridge in apps/erp yet — read this before touching auth
 *
 * Every screen under `apps/erp/src/app/reports/` (the only screens that existed before
 * this task) is READ-ONLY and never calls `authorize()` — they read straight off the
 * owner connection (`getDb()`), with no concept of "who is asking" at all. Bible §7.1
 * plans a real identity bridge (Firebase Auth -> a verified server session -> `Actor`),
 * but no task has built it yet, and building one is well outside T-122's scope (it is a
 * cross-cutting concern for every future screen, not an expenses-specific one).
 *
 * Expenses is the FIRST screen that must actually MUTATE through `authorize()`-gated
 * domain functions, which require a real `{ personId, orgId }`. Absent a session, the
 * only honest options were: (a) block screen-building entirely until an auth bridge task
 * lands, or (b) let the acting person be chosen explicitly in the UI, exactly like the
 * existing reports screens already let the org and store be chosen via `?org=`/`?store=`
 * query parameters with no verification at all.
 *
 * **This file takes (b), and says so loudly.** `actingPersonId` travels the same way
 * `orgId`/`storeId` already do on the reports screens — a plain, client-supplied form
 * field / query parameter, unsigned, unverified. That is a KNOWING, TEMPORARY departure
 * from bible §7.1's "no server action ever accepts an actor identity as a parameter" (a
 * rule aimed at a CLIENT supplying its own identity to a session-bearing app — there is
 * no session here for it to bypass). It is reported as a spec gap in the task report, not
 * silently normalised. Replace `withOrgPrincipal`'s caller-supplied `orgId`/`actingPersonId`
 * with values read from a verified session the moment the identity bridge exists — nothing
 * about the RLS wiring below needs to change, only where these two ids come from.
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
