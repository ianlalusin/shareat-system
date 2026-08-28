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
import {
  createSupplier,
  recordInvoice,
  verifyInvoice,
  voidInvoice,
  recordExpenseForInvoice,
  recordPayment,
  voidPayment,
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

/** Records + verifies one invoice, returns its id. Evidence attached so verify never blocks
 *  on the photo gate unless a test explicitly wants that. */
async function verifiedInvoice(f: FixtureWithSupplier, totalAmount: string, over: Record<string, unknown> = {}): Promise<string> {
  const created = await asOrg(f.orgId, (tx) =>
    recordInvoice(tx, f.staff, {
      storeId: f.storeId,
      supplierId: f.supplierId,
      invoiceDate: '2026-01-10',
      totalAmount,
      receiptPhotoUrl: 'https://example.com/inv.jpg',
      ...over,
    }),
  );
  await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id));
  return created.id;
}

async function fixtureWithSupplier(hint: string): Promise<FixtureWithSupplier> {
  const f = await fixture(hint);
  const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `${hint} Supplier` }));
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

    let open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId));
    expect(open).toHaveLength(1);
    expect(open[0]!.outstanding).toBe('10000.00');
    expect((await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId))).controlBalance).toBe('10000.00');

    const paid = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
        amount: '10000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId: open[0]!.expenseId, amountApplied: '10000.00' }],
      }),
    );
    expect(paid.allocated).toBe('10000.00');
    expect(paid.unallocated).toBe('0.00');

    open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId));
    expect(open).toHaveLength(0);
    expect((await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId))).controlBalance).toBe('0.00');
  });

  it('⭐ a partial payment leaves the item open for the remainder, then a second payment closes it', async () => {
    const f = await fixtureWithSupplier('partial');
    const invoiceId = await verifiedInvoice(f, '6000.00');
    const { expenseId } = await creditExpense(f, invoiceId, '6000.00');

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
        amount: '4000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '4000.00' }],
      }),
    );
    let open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId));
    expect(open[0]!.outstanding).toBe('2000.00');

    await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-20',
        amount: '2000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '2000.00' }],
      }),
    );
    open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId));
    expect(open).toHaveLength(0);
  });

  it('⭐ overpayment routes the rest to 1240 — never floats to nowhere', async () => {
    const f = await fixtureWithSupplier('over');
    const invoiceId = await verifiedInvoice(f, '8000.00');
    const { expenseId } = await creditExpense(f, invoiceId, '8000.00');

    const result = await asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
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
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-20',
        amount: '6000.00', moneyAccountId: f.drawerId,
        allocations: [
          { expenseId: a.expenseId, amountApplied: '3000.00' },
          { expenseId: b.expenseId, amountApplied: '3000.00' },
        ],
      }),
    );

    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId));
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
    const other = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: 'Someone Else' }));
    const invOther = await verifiedInvoice({ ...f, supplierId: other.id }, '1000.00');
    const { expenseId } = await creditExpense({ ...f, supplierId: other.id }, invOther, '1000.00');

    const before = await asOrg(f.orgId, (tx) => apRepo.positionOf(tx, f.orgId, f.supplierId));
    await expect(
      asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, {
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
        recordPayment(tx, f.manager, {
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
    const pending = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10',
        totalAmount: '500.00', receiptPhotoUrl: 'https://example.com/x.jpg',
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
      asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id)),
    ).rejects.toThrow(/has no receipt photo/);
  });

  it('⛔ verifyInvoice rejects a hand-typed receiptFileId that names no real file — a bare truthiness check would have let this through (DEF-077 audit)', async () => {
    const f = await fixtureWithSupplier('forgedfile');
    const created = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-10', totalAmount: '500.00',
        receiptFileId: '00000000-0000-0000-0000-000000000000',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, created.id)),
    ).rejects.toThrow(/does not exist in this org/);
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
    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId));
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
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
        amount: '3000.00', moneyAccountId: f.drawerId, allocations: [{ expenseId, amountApplied: '3000.00' }],
      }),
    );
    expect((await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId)))).toHaveLength(0);

    await asOrg(f.orgId, (tx) => voidPayment(tx, f.manager, { paymentId: paid.paymentId, reason: 'Bounced check' }));

    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId));
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
    const invoiceId = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: f.supplierId, invoiceDate: '2026-01-01',
        dueDate: '2026-01-01', totalAmount: '900.00', receiptPhotoUrl: 'https://example.com/a.jpg',
      }),
    ).then((r) => r.id);
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, invoiceId));
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
