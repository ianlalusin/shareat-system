import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-502 S3 / section 12 (TESTER, red first) - an expense is one CATEGORY slice of an itemised invoice, and one invoice can be
 * recorded as a batch. Spec: docs/tasks/502-expense-item-catalog.md section 12 "Tests" 1-8 (9 is the picker and 10 the allocator;
 * they live in apps/erp/tests/integration/t502-s12-picker-category.test.ts and packages/domain/tests/t502-s12-allocate-batch-payments.test.ts).
 *
 * SHAPES ASSUMED (the spec names only the function names and the option; the orchestrator must rule - see the hand-back):
 *   createExpense(tx, actor, input, { requireItemised? })  - the helper passes the flag BOTH as input.requireItemised and as a 4th argument,
 *                                                            so either placement the builder picks satisfies these tests.
 *   recordInvoiceExpensesBatch(tx, actor, { storeId, supplierInvoiceId, supplierId, groups:[{categoryId: string|null, pickedCategoryId?, particulars?}], payments })
 *       categoryId null = the "Uncategorised" group; pickedCategoryId = the category the person picks for that group.
 * All shape knowledge sits in `create()` / `batch()` below, so a ruling changes one helper, not every test.
 *
 * MUTANTS: requireItemised default false; the group ceiling checked against the whole invoice; a voided expense still counted in its
 * group; the batch looping outside one transaction (rows survive a failure); the batch posting on a pending invoice or leaving a
 * verified one as drafts; a second batch writing again; the batch skipping authorize.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { ap475Fixture, asOrg, actorOf, uid, type Fixture } from './_fixtures/t475-ap';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Tx = Parameters<Parameters<typeof asOrg>[1]>[0];
type Pay = { method: 'cash' | 'credit'; amount: string; moneyAccountId?: string };
type Opts = { requireItemised?: boolean };
type CreateFn = (tx: Tx, actor: Actor, input: Record<string, unknown>, options?: Opts) => Promise<{ id: string }>;
type EditFn = (tx: Tx, actor: Actor, id: string, input: Record<string, unknown>, options?: Opts) => Promise<void>;
type BatchGroup = { categoryId: string | null; pickedCategoryId?: string; particulars?: string };
type BatchFn = (
  tx: Tx,
  actor: Actor,
  input: { storeId: string; supplierInvoiceId: string; supplierId: string; groups: BatchGroup[]; payments: Pay[] },
) => Promise<unknown>;
const createExpenseX = domain.createExpense as unknown as CreateFn;
const editExpenseX = domain.editExpense as unknown as EditFn;
const batchFn = (domain as unknown as { recordInvoiceExpensesBatch?: BatchFn }).recordInvoiceExpensesBatch;

/** The sentence a refusal carries (what a person reads), or null when it did not refuse. A raw non-refusal throw is surfaced as RAW. */
async function sentenceOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? `RAW: ${(err as Error).message}`;
  }
}

const NOT_ITEMISED = 'List what was on this bill first (invoice page), then record the expense.';
const ALREADY_RECORDED = /Everything on this bill is already recorded/;
const PLAIN = /^RAW:|violates|constraint|expenses_|is not a function|not exported/i;

/** Mapped categories (account_code not null) of the seeded org, in a stable order. */
async function mappedCategories(orgId: string, n: number): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and is_active and account_code is not null order by category limit ${n}`;
  if (rows.length < n) throw new Error('fixture org has too few mapped expense categories');
  return rows.map((r) => r.id);
}

/** An item in the org carrying `categoryId` (null = uncategorised). */
async function itemIn(f: Fixture, categoryId: string | null, name: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by, expense_category_id)
    values (${f.orgId}, ${testItemCode()}, ${`${name} ${uid('i')}`}, 'raw_material', 'kg', ${f.adminId}, ${categoryId}) returning id`;
  return r!.id;
}

/**
 * An invoice at the fixture store, itemised: one line per group (one item per group, in the group's category), the invoice total = the
 * sum of its lines. `cat: null` = an uncategorised item.
 */
