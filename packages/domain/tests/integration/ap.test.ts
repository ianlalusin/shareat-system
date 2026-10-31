import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-130 — accounts payable. docs/tasks/130-accounts-payable.md.
 *
 * ⭐ Three tests carry the design:
 *   1. *"createExpense rejects a pending invoice"* — the gate, universal (cash included). The
 *      credit/cash split of that same proof lives here (test 3); the pending-vs-verified half
 *      already lives in expenses.test.ts's own invariant 11 (T-130 relocated DEF-055 there).
 *   2. *"a payment allocates across two open invoices"* — the open-item allocation this task's
 *      title names, and invariant 6 (subledger sums to the control balance) re-proven for the
 *      first control account with more than one open item per party.
 *   3. *"voiding an invoice cascades through voidExpense, never a reimplemented reversal"* — the
 *      single most load-bearing lesson this task's grounding found (v1's `voidReceiptAction`).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { apRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { parseBusinessDate } from '@shareat/core/datetime';
import {
  createSupplier,
  humanDate,
  recordInvoice,
  verifyInvoice,
  voidInvoice,
  recordExpenseForInvoice,
  recordPayment,
  voidPayment,
  createExpense,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

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
  const code = uid(`ap-${hint}`);
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
  const [staff] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staff!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId: staff!.id, setBy: manager!.id,
  });

  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  await fund(orgId, storeId, '1110', '500000.00', null);

  const category = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'
  `;

  return {
    orgId, storeId, managerId: manager!.id, staffId: staff!.id,
    manager: actor(orgId, manager!.id), staff: actor(orgId, staff!.id),
    drawerId: drawer!.id, categoryId: category[0]!.id,
  };
}

async function fund(orgId: string, storeId: string, code: string, amount: string, moneyAccountId: string | null) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft')
      returning id
    `;
    const codes = await tx<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${orgId} and code in (${code}, '3900')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0',
              ${moneyAccountId ? 'money_account' : null}, ${moneyAccountId})
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

interface FixtureWithSupplier extends Fixture {
  supplierId: string;
}


/**
 * ⭐ A real `stored_files` row. Evidence is a FILE now (migration 0046) — `receipt_photo_url` is
 * gone, and `verifyInvoice` proves the row exists via `filesRepo.getById`. A fixture that faked
 * it with a string would be testing the hole this task closed.
 */
async function receiptFile(orgId: string, storeId: string, uploadedBy: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/stores/${storeId}/receipt_photo/${uid('f')}.jpg`},
            'image/jpeg', 1024, ${uid('sum')}, ${uploadedBy})
    returning id
  `;
  return row!.id;
}

/** Records + verifies one invoice, returns its id. Evidence attached so verify never blocks
 *  on the photo gate unless a test explicitly wants that. */
async function verifiedInvoice(f: FixtureWithSupplier, totalAmount: string, over: Record<string, unknown> = {}): Promise<string> {
  const fileId = await receiptFile(f.orgId, f.storeId, f.staffId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId: f.storeId,
      supplierId: f.supplierId,
      invoiceDate: '2026-01-10',
      totalAmount,
      receiptFileId: fileId,
      ...over,
    }),
  );
  // ⛔ staff logs it, MANAGER verifies it — two people, enforced by the DB (migration 0046).
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  return created.id;
}

async function fixtureWithSupplier(hint: string): Promise<FixtureWithSupplier> {
  const f = await fixture(hint);
  // T-361: credit needs terms now the domain enforces it (DEF-492).
  const supplier = await asOrg(f.orgId, (tx) =>
    createSupplier(tx, f.manager, { name: `${hint} Supplier`, creditTermsDays: 30 }),
  );
  return { ...f, supplierId: supplier.id };
}

async function creditExpense(f: FixtureWithSupplier, invoiceId: string, amount: string, particulars = 'Stock purchase') {
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

// =========================================================================================
// T-196 — a draft expense may sit against a PENDING supplier invoice; verification posts it.
// docs/tasks/196-draft-expense-on-a-pending-invoice.md.
// =========================================================================================

/** Records an invoice and leaves it PENDING — never verifies it. */
async function pendingInvoice(f: FixtureWithSupplier, totalAmount: string): Promise<string> {
  const fileId = await receiptFile(f.orgId, f.storeId, f.staffId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId: f.storeId,
      supplierId: f.supplierId,
      invoiceDate: '2026-01-10',
      totalAmount,
      receiptFileId: fileId,
    }),
  );
  return created.id;
}

/** ⭐ T-196 — `createExpense` directly, by the STAFF actor (create_expense alone is sufficient),
 *  never `recordExpenseForInvoice` — this is the draft path, the whole point of the task. */
