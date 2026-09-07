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
import {
  APP_ROLE,
  budgetsRepo,
  closeDb,
  commissaryCatalogueRepo,
  commissaryRepo,
  expensesRepo,
  findingsRepo,
  transaction,
  type Tx,
} from '@shareat/db';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { AuthorizationError, type Actor } from '@shareat/auth';
// ⚠️ Relative, not through `@shareat/domain` — the barrel line
// (`export * from './categories'` in packages/domain/src/expenses/index.ts) is added by the
// integrating session, not by this lane. T-229 Scope.
import {
  createCategory,
  renameCategory,
  setCategoryAccount,
  setCategoryActive,
} from '../../src/expenses/categories';

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

// =====================================================================================
// T-229 slice 2 — create, rename, retire. **DEF-205.**
// =====================================================================================

describe('T-229 slice 2 — creating, renaming and retiring a category (DEF-205)', () => {
  it('9 ⭐ an admin creates a category; it is a USER row, active, and unmapped', async () => {
    const f = await fixture('create');
    const { categoryId } = await asOrg(f.orgId, (tx) =>
      createCategory(tx, f.admin, { group: 'OPEX', category: 'Scooter rental', accountCode: null }),
    );
    const [row] = await sql<Record<string, unknown>[]>`
      select * from expense_categories where id = ${categoryId}`;
    expect(row!.category).toBe('Scooter rental');
    expect(row!.is_system).toBe(false);
    expect(row!.is_active).toBe(true);
    expect(row!.account_code).toBeNull();
  });

  it('10 a manager is refused — Q1: the whole screen is admin-only, not half of it', async () => {
    const f = await fixture('gate2');
    await expect(
      asOrg(f.orgId, (tx) =>
        createCategory(tx, f.manager, { group: 'OPEX', category: 'Sneaky', accountCode: null }),
      ),
    ).rejects.toThrow(/may not 'manage_chart_of_accounts'/);
    // ⛔ Splitting create from map across two capabilities would let a manager create a category
    //    they cannot make postable — manufacturing DEF-193's condition deliberately.
    const existing = await category(f, null);
    await expect(
      asOrg(f.orgId, (tx) => renameCategory(tx, f.manager, { categoryId: existing, category: 'X' })),
    ).rejects.toThrow(/may not 'manage_chart_of_accounts'/);
  });

  it('11 ⭐⭐ DEF-205 — a case/whitespace duplicate is refused, and the DATABASE is what refuses it', async () => {
    const f = await fixture('dupe');
    await asOrg(f.orgId, (tx) =>
      createCategory(tx, f.admin, { group: 'OPEX', category: 'Rent', accountCode: null }),
    );

    // (a) through the domain — a sentence naming the row it would collide with.
    await expect(
      asOrg(f.orgId, (tx) =>
        createCategory(tx, f.admin, { group: 'OPEX', category: '  rent ', accountCode: null }),
      ),
    ).rejects.toThrow(/Rent/);

    // (b) ⭐ straight through the REPO, bypassing the domain pre-read, so the refusal is the
    //     INDEX's. Before 0134 the index was `(org_id, category)` — case- and whitespace-SENSITIVE
    //     — and BOTH of these inserted. That is the duplicate-Rent defect bible §4.4 exists to
    //     close, and it was still open on this table until this slice.
    await expect(
      asOrg(f.orgId, (tx) =>
        expensesRepo.insertCategory(tx, {
          orgId: f.orgId, group: 'OPEX', category: 'RENT  ', accountCode: null,
        }),
      ),
    ).rejects.toThrow(/expense_categories_org_id_category_unique/);

    // ⛔ And a different GROUP does not buy a second "Rent": `group` is deliberately NOT in the key.
    await expect(
      asOrg(f.orgId, (tx) =>
        createCategory(tx, f.admin, { group: 'COGS', category: 'rent', accountCode: null }),
      ),
    ).rejects.toThrow(/Rent/);
  });

  it('12 rename works, and a rename onto an existing name is refused', async () => {
    const f = await fixture('rename');
    const { categoryId } = await asOrg(f.orgId, (tx) =>
      createCategory(tx, f.admin, { group: 'OPEX', category: 'Sccoter rental', accountCode: null }),
    );
    await asOrg(f.orgId, (tx) =>
      createCategory(tx, f.admin, { group: 'OPEX', category: 'Fuel', accountCode: null }),
    );

    await asOrg(f.orgId, (tx) => renameCategory(tx, f.admin, { categoryId, category: 'Scooter rental' }));
    const [row] = await sql<{ category: string }[]>`
      select category from expense_categories where id = ${categoryId}`;
    expect(row!.category).toBe('Scooter rental');

    await expect(
      asOrg(f.orgId, (tx) => renameCategory(tx, f.admin, { categoryId, category: ' FUEL ' })),
    ).rejects.toThrow(/Fuel/);
  });

  it('13 ⛔ a SEEDED row may be retired but never renamed — bible §4.4 rules 2 and 5', async () => {
    const f = await fixture('system');
    await seedExpenseCategories(sql, f.orgId);
    const [seeded] = await sql<{ id: string; category: string }[]>`
      select id, category from expense_categories
       where org_id = ${f.orgId} and is_system = true limit 1`;

    // Identity is stable forever — the seed owns this row's name, not the screen (rule 5).
    await expect(
      asOrg(f.orgId, (tx) => renameCategory(tx, f.admin, { categoryId: seeded!.id, category: 'Renamed' })),
    ).rejects.toThrow(/seeded|system/i);

    // …but it CAN be retired: "deactivated but never deleted" (rule 2).
    await asOrg(f.orgId, (tx) =>
      setCategoryActive(tx, f.admin, { categoryId: seeded!.id, isActive: false }),
    );
    const [after] = await sql<{ is_active: boolean }[]>`
      select is_active from expense_categories where id = ${seeded!.id}`;
    expect(after!.is_active).toBe(false);
  });

  it('14 ⭐ retiring keeps the category readable on everything already posted against it', async () => {
    const f = await fixture('retire');
    const { categoryId } = await asOrg(f.orgId, (tx) =>
      createCategory(tx, f.admin, { group: 'OPEX', category: 'Old service', accountCode: '6200' }),
    );
    // ⚠️ Through the file's own helper: `expenses.supplier_invoice_id` is NOT NULL with a trigger
    // behind it (T-130), so a naive INSERT is refused with "supplier invoice <NULL> does not exist".
    await draftExpense(f, categoryId, daysAgo(5));

    await asOrg(f.orgId, (tx) => setCategoryActive(tx, f.admin, { categoryId, isActive: false }));

    // ⛔ The row is still THERE and still joins — a retired category is invisible to a PICKER, never
    //    to history. Deleting it is impossible anyway: `expenses.category_id` is `on delete restrict`.
    const admin = await asOrg(f.orgId, (tx) => expensesRepo.listCategoriesForAdmin(tx, f.orgId));
    expect(admin.find((c) => c.id === categoryId)?.isActive).toBe(false);
    const [joined] = await sql<{ category: string }[]>`
      select c.category from expenses e join expense_categories c on c.id = e.category_id
       where e.category_id = ${categoryId}`;
    expect(joined!.category).toBe('Old service');
  });

  it('15 ⭐ the seed still works after the index change, and is still idempotent', async () => {
    const f = await fixture('seed');
    // ⛔ `on conflict (org_id, category)` STOPPED MATCHING ANY INDEX at 0134 and had to become
    //    `on conflict (org_id, lower(trim(category)))`. Without that edit this call raises
    //    "there is no unique or exclusion constraint matching the ON CONFLICT specification" —
    //    a coupling invisible from either file alone.
    const first = await seedExpenseCategories(sql, f.orgId);
    expect(first.categoriesInserted).toBeGreaterThan(0);
    const second = await seedExpenseCategories(sql, f.orgId);
    expect(second.categoriesInserted).toBe(0);

    const [userRows] = await sql<{ n: number }[]>`
      select count(*)::int as n from expense_categories
       where org_id = ${f.orgId} and is_system = false`;
    expect(userRows!.n).toBe(0);
  });
});

