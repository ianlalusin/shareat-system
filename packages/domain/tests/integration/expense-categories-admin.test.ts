import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-229 slice 1 — administering the expense-category → account mapping.
 * `docs/tasks/229-reference-data-administration.md`, discovery
 * `docs/discovery/28-reference-data-administration.md` §1.
 *
 * ⛔ **This file exists because of DEF-193**, and test 7 is the whole reason. `expense_categories`
 * had exactly one writer that has ever existed — `packages/db/seed/expense-categories.ts` — while
 * T-213's `expenseCategoryUnpostable` detector reports a draft expense stuck behind a category
 * with no mapped account and says *"cannot post until one is"*. **There was no screen, and no
 * function, on which anyone could map one.** A detector that reports a condition nobody can remedy
 * is worse than no detector: it teaches people that findings are noise.
 *
 * ⭐ Test 7 is therefore the acceptance test for the task, and the other seven are unit-ish tests
 * of the function that makes it possible. Written and watched to FAIL before
 * `packages/domain/src/expenses/categories.ts` existed.
 *
 * ⚠️ `account_code` is nullable **on purpose** (`packages/db/schema/expenses.ts:66-68` — *"a
 * category with no account mapped blocks posting rather than defaulting to 6900"*), so test 3
 * matters as much as test 1: a screen that could only ever SET a mapping would make a wrong one
 * unremovable, and a wrong account posts silently where an absent one refuses loudly.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { APP_ROLE, closeDb, expensesRepo, findingsRepo, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
// ⚠️ Relative, not through `@shareat/domain` — the barrel line
// (`export * from './categories'` in packages/domain/src/expenses/index.ts) is added by the
// integrating session, not by this lane. T-229 Scope.
import { setCategoryAccount } from '../../src/expenses/categories';

/**
 * ⭐ **Why test 8 calls the repo directly and takes no `Actor`.** The read is deliberately
 * ungated, following the asymmetry this codebase states outright in
 * `apps/erp/src/app/admin/users/lib.ts:4-7`: *"plain reads go straight to the repo layer with no
 * capability gate — the gate belongs to the WRITE, not to looking at a roster — and every mutation
 * runs through `packages/auth`'s own `authorize()`."* `/staff` and `/attendance/terminals` do the
 * same. Gating the read as well would make a manager who opens the screen hit a thrown
 * `AuthorizationError` instead of a form that refuses them on submit, and hiding a screen is
 * presentation (DEF-051) — the control is the write, which test 2 proves.
 */

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** `n` days before today in Manila, as `YYYY-MM-DD`. The detector's own threshold is 3 days. */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

interface Fixture {
  orgId: string;
  storeId: string;
  admin: Actor;
  manager: Actor;
  staff: Actor;
  staffId: string;
}

/**
 * One org with the real 93-account chart, one store, and one person per role. The chart is seeded
 * rather than hand-inserted because tests 4 and 5 assert on real account eligibility — `6200` is an
 * active leaf, `6000` is a header (`is_postable = false`) and `2250` is `status = 'reserved'`.
 */
async function fixture(hint: string): Promise<Fixture> {
  const code = uid(`ecat-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${daysAgo(60)}, ${daysAgo(-60)}, 'open')`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;

  const person = async (name: string, role: string): Promise<string> => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };

  const adminId = await person('Admin', 'admin');
  const managerId = await person('Manager', 'manager');
  const staffId = await person('Cashier', 'staff');

  return {
    orgId,
    storeId,
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
    staffId,
  };
}

/** A category, mapped or not. Returns its id. */
async function category(f: Fixture, accountCode: string | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${f.orgId}, 'OPEX', ${uid('cat')}, ${accountCode})
    returning id`;
  return row!.id;
}

/**
 * A DRAFT expense against a verified supplier invoice, dated `businessDate` — everything
 * `expenseCategoryUnpostable` needs. Written with raw SQL rather than through `createExpense`
 * deliberately: this file tests the category admin path, not AP's segregation-of-duties and
 * photo-evidence rules. Same choice, and the same reason, as `oil-wave-2.test.ts`'s own fixture.
 */
async function draftExpense(f: Fixture, categoryId: string, businessDate: string): Promise<string> {
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.staffId}) returning id`;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices
      (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
       attested_supplier, attested_invoice, attested_items, attested_price, created_by)
    values (${f.orgId}, ${f.storeId}, ${supplier!.id}, ${businessDate}, '500.00', 'verified',
      ${f.admin.personId}, now(), true, true, true, true, ${f.staffId})
    returning id`;
  const [expense] = await sql<{ id: string }[]>`
    insert into expenses
      (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id,
       particulars, status, created_by)
    values (${f.orgId}, ${f.storeId}, ${businessDate}, '500.00', ${categoryId}, ${supplier!.id},
      ${invoice!.id}, 'fixture expense', 'draft', ${f.staffId})
    returning id`;
  return expense!.id;
}

async function accountCodeOf(categoryId: string): Promise<string | null> {
  const [row] = await sql<{ account_code: string | null }[]>`
    select account_code from expense_categories where id = ${categoryId}`;
  return row?.account_code ?? null;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-229 §1 — mapping an expense category to an account', () => {
  it('1. an admin maps an account onto an unmapped category', async () => {
    const f = await fixture('map');
    const categoryId = await category(f, null);

    await asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.admin, { categoryId, accountCode: '6200' }));

    expect(await accountCodeOf(categoryId)).toBe('6200');
  });

  it('2. ⛔ a manager and a staff member are each refused — the ✗ that makes it a control', async () => {
    const f = await fixture('deny');
    const categoryId = await category(f, null);

    // CAPABILITY-MATRIX rule 1: "a capability whose ✗ is never exercised is not a control."
    // `manage_chart_of_accounts` is admin+ and org-scoped — the matrix's own "technical residue".
    await expect(
      asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.manager, { categoryId, accountCode: '6200' })),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.staff, { categoryId, accountCode: '6200' })),
    ).rejects.toThrow(AuthorizationError);

    expect(await accountCodeOf(categoryId)).toBeNull();
  });

  it('3. ⭐ clearing a mapping is allowed — account_code is nullable ON PURPOSE', async () => {
    const f = await fixture('clear');
    const categoryId = await category(f, '6200');

    await asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.admin, { categoryId, accountCode: null }));

    expect(await accountCodeOf(categoryId)).toBeNull();
  });

  it('4. an account code that does not exist in this org is refused', async () => {
    const f = await fixture('unknown');
    const categoryId = await category(f, null);

    await expect(
      asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.admin, { categoryId, accountCode: '9999' })),
    ).rejects.toThrow(/9999/);

    expect(await accountCodeOf(categoryId)).toBeNull();
  });

  it('5. ⛔ a header account and a reserved account are both refused', async () => {
    const f = await fixture('ineligible');
    const categoryId = await category(f, null);

    // 6000 "Operating expenses" is a header — is_postable = false.
    await expect(
      asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.admin, { categoryId, accountCode: '6000' })),
    ).rejects.toThrow(/6000/);
    // 2250 "VAT payable" is seeded status = 'reserved' — bible §16.9: not postable, not in
    // pickers, not in reports. Mapping to one produces a category that blocks at POSTING time,
    // days later, for a reason the person who mapped it cannot see.
    await expect(
      asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.admin, { categoryId, accountCode: '2250' })),
    ).rejects.toThrow(/2250/);

    expect(await accountCodeOf(categoryId)).toBeNull();
  });

  it('6. a category belonging to another org is refused, not silently ignored', async () => {
    const mine = await fixture('org-a');
    const theirs = await fixture('org-b');
    const foreignCategoryId = await category(theirs, null);

    await expect(
      asOrg(mine.orgId, (tx) =>
        setCategoryAccount(tx, mine.admin, { categoryId: foreignCategoryId, accountCode: '6200' }),
      ),
    ).rejects.toThrow(/does not exist/);

    expect(await accountCodeOf(foreignCategoryId)).toBeNull();
  });

  it('7. ⭐ DEF-193 — the finding the detector raises is cleared by the mapping', async () => {
    const f = await fixture('def193');
    const categoryId = await category(f, null);
    await draftExpense(f, categoryId, daysAgo(4));

    const before = await asOrg(f.orgId, (tx) => findingsRepo.expenseCategoryUnpostable(tx, f.orgId));
    expect(before).toHaveLength(1);
    expect(before[0]!.kind).toBe('expenseCategoryUnpostable');
    expect(before[0]!.detail).toMatch(/has no account mapped/);

    await asOrg(f.orgId, (tx) => setCategoryAccount(tx, f.admin, { categoryId, accountCode: '6200' }));

    const after = await asOrg(f.orgId, (tx) => findingsRepo.expenseCategoryUnpostable(tx, f.orgId));
    expect(after).toEqual([]);
  });

  it('8. the list reports how many drafts each unmapped category is blocking', async () => {
    const f = await fixture('blocked');
    const stuckId = await category(f, null);
    const fineId = await category(f, '6200');
    await draftExpense(f, stuckId, daysAgo(4));
    await draftExpense(f, stuckId, daysAgo(9));
    await draftExpense(f, fineId, daysAgo(4));

    const rows = await asOrg(f.orgId, (tx) => expensesRepo.listCategoriesForAdmin(tx, f.orgId));

    // ⭐ Unmapped rows sort FIRST — they are the only actionable state on the screen, and the
    // detector is already telling somebody about them.
    expect(rows[0]?.id).toBe(stuckId);

    const stuck = rows.find((r) => r.id === stuckId);
    const fine = rows.find((r) => r.id === fineId);
    expect(stuck?.blockedDraftCount).toBe(2);
    expect(stuck?.accountCode).toBeNull();
    expect(stuck?.accountName).toBeNull();
    // ⛔ A mapped category blocks nothing, whatever its drafts — the count is about the MAPPING,
    // not about drafts in general. Getting this wrong would put a number beside every row and
    // make the actionable ones invisible, which is the state this screen exists to end.
    expect(fine?.blockedDraftCount).toBe(0);
    expect(fine?.accountCode).toBe('6200');
    expect(fine?.accountName).toBe('Rent');
  });
});