async function draftExpense(
  f: FixtureWithSupplier,
  invoiceId: string,
  amount: string,
  categoryId: string,
  particulars = 'Draft against a pending invoice',
) {
  return asOrg(f.orgId, (tx) =>
    createExpense(tx, f.staff, {
      storeId: f.storeId,
      businessDate: '', // ignored — createExpense forces this from the invoice's own date
      supplierId: f.supplierId,
      supplierInvoiceId: invoiceId,
      categoryId,
      particulars,
      payments: [{ method: 'cash', amount, moneyAccountId: f.drawerId }],
    }),
  );
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('the open-item allocation this task exists for', () => {
  it('books a credit expense, pays it in full, and the open item closes', async () => {
    const f = await fixtureWithSupplier('full');
    const invoiceId = await verifiedInvoice(f, '10000.00');
    await creditExpense(f, invoiceId, '10000.00');

    let open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open).toHaveLength(1);
    expect(open[0]!.outstanding).toBe('10000.00');
    expect((await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId))).controlBalance).toBe('10000.00');

    const paid = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
        amount: '10000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId: open[0]!.expenseId, amountApplied: '10000.00' }],
      }),
    );
    expect(paid.allocated).toBe('10000.00');
    expect(paid.unallocated).toBe('0.00');

    open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open).toHaveLength(0);
    expect((await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId))).controlBalance).toBe('0.00');
  });

  it('⭐ a partial payment leaves the item open for the remainder, then a second payment closes it', async () => {
    const f = await fixtureWithSupplier('partial');
    const invoiceId = await verifiedInvoice(f, '6000.00');
    const { expenseId } = await creditExpense(f, invoiceId, '6000.00');

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
        amount: '4000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '4000.00' }],
      }),
    );
    let open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open[0]!.outstanding).toBe('2000.00');

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-20',
        amount: '2000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '2000.00' }],
      }),
    );
    open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open).toHaveLength(0);
  });

  it('⭐ overpayment routes the rest to 1240 — never floats to nowhere', async () => {
    const f = await fixtureWithSupplier('over');
    const invoiceId = await verifiedInvoice(f, '8000.00');
    const { expenseId } = await creditExpense(f, invoiceId, '8000.00');

    const result = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
        amount: '8500.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '8000.00' }],
      }),
    );
    expect(result.allocated).toBe('8000.00');
    expect(result.unallocated).toBe('500.00');

    const lines = await sql<{ code: string; debit: string; credit: string; party_id: string | null }[]>`
      select a.code, jl.debit, jl.credit, jl.party_id
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${result.entryId} order by a.code
    `;
    const advances = lines.find((l) => l.code === '1240');
    expect(advances?.debit).toBe('500.00');
    expect(advances?.party_id).toBe(f.supplierId);
  });

  it('⭐ one payment allocates across TWO open invoices from the same supplier', async () => {
    const f = await fixtureWithSupplier('multi');
    const invA = await verifiedInvoice(f, '3000.00');
    const invB = await verifiedInvoice(f, '5000.00');
    const a = await creditExpense(f, invA, '3000.00', 'Invoice A goods');
    const b = await creditExpense(f, invB, '5000.00', 'Invoice B goods');

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-20',
        amount: '6000.00', moneyAccountId: f.drawerId,
        allocations: [
          { expenseId: a.expenseId, amountApplied: '3000.00' },
          { expenseId: b.expenseId, amountApplied: '3000.00' },
        ],
      }),
    );

    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open).toHaveLength(1);
    expect(open[0]!.outstanding).toBe('2000.00');
    // ⭐ Invariant 6, re-proven for the first control account with >1 open item per party.
    const position = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId));
    expect(position.controlBalance).toBe('2000.00');
  });
});

describe('the refusals', () => {
  it('⛔ an allocation naming an expense from a DIFFERENT supplier is refused, nothing posts', async () => {
    const f = await fixtureWithSupplier('wrongsup');
    // T-361: credit needs terms now the domain enforces it (DEF-492).
    const other = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.manager, { name: 'Someone Else', creditTermsDays: 30 }),
    );
    const invOther = await verifiedInvoice({ ...f, supplierId: other.id }, '1000.00');
    const { expenseId } = await creditExpense({ ...f, supplierId: other.id }, invOther, '1000.00');

    const before = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId));
    await expect(
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
          amount: '1000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '1000.00' }],
        }),
      ),
    ).rejects.toThrow(/not an open item for this supplier/);
    const after = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId));
    expect(after.controlBalance).toBe(before.controlBalance);
  });

  it('⛔ allocations summing to more than the payment amount are refused before any write', async () => {
    const f = await fixtureWithSupplier('overalloc');
    const invoiceId = await verifiedInvoice(f, '5000.00');
    const { expenseId } = await creditExpense(f, invoiceId, '5000.00');

    await expect(
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
          amount: '1000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '5000.00' }],
        }),
      ),
    ).rejects.toThrow(/more than the/);
  });

  it('⛔ createExpense rejects an amount that exceeds the invoice\'s remaining capacity', async () => {
    const f = await fixtureWithSupplier('capacity');
    const invoiceId = await verifiedInvoice(f, '1000.00');
    await expect(creditExpense(f, invoiceId, '1000.01')).rejects.toThrow(/does not fit/);
  });

  it('⛔ createExpense rejects a PENDING (unverified) invoice — the universal gate, cash included', async () => {
    const f = await fixtureWithSupplier('pending');
    const pendingFile = await receiptFile(f.orgId, f.storeId, f.staffId);
    const pending = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '500.00', receiptFileId: pendingFile,
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        recordExpenseForInvoice(tx, f.manager, {
          storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: pending.id,
          categoryId: f.categoryId, particulars: 'Cash buy, no draft',
          payments: [{ method: 'cash', amount: '500.00', moneyAccountId: f.drawerId }],
        }),
      ),
    ).rejects.toThrow(/is pending/);
  });

  it('⛔ verifyInvoice rejects when there is no evidence at all — T-141\'s rule ported, DEF-055', async () => {
    const f = await fixtureWithSupplier('noevidence');
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: '500.00',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true })),
    ).rejects.toThrow(/has no receipt photo/);
  });

  /**
   * ⭐ This test used to assert that VERIFY refused a hand-typed `receiptFileId`. It now cannot
   * get that far: migration 0046 gave the column a real FK, so a uuid naming no file is refused
   * at INSERT. The rejection moved one step earlier, which is strictly better — the invoice never
   * exists carrying fake evidence. `verifyInvoice`'s `filesRepo.getById` check stays as the
   * backstop for a file deleted between logging and verifying.
   */
  it('⛔ a hand-typed receiptFileId naming no real file is refused when the invoice is logged', async () => {
    const f = await fixtureWithSupplier('forgedfile');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordInvoice(tx, f.staff, {
          storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: '500.00',
          receiptFileId: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('⭐ the gate is universal — cash expenses need a verified invoice too, and never appear in AP', () => {
  it('a cash-funded expense against a verified invoice posts immediately and never shows in openItems', async () => {
    const f = await fixtureWithSupplier('cash');
    const invoiceId = await verifiedInvoice(f, '750.00');

    const result = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: invoiceId,
        categoryId: f.categoryId, particulars: 'Cash buy, no draft',
        payments: [{ method: 'cash', amount: '750.00', moneyAccountId: f.drawerId }],
      }),
    );
    expect(result.created).toBe(true);

    const [row] = await sql<{ status: string }[]>`select status from expenses where id = ${result.expenseId}`;
    expect(row!.status).toBe('posted');
    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open).toHaveLength(0);
    expect((await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId))).controlBalance).toBe('0.00');
  });
});

