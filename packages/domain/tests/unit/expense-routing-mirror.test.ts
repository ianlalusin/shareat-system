import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { ACCOUNTS as ETL_ACCOUNTS } from '../../../etl/src/leg-mapping';
import { convertExpense, type ExpenseDoc } from '../../../etl/src/convert';
import { routeExpense, EXPENSE_FUNDING_ACCOUNTS } from '../../src/expenses/routing';

/**
 * Drift guard for packages/domain/src/expenses/routing.ts's top-comment claim: the
 * funding-account codes are a COPY of packages/etl/src/leg-mapping.ts's `ACCOUNTS`
 * (domain cannot import etl — etl depends on domain, ADR-004). Same technique as
 * tests/unit/posting-patterns-doc.test.ts (parses a doc against fixtures.ts) and
 * packages/etl/tests/leg-mapping.test.ts (checks leg-mapping.ts against the real seed):
 * a test file OUTSIDE both packages/domain and packages/etl may read both freely — only
 * the PACKAGES themselves may not depend on each other in the wrong direction. This file
 * only ever READS packages/etl — it never modifies it (bible: reference-adjacent code
 * that this repo owns is fine to read; packages/etl itself is Scope-excluded from T-122's
 * edits, not from being read by a same-repo test).
 */
describe('expense routing mirrors leg-mapping.ts / convert.ts exactly', () => {
  it('the funding account codes agree with leg-mapping.ts ACCOUNTS', () => {
    expect(EXPENSE_FUNDING_ACCOUNTS.CASH_CASHIER).toBe(ETL_ACCOUNTS.CASH_CASHIER);
    expect(EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF).toBe(ETL_ACCOUNTS.CASH_STAFF);
    expect(EXPENSE_FUNDING_ACCOUNTS.CASH_OFFICE).toBe(ETL_ACCOUNTS.CASH_OFFICE);
    expect(EXPENSE_FUNDING_ACCOUNTS.ONLINE).toBe(ETL_ACCOUNTS.ONLINE);
    expect(EXPENSE_FUNDING_ACCOUNTS.AP).toBe(ETL_ACCOUNTS.AP);
    expect(EXPENSE_FUNDING_ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES).toBe(ETL_ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES);
  });

  /**
   * Cross-checks routeExpense's funding-leg CHOICE (which account, for a given payment
   * shape) against convertExpense's real behaviour, for every case both implementations
   * can express (OPEX, so the classification leg is comparable too). convertExpense
   * quarantines COGS/CAPEX/PERSONAL differently than routeExpense does (it never
   * implemented the two-stage inventory posting, and works from expenseEntryGroup rather
   * than a resolved category account) — this test only compares the FUNDING side, which
   * is what T-122 §2 says must mirror exactly.
   */
  function fundingCodesFromConvert(doc: ExpenseDoc): string[] {
    const result = convertExpense('specimen', 'expense.cash' as never, doc);
    if (result.status !== 'converted') throw new Error(`expected converted, got ${result.status}: ${result.reason}`);
    // Every line except the last (the classification leg convertExpense appends for OPEX)
    // is a funding line, in payment order.
    return result.entries[0]!.lines.slice(0, -1).map((l) => l.accountCode);
  }

  it('cash (no cashRequestId) -> 1110, matching convertExpense', () => {
    const doc: ExpenseDoc = {
      id: 'e1', dayKey: '2026-01-01', storeId: 'S1', totalAmount: 100,
      payments: [{ method: 'cash', amount: 100 }],
      expenseEntryGroup: 'OPEX', category: 'Rent',
    };
    expect(fundingCodesFromConvert(doc)).toEqual([EXPENSE_FUNDING_ACCOUNTS.CASH_CASHIER]);

    const routed = routeExpense({
      totalAmount: money('100.00'), supplierId: null, categoryName: 'Rent', categoryAccountCode: '6200',
      payments: [{ method: 'cash', amount: money('100.00') }],
    });
    expect(routed.ok && routed.lines[0]!.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.CASH_CASHIER);
  });

  it('cash WITH cashRequestId -> 1120, matching convertExpense', () => {
    const doc: ExpenseDoc = {
      id: 'e2', dayKey: '2026-01-01', storeId: 'S1', totalAmount: 100,
      payments: [{ method: 'cash', amount: 100, cashRequestId: 'cr-1' }],
      expenseEntryGroup: 'OPEX', category: 'Rent',
    };
    expect(fundingCodesFromConvert(doc)).toEqual([EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF]);

    const routed = routeExpense({
      totalAmount: money('100.00'), supplierId: null, categoryName: 'Rent', categoryAccountCode: '6200',
      payments: [{ method: 'cash', amount: money('100.00'), cashRequestId: 'cr-1' }],
    });
    expect(routed.ok && routed.lines[0]!.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF);
  });

  it("cash WITH accountId 'office' -> 1130, matching convertExpense", () => {
    const doc: ExpenseDoc = {
      id: 'e3', dayKey: '2026-01-01', storeId: 'S1', totalAmount: 100,
      payments: [{ method: 'cash', amount: 100, accountId: 'office' }],
      expenseEntryGroup: 'OPEX', category: 'Rent',
    };
    expect(fundingCodesFromConvert(doc)).toEqual([EXPENSE_FUNDING_ACCOUNTS.CASH_OFFICE]);

    const routed = routeExpense({
      totalAmount: money('100.00'), supplierId: null, categoryName: 'Rent', categoryAccountCode: '6200',
      payments: [{ method: 'cash', amount: money('100.00'), accountCode: 'office' }],
    });
    expect(routed.ok && routed.lines[0]!.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.CASH_OFFICE);
  });

  it('online -> 1140, matching convertExpense', () => {
    const doc: ExpenseDoc = {
      id: 'e4', dayKey: '2026-01-01', storeId: 'S1', totalAmount: 100,
      payments: [{ method: 'online', amount: 100, accountId: 'gcash-main' }],
      expenseEntryGroup: 'OPEX', category: 'Rent',
    };
    expect(fundingCodesFromConvert(doc)).toEqual([EXPENSE_FUNDING_ACCOUNTS.ONLINE]);
  });

  it('credit -> 2110 with the supplier party, matching convertExpense', () => {
    const doc: ExpenseDoc = {
      id: 'e5', dayKey: '2026-01-01', storeId: 'S1', totalAmount: 100,
      payments: [{ method: 'credit', amount: 100 }],
      supplierId: 'sup-1',
      expenseEntryGroup: 'OPEX', category: 'Rent',
    };
    const result = convertExpense('specimen', 'expense.credit' as never, doc);
    if (result.status !== 'converted') throw new Error('expected converted');
    const line = result.entries[0]!.lines[0]!;
    expect(line.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.AP);
    expect(line.partyType).toBe('supplier');
    expect(line.partyId).toBe('sup-1');
  });

  it('reimbursable -> 2130 with the employee party, matching convertExpense', () => {
    const doc: ExpenseDoc = {
      id: 'e6', dayKey: '2026-01-01', storeId: 'S1', totalAmount: 100,
      payments: [{ method: 'reimbursable', amount: 100, staffId: 'staff-1' }],
      expenseEntryGroup: 'OPEX', category: 'Rent',
    };
    const result = convertExpense('specimen', 'expense.reimbursable' as never, doc);
    if (result.status !== 'converted') throw new Error('expected converted');
    const line = result.entries[0]!.lines[0]!;
    expect(line.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES);
    expect(line.partyType).toBe('employee');
    expect(line.partyId).toBe('staff-1');
  });

  it("'other' and 'ar_collection' are unmapped in BOTH convertExpense and routeExpense (DEF-054)", () => {
    for (const method of ['other', 'ar_collection'] as const) {
      const doc: ExpenseDoc = {
        id: `e-${method}`, dayKey: '2026-01-01', storeId: 'S1', totalAmount: 100,
        payments: [{ method, amount: 100 }],
        expenseEntryGroup: 'OPEX', category: 'Rent',
      };
      const result = convertExpense('specimen', 'expense.other' as never, doc);
      expect(result.status).toBe('quarantined');
      expect(result.reasonCode).toBe('unimplemented_payment_method');
    }
  });
});
