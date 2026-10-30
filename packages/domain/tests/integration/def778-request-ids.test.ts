import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * DEF-778 - `createMoneyTransfer` and AP `recordPayment` used to mint their idempotency key server-side (a fresh id per
 * call), so a double click was two genuine requests and posted two entries. They now take the form's per-render
 * `requestId` (the T-488 pattern): the entry and the row are keyed on it.
 *
 * Per function: (a) two calls, different ids -> TWO entries; (b) the same id twice -> ONE entry and the second call hands
 * back the first's id; (c) the same id with a different amount or a different date -> refused, nothing new written;
 * (d) a missing / garbage id -> refused, nothing written.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, apRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createMoneyTransfer,
  createSupplier,
  voidMoneyTransfer,
  voidPayment,
  recordExpenseForInvoice,
  recordInvoice,
  recordPayment,
  verifyInvoice,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const DIFFERENT = 'This was already recorded with different figures. Reload the page and try again.';
const STALE = 'This form is out of date. Reload the page and try again.';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** The sentence a refused caller is shown; fails if the call did not reject at all. */
async function userMessageOf(call: Promise<unknown>): Promise<string> {
  const outcome = await call.then(
    () => ({ rejected: false as const }),
    (err: unknown) => ({ rejected: true as const, err }),
  );
  if (!outcome.rejected) throw new Error('expected the call to be refused, but it succeeded');
  return (outcome.err as { userMessage?: string }).userMessage ?? `not a refusal: ${String(outcome.err)}`;
}