describe('⭐ receipt-date authority — the invoice date wins, always', () => {
  it('the expense business_date equals the invoice invoice_date regardless of anything else', async () => {
    const f = await fixtureWithSupplier('date');
    const invoiceId = await verifiedInvoice(f, '400.00');
    const { expenseId } = await creditExpense(f, invoiceId, '400.00');
    const [row] = await sql<{ business_date: string }[]>`select business_date::text from expenses where id = ${expenseId}`;
    expect(row!.business_date).toBe('2026-01-10');
  });
});

describe('⛔ voiding an invoice cascades through voidExpense — never a reimplemented reversal', () => {
  it('voids every live linked expense and reverses their journal effects', async () => {
    const f = await fixtureWithSupplier('voidcascade');
    const invoiceId = await verifiedInvoice(f, '2000.00');
    const { expenseId } = await creditExpense(f, invoiceId, '2000.00');

    expect((await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId))).controlBalance).toBe('2000.00');

    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Wrong invoice entirely' }));

    const [expenseRow] = await sql<{ status: string }[]>`select status from expenses where id = ${expenseId}`;
    expect(expenseRow!.status).toBe('voided');
    const [invoiceRow] = await sql<{ status: string }[]>`select status from supplier_invoices where id = ${invoiceId}`;
    expect(invoiceRow!.status).toBe('voided');
    // Reversed, not deleted — the position returns to zero because BOTH legs stand.
    expect((await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId))).controlBalance).toBe('0.00');
  });
});

describe('void a posted AP payment — reversal, not deletion; the item reopens', () => {
  it('reverses the payment entry and the open item reappears', async () => {
    const f = await fixtureWithSupplier('voidpay');
    const invoiceId = await verifiedInvoice(f, '3000.00');
    const { expenseId } = await creditExpense(f, invoiceId, '3000.00');

    const paid = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
        amount: '3000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '3000.00' }],
      }),
    );
    expect((await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId)))).toHaveLength(0);

    await asOrg(f.orgId, (tx) => voidPayment(tx, f.manager, { paymentId: paid.paymentId, reason: 'Bounced check' }));

    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open).toHaveLength(1);
    expect(open[0]!.outstanding).toBe('3000.00');
  });
});

describe('bible §16.10 — duplicate-invoice detection warns, never blocks', () => {
  it('a second invoice with the same supplier + invoice number returns a warning, and still saves', async () => {
    const f = await fixtureWithSupplier('dup');
    await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceNo: 'INV-001',
        invoiceDate: '2026-01-05', totalAmount: '1000.00',
      }),
    );
    const second = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceNo: 'INV-001',
        invoiceDate: '2026-01-06', totalAmount: '1000.00',
      }),
    );
    expect(second.duplicateWarning).toMatch(/duplicate/i);
  });
});

describe('aging — buckets by due date, falling back to invoice date when there is none', () => {
  it('places a 45-day-old item in the 31-60 bucket', async () => {
    const f = await fixtureWithSupplier('aging');
    const agingFile = await receiptFile(f.orgId, f.storeId, f.staffId);
    const invoiceId = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-01',
        dueDate: '2026-01-01', totalAmount: '900.00', receiptFileId: agingFile,
      }),
    ).then((r) => r.id);
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, invoiceId, { supplier: true, invoice: true, items: true, price: true }));
    await creditExpense(f, invoiceId, '900.00');

    const buckets = await asOrg(f.orgId, (tx) => apRepo.aging(tx, f.orgId, '2026-02-15'));
    const row = buckets.find((b) => b.supplierId === f.supplierId);
    expect(row?.d31to60).toBe('900.00');
    expect(row?.current).toBe('0.00');
  });
});

describe('T-126 — loans.lenderId, the FK T-130 promised', () => {
  it('a loan can name a suppliers row as its lender; the party on the line stays party_type=loan', async () => {
    const f = await fixtureWithSupplier('loanfk');
    const [loan] = await sql<{ id: string }[]>`
      insert into loans (org_id, store_id, lender_name, lender_id, name, principal_amount, interest_rate,
        rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
      values (${f.orgId}, ${f.storeId}, ${'Test Lender'}, ${f.supplierId}, 'Test loan', '10000.00', '0.02',
        'month', 'straight', 'monthly', 12, '2026-01-01', ${f.staffId})
      returning id
    `;
    const [row] = await sql<{ lender_id: string }[]>`select lender_id from loans where id = ${loan!.id}`;
    expect(row!.lender_id).toBe(f.supplierId);
  });
});