// =====================================================================================
// ⭐ The raw-SQL readers of the dropped `sub_category` column — EXECUTED, not typechecked.
// =====================================================================================

/**
 * ⛔ **Why these four assertions exist, and why they are the point of slice 2's test list.**
 * `sub_category` was dropped on the premise that it was "read by nothing". It had no DATA, but it
 * had four live SQL readers — and only ONE of them (`repo/expenses.ts`) went through Drizzle's
 * typed builder. The other three are raw `sql` template strings that TypeScript cannot see, so
 * dropping the column left a GREEN typecheck, a GREEN unit suite and a GREEN build, with
 * `column c.sub_category does not exist` waiting at runtime on the budgets screen and the
 * commissary catalogue.
 *
 * `budgets.test.ts` already reaches `listForStorePeriod`. The three below were reached by nothing.
 * ⚠️ **A green typecheck is not evidence for a raw string — only an executed query is.**
 */
describe('T-229 slice 2 — every raw-SQL reader of the dropped column still runs', () => {
  it('19 ⭐ the PICKER list excludes a retired category; the HISTORY list still carries it', async () => {
    // ⭐ The choke point every new-record picker funnels through — `/expenses/new`, the AP invoice
    //    line editor, recurring templates and the commissary map all call `listCategories` with
    //    `activeOnly`. ⛔ Without this the Retire button marks a badge and stops nothing: the
    //    category keeps appearing in every dropdown, which is the "a control that controls
    //    nothing" shape this project keeps hitting.
    const f = await fixture('picker');
    const { categoryId } = await asOrg(f.orgId, (tx) =>
      createCategory(tx, f.admin, { group: 'OPEX', category: 'Retired thing', accountCode: '6200' }),
    );
    await asOrg(f.orgId, (tx) => setCategoryActive(tx, f.admin, { categoryId, isActive: false }));

    const picker = await asOrg(f.orgId, (tx) =>
      expensesRepo.listCategories(tx, f.orgId, { activeOnly: true }),
    );
    expect(picker.map((c) => c.id)).not.toContain(categoryId);

    // ⚠️ …and the unfiltered call still returns it, because an expense already recorded against it
    //    has to render its own category's name and `/expenses`' filter has to filter by it.
    const history = await asOrg(f.orgId, (tx) => expensesRepo.listCategories(tx, f.orgId));
    expect(history.map((c) => c.id)).toContain(categoryId);
    expect(history.find((c) => c.id === categoryId)?.isActive).toBe(false);
  });

  it('16 budgetsRepo.categoriesWithoutBudget executes and returns rows', async () => {
    const f = await fixture('rawbudget');
    await seedExpenseCategories(sql, f.orgId);
    const rows = await asOrg(f.orgId, (tx) =>
      budgetsRepo.categoriesWithoutBudget(tx, f.orgId, f.storeId, '202601'),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0]!.label).toBe('string');
    expect(rows[0]!.label.length).toBeGreaterThan(0);
  });

  it('17 budgetsRepo.listForStorePeriod executes and labels a category', async () => {
    const f = await fixture('rawbudget2');
    const categoryId = await category(f, '6200');
    await asOrg(f.orgId, (tx) =>
      budgetsRepo.setBudget(tx, {
        orgId: f.orgId, storeId: f.storeId, categoryId, periodKey: '202601',
        amount: '1000.00', autoReissue: false, reissueInterval: null, createdBy: f.staffId,
      }),
    );
    const rows = await asOrg(f.orgId, (tx) =>
      budgetsRepo.listForStorePeriod(tx, f.orgId, f.storeId, '202601'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.categoryLabel.length).toBeGreaterThan(0);
  });

  it('18 the two commissary readers execute', async () => {
    const f = await fixture('rawcomm');
    // Both are list reads that must PARSE and RUN against a table whose column is gone. An empty
    // result is a pass — the query executing at all is the thing under test.
    const offerings = await asOrg(f.orgId, (tx) =>
      commissaryRepo.orderableCatalogue(tx, f.orgId, f.storeId, f.storeId),
    );
    expect(Array.isArray(offerings)).toBe(true);
    const mappings = await asOrg(f.orgId, (tx) =>
      commissaryCatalogueRepo.listMap(tx, f.orgId, f.storeId, f.storeId),
    );
    expect(Array.isArray(mappings)).toBe(true);
  });
});