async function fund(orgId: string, storeId: string, code: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id
    `;
    const codes = await tx<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${orgId} and code in (${code}, '3900')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get(code)!}, ${storeId}, ${amount}, '0'),
             (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function fixture(hint: string) {
  const code = uid(`def778-${hint}`);
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
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await person('Manager', 'manager');
  const staffId = await person('Staff', 'staff');
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: employment!.id, personId: staffId, setBy: managerId });
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  await fund(orgId, storeId, '1110', '500000.00');
  await fund(orgId, storeId, '1130', '500000.00');
  const category = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and category = 'Cost of Goods Sold — General'
  `;
  return {
    orgId, storeId, managerId, staffId, manager: actor(orgId, managerId), staff: actor(orgId, staffId),
    drawerId: drawer!.id, safeId: safe!.id, categoryId: category[0]!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// `requestId` is typed via a cast on purpose: the (d) cases hand in garbage.
const rq = (v: unknown) => ({ requestId: v as string });

// ---------------------------------------------------------------------------------------------------------------------
// createMoneyTransfer
// ---------------------------------------------------------------------------------------------------------------------
describe('DEF-778 - createMoneyTransfer keys on the form requestId', () => {
  const transfer = (f: Fixture, requestId: unknown, amount = '500.00', transferDate = '2026-01-10') =>
    asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.manager, {
        fromMoneyAccountId: f.safeId, toMoneyAccountId: f.drawerId, amountOut: amount, amountIn: amount, transferDate,
        ...rq(requestId),
      }),
    );
  const counts = async (f: Fixture) => {
    const [e] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'transfer'`;
    const [t] = await sql<{ n: string }[]>`select count(*)::text as n from money_transfers where org_id = ${f.orgId}`;
    return { entries: Number(e!.n), rows: Number(t!.n) };
  };

  it('(a) two calls, same figures, different requestIds -> TWO entries and two rows', async () => {
    const f = await fixture('mt-a');
    const one = await transfer(f, randomUUID());
    const two = await transfer(f, randomUUID());
    expect(two.entryId).not.toBe(one.entryId);
    expect(await counts(f)).toEqual({ entries: 2, rows: 2 });
  });

  it('(b) the same requestId twice -> ONE entry; the second call returns the first ids', async () => {
    const f = await fixture('mt-b');
    const id = randomUUID();
    const one = await transfer(f, id);
    const two = await transfer(f, id);
    expect(two.entryId).toBe(one.entryId);
    expect(two.id).toBe(one.id);
    expect(await counts(f)).toEqual({ entries: 1, rows: 1 });
  });

  it('(b2) a replay still succeeds after the safe can no longer cover the draw (the first call spent it)', async () => {
    const f = await fixture('mt-b2');
    const id = randomUUID();
    // Everything in the safe leaves in the first call; the replay would be an overdraw if it were judged afresh.
    const one = await transfer(f, id, '500000.00');
    const two = await transfer(f, id, '500000.00');
    expect(two.entryId).toBe(one.entryId);
    expect(await counts(f)).toEqual({ entries: 1, rows: 1 });
  });

  it('(c) the same requestId with a different amount -> refused, nothing new written', async () => {
    const f = await fixture('mt-c');
    const id = randomUUID();
    await transfer(f, id, '500.00');
    expect(await userMessageOf(transfer(f, id, '600.00'))).toBe(DIFFERENT);
    expect(await counts(f)).toEqual({ entries: 1, rows: 1 });
  });

  it('(c2) the same requestId with a different date -> refused, nothing new written', async () => {
    const f = await fixture('mt-c2');
    const id = randomUUID();
    await transfer(f, id, '500.00', '2026-01-10');
    expect(await userMessageOf(transfer(f, id, '500.00', '2026-01-11'))).toBe(DIFFERENT);
    expect(await counts(f)).toEqual({ entries: 1, rows: 1 });
  });

  it('(e) two simultaneous submits, same id and figures -> both succeed with the same ids, one entry', async () => {
    for (let i = 0; i < 5; i++) {
      const f = await fixture('mt-e');
      const id = randomUUID();
      const [x, y] = await Promise.all([transfer(f, id), transfer(f, id)]);
      expect(y.entryId).toBe(x.entryId);
      expect(y.id).toBe(x.id);
      expect(await counts(f)).toEqual({ entries: 1, rows: 1 });
    }
  });

  it('(e2) two simultaneous submits, same id, different amounts -> one wins, the other gets the "different figures" refusal', async () => {
    for (let i = 0; i < 5; i++) {
      const f = await fixture('mt-e2');
      const id = randomUUID();
      const out = await Promise.allSettled([transfer(f, id, '500.00'), transfer(f, id, '600.00')]);
      expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect((lost.reason as { userMessage?: string }).userMessage).toBe(DIFFERENT);
      expect(await counts(f)).toEqual({ entries: 1, rows: 1 });
    }
  });

  it.each([[undefined], [''], ['not-a-uuid'], ['12345678-1234-1234-1234-12345678901']])(
    '(d) requestId %j -> refused, nothing written',
    async (bad) => {
      const f = await fixture('mt-d');
      expect(await userMessageOf(transfer(f, bad))).toBe(STALE);
      expect(await counts(f)).toEqual({ entries: 0, rows: 0 });
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// AP recordPayment
// ---------------------------------------------------------------------------------------------------------------------
describe('DEF-778 - AP recordPayment keys on the form requestId', () => {
  async function apFixture(hint: string) {
    const f = await fixture(hint);
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${uid('f')}.jpg`},
              'image/jpeg', 1024, ${uid('sum')}, ${f.staffId})
      returning id
    `;
    const invoice = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, {
        storeId: f.storeId, supplierId: supplier.id, invoiceDate: '2026-01-10', totalAmount: '20000.00', receiptFileId: file!.id,
      }),
    );
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, invoice.id, { supplier: true, invoice: true, items: true, price: true }));
    const { expenseId } = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: supplier.id, supplierInvoiceId: invoice.id, categoryId: f.categoryId,
        particulars: 'Stock purchase', payments: [{ method: 'credit', amount: '20000.00' }],
      }),
    );
    return { ...f, supplierId: supplier.id, expenseId };
  }
  type ApFixture = Awaited<ReturnType<typeof apFixture>>;

  const pay = (f: ApFixture, requestId: unknown, amount = '4000.00', businessDate = '2026-01-15') =>
    asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate, amount, moneyAccountId: f.drawerId,
        allocations: [{ expenseId: f.expenseId, amountApplied: amount }], ...rq(requestId),
      }),
    );
  const counts = async (f: ApFixture) => {
    const [e] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'ap_payment'`;
    const [p] = await sql<{ n: string }[]>`select count(*)::text as n from ap_payments where org_id = ${f.orgId}`;
    const [a] = await sql<{ n: string }[]>`select count(*)::text as n from ap_payment_allocations apa join ap_payments ap on ap.id = apa.ap_payment_id where ap.org_id = ${f.orgId}`;
    return { entries: Number(e!.n), payments: Number(p!.n), allocations: Number(a!.n) };
  };

  it('(a) two calls, same figures, different requestIds -> TWO entries and two payments', async () => {
    const f = await apFixture('ap-a');
    const one = await pay(f, randomUUID());
    const two = await pay(f, randomUUID());
    expect(two.entryId).not.toBe(one.entryId);
    expect(await counts(f)).toEqual({ entries: 2, payments: 2, allocations: 2 });
  });

  it('(b) the same requestId twice -> ONE entry; the second call returns the first result', async () => {
    const f = await apFixture('ap-b');
    const id = randomUUID();
    const one = await pay(f, id);
    const two = await pay(f, id);
    expect(two.entryId).toBe(one.entryId);
    expect(two.paymentId).toBe(one.paymentId);
    expect(two.allocated).toBe('4000.00');
    expect(two.unallocated).toBe('0.00');
    expect(await counts(f)).toEqual({ entries: 1, payments: 1, allocations: 1 });
    // The open item was reduced once, not twice.
    const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, f.supplierId, f.storeId));
    expect(open[0]!.outstanding).toBe('16000.00');
  });

  it('(b2) a replay of a payment that settled the item in full is not refused as "not open"', async () => {
    const f = await apFixture('ap-b2');
    const id = randomUUID();
    const one = await pay(f, id, '20000.00');
    const two = await pay(f, id, '20000.00');
    expect(two.entryId).toBe(one.entryId);
    expect(await counts(f)).toEqual({ entries: 1, payments: 1, allocations: 1 });
  });

  it('(c) the same requestId with a different amount -> refused, nothing new written', async () => {
    const f = await apFixture('ap-c');
    const id = randomUUID();
    await pay(f, id, '4000.00');
    expect(await userMessageOf(pay(f, id, '5000.00'))).toBe(DIFFERENT);
    expect(await counts(f)).toEqual({ entries: 1, payments: 1, allocations: 1 });
  });

  it('(c2) the same requestId with a different date -> refused, nothing new written', async () => {
    const f = await apFixture('ap-c2');
    const id = randomUUID();
    await pay(f, id, '4000.00', '2026-01-15');
    expect(await userMessageOf(pay(f, id, '4000.00', '2026-01-16'))).toBe(DIFFERENT);
    expect(await counts(f)).toEqual({ entries: 1, payments: 1, allocations: 1 });
  });

  it('(e) two simultaneous submits, same id and figures -> both succeed with the same ids, one payment', async () => {
    for (let i = 0; i < 5; i++) {
      const f = await apFixture('ap-e');
      const id = randomUUID();
      const [x, y] = await Promise.all([pay(f, id), pay(f, id)]);
      expect(y.paymentId).toBe(x.paymentId);
      expect(y.entryId).toBe(x.entryId);
      expect(await counts(f)).toEqual({ entries: 1, payments: 1, allocations: 1 });
    }
  });

  it('(e2) two simultaneous submits, same id, different amounts -> one wins, the other gets the "different figures" refusal', async () => {
    for (let i = 0; i < 5; i++) {
      const f = await apFixture('ap-e2');
      const id = randomUUID();
      const out = await Promise.allSettled([pay(f, id, '4000.00'), pay(f, id, '5000.00')]);
      expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect((lost.reason as { userMessage?: string }).userMessage).toBe(DIFFERENT);
      expect(await counts(f)).toEqual({ entries: 1, payments: 1, allocations: 1 });
    }
  });

  it.each([[undefined], [''], ['not-a-uuid'], ['12345678-1234-1234-1234-12345678901']])(
    '(d) requestId %j -> refused, nothing written',
    async (bad) => {
      const f = await apFixture('ap-d');
      expect(await userMessageOf(pay(f, bad))).toBe(STALE);
      expect(await counts(f)).toEqual({ entries: 0, payments: 0, allocations: 0 });
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Audit round on 13d6b7e
// ---------------------------------------------------------------------------------------------------------------------
describe('DEF-778 audit - createMoneyTransfer', () => {
  const VOIDED = 'This was voided. Reload the page and start a new one.';
  const transfer = (f: Fixture, requestId: string, over: Record<string, unknown> = {}) =>
    asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.manager, {
        fromMoneyAccountId: f.safeId, toMoneyAccountId: f.drawerId, amountOut: '500.00', amountIn: '500.00', transferDate: '2026-01-10',
        requestId, ...over,
      }),
    );

  it('(1) two simultaneous submits on an account holding EXACTLY the draw -> both get the same result, no "cannot cover"', async () => {
    for (let i = 0; i < 5; i++) {
      const f = await fixture('mt-x1');
      const id = randomUUID();
      const draw = { amountOut: '500000.00', amountIn: '500000.00' };
      const [x, y] = await Promise.all([transfer(f, id, draw), transfer(f, id, draw)]);
      expect(y.entryId).toBe(x.entryId);
      expect(y.id).toBe(x.id);
    }
  });

  it.each([
    ['reference', { reference: 'REF-2' }],
    ['notes', { notes: 'another note' }],
    ['fee account', { amountIn: '490.00', feeAccountCode: '6200' }],
  ])('(3) a replay with another %s -> refused', async (_n, over) => {
    const f = await fixture('mt-x3');
    const id = randomUUID();
    const first = f && { reference: 'REF-1', notes: 'a note', amountIn: '490.00' };
    await transfer(f, id, first);
    expect(await userMessageOf(transfer(f, id, { ...first, ...over }))).toBe(DIFFERENT);
  });

  it('(3) a replay of a VOIDED transfer id -> refused with the voided sentence, never success', async () => {
    const f = await fixture('mt-x3v');
    const id = randomUUID();
    const first = await transfer(f, id);
    await asOrg(f.orgId, (tx) => voidMoneyTransfer(tx, f.manager, { moneyTransferId: first.id, reason: 'test' }));
    expect(await userMessageOf(transfer(f, id))).toBe(VOIDED);
  });

  it('(4) an id already owned by ANOTHER org -> a refusal, never a raw primary-key error', async () => {
    const f = await fixture('mt-x4a');
    const g = await fixture('mt-x4b');
    const id = randomUUID();
    await transfer(f, id);
    const msg = await userMessageOf(transfer(g, id));
    expect(msg).toBe(STALE);
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from money_transfers where org_id = ${g.orgId}`;
    expect(n!.n).toBe('0');
  });
});

describe('DEF-778 audit - AP recordPayment', () => {
  const VOIDED = 'This was voided. Reload the page and start a new one.';
  async function apFx(hint: string) {
    const f = await fixture(hint);
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `${hint} Supplier`, creditTermsDays: 30 }));
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${`orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${uid('f')}.jpg`},
              'image/jpeg', 1024, ${uid('sum')}, ${f.staffId}) returning id
    `;
    const invoice = await asOrg(f.orgId, (tx) =>
      recordInvoice(tx, f.staff, { storeId: f.storeId, supplierId: supplier.id, invoiceDate: '2026-01-10', totalAmount: '20000.00', receiptFileId: file!.id }),
    );
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.manager, invoice.id, { supplier: true, invoice: true, items: true, price: true }));
    const { expenseId } = await asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.manager, {
        storeId: f.storeId, supplierId: supplier.id, supplierInvoiceId: invoice.id, categoryId: f.categoryId,
        particulars: 'Stock purchase', payments: [{ method: 'credit', amount: '20000.00' }],
      }),
    );
    return { ...f, supplierId: supplier.id, expenseId };
  }
  type Ap = Awaited<ReturnType<typeof apFx>>;
  const pay = (f: Ap, requestId: string, over: Record<string, unknown> = {}) =>
    asOrg(f.orgId, (tx) =>
      recordPayment(tx, f.manager, {
        storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15', amount: '4000.00', moneyAccountId: f.drawerId,
        allocations: [{ expenseId: f.expenseId, amountApplied: '4000.00' }], requestId, ...over,
      }),
    );

  it('(2) a replay that ADDS a cash request -> refused', async () => {
    const f = await apFx('ap-x2');
    const id = randomUUID();
    await pay(f, id);
    expect(await userMessageOf(pay(f, id, { cashRequestId: randomUUID() }))).toBe(DIFFERENT);
  });

  it('(3) a replay of a VOIDED payment id -> refused with the voided sentence, never success', async () => {
    const f = await apFx('ap-x3v');
    const id = randomUUID();
    const first = await pay(f, id);
    await asOrg(f.orgId, (tx) => voidPayment(tx, f.manager, { paymentId: first.paymentId, reason: 'test' }));
    expect(await userMessageOf(pay(f, id))).toBe(VOIDED);
  });

  it('(4) an id already owned by ANOTHER org -> a refusal, never a raw primary-key error', async () => {
    const f = await apFx('ap-x4a');
    const g = await apFx('ap-x4b');
    const id = randomUUID();
    await pay(f, id);
    const msg = await userMessageOf(pay(g, id));
    expect(msg).toBe(STALE);
  });
});