// =========================================================================================
// Store scoping — Ian, 2026-08-28: "make it store scoped not org but store"
// =========================================================================================

/** Adds a second store to an existing fixture, scoped to the same manager and funded. */
async function secondStore(f: FixtureWithSupplier, hint: string) {
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${f.orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;
  await sql`insert into person_store_scope (person_id, store_id) values (${f.managerId}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${f.staffId}, ${storeId})`;
  // T-341 / DEF-414 (orchestrator CHANGES, 2026-09-25): person_store_scope alone no longer
  // authorises a store-scoped, position-sourced capability here — f.staff needs a real
  // employment/position at THIS store too, or creditExpenseAt's recordInvoice call correctly
  // refuses (staff's record_supplier_invoice grant is scoped to f.storeId's own default only).
  // Not the DEF-414 leak this fixture used to rely on — a genuine second-store hire; this describe
  // block tests AP scoping, not staff authorisation.
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${f.orgId}, ${storeId}, ${f.staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId: f.orgId, storeId, employmentId: employment!.id, personId: f.staffId, setBy: f.managerId,
  });
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  await fund(f.orgId, storeId, '1110', '500000.00', null);
  return { storeId, drawerId: drawer!.id };
}

/** One verified invoice + one posted credit expense, at an arbitrary store. */
async function creditExpenseAt(f: FixtureWithSupplier, storeId: string, amount: string, particulars: string) {
  const fileId = await receiptFile(f.orgId, storeId, f.staffId);
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId,
      supplierId: f.supplierId,
      invoiceDate: '2026-01-10',
      totalAmount: amount,
      receiptFileId: fileId,
    }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id, { supplier: true, invoice: true, items: true, price: true }));
  const exp = await asOrg(f.orgId, (tx) =>
    recordExpenseForInvoice(tx, f.manager, {
      storeId,
      supplierId: f.supplierId,
      supplierInvoiceId: created.id,
      categoryId: f.categoryId,
      particulars,
      payments: [{ method: 'credit', amount }],
    }),
  );
  return { invoiceId: created.id, expenseId: exp.expenseId };
}

describe('⭐ AP is scoped to a STORE, never the whole org', () => {
  it('openItems returns only the named store’s items, not every store’s', async () => {
    const f = await fixtureWithSupplier('scope-open');
    const b = await secondStore(f, 'scope-open-b');

    const atA = await creditExpenseAt(f, f.storeId, '1000.00', 'Store A purchase');
    const atB = await creditExpenseAt(f, b.storeId, '2000.00', 'Store B purchase');

    const itemsA = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    const itemsB = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, b.storeId));

    expect(itemsA.map((i) => i.expenseId)).toEqual([atA.expenseId]);
    expect(itemsB.map((i) => i.expenseId)).toEqual([atB.expenseId]);
  });

  it('⛔ a payment at store A cannot settle an open item booked at store B', async () => {
    const f = await fixtureWithSupplier('scope-pay');
    const b = await secondStore(f, 'scope-pay-b');

    await creditExpenseAt(f, f.storeId, '1000.00', 'Store A purchase');
    const atB = await creditExpenseAt(f, b.storeId, '2000.00', 'Store B purchase');

    // Paying from store A's drawer while naming store B's expense: the 2110 debit would land on
    // A and clear a liability that was never A's, so A's books go negative and B's never clear.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId,
          supplierId: f.supplierId,
          businessDate: '2026-01-20',
          amount: '2000.00',
          moneyAccountId: f.drawerId,
          allocations: [{ expenseId: atB.expenseId, amountApplied: '2000.00' }],
        }),
      ),
    ).rejects.toThrow(/not an open item|another store|different store/i);
  });

  it('each store’s 2110 balance stands alone, and the two sum to the supplier total', async () => {
    const f = await fixtureWithSupplier('scope-pos');
    const b = await secondStore(f, 'scope-pos-b');

    await creditExpenseAt(f, f.storeId, '1000.00', 'Store A purchase');
    await creditExpenseAt(f, b.storeId, '2000.00', 'Store B purchase');

    const posA = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId, f.storeId));
    const posB = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId, b.storeId));
    const posOrg = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId));

    expect(posA.controlBalance).toBe('1000.00');
    expect(posB.controlBalance).toBe('2000.00');
    expect(posOrg.controlBalance).toBe('3000.00');
  });
});