async function itemisedInvoice(
  f: Fixture,
  status: 'pending' | 'verified',
  groups: { cat: string | null; total: string; name?: string }[],
): Promise<{ id: string }> {
  const centavos = groups.reduce((s, g) => s + Math.round(Number(g.total) * 100), 0);
  const id = await f.invoice({ total: (centavos / 100).toFixed(2), status });
  let lineNo = 0;
  for (const g of groups) {
    const itemId = await itemIn(f, g.cat, g.name ?? 'Item');
    lineNo += 1;
    await sql`
      insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
      values (${id}, ${lineNo}, ${itemId}, '1', 'pcs', '1', ${g.total}, ${g.total})`;
  }
  return { id };
}

const cashPay = (f: Fixture, amount: string): Pay => ({ method: 'cash', amount, moneyAccountId: f.cashId });

const create = (f: Fixture, invoiceId: string, o: { categoryId: string; amount: string; actor?: Actor; opts?: Opts }) =>
  asOrg(f.orgId, (tx) =>
    createExpenseX(
      tx,
      o.actor ?? f.admin,
      {
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: invoiceId, businessDate: '2026-01-10', categoryId: o.categoryId,
        particulars: 'T-502 S12', payments: [cashPay(f, o.amount)], ...(o.opts ?? {}),
      },
      o.opts,
    ),
  );
const edit = (f: Fixture, id: string, input: Record<string, unknown>) => asOrg(f.orgId, (tx) => editExpenseX(tx, f.admin, id, input));
const batch = (f: Fixture, invoiceId: string, groups: BatchGroup[], payments: Pay[], actor: Actor = f.admin, storeId: string = f.storeId) => {
  if (!batchFn) throw new Error('recordInvoiceExpensesBatch is not exported from @shareat/domain');
  return asOrg(f.orgId, (tx) => batchFn(tx, actor, { storeId, supplierInvoiceId: invoiceId, supplierId: f.supplierId, groups, payments }));
};

const expensesOf = (invoiceId: string) =>
  sql<{ id: string; category_id: string; total_amount: string; status: string; particulars: string; journal_entry_id: string | null }[]>`
    select id, category_id, total_amount::text, status, particulars, journal_entry_id from expenses where supplier_invoice_id = ${invoiceId} order by created_at, id`;
const paymentsOf = (expenseId: string) =>
  sql<{ method: string; amount: string }[]>`select method, amount::text from expense_payments where expense_id = ${expenseId} order by amount desc, method`;
const auditCount = async (orgId: string, action: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${orgId} and action = ${action}`)[0]!.n);
const expenseEntries = async (orgId: string) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'expense_payment'`)[0]!.n);

