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
import {
  moneyAccountsRepo, schema, expensesRepo, journalRepo,
  withOrgPrincipal as dbWithOrgPrincipal, type Tx,
} from '@shareat/db';
import { recordIfUnmappedConstraint } from '../../lib/constraint-messages';

/**
 * How many payment rows the expense form offers.
 *
 * ⚠️ **A UI limit only — the domain accepts any number of splits** (`createExpense` rejects only
 * an EMPTY payments array). It was 4, which is below what the business actually does: v1's split
 * payments are unbounded (`useFieldArray`, no maximum), and `expense.split.cash-online` is the
 * most common shape in v1's whole dataset. Ian, 2026-08-26: *"it is common in our set up to use
 * more than 1 account, for example an expense paid by partly cash cashier, cash online and office
 * online in one single transaction."*
 *
 * ⭐ Defined ONCE and imported by both the form and the action, because the two reading different
 * numbers is a silent truncation: the form would collect rows the parser never looks at.
 *
 * A proper add-a-row control is the real answer; this raises the ceiling above the real-world
 * shape in the meantime.
 */
export const PAYMENT_ROW_COUNT = 8;
export const PAYMENT_ROWS = Array.from({ length: PAYMENT_ROW_COUNT }, (_, i) => i + 1);

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
  /** ⭐ T-229 slice 2. A retired category stays on everything already recorded in it and stops
   *  being offered for anything new — so a screen that RENDERS history needs it and a screen that
   *  OFFERS a choice must not. */
  isActive: boolean;
}

/* ⛔ `listOrgs()` was deleted here — T-231 slice 3, DEF-214 (Ian's call as capability holder).
 * It selected EVERY active organisation off the owner connection, with no principal and no
 * caller: nothing in any `.tsx` rendered it, and `sales-days/lib.ts` only re-exported it onward.
 * A single-organisation product has no business exporting a cross-org read. If a platform-level
 * screen ever needs one it comes back as an explicit system-principal read WITH a caller. */

export async function listStores(orgId: string): Promise<StoreOption[]> {
  return withOrgPrincipal(orgId, (tx) =>
    tx
      .select({ id: schema.stores.id, name: schema.stores.name, code: schema.stores.code })
      .from(schema.stores)
      .where(eq(schema.stores.orgId, orgId))
      .orderBy(asc(schema.stores.name)),
  );
}

/** Everyone in the org who currently holds an active role — the pool "acting as" picks
 *  from. See this file's top comment: this is a stand-in for a real signed-in session. */
export async function listActingPersons(orgId: string): Promise<PersonOption[]> {
  const rows = await withOrgPrincipal(orgId, (tx) =>
    tx
      .select({ id: schema.persons.id, displayName: schema.persons.displayName, role: schema.personRoles.role })
    .from(schema.persons)
    .innerJoin(
      schema.personRoles,
      and(eq(schema.personRoles.personId, schema.persons.id), isNull(schema.personRoles.revokedAt)),
    )
      .where(and(eq(schema.persons.orgId, orgId), eq(schema.persons.isActive, true)))
      .orderBy(asc(schema.persons.displayName)),
  );
  return rows;
}

/**
 * Everyone active in the org, role or not.
 *
 * ⚠️ **Deliberately WIDER than `listActingPersons`.** That pool is who can act in the ERP; this is
 * who money can be handed to. A kitchen hand sent on a market run never signs in here, and a float
 * picker that could not name them would push the request onto someone who did — which is exactly
 * the mis-attribution the party on `1120` exists to prevent.
 */
export async function listActivePersons(orgId: string): Promise<Omit<PersonOption, 'role'>[]> {
  return withOrgPrincipal(orgId, (tx) =>
    tx
      .select({ id: schema.persons.id, displayName: schema.persons.displayName })
      .from(schema.persons)
      .where(and(eq(schema.persons.orgId, orgId), eq(schema.persons.isActive, true)))
      .orderBy(asc(schema.persons.displayName)),
  );
}