describe('⭐ AP integrity gaps found by the 2026-08-28 audit', () => {
  it('⛔ an expense cannot name a supplier its invoice does not belong to', async () => {
    const f = await fixtureWithSupplier('mismatch');
    const other = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `Other ${uid('s')}` }));
    const invoiceId = await verifiedInvoice(f, '5000.00'); // belongs to f.supplierId

    await expect(
      asOrg(f.orgId, (tx) =>
        recordExpenseForInvoice(tx, f.manager, {
          storeId: f.storeId,
          supplierId: other.id, // ⛔ a DIFFERENT supplier
          supplierInvoiceId: invoiceId,
          categoryId: f.categoryId,
          particulars: 'Wrong supplier for this invoice',
          payments: [{ method: 'credit', amount: '5000.00' }],
        }),
      ),
    ).rejects.toThrow(/supplier/i);
  });

  /**
   * ⚠️ **This test passed BEFORE the fix, for the wrong reason** — worth recording, because a
   * green test that proves nothing is how the RLS defect survived three tasks.
   *
   * Both payments really do run concurrently (verified: two transactions on this pool overlap).
   * But without a lock the winner simply committed before the loser got as far as reading
   * `openItems`, so the loser saw a closed item and failed with the right message by luck. Under
   * different scheduling — both reading before either commits — both would have posted, and the
   * supplier would have been paid twice.
   *
   * `lockExpensesForAllocation` is what makes the outcome deterministic rather than lucky: the
   * second transaction blocks on the expense row until the first commits, and only then reads
   * balances. Exactly one payment can win, whichever order they arrive in.
   */
  it('⛔ two concurrent payments cannot both allocate the same open item', async () => {
    const f = await fixtureWithSupplier('race');
    const invoiceId = await verifiedInvoice(f, '1000.00');
    const exp = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId,
        supplierId: f.supplierId,
        supplierInvoiceId: invoiceId,
        categoryId: f.categoryId,
        particulars: 'Contended item',
        payments: [{ method: 'credit', amount: '1000.00' }],
      }),
    );

    const pay = () =>
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId,
          supplierId: f.supplierId,
          businessDate: '2026-01-20',
          amount: '1000.00',
          moneyAccountId: f.drawerId,
          allocations: [{ expenseId: exp.expenseId, amountApplied: '1000.00' }],
        }),
      );

    const results = await Promise.allSettled([pay(), pay()]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok, 'both payments settled the same ₱1,000 — the supplier was paid twice').toBe(1);

    // And the ledger agrees: the item is closed exactly once.
    const pos = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId));
    expect(pos.controlBalance).toBe('0.00');
  });
});

// =========================================================================================
// The gate, hardened — Ian, 2026-08-28: "for receipt nothing would accept that x"
// =========================================================================================

describe('⛔ evidence is a FILE, and nothing else counts', () => {
  it('an invoice with no evidence at all cannot be verified', async () => {
    const f = await fixtureWithSupplier('no-evidence');
    const bare = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId,
        invoiceDate: '2026-01-10', totalAmount: '400.00',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        verifyInvoice(tx, f.manager, bare.id, { supplier: true, invoice: true, items: true, price: true }),
      ),
    ).rejects.toThrow(/no receipt photo/i);
  });

  it('⭐ a well-formed uuid that names nothing never becomes an invoice at all', async () => {
    const f = await fixtureWithSupplier('forged');
    // This is the `x` of the file era: the right SHAPE, pointing at nothing. The FK added in
    // migration 0046 is what makes shape insufficient.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordInvoice(tx, f.staff, {
          storeId: f.storeId, supplierId: f.supplierId,
          invoiceDate: '2026-01-10', totalAmount: '400.00',
          receiptFileId: '01a04000-0000-7000-8000-000000000000',
        }),
      ),
    ).rejects.toThrow();
  });

  it('⛔ a receipt belonging to ANOTHER store is not evidence for this invoice', async () => {
    const f = await fixtureWithSupplier('wrong-store');
    const b = await secondStore(f, 'wrong-store-b');
    const elsewhere = await receiptFile(f.orgId, b.storeId, f.staffId); // uploaded at store B
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId,
        invoiceDate: '2026-01-10', totalAmount: '400.00', receiptFileId: elsewhere,
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        verifyInvoice(tx, f.manager, inv.id, { supplier: true, invoice: true, items: true, price: true }),
      ),
    ).rejects.toThrow(/another store/i);
  });
});

describe('⛔ verification means all four confirmations, by a second person', () => {
  it('a half-ticked attestation is refused, naming what is still unconfirmed', async () => {
    const f = await fixtureWithSupplier('half-attest');
    const fileId = await receiptFile(f.orgId, f.storeId, f.staffId);
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId,
        invoiceDate: '2026-01-10', totalAmount: '400.00', receiptFileId: fileId,
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        verifyInvoice(tx, f.manager, inv.id, { supplier: true, invoice: true, items: false, price: false }),
      ),
    ).rejects.toThrow(/items, price/);
  });

  it('⭐ the person who logged the invoice cannot verify it — v1 allowed this 44% of the time', async () => {
    const f = await fixtureWithSupplier('sod');
    const fileId = await receiptFile(f.orgId, f.storeId, f.managerId);
    // The MANAGER logs it this time, then tries to verify their own entry.
    const inv = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId,
        invoiceDate: '2026-01-10', totalAmount: '400.00', receiptFileId: fileId,
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        verifyInvoice(tx, f.manager, inv.id, { supplier: true, invoice: true, items: true, price: true }),
      ),
    ).rejects.toThrow(/cannot also verify it/i);
  });
});

describe('⛔ a supplier must be ACTIVE, not merely on file', () => {
  it('an inactive supplier cannot be billed against, and cannot back a new expense', async () => {
    const f = await fixtureWithSupplier('inactive');
    const invoiceId = await verifiedInvoice(f, '1000.00'); // logged while still active
    await sql`update suppliers set status = 'inactive' where id = ${f.supplierId}`;

    await expect(
      asOrg(f.orgId, (tx) =>
        recordInvoice(tx, f.staff, {
          storeId: f.storeId, supplierId: f.supplierId,
          invoiceDate: '2026-01-11', totalAmount: '100.00',
        }),
      ),
    ).rejects.toThrow(/not active/i);

    // And the spend itself is refused, even against an invoice verified while they were active —
    // recording the expense is the step that moves money.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordExpenseForInvoice(tx, f.manager, {
          storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: invoiceId,
          categoryId: f.categoryId, particulars: 'Buying from a supplier we stopped using',
          payments: [{ method: 'credit', amount: '1000.00' }],
        }),
      ),
    ).rejects.toThrow(/not active/i);
  });
});