// ---------------------------------------------------------------------------------------------------------------------------
describe('T-502 S12 / 1 - no lines, no expense (requireItemised)', () => {
  it('createExpense on an invoice with NO lines is refused with the exact sentence, and nothing is written', async () => {
    const f = await ap475Fixture(sql, 's12-1');
    const [meat] = await mappedCategories(f.orgId, 1);
    const bare = await f.invoice({ total: '1000.00' });
    const s = await sentenceOf(() => create(f, bare, { categoryId: meat!, amount: '100.00' }));
    expect(s, 'a lineless invoice must refuse (default requireItemised = true)').toBe(NOT_ITEMISED);
    expect(await expensesOf(bare)).toHaveLength(0);
    expect(await auditCount(f.orgId, 'expense.drafted')).toBe(0);
  });

  it('GUARD - requireItemised:false is the recurring-job / system-invoice path and still drafts on a lineless invoice', async () => {
    const f = await ap475Fixture(sql, 's12-1b');
    const [meat] = await mappedCategories(f.orgId, 1);
    const bare = await f.invoice({ total: '1000.00' });
    expect(await sentenceOf(() => create(f, bare, { categoryId: meat!, amount: '100.00', opts: { requireItemised: false } }))).toBeNull();
    expect(await expensesOf(bare)).toHaveLength(1);
  });

  it('editExpense on a draft whose invoice has NO lines is refused with the same sentence; the draft is untouched', async () => {
    const f = await ap475Fixture(sql, 's12-1c');
    const [meat] = await mappedCategories(f.orgId, 1);
    const bare = await f.invoice({ total: '1000.00' });
    const { id } = await create(f, bare, { categoryId: meat!, amount: '100.00', opts: { requireItemised: false } });
    expect(await sentenceOf(() => edit(f, id, { particulars: 'changed' }))).toBe(NOT_ITEMISED);
    expect((await expensesOf(bare))[0]!.particulars).toBe('T-502 S12');
  });

  it('GUARD - an itemised invoice is not refused by the rule', async () => {
    const f = await ap475Fixture(sql, 's12-1d');
    const [meat] = await mappedCategories(f.orgId, 1);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '1000.00' }]);
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '400.00' }))).toBeNull();
  });

  it('recordExpenseForInvoice (the invoice page "+ Record expense") enforces it too - it goes through createExpense', async () => {
    const f = await ap475Fixture(sql, 's12-1e');
    const [meat] = await mappedCategories(f.orgId, 1);
    const bare = await f.invoice({ total: '1000.00', status: 'verified' });
    const s = await sentenceOf(() =>
      asOrg(f.orgId, (tx) =>
        domain.recordExpenseForInvoice(tx, f.admin, {
          storeId: f.storeId, supplierInvoiceId: bare, supplierId: f.supplierId, categoryId: meat!, particulars: 'x', payments: [cashPay(f, '100.00')],
        }),
      ),
    );
    expect(s).toBe(NOT_ITEMISED);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("T-502 S12 / 2 - the category must be one of the invoice's groups", () => {
  it('createExpense with a category no line carries is refused in plain words; a group category is accepted', async () => {
    const f = await ap475Fixture(sql, 's12-2');
    const [meat, veg, dry] = await mappedCategories(f.orgId, 3);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '1000.00' }, { cat: veg!, total: '500.00' }]);
    const s = await sentenceOf(() => create(f, inv.id, { categoryId: dry!, amount: '100.00' }));
    expect(s, 'dry goods is not on this bill').not.toBeNull();
    expect(s).not.toMatch(PLAIN);
    expect(await expensesOf(inv.id)).toHaveLength(0);
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: veg!, amount: '100.00' }))).toBeNull();
  });

  it('editExpense moving a draft onto a category no line carries is refused; moving to another group category is allowed', async () => {
    const f = await ap475Fixture(sql, 's12-2b');
    const [meat, veg, dry] = await mappedCategories(f.orgId, 3);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '1000.00' }, { cat: veg!, total: '500.00' }]);
    const { id } = await create(f, inv.id, { categoryId: meat!, amount: '100.00' });
    const s = await sentenceOf(() => edit(f, id, { categoryId: dry! }));
    expect(s).not.toBeNull();
    expect(s).not.toMatch(PLAIN);
    expect((await expensesOf(inv.id))[0]!.category_id).toBe(meat);
    expect(await sentenceOf(() => edit(f, id, { categoryId: veg! }))).toBeNull();
    expect((await expensesOf(inv.id))[0]!.category_id).toBe(veg);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('T-502 S12 / 3 - the amount ceiling is per GROUP, and voiding frees the group', () => {
  it('Meat 4250 + Veg 750: 4250.01 on Meat is refused (the WHOLE invoice would allow it); 4250.00 passes', async () => {
    const f = await ap475Fixture(sql, 's12-3');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4250.00' }, { cat: veg!, total: '750.00' }]);
    const over = await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '4250.01' }));
    expect(over, 'one centavo over the group').not.toBeNull();
    expect(over).not.toMatch(PLAIN);
    expect(await expensesOf(inv.id)).toHaveLength(0);
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '4250.00' })), 'exactly the group passes').toBeNull();
  });

  it('live expenses in the same category count against it: after 1000.00 on Meat only 3250.00 is left', async () => {
    const f = await ap475Fixture(sql, 's12-3b');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4250.00' }, { cat: veg!, total: '750.00' }]);
    await create(f, inv.id, { categoryId: meat!, amount: '1000.00' });
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '3250.01' }))).not.toBeNull();
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '3250.00' }))).toBeNull();
  });

  it('VOIDING a posted expense frees its group (mutant: a voided expense still counted)', async () => {
    const f = await ap475Fixture(sql, 's12-3c');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'verified', [{ cat: meat!, total: '4250.00' }, { cat: veg!, total: '750.00' }]);
    const posted = await asOrg(f.orgId, (tx) =>
      domain.recordExpenseForInvoice(tx, f.admin, {
        storeId: f.storeId, supplierInvoiceId: inv.id, supplierId: f.supplierId, categoryId: meat!, particulars: 'Meat', payments: [cashPay(f, '4250.00')],
      }),
    );
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '0.01' })), 'group is full').not.toBeNull();
    await asOrg(f.orgId, (tx) => domain.voidExpense(tx, f.admin, posted.expenseId, 'T-502 S12 test'));
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '4250.00' })), 'the group is free again').toBeNull();
  });

  it('deleting a DRAFT frees its group too', async () => {
    const f = await ap475Fixture(sql, 's12-3d');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4250.00' }, { cat: veg!, total: '750.00' }]);
    const { id } = await create(f, inv.id, { categoryId: meat!, amount: '4250.00' });
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '0.01' }))).not.toBeNull();
    await asOrg(f.orgId, (tx) => domain.deleteExpenseDraft(tx, f.admin, id));
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: meat!, amount: '4250.00' }))).toBeNull();
  });

  it('editExpense does not count the draft against itself: re-saving the full group amount passes; one centavo more is refused', async () => {
    const f = await ap475Fixture(sql, 's12-3e');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4250.00' }, { cat: veg!, total: '750.00' }]);
    const { id } = await create(f, inv.id, { categoryId: meat!, amount: '4250.00' });
    expect(await sentenceOf(() => edit(f, id, { payments: [cashPay(f, '4250.00')] })), 'self is excluded from the group sum').toBeNull();
    const more = await sentenceOf(() => edit(f, id, { payments: [cashPay(f, '4250.01')] }));
    expect(more).not.toBeNull();
    expect(more).not.toMatch(PLAIN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('T-502 S12 / 4 - the Uncategorised group needs an explicit category, and has only its own room', () => {
  it("lines whose item has no category: the person's category is accepted, up to that group's total only (not the invoice room)", async () => {
    const f = await ap475Fixture(sql, 's12-4');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4000.00' }, { cat: null, total: '1000.00', name: 'Mystery' }]);
    const over = await sentenceOf(() => create(f, inv.id, { categoryId: veg!, amount: '1000.01' }));
    expect(over, 'the Uncategorised group holds 1000.00; the invoice room (5000) must not be the ceiling').not.toBeNull();
    expect(over).not.toMatch(PLAIN);
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: veg!, amount: '1000.00' })), 'picked category for the uncategorised group').toBeNull();
    expect((await expensesOf(inv.id))[0]!.category_id).toBe(veg);
  });

  it('with the Uncategorised group used up, a category no line carries is refused again', async () => {
    const f = await ap475Fixture(sql, 's12-4b');
    const [meat, veg, dry] = await mappedCategories(f.orgId, 3);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4000.00' }, { cat: null, total: '1000.00' }]);
    await create(f, inv.id, { categoryId: veg!, amount: '1000.00' });
    expect(await sentenceOf(() => create(f, inv.id, { categoryId: dry!, amount: '1.00' }))).not.toBeNull();
  });

  it('batch: an Uncategorised group with NO picked category is refused as a whole; with one it records under that category', async () => {
    const f = await ap475Fixture(sql, 's12-4c');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4000.00' }, { cat: null, total: '1000.00' }]);
    const none = await sentenceOf(() => batch(f, inv.id, [{ categoryId: meat! }, { categoryId: null }], [cashPay(f, '5000.00')]));
    expect(none, 'no category picked for the uncategorised group').not.toBeNull();
    expect(none).not.toMatch(PLAIN);
    expect(await expensesOf(inv.id), 'nothing written').toHaveLength(0);
    expect(await sentenceOf(() => batch(f, inv.id, [{ categoryId: meat! }, { categoryId: null, pickedCategoryId: veg! }], [cashPay(f, '5000.00')]))).toBeNull();
    expect((await expensesOf(inv.id)).map((r) => r.category_id).sort()).toEqual([meat, veg].sort());
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('T-502 S12 / 5 - batch: one expense per ticked group, in ONE transaction', () => {
  it("3 groups -> 3 expenses, amounts = each group's remaining, group categories, 3 expense.drafted + 1 expense.batch_recorded", async () => {
    const f = await ap475Fixture(sql, 's12-5');
    const [meat, veg, dry] = await mappedCategories(f.orgId, 3);
    const inv = await itemisedInvoice(f, 'pending', [
      { cat: meat!, total: '4250.00', name: 'Pork kasim' }, { cat: veg!, total: '750.50' }, { cat: dry!, total: '99.99' },
    ]);
    await batch(f, inv.id, [{ categoryId: meat! }, { categoryId: veg! }, { categoryId: dry! }], [cashPay(f, '5100.49')]);
    const rows = await expensesOf(inv.id);
    expect(rows).toHaveLength(3);
    const byCat = new Map(rows.map((r) => [r.category_id, r]));
    expect(byCat.get(meat!)!.total_amount).toBe('4250.00');
    expect(byCat.get(veg!)!.total_amount).toBe('750.50');
    expect(byCat.get(dry!)!.total_amount).toBe('99.99');
    for (const r of rows) expect(r.particulars.trim(), 'particulars is pre-filled, never blank').not.toBe('');
    expect(byCat.get(meat!)!.particulars, "pre-filled from the group's item names").toMatch(/Pork kasim/);
    expect(await auditCount(f.orgId, 'expense.drafted')).toBe(3);
    expect(await auditCount(f.orgId, 'expense.batch_recorded')).toBe(1);
    const [a] = await sql<{ after: unknown }[]>`select after from audit_log where org_id = ${f.orgId} and action = 'expense.batch_recorded'`;
    const text = JSON.stringify(a!.after);
    expect(text, 'the batch event names the invoice').toContain(inv.id);
    for (const r of rows) expect(text, 'and every expense id').toContain(r.id);
  });

  it('a group already partly recorded contributes only what is left (amount = remaining)', async () => {
    const f = await ap475Fixture(sql, 's12-5b');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '4250.00' }, { cat: veg!, total: '750.00' }]);
    await create(f, inv.id, { categoryId: meat!, amount: '1000.00' });
    await batch(f, inv.id, [{ categoryId: meat! }, { categoryId: veg! }], [cashPay(f, '4000.00')]); // 3250 + 750
    expect((await expensesOf(inv.id)).map((r) => r.total_amount).sort()).toEqual(['1000.00', '3250.00', '750.00']);
  });

  it('ALL OR NONE: the 3rd group cannot post (unmapped category, VERIFIED invoice) -> no expense, payment, journal entry or audit row survives', async () => {
    const f = await ap475Fixture(sql, 's12-5c');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const broken = await f.unmappedCategory();
    const inv = await itemisedInvoice(f, 'verified', [{ cat: meat!, total: '100.00' }, { cat: veg!, total: '200.00' }, { cat: broken, total: '300.00' }]);
    const s = await sentenceOf(() => batch(f, inv.id, [{ categoryId: meat! }, { categoryId: veg! }, { categoryId: broken }], [cashPay(f, '600.00')]));
    expect(s, 'the third cannot post').not.toBeNull();
    expect(s).not.toMatch(/is not a function|not exported/i);
    expect(await expensesOf(inv.id), 'mutant: rows 1 and 2 survive').toHaveLength(0);
    expect(await expenseEntries(f.orgId), 'no journal entry survives').toBe(0);
    expect(await auditCount(f.orgId, 'expense.drafted')).toBe(0);
    expect(await auditCount(f.orgId, 'expense.batch_recorded')).toBe(0);
    const [{ n } = { n: "-1" }] = await sql<{ n: string }[]>`select count(*)::text as n from expense_payments ep join expenses e on e.id = ep.expense_id where e.supplier_invoice_id = ${inv.id}`;
    expect(Number(n)).toBe(0);
  });

  it("the payments must EQUAL the ticked groups' total: short and over are both refused, nothing written", async () => {
    const f = await ap475Fixture(sql, 's12-5d');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '100.00' }, { cat: veg!, total: '50.00' }]);
    for (const amount of ['149.99', '150.01']) {
      const s = await sentenceOf(() => batch(f, inv.id, [{ categoryId: meat! }, { categoryId: veg! }], [cashPay(f, amount)]));
      expect(s, `payments ${amount} vs groups 150.00`).not.toBeNull();
      expect(s).not.toMatch(PLAIN);
    }
    expect(await expensesOf(inv.id)).toHaveLength(0);
  });

  it('several sources: groups 100 / 50, cash 80 then credit 70 -> expense 1 has 80 cash + 20 credit, expense 2 has 50 credit (no zero rows)', async () => {
    const f = await ap475Fixture(sql, 's12-5e');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '100.00' }, { cat: veg!, total: '50.00' }]);
    await batch(f, inv.id, [{ categoryId: meat! }, { categoryId: veg! }], [cashPay(f, '80.00'), { method: 'credit', amount: '70.00' }]);
    const rows = await expensesOf(inv.id);
    expect(await paymentsOf(rows.find((r) => r.category_id === meat)!.id)).toEqual([{ method: 'cash', amount: '80.00' }, { method: 'credit', amount: '20.00' }]);
    expect(await paymentsOf(rows.find((r) => r.category_id === veg)!.id)).toEqual([{ method: 'credit', amount: '50.00' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('T-502 S12 / 6 - batch follows the invoice status (pending -> drafts, verified -> posted)', () => {
  it('PENDING: every expense is a draft and no journal entry exists', async () => {
    const f = await ap475Fixture(sql, 's12-6');
    const [meat, veg, dry] = await mappedCategories(f.orgId, 3);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '100.00' }, { cat: veg!, total: '200.00' }, { cat: dry!, total: '300.00' }]);
    await batch(f, inv.id, [{ categoryId: meat! }, { categoryId: veg! }, { categoryId: dry! }], [cashPay(f, '600.00')]);
    const rows = await expensesOf(inv.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'draft' && r.journal_entry_id === null), 'mutant: batch posts on a pending invoice').toBe(true);
    expect(await expenseEntries(f.orgId)).toBe(0);
  });

  it('VERIFIED: every expense is posted with its OWN journal entry (3 expenses -> 3 entries, each with lines)', async () => {
    const f = await ap475Fixture(sql, 's12-6b');
    const [meat, veg, dry] = await mappedCategories(f.orgId, 3);
    const inv = await itemisedInvoice(f, 'verified', [{ cat: meat!, total: '100.00' }, { cat: veg!, total: '200.00' }, { cat: dry!, total: '300.00' }]);
    await batch(f, inv.id, [{ categoryId: meat! }, { categoryId: veg! }, { categoryId: dry! }], [cashPay(f, '600.00')]);
    const rows = await expensesOf(inv.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'posted' && r.journal_entry_id !== null), "mutant: a verified invoice's expenses left as drafts").toBe(true);
    expect(new Set(rows.map((r) => r.journal_entry_id)).size, 'one entry per expense').toBe(3);
    expect(await expenseEntries(f.orgId)).toBe(3);
    for (const r of rows) {
      const [{ n } = { n: "-1" }] = await sql<{ n: string }[]>`select count(*)::text as n from journal_lines where entry_id = ${r.journal_entry_id!}`;
      expect(Number(n), 'a balanced entry has at least two lines').toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('T-502 S12 / 7 - batch twice', () => {
  it('the second submit is refused ("Everything on this bill is already recorded") and writes nothing', async () => {
    const f = await ap475Fixture(sql, 's12-7');
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, 'pending', [{ cat: meat!, total: '100.00' }, { cat: veg!, total: '50.00' }]);
    const groups = [{ categoryId: meat! }, { categoryId: veg! }];
    await batch(f, inv.id, groups, [cashPay(f, '150.00')]);
    const before = (await expensesOf(inv.id)).length;
    const drafted = await auditCount(f.orgId, 'expense.drafted');
    expect(await sentenceOf(() => batch(f, inv.id, groups, [cashPay(f, '150.00')]))).toMatch(ALREADY_RECORDED);
    expect((await expensesOf(inv.id)).length, 'mutant: a second batch writes again').toBe(before);
    expect(await auditCount(f.orgId, 'expense.drafted')).toBe(drafted);
    expect(await auditCount(f.orgId, 'expense.batch_recorded')).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe("T-502 S12 / 8 - permissions match createExpense's (each check has its refusing twin)", () => {
  /** A manager whose only store is the SECOND store: may record at Malvar, not at the invoice's store. */
  async function managerAtStore2(f: Fixture): Promise<Actor> {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Malvar Manager') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.store2Id})`;
    return actorOf(f.orgId, p!.id);
  }
  const twoGroups = async (f: Fixture, status: 'pending' | 'verified') => {
    const [meat, veg] = await mappedCategories(f.orgId, 2);
    const inv = await itemisedInvoice(f, status, [{ cat: meat!, total: '100.00' }, { cat: veg!, total: '50.00' }]);
    return { inv, meat: meat!, groups: [{ categoryId: meat! }, { categoryId: veg! }] as BatchGroup[] };
  };

  it('OK: admin and manager can batch (pending -> drafts)', async () => {
    const f = await ap475Fixture(sql, 's12-8a');
    for (const actor of [f.admin, f.manager]) {
      const t = await twoGroups(f, 'pending');
      expect(await sentenceOf(() => batch(f, t.inv.id, t.groups, [cashPay(f, '150.00')], actor)), `${actor.personId} may record`).toBeNull();
      expect(await expensesOf(t.inv.id)).toHaveLength(2);
    }
  });

  it("REFUSED: floor staff (no create_expense) gets createExpense's own sentence from the batch; nothing is written", async () => {
    const f = await ap475Fixture(sql, 's12-8b');
    const t = await twoGroups(f, 'pending');
    const single = await sentenceOf(() => create(f, t.inv.id, { categoryId: t.meat, amount: '10.00', actor: f.staff }));
    expect(single, 'fixture: staff cannot createExpense').not.toBeNull();
    expect(await sentenceOf(() => batch(f, t.inv.id, t.groups, [cashPay(f, '150.00')], f.staff)), 'same gate, same words').toBe(single);
    expect(await expensesOf(t.inv.id)).toHaveLength(0);
  });

  it("REFUSED: a manager scoped to another store only cannot batch at this store (createExpense's sentence)", async () => {
    const f = await ap475Fixture(sql, 's12-8c');
    const t = await twoGroups(f, 'pending');
    const away = await managerAtStore2(f);
    const single = await sentenceOf(() => create(f, t.inv.id, { categoryId: t.meat, amount: '10.00', actor: away }));
    expect(single, 'fixture: an out-of-scope manager cannot createExpense here').not.toBeNull();
    expect(await sentenceOf(() => batch(f, t.inv.id, t.groups, [cashPay(f, '150.00')], away))).toBe(single);
    expect(await expensesOf(t.inv.id)).toHaveLength(0);
  });

  it("REFUSED: the other store's staff cannot batch here; naming the wrong store for the invoice is refused as well", async () => {
    const f = await ap475Fixture(sql, 's12-8d');
    const t = await twoGroups(f, 'pending');
    expect(await sentenceOf(() => batch(f, t.inv.id, t.groups, [cashPay(f, '150.00')], f.otherStoreStaff))).not.toBeNull();
    const wrongStore = await sentenceOf(() => batch(f, t.inv.id, t.groups, [cashPay(f, '150.00')], f.admin, f.store2Id));
    expect(wrongStore, 'the invoice is at store 1; the batch names store 2').not.toBeNull();
    expect(wrongStore).not.toMatch(PLAIN);
    expect(await expensesOf(t.inv.id)).toHaveLength(0);
  });

  it('VERIFIED invoice: posting needs the posting capability too - admin posts, floor staff is refused (same gate as "+ Record expense")', async () => {
    const f = await ap475Fixture(sql, 's12-8e');
    const t = await twoGroups(f, 'verified');
    expect(await sentenceOf(() => batch(f, t.inv.id, t.groups, [cashPay(f, '150.00')], f.staff))).not.toBeNull();
    expect(await expensesOf(t.inv.id)).toHaveLength(0);
    expect(await sentenceOf(() => batch(f, t.inv.id, t.groups, [cashPay(f, '150.00')], f.admin))).toBeNull();
    expect((await expensesOf(t.inv.id)).every((r) => r.status === 'posted')).toBe(true);
  });

  it('NO new capability: the capability list has no batch-specific entry', async () => {
    const { CAPABILITIES } = await import('@shareat/auth');
    expect(CAPABILITIES.filter((c) => /batch/i.test(c))).toEqual([]);
  });
});
