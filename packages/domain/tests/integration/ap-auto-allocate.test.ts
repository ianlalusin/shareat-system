import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-330 — auto-allocate a payment, oldest first. docs/tasks/330-auto-allocate-a-payment-oldest-first.md.
 *
 * ⛔ Targets `suggestPaymentAllocation(tx, actor, storeId, amount, open, keys)` against
 * AMENDMENT 3's deliberately-empty stub (AMENDMENT 4 added `storeId` as the third argument).
 *
 * ⭐ Test 3 is the one the amendment rewrote after the tester traced the allocation grain: AP's
 * sort keys (due_date, invoice_no) live on `supplier_invoices`, but the allocation grain is the
 * EXPENSE, and `expenses.supplier_invoice_id` is not unique — so two expenses backed by one
 * invoice tie on every key from that table, and the real tie-break is `expenses.id` (AMENDMENT 4,
 * F3+F7 — `created_at` was tried first and proven unable to ever change an outcome).
 *
 * ⛔ AMENDMENT 4, second pass: `dueDate` is handed in RAW (nullable) alongside a NOT-NULL
 * `invoiceDate` fallback — the PURE module resolves `dueDate ?? invoiceDate` itself, not this
 * file's key lookup. `agingDate` (a pre-resolved column) was retired before any source used it:
 * a resolved date can't be told apart from its absence by a test that only sees the result.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { money } from '@shareat/core/money';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { apRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createSupplier,
  recordInvoice,
  verifyInvoice,
  recordExpenseForInvoice,
  recordPayment,
  // ⛔ DOES NOT EXIST YET — this is the contract the amended spec names but the builder has not
  // written. Importing it is deliberate: this is what makes the case below able to go red on the
  // assertion once it exists, per protocol step 1.
  suggestPaymentAllocation,
} from '@shareat/domain';

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

async function fixture(hint: string) {
  const code = uid(`apauto-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')
  `;
  const [manager] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id
  `;
  // ⭐ A SECOND manager-role person, purely so recordInvoice and verifyInvoice are never the same
  // actor — the two-person rule (migration 0046) throws otherwise, and 'manager' already holds
  // record_supplier_invoice in the base matrix, so no everyday-access grant is needed for this.
  const [logger] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Invoice Logger') returning id
  `;
  const [staff] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${logger!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${logger!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;

  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  const category = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'
  `;

  const managerActor = actor(orgId, manager!.id);
  const loggerActor = actor(orgId, logger!.id);
  const supplier = await asOrg(orgId, (tx) => createSupplier(tx, managerActor, { name: `${hint} Supplier` }));

  return {
    orgId, storeId, managerId: manager!.id, loggerId: logger!.id, staffId: staff!.id,
    manager: managerActor, logger: loggerActor, staff: actor(orgId, staff!.id),
    drawerId: drawer!.id, categoryId: category[0]!.id, supplierId: supplier.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Evidence for verifyInvoice — a real `stored_files` row, matching ap.test.ts's own fixture. */
async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy})
    returning id
  `;
  return row!.id;
}

/** `logger` records the invoice, `f.manager` verifies it — two different manager-role people,
 *  satisfying the two-person rule without needing an everyday-access grant for either. */
async function verifiedInvoice(f: Fixture, totalAmount: string, over: Record<string, unknown> = {}): Promise<string> {
  const fileId = await receiptFile(f.orgId, f.storeId, f.loggerId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.logger, {
      storeId: f.storeId,
      supplierId: f.supplierId,
      invoiceDate: '2026-01-10',
      totalAmount,
      receiptFileId: fileId,
      ...over,
    }),
  );
  await asOrg(f.orgId, (tx) =>
    verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }),
  );
  return created.id;
}

async function creditExpense(f: Fixture, invoiceId: string, amount: string, particulars = 'Stock purchase') {
  return asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId: f.storeId,
      supplierId: f.supplierId,
      supplierInvoiceId: invoiceId,
      categoryId: f.categoryId,
      particulars,
      payments: [{ method: 'credit', amount }],
    }),
  );
}

/** The narrow ordering-key lookup ruling 1 describes — keyed by the ids `openItems` already
 *  returned, used ONLY to sort. Test-local, mirroring what `apRepo` would supply for real.
 *  ⛔ AMENDMENT 4 (final): `dueDate` is RAW and nullable; `invoiceDate` is the NOT-NULL fallback,
 *  and `suggestPaymentAllocation`/the pure module resolve `dueDate ?? invoiceDate` themselves —
 *  this lookup does NOT coalesce. `createdAt` stays gone (F3+F7); the final key is `id` alone. */