// =========================================================================================
// T-196 — drafts against a PENDING invoice: capacity, verification cascade, void cascade.
// docs/tasks/196-draft-expense-on-a-pending-invoice.md. The gate before this task was
// "no expense may EXIST until its invoice is verified" (T-130, tested above); after it, the
// gate is "no expense may POST until its invoice is verified" — every test above that records a
// CREDIT expense through `recordExpenseForInvoice` against an already-verified invoice is
// unaffected (Test 10 of the spec's own list: "recordExpenseForInvoice against a verified
// invoice → still posts in one call, unchanged" — proven repeatedly above, not re-proven here).
// =========================================================================================

describe('T-196 — capacity: drafts count against a PENDING invoice exactly like postings do', () => {
  it('⛔ two drafts that together exceed the invoice total — the second does not fit, at the trigger', async () => {
    const f = await fixtureWithSupplier('t196-capacity');
    const invoiceId = await pendingInvoice(f, '1000.00');
    await draftExpense(f, invoiceId, '700.00', f.categoryId, 'First draft, fits');

    await expect(
      draftExpense(f, invoiceId, '400.00', f.categoryId, 'Second draft, does not fit'),
    ).rejects.toThrow(/does not fit/);
  });

  it('⛔ a draft may not be created against a VOIDED invoice', async () => {
    const f = await fixtureWithSupplier('t196-voided-invoice');
    const invoiceId = await pendingInvoice(f, '500.00');
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Never mind, cancelled' }));

    await expect(
      draftExpense(f, invoiceId, '500.00', f.categoryId, 'Too late, invoice is voided'),
    ).rejects.toThrow(/voided/);
  });
});

describe('T-196 — verifyInvoice posts every draft standing against the invoice, in one transaction', () => {
  it('manager verifies → every draft posts, journal_entry_id set on each, each entry balances', async () => {
    const f = await fixtureWithSupplier('t196-verify-all');
    const invoiceId = await pendingInvoice(f, '3000.00');
    const a = await draftExpense(f, invoiceId, '1000.00', f.categoryId, 'First draft');
    const b = await draftExpense(f, invoiceId, '2000.00', f.categoryId, 'Second draft');

    await asOrg(f.orgId, (tx) =>
      verifyInvoice(tx, f.manager, invoiceId, { supplier: true, invoice: true, items: true, price: true }),
    );

    for (const exp of [a, b]) {
      const [row] = await sql<{ status: string; journal_entry_id: string | null }[]>`
        select status, journal_entry_id from expenses where id = ${exp.id}
      `;
      expect(row!.status).toBe('posted');
      expect(row!.journal_entry_id).not.toBeNull();
      const lines = await sql<{ debit: string; credit: string }[]>`
        select debit, credit from journal_lines where entry_id = ${row!.journal_entry_id}
      `;
      const debits = lines.reduce((t, l) => t + Number(l.debit), 0);
      const credits = lines.reduce((t, l) => t + Number(l.credit), 0);
      expect(debits).toBeCloseTo(credits, 2);
      expect(debits).toBeGreaterThan(0);
    }

    const [invoiceRow] = await sql<{ status: string }[]>`select status from supplier_invoices where id = ${invoiceId}`;
    expect(invoiceRow!.status).toBe('verified');
  });

  it('⛔ all-or-nothing: one unmapped-category draft rolls back the WHOLE verification, naming the offending expense', async () => {
    const f = await fixtureWithSupplier('t196-rollback');
    const invoiceId = await pendingInvoice(f, '2000.00');
    const [badCat] = await sql<{ id: string }[]>`
      insert into expense_categories (org_id, "group", category, account_code)
      values (${f.orgId}, 'OPEX', 'T-196 Mystery Spend', null)
      returning id
    `;
    const good = await draftExpense(f, invoiceId, '500.00', f.categoryId, 'Fine draft');
    const bad = await draftExpense(f, invoiceId, '500.00', badCat!.id, 'Unmapped category draft');

    await expect(
      asOrg(f.orgId, (tx) =>
        verifyInvoice(tx, f.manager, invoiceId, { supplier: true, invoice: true, items: true, price: true }),
      ),
    ).rejects.toThrow(new RegExp(bad.id));

    // ⚠️ Invariant 7/8 — the invoice stays PENDING (never verified-with-stuck-drafts) and BOTH
    // drafts stay drafts, including the one that would have posted fine on its own. Verify-and-skip
    // would have left the good one posted and the invoice pending with one stuck draft — a new
    // orphan class this task exists to prevent.
    const [invoiceRow] = await sql<{ status: string }[]>`select status from supplier_invoices where id = ${invoiceId}`;
    expect(invoiceRow!.status).toBe('pending');
    const [goodRow] = await sql<{ status: string }[]>`select status from expenses where id = ${good.id}`;
    expect(goodRow!.status).toBe('draft');
    const [badRow] = await sql<{ status: string }[]>`select status from expenses where id = ${bad.id}`;
    expect(badRow!.status).toBe('draft');
  });
});

