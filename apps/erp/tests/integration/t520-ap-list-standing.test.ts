import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-520 - the /ap list's Recorded / Left / Owed are the invoice page's own numbers, for every invoice, from one bulk read.
 * The detail page's definitions are the oracle: `apRepo.capacityOf` (Recorded / Remaining) and `apRepo.openItems`
 * filtered to the invoice (Owed). Also: newest first, and the Not-verified filter's rows.
 * Runs on any *_test database.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { apRepo, closeDb } from '@shareat/db';
import { recordExpenseForInvoice, recordPayment, verifyInvoice, voidInvoice } from '@shareat/domain';
import { ap475Fixture, asOrg } from '../../../../packages/domain/tests/integration/_fixtures/t475-ap';
import { listInvoicesWithStanding, standingPills } from '../../src/app/ap/lib';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ATTEST = { supplier: true, invoice: true, items: true, price: true };

async function seed() {
  const f = await ap475Fixture(sql, 't520');
  const verified = async (on: string, total: string) => {
    const id = await f.invoice({ on, total });
    await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.admin, id, ATTEST));
    return id;
  };
  const book = (invoiceId: string, amount: string) =>
    asOrg(f.orgId, (tx) =>
      recordExpenseForInvoice(tx, f.admin, {
        requireItemised: false,
        storeId: f.storeId, supplierId: f.supplierId, supplierInvoiceId: invoiceId, categoryId: f.categoryId,
        particulars: 'Stock purchase', payments: [{ method: 'credit', amount }],
      }),
    );

  const partly = await verified('2026-01-10', '1000.00');
  await book(partly, '400.00');

  const fullUnpaid = await verified('2026-01-11', '500.00');
  await book(fullUnpaid, '500.00');

  const paid = await verified('2026-01-12', '300.00');
  const { expenseId } = await book(paid, '300.00');
  await asOrg(f.orgId, (tx) =>
    recordPayment(tx, f.admin, {
      requestId: crypto.randomUUID(), storeId: f.storeId, supplierId: f.supplierId, businessDate: '2026-01-15',
      amount: '300.00', moneyAccountId: f.cashId, allocations: [{ expenseId, amountApplied: '300.00' }],
    }),
  );

  const voided = await f.invoice({ on: '2026-01-13', total: '200.00' });
  await asOrg(f.orgId, (tx) => voidInvoice(tx, f.admin, { invoiceId: voided, reason: 'T-520 test' }));

  const pending = await f.invoice({ on: '2026-01-14', total: '800.00' });
  return { f, partly, fullUnpaid, paid, voided, pending };
}

describe('T-520 - the /ap list agrees with each invoice page', () => {
  it('Recorded / Left / Owed equal the detail page figures; newest first; pills read right', async () => {
    const { f, partly, fullUnpaid, paid, voided, pending } = await seed();
    const rows = await listInvoicesWithStanding(f.orgId);

    // Newest first: pending (14th), voided (13th), paid (12th), fullUnpaid (11th), partly (10th).
    expect(rows.map((r) => r.id)).toEqual([pending, voided, paid, fullUnpaid, partly]);

    for (const row of rows) {
      const cap = await asOrg(f.orgId, (tx) => apRepo.capacityOf(tx, f.orgId, row.id));
      const open = await asOrg(f.orgId, (tx) => apRepo.openItems(tx, f.orgId, row.supplierId, row.storeId));
      const owed = open.filter((i) => i.supplierInvoiceId === row.id).reduce((t, i) => t + Number(i.outstanding), 0).toFixed(2);
      expect({ recorded: row.recorded, remaining: row.remaining, owed: row.owed }, row.id).toEqual({
        recorded: cap!.recorded, remaining: cap!.remaining, owed,
      });
    }

    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[partly]).toMatchObject({ recorded: '400.00', remaining: '600.00', owed: '400.00' });
    expect(by[fullUnpaid]).toMatchObject({ recorded: '500.00', remaining: '0.00', owed: '500.00' });
    expect(by[paid]).toMatchObject({ recorded: '300.00', remaining: '0.00', owed: '0.00' });
    expect(by[voided]).toMatchObject({ status: 'voided', recorded: '0.00', owed: '0.00' });
    expect(by[pending]).toMatchObject({ status: 'pending', recorded: '0.00', remaining: '800.00', owed: '0.00' });

    expect(standingPills(by[partly]!)).toEqual({
      recorded: { tone: 'progress', label: 'Open · ₱600.00 left' },
      paid: { tone: 'warning', label: '₱400.00 owed' },
    });
    expect(standingPills(by[fullUnpaid]!)).toEqual({
      recorded: { tone: 'success', label: 'Fully recorded' },
      paid: { tone: 'warning', label: '₱500.00 owed' },
    });
    expect(standingPills(by[paid]!)).toEqual({ recorded: { tone: 'success', label: 'Fully recorded' }, paid: { tone: 'success', label: 'Paid' } });
    expect(standingPills(by[voided]!)).toEqual({ recorded: null, paid: null });
    expect(standingPills(by[pending]!)).toEqual({ recorded: { tone: 'warning', label: 'Not recorded' }, paid: null });
  });

  it('the Not-verified filter (status pending) lists only unverified invoices', async () => {
    const { f, pending } = await seed();
    const rows = await listInvoicesWithStanding(f.orgId);
    expect(rows.filter((r) => r.status === 'pending').map((r) => r.id)).toEqual([pending]);
  });
});