/**
 * **Every** category, retired ones included.
 *
 * ⚠️ **This is the HISTORY list, not a picker.** An expense recorded against a category that was
 * later retired must still render its own category's name, and `/expenses`' filter must still be
 * able to filter by it. Use `listActiveCategoriesGrouped` for anything offering a NEW choice —
 * the same picker-vs-validator split T-230 drew for sales channels.
 */
export async function listCategoriesGrouped(orgId: string): Promise<CategoryOption[]> {
  return withOrgPrincipal(orgId, (tx) => expensesRepo.listCategories(tx, orgId));
}

/** ⭐ T-229 slice 2 — the PICKER list. Retired categories are not offered for new records. */
export async function listActiveCategoriesGrouped(orgId: string): Promise<CategoryOption[]> {
  return withOrgPrincipal(orgId, (tx) => expensesRepo.listCategories(tx, orgId, { activeOnly: true }));
}

export async function categoryLabel(orgId: string, categoryId: string): Promise<string> {
  const cats = await listCategoriesGrouped(orgId);
  const c = cats.find((x) => x.id === categoryId);
  return c ? `${c.group} — ${c.category}` : categoryId;
}

/**
 * ⭐ **The RLS principal — one definition, in `@shareat/db`** (T-231 slice 2, DEF-211).
 *
 * Re-exported here rather than moved, because **89 files reach it through this module**. Keeping
 * the name and the path stable is what let the deduplication be one line instead of eighty-nine.
 *
 * ⚠️ The version this replaces was one of THREE copies of the same five statements (here, the
 * scheduler, and 68 test helpers), which existed because the canonical `withPrincipal` is typed
 * for postgres.js while this app speaks Drizzle. That mismatch is why DEF-209 was filed against
 * the wrong evidence: a grep for the canonical name found two files and concluded RLS had no
 * production callers. It had 310.
 *
 * T-261 / DEF-274, bible §13 row 189 — **this is now also the refusal-counter chokepoint.** Every
 * screen in the app reaches the database through this one line (directly, or via one of 44
 * re-export files that forward the binding), so wrapping it here reaches all of them instead of
 * ~163 hand-written call sites. See `docs/tasks/261-*.md` §B1/§B4.
 */
export async function withOrgPrincipal<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await dbWithOrgPrincipal(orgId, fn);
  } catch (err) {
    await recordIfUnmappedConstraint(err, { orgId, storeId: null, actorPersonId: null });
    throw err;
  }
}

/**
 * For the handful of callers that hand a domain function `null` and let it open its own
 * transaction: the refusal never passes through `withOrgPrincipal` above, so that wrapper cannot
 * see it. Wrap the CALL, not the transaction — `transaction()` (`packages/db/src/client.ts:82`)
 * takes no `orgId` and could not file a row if it caught one. See `docs/tasks/261-*.md` §B4.1.
 */
export async function recordingRefusalsFor<T>(orgId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    await recordIfUnmappedConstraint(err, { orgId, storeId: null, actorPersonId: null });
    throw err;
  }
}

export { journalRepo };

/** ⭐ EVERY active money account — cash locations included (DEF-058).
 *
 *  ⚠️ This deliberately reverses an earlier call. The picker first offered only e-wallets and
 *  bank accounts, on the reasoning that a cash payment's destination was already unambiguous from
 *  its sub-route. It was unambiguous only because a CHECKBOX was carrying the office/cashier
 *  distinction — and that tickbox is what let a cashier route cash away from their own till.
 *  With the checkbox gone, the cash drawer and the office safe are themselves choices, so they
 *  belong in the list. */
export async function listMoneyAccountsForPicker(
  orgId: string,
): Promise<{ id: string; name: string; storeId: string; custodian: string }[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await moneyAccountsRepo.listMoneyAccounts(tx, orgId, {});
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      storeId: r.storeId,
      custodian: r.custodian,
    }));
  });
}