describe('T-196 — voidInvoice branches on the child\'s status (a defect this task creates)', () => {
  it('void a PENDING invoice carrying two drafts → both rows gone, invoice voided', async () => {
    const f = await fixtureWithSupplier('t196-void-pending');
    const invoiceId = await pendingInvoice(f, '2000.00');
    const a = await draftExpense(f, invoiceId, '800.00', f.categoryId, 'Draft one');
    const b = await draftExpense(f, invoiceId, '800.00', f.categoryId, 'Draft two');

    // ⚠️ Before T-196 this cascade would have THROWN — voidExpense refuses a draft ("nothing has
    // been posted yet to void; edit or discard it instead"), and until this task a pending
    // invoice could never carry a draft in the first place.
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Wrong invoice, never verified' }));

    const rows = await sql<{ c: number }[]>`select count(*)::int c from expenses where id in (${a.id}, ${b.id})`;
    expect(rows[0]!.c).toBe(0);
    const [invoiceRow] = await sql<{ status: string }[]>`select status from supplier_invoices where id = ${invoiceId}`;
    expect(invoiceRow!.status).toBe('voided');
  });

  it('void a VERIFIED invoice carrying one draft and one posted expense → draft deleted, posted reversed, both entries readable', async () => {
    const f = await fixtureWithSupplier('t196-void-mixed');
    const invoiceId = await verifiedInvoice(f, '3000.00');
    const posted = await creditExpense(f, invoiceId, '1000.00', 'Posted before the new draft');
    // ⭐ A NEW draft against an ALREADY-verified invoice is legitimate — createExpense never
    // requires 'verified', only not-voided. Nothing auto-posts it: verifyInvoice already ran.
    const draft = await draftExpense(f, invoiceId, '500.00', f.categoryId, 'Drafted after verification');

    const [draftBefore] = await sql<{ status: string }[]>`select status from expenses where id = ${draft.id}`;
    expect(draftBefore!.status).toBe('draft');

    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Supplier cancelled the order' }));

    const [draftGone] = await sql<{ c: number }[]>`select count(*)::int c from expenses where id = ${draft.id}`;
    expect(draftGone!.c).toBe(0);

    const [postedRow] = await sql<{ status: string; journal_entry_id: string }[]>`
      select status, journal_entry_id from expenses where id = ${posted.expenseId}
    `;
    expect(postedRow!.status).toBe('voided');

    // Reversed, not deleted — the original stays visible AND the reversal exists, both readable.
    const [reversal] = await sql<{ id: string }[]>`
      select id from journal_entries where reversal_of_entry_id = ${postedRow!.journal_entry_id}
    `;
    expect(reversal).toBeTruthy();
    const [original] = await sql<{ status: string }[]>`
      select status from journal_entries where id = ${postedRow!.journal_entry_id}
    `;
    expect(original!.status).toBe('reversed');
  });
});

describe('DEF-272 — a sub-centavo amount is refused with a written sentence, not driver text', () => {
  it('recordPayment refuses "0.004" for the payment amount itself — reached before the allocations check', async () => {
    const f = await fixtureWithSupplier('def272-pay');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId, supplierId: f.supplierId,
          businessDate: '2026-01-15', amount: '0.004', moneyAccountId: f.drawerId, allocations: [],
        }),
      ),
    ).rejects.toThrow(/recordPayment: the amount.*"0\.004"/);
  });

  it('recordPayment refuses "0.004" for an ALLOCATION amount too — the per-line sibling of the same defect', async () => {
    const f = await fixtureWithSupplier('def272-alloc');
    const invoiceId = await verifiedInvoice(f, '3000.00');
    const expenseId = (await creditExpense(f, invoiceId, '3000.00')).expenseId;
    await expect(
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
          amount: '1000.00', moneyAccountId: f.drawerId,
          allocations: [{ expenseId, amountApplied: '0.004' }],
        }),
      ),
    ).rejects.toThrow(/recordPayment: the allocation for expense.*"0\.004"/);
  });
});

// ---------------------------------------------------------------------------------------
// T-343 S5.2 — P2, P3. `docs/tasks/343-def-417-human-readable-refusals.md` §S5.2.
// `packages/db/src/repo/ap.ts`'s `assertOpenForRecording` (:431,437,443) threw a raw `Error` with no
// `userMessage` before this slice; S5.2 converts it to `refuse(raw, sentence)` naming the invoice
// (rule 2: `invoice ${invoiceNo} from ${supplierName}`, or the no-number fallback `the ${humanDate}
// invoice from ${supplierName}` when `invoice_no` is null) and the supplier. `createExpense` never
// catches this throw — it propagates as-is, so the REAL domain call surfaces exactly what
// `capacityOf`'s caller sees.
//
// ⛔ Was red before the builder: neither leg's `userMessage` existed (P1/P2's own "expected red:
// undefined").
// ---------------------------------------------------------------------------------------