interface ApOrderingKeys {
  expenseId: string;
  dueDate: string | null;
  invoiceDate: string;
  invoiceNo: string | null;
}
async function orderingKeysFor(expenseIds: string[]): Promise<ApOrderingKeys[]> {
  if (expenseIds.length === 0) return [];
  const rows = await sql<{ expense_id: string; due_date: string | null; invoice_date: string; invoice_no: string | null }[]>`
    select e.id as expense_id, si.due_date::text as due_date, si.invoice_date::text as invoice_date, si.invoice_no
    from expenses e join supplier_invoices si on si.id = e.supplier_invoice_id
    where e.id = any(${expenseIds})
  `;
  return rows.map((r) => ({
    expenseId: r.expense_id,
    dueDate: r.due_date,
    invoiceDate: r.invoice_date,
    invoiceNo: r.invoice_no,
  }));
}

/** ⭐ AMENDMENT 4: `storeId` is now a required third argument — the caller's own duty to prove
 *  `open` was fetched store-scoped, not the org-wide read `openItems` was built to forbid. */
async function suggest(f: Fixture, who: Actor, amount: string) {
  return asOrg(f.orgId, async (tx) => {
    const open = await apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId);
    const keys = await orderingKeysFor(open.map((o) => o.expenseId));
    return suggestPaymentAllocation(tx, who, f.storeId, amount, open, keys);
  });
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-330 — suggestPaymentAllocation', () => {
  it('1. exhausts the payment across three outstanding items, all to zero', async () => {
    const f = await fixture('exhaust');
    const invA = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-05', invoiceNo: 'X-1' });
    const invB = await verifiedInvoice(f, '2000.00', { dueDate: '2026-01-10', invoiceNo: 'X-2' });
    const invC = await verifiedInvoice(f, '1500.00', { dueDate: '2026-01-15', invoiceNo: 'X-3' });
    await creditExpense(f, invA, '1000.00');
    await creditExpense(f, invB, '2000.00');
    await creditExpense(f, invC, '1500.00');

    const result = await suggest(f, f.manager, '4500.00');
    expect(result.unallocated).toBe('0.00');
    const total = result.allocations.reduce((s, a) => s + Number(a.amountApplied), 0);
    expect(total.toFixed(2)).toBe('4500.00');

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-20',
        amount: '4500.00', moneyAccountId: f.drawerId, allocations: result.allocations,
      }),
    );
    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open).toHaveLength(0);
  });

  it('2. a payment smaller than the oldest item allocates that item only, partially', async () => {
    const f = await fixture('partial');
    const invA = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-05', invoiceNo: 'P-1' });
    const invB = await verifiedInvoice(f, '2000.00', { dueDate: '2026-01-20', invoiceNo: 'P-2' });
    await creditExpense(f, invA, '1000.00');
    await creditExpense(f, invB, '2000.00');

    const result = await suggest(f, f.manager, '400.00');
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.amountApplied).toBe('400.00');
    expect(result.unallocated).toBe('0.00');
  });

  it('3. ⭐ oldest by due_date, tie-broken by invoice_no then expense id — two items share one invoice', async () => {
    const f = await fixture('order');
    // Same invoice -> identical due_date AND invoice_no on both expenses under it. The only thing
    // that can legitimately separate them is expenses.id (uuidv7, creation-ordered — AMENDMENT 4's
    // sole surviving tie-break), not business_date (forced from invoiceDate, identical here too)
    // and not insertion order re-derived any other way.
    const invA = await verifiedInvoice(f, '2500.00', { dueDate: '2026-01-10', invoiceNo: 'A-1' });
    const invB = await verifiedInvoice(f, '2000.00', { dueDate: '2026-01-05', invoiceNo: 'B-1' }); // most overdue

    // Insertion order deliberately scrambled: aFirst, then B, then aSecond. aFirst is created
    // before aSecond, so aFirst's uuidv7 id is the smaller one — that is the only thing standing
    // between "correct" and "insertion order" here, since both are otherwise identical.
    const aFirst = await creditExpense(f, invA, '1000.00', 'A, created first — must win the tie');
    const b = await creditExpense(f, invB, '2000.00', 'B, most overdue — must go first overall');
    const aSecond = await creditExpense(f, invA, '1500.00', 'A, created second — must lose the tie');

    const result = await suggest(f, f.manager, '2500.00');
    expect(result.allocations).toEqual([
      { expenseId: b.expenseId, amountApplied: '2000.00' },
      { expenseId: aFirst.expenseId, amountApplied: '500.00' },
    ]);
    expect(result.unallocated).toBe('0.00');
    expect(result.allocations.some((a) => a.expenseId === aSecond.expenseId)).toBe(false);
  });

  it("3b. ⭐⭐ an undated bill falls back to its invoice date and can outrank a bill with a real, later due date — Ian's reversal (AMENDMENT 4)", async () => {
    const f = await fixture('coalesce');
    // The auditor's own scenario: a large bill invoiced early with NO due date (agingDate must
    // fall back to invoice_date, 2026-01-15) against a smaller bill with a real but much LATER due
    // date. Under the withdrawn NULLS LAST rule, the undated bill would have sorted LAST despite
    // being the most overdue thing outstanding — this is the case that reversed the ruling.
    // dueDate: null is passed through RAW here — the fallback to invoice_date happens inside
    // suggestPaymentAllocation / the pure module, not in this fixture or the keys lookup.
    const invJan = await verifiedInvoice(f, '50000.00', { invoiceDate: '2026-01-15', dueDate: null, invoiceNo: 'JAN-1' });
    const invSep = await verifiedInvoice(f, '10000.00', { invoiceDate: '2026-01-20', dueDate: '2026-09-25', invoiceNo: 'SEP-1' });
    const jan = await creditExpense(f, invJan, '50000.00', 'Undated — must fall back to invoice_date and go FIRST');
    await creditExpense(f, invSep, '10000.00', 'Due 09-25 — must go SECOND despite having a real due date');

    const result = await suggest(f, f.manager, '10000.00');
    expect(result.allocations).toEqual([{ expenseId: jan.expenseId, amountApplied: '10000.00' }]);
    expect(result.unallocated).toBe('0.00');
  });

  it("⛔ refuses an item whose storeId differs from the one named — the caller's own store-scope duty (AMENDMENT 4)", async () => {
    const f = await fixture('crossstore');
    const invA = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-05', invoiceNo: 'CS-1' });
    await creditExpense(f, invA, '1000.00');
    const [otherStore] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('other')}, 'Other Store') returning id
    `;

    await expect(
      asOrg(f.orgId, async (tx) => {
        const open = await apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId);
        const keys = await orderingKeysFor(open.map((o) => o.expenseId));
        // Simulates a caller that fetched org-wide (or the wrong store) instead of store-scoped —
        // exactly the failure AMENDMENT 4 traced: the screen renders one store, auto-allocate
        // proposes another store's open item, and Save throws on a figure the operator never typed.
        const tampered = open.map((o) => ({ ...o, storeId: otherStore!.id }));
        return suggestPaymentAllocation(tx, f.manager, f.storeId, '500.00', tampered, keys);
      }),
    ).rejects.toThrow(/outside the payment's own store/);
  });

  it("⛔ Q3 — an `open` id with no matching `keys` entry is refused, fail closed, not sorted first or last (AMENDMENT 4 spec table)", async () => {
    const f = await fixture('nokeys');
    const invA = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-05', invoiceNo: 'NK-1' });
    await creditExpense(f, invA, '1000.00');

    await expect(
      asOrg(f.orgId, async (tx) => {
        const open = await apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId);
        const keys = await orderingKeysFor(open.map((o) => o.expenseId));
        // Simulates a keys lookup that silently dropped a row (a join filtering something out) —
        // `open` still names an item `keys` says nothing about. The ruling is THROW, never
        // synthesize a fallback key: `keys.find(...) ?? { dueDate: null, invoiceDate: '', ... }`
        // would resolve to `invoiceDate: ''`, which sorts before every real date — undated-first
        // again, by a third route nothing else in this file exercises.
        const partial = keys.slice(1);
        return suggestPaymentAllocation(tx, f.manager, f.storeId, '500.00', open, partial);
      }),
      // ⚠️ Message-asserted, not bare — same reasoning as the storeId case just above: a bare
      // `toThrow()` would also pass if `authorize` or something upstream threw for an unrelated
      // reason. This asserts the KEYS check specifically fired.
    ).rejects.toThrow(/has no ordering key/);
  });

  it("2b. ⭐ AMENDMENT 7 — the payment available is reduced by the typed sum, and the merged array still posts cleanly through recordPayment's own guard", async () => {
    const f = await fixture('typed-reduce');
    const invTyped = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-01', invoiceNo: 'TY-1' });
    const invOpen = await verifiedInvoice(f, '2000.00', { dueDate: '2026-01-05', invoiceNo: 'OP-1' });
    const typedExp = await creditExpense(f, invTyped, '1000.00');
    const openExp = await creditExpense(f, invOpen, '2000.00');

    const typed = [{ id: typedExp.expenseId, amount: money('300.00') }];
    const result = await asOrg(f.orgId, async (tx) => {
      const open = await apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId);
      const keys = await orderingKeysFor(open.map((o) => o.expenseId));
      return suggestPaymentAllocation(tx, f.manager, f.storeId, '800.00', open, keys, typed);
    });

    // Available for auto-fill is 800 − 300 = 500, all to the untyped item — not the full 800, and
    // the typed item is absent from the output entirely (Ian's ruling 2, tested at the unit level
    // too; here it matters that the WRAPPER threads `typed` through correctly).
    expect(result.allocations).toEqual([{ expenseId: openExp.expenseId, amountApplied: '500.00' }]);
    expect(result.unallocated).toBe('0.00');

    // Merge typed + suggested exactly as the screen would, and prove recordPayment's OWN guard —
    // which sees only the final array, not the arithmetic that built it — still accepts it.
    const merged = [
      { expenseId: typedExp.expenseId, amountApplied: '300.00' },
      ...result.allocations,
    ];
    const posted = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-20',
        amount: '800.00', moneyAccountId: f.drawerId, allocations: merged,
      }),
    );
    expect(posted.allocated).toBe('800.00');
    expect(posted.unallocated).toBe('0.00');
  });

  it('4. a payment exceeding everything outstanding leaves the exact surplus, before posting', async () => {
    const f = await fixture('remainder');
    const invA = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-05', invoiceNo: 'R-1' });
    const a = await creditExpense(f, invA, '1000.00');

    const result = await suggest(f, f.manager, '1500.00');
    expect(result.allocations).toEqual([{ expenseId: a.expenseId, amountApplied: '1000.00' }]);
    expect(result.unallocated).toBe('500.00');
  });

  it('⛔ a staff-role actor is refused — this is a new read path over the counterparty\'s ledger and must be gated like recordPayment', async () => {
    const f = await fixture('unauth');
    const invA = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-05', invoiceNo: 'U-1' });
    await creditExpense(f, invA, '1000.00');

    // ⚠️ Specifically an AuthorizationError, not `.rejects.toThrow()` bare — a bare assertion would
    // pass right now for the WRONG reason (suggestPaymentAllocation is not a function yet, and a
    // TypeError also satisfies a bare toThrow()). That is a false green, not a usable red.
    await expect(suggest(f, f.staff, '500.00')).rejects.toThrow(AuthorizationError);
  });

  it("6'. ⭐ the remainder is provable from the DOUBLE ENTRY, not from re-evaluating the same subtraction twice", async () => {
    // ⛔ FIXED per AMENDMENT 4 F5: comparing `posted.unallocated` to `result.unallocated` is one
    // formula (`amount − Σallocations`) evaluated twice over the identical `allocations` array —
    // recordPayment recomputes `Math.max(0, amount - allocatedTotal)` from the SAME array the
    // suggestion produced, so the two could only ever disagree on float-vs-bigint, which cannot
    // happen at these magnitudes. That made the case unfalsifiable once the first assertion below
    // passed. FIX: read the remainder out of the GENERAL LEDGER — a fresh SQL sum over
    // journal_lines, independent of any in-memory value either function returned — and require it
    // to move by exactly the suggestion's own figure.
    const f = await fixture('agree');
    const invA = await verifiedInvoice(f, '1000.00', { dueDate: '2026-01-05', invoiceNo: 'G-1' });
    await creditExpense(f, invA, '1000.00');

    const before = await asOrg(f.orgId, (tx) => apRepo.advancesPositionOf(tx, f.orgId, f.supplierId));

    const result = await suggest(f, f.manager, '1300.00');
    expect(result.unallocated).toBe('300.00');

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-20',
        amount: '1300.00', moneyAccountId: f.drawerId, allocations: result.allocations,
      }),
    );

    const after = await asOrg(f.orgId, (tx) => apRepo.advancesPositionOf(tx, f.orgId, f.supplierId));
    expect((Number(after) - Number(before)).toFixed(2)).toBe(result.unallocated);
  });
});