describe('T-343 S5.2 — P2: a voided invoice’s refusal names the invoice and supplier, no UUID', () => {
  it('with an invoice_no: "Invoice <no> from <supplier> has been voided…"', async () => {
    const f = await fixtureWithSupplier('s5-2-p2-numbered');
    const fileId = await receiptFile(f.orgId, f.storeId, f.staffId);
    const invoiceNo = 'INV-5551';
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId,
        supplierId: f.supplierId,
        invoiceDate: '2026-01-10',
        totalAmount: '500.00',
        receiptFileId: fileId,
        invoiceNo,
      }),
    );
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId: created.id, reason: 'Wrong invoice' }));

    const caught = await draftExpense(f, created.id, '500.00', f.categoryId, 'Too late').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the draft was not refused at all').not.toBeNull();
    expect(caught!.message).toMatch(/voided/);
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toContain(invoiceNo);
    expect(userMessage).toContain('s5-2-p2-numbered Supplier');
    expect(userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('with NO invoice_no: "The <humanDate> invoice from <supplier> has been voided…", never "invoice null"', async () => {
    const f = await fixtureWithSupplier('s5-2-p2-unnumbered');
    const invoiceId = await pendingInvoice(f, '500.00');
    await asOrg(f.orgId, (tx) => voidInvoice(tx, f.manager, { invoiceId, reason: 'Wrong invoice' }));

    const caught = await draftExpense(f, invoiceId, '500.00', f.categoryId, 'Too late').then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the draft was not refused at all').not.toBeNull();
    expect(caught!.message).toMatch(/voided/);
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).not.toContain('invoice null');
    expect(userMessage).toContain(humanDate(parseBusinessDate('2026-01-10')));
    expect(userMessage).toContain('s5-2-p2-unnumbered Supplier');
  });
});

describe('T-343 S5.2 — P3: recordPayment over-allocating one expense names it by its human key', () => {
  it('"particulars" (date) has only ₱X still owed…', async () => {
    const f = await fixtureWithSupplier('s5-2-p3');
    const invoiceId = await verifiedInvoice(f, '1000.00');
    const particulars = 'Sacks of rice';
    const { expenseId } = await creditExpense(f, invoiceId, '1000.00', particulars);

    const caught = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId,
        supplierId: f.supplierId,
        businessDate: '2026-01-15',
        amount: '1000.00',
        moneyAccountId: f.drawerId,
        allocations: [{ expenseId, amountApplied: '1000.01' }],
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the over-allocation was not refused at all').not.toBeNull();
    expect(caught!.message).toMatch(/does not fit/);
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).toContain(`"${particulars}"`);
    expect(userMessage).not.toContain(expenseId);
  });
});

// ---------------------------------------------------------------------------------------
// T-343 S5.2 — P6, P7 (auditor CHANGES, 2026-09-27).
// ---------------------------------------------------------------------------------------

describe('T-343 S5.2 — P6: expenseKey’s fallback names a deleted/cross-org expense as "This expense"', () => {
  it('userMessage starts with "This expense" (capital T), no UUID', async () => {
    const f = await fixtureWithSupplier('s5-2-p6');
    const missingExpenseId = crypto.randomUUID();

    const caught = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId,
        supplierId: f.supplierId,
        businessDate: '2026-01-15',
        amount: '100.00',
        moneyAccountId: f.drawerId,
        allocations: [{ expenseId: missingExpenseId, amountApplied: '100.00' }],
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the allocation was not refused at all').not.toBeNull();
    expect(caught!.message).toContain(missingExpenseId);
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage!.startsWith('This expense')).toBe(true);
    expect(userMessage).not.toContain(missingExpenseId);
  });
});

describe('T-343 S5.2 — P7: verifyInvoice’s missing-attestation sentence names only the parts actually missing', () => {
  it('"…still unconfirmed: the items and the prices." — never a bare "price"/"items" key', async () => {
    const f = await fixtureWithSupplier('s5-2-p7');
    const invoiceId = await pendingInvoice(f, '500.00');

    const caught = await asOrg(f.orgId, (tx) =>
      verifyInvoice(tx, f.manager, invoiceId, { supplier: true, invoice: true, items: false, price: false }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'verification was not refused at all').not.toBeNull();
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    // The DYNAMIC clause — only the parts actually left unattested, joined "A and B", never the raw
    // keys ("items", "price") standing alone.
    expect(userMessage).toContain('still unconfirmed: the items and the prices.');
    expect(userMessage).not.toContain('unconfirmed: items');
    expect(userMessage).not.toContain('unconfirmed: price');
  });
});

describe('T-343 S5.2fu — P8: a manager at store A allocating a REAL store-B expense gets the same generic refusal, never store B’s particulars or date', () => {
  it('userMessage says "This expense…", never the store-B particulars/date the raw diagnostic is allowed to carry', async () => {
    const f = await fixtureWithSupplier('s5-2fu-p8');
    const b = await secondStore(f, 's5-2fu-p8-b');

    const particulars = 'Store B confidential purchase';
    const atB = await creditExpenseAt(f, b.storeId, '750.00', particulars);
    const [expenseRow] = await sql<{ business_date: string }[]>`
      select business_date::text as business_date from expenses where id = ${atB.expenseId}
    `;
    const expenseDate = expenseRow!.business_date;

    const caught = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
        storeId: f.storeId, // ⛔ store A — atB.expenseId belongs to store B
        supplierId: f.supplierId,
        businessDate: '2026-03-02',
        amount: '750.00',
        moneyAccountId: f.drawerId,
        allocations: [{ expenseId: atB.expenseId, amountApplied: '750.00' }],
      }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the cross-store allocation was not refused at all').not.toBeNull();
    // The RAW diagnostic is internal-only and may name the id — never asserted here.
    expect(caught!.message).toContain(atB.expenseId);
    const userMessage = (caught as unknown as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage!.startsWith('This expense')).toBe(true);
    expect(userMessage).not.toContain(particulars);
    expect(userMessage).not.toContain(humanDate(parseBusinessDate(expenseDate)));
    expect(userMessage).not.toContain(atB.expenseId);
  });
});
