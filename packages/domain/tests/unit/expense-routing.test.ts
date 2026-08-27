import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { routeExpense, EXPENSE_FUNDING_ACCOUNTS, type RoutingPayment } from '../../src/expenses/routing';

/**
 * docs/tasks/122-expenses.md — the posting invariants (1-10), proven pure/DB-free first.
 * The full round trip through real postEntry is
 * packages/domain/tests/integration/expenses.test.ts.
 */

/** Cash from the cashier's own drawer — the ordinary case. ⭐ Since DEF-058 the ACCOUNT decides
 *  where the credit lands and who owned the money, so every cash payment names one. */
function cash(amount: string): RoutingPayment {
  return { method: 'cash', amount: money(amount), moneyAccountId: 'drawer', moneyAccountGlCode: '1110' };
}

describe('routeExpense', () => {
  it('invariant 1 — a single cash expense posts exactly the lines POSTING-PATTERNS.md declares', () => {
    // expense.cash.simple: DR 5100 COGS — food 1,200 / CR 1110 cash 1,200.
    const result = routeExpense({
      totalAmount: money('1200.00'),
      supplierId: null,
      categoryName: 'Meat',
      categoryAccountCode: '5100',
      payments: [cash('1200.00')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines).toEqual([
      { accountCode: EXPENSE_FUNDING_ACCOUNTS.CASH_CASHIER, side: 'credit', amount: money('1200.00'), lineMemo: 'cash payment #1' },
      { accountCode: '5100', side: 'debit', amount: money('1200.00'), lineMemo: 'Meat' },
    ]);
  });

  it('invariant 2 — a three-way split produces ONE set of lines with three credit lines, not three entries', () => {
    const result = routeExpense({
      totalAmount: money('3000.00'),
      supplierId: null,
      categoryName: 'Supplies and Stocks',
      categoryAccountCode: '6500',
      payments: [cash('1000.00'), { method: 'online', amount: money('1000.00'), moneyAccountId: 'wallet-1', moneyAccountGlCode: '1140' }, { method: 'cash', amount: money('1000.00'), moneyAccountId: 'float', moneyAccountGlCode: '1120', cashRequestId: 'cr-1' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const credits = result.lines.filter((l) => l.side === 'credit');
    const debits = result.lines.filter((l) => l.side === 'debit');
    expect(credits).toHaveLength(3);
    expect(debits).toHaveLength(1);
    expect(credits.map((l) => l.accountCode)).toEqual([
      EXPENSE_FUNDING_ACCOUNTS.CASH_CASHIER,
      EXPENSE_FUNDING_ACCOUNTS.ONLINE,
      EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF,
    ]);
  });

  it('invariant 3 — reimbursable credits 2130 WITH the staff party', () => {
    const result = routeExpense({
      totalAmount: money('650.00'),
      supplierId: null,
      categoryName: 'Repairs and Maintenance',
      categoryAccountCode: '6600',
      payments: [{ method: 'reimbursable', amount: money('650.00'), staffId: 'staff-1' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const funding = result.lines.find((l) => l.side === 'credit')!;
    expect(funding.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.REIMBURSABLE_TO_EMPLOYEES);
    expect(funding.partyType).toBe('employee');
    expect(funding.partyId).toBe('staff-1');
  });

  it('invariant 3 (denial) — reimbursable WITHOUT a staff party is rejected, not posted unattributed', () => {
    const result = routeExpense({
      totalAmount: money('650.00'),
      supplierId: null,
      categoryName: 'Repairs and Maintenance',
      categoryAccountCode: '6600',
      payments: [{ method: 'reimbursable', amount: money('650.00') }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/staffId/);
  });

  it('a credit (AP) payment carries the supplier party, mirroring convert.ts', () => {
    const result = routeExpense({
      totalAmount: money('8000.00'),
      supplierId: 'sup-1',
      categoryName: 'Supplies and Stocks',
      categoryAccountCode: '6500',
      payments: [{ method: 'credit', amount: money('8000.00') }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const funding = result.lines.find((l) => l.side === 'credit')!;
    expect(funding.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.AP);
    expect(funding.partyType).toBe('supplier');
    expect(funding.partyId).toBe('sup-1');
  });

  it('a credit payment with no supplierId is rejected, never posted unattributed', () => {
    const result = routeExpense({
      totalAmount: money('8000.00'),
      supplierId: null,
      categoryName: 'Supplies and Stocks',
      categoryAccountCode: '6500',
      payments: [{ method: 'credit', amount: money('8000.00') }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/supplierId/);
  });

  it('invariant 7 — an unmapped category BLOCKS, naming the category, never falls back to 6900', () => {
    const result = routeExpense({
      totalAmount: money('500.00'),
      supplierId: null,
      categoryName: 'Some Unmapped Category',
      categoryAccountCode: null,
      payments: [cash('500.00')],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Some Unmapped Category');
    // ok:false carries no `lines` at all — the type itself proves nothing was routed to
    // 6900 or anywhere else; "6900" appears in `reason` only as prose naming the rule.
  });

  // ⭐ T-127 SPLIT THIS IN TWO. A personal expense has no single account: it is a DRAWING only when
  // the business does not expect the money back, and a RECEIVABLE when it does. That is the line the
  // tax treatment turns on — a payment made with no expectation of repayment is a distribution
  // however it is labelled — and it is decided per owner, not per category.
  const personal = (treatment: 'repayable' | 'drawing') => ({
    totalAmount: money('1000.00'),
    supplierId: null,
    categoryName: "Personal — owner's expense",
    categoryAccountCode: '3200',
    payments: [cash('1000.00')],
    owner: { id: 'owner-1', treatment },
  });

  it("invariant 8 — a NON-repayable personal expense routes to 3200, contra-equity, not an expense account", () => {
    const result = routeExpense(personal('drawing'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const classification = result.lines.find((l) => l.side === 'debit')!;
    expect(classification.accountCode).toBe('3200');
    // The party is what lets a drawing limit see it at all.
    expect(classification.partyType).toBe('owner');
    expect(classification.partyId).toBe('owner-1');
  });

  it('⭐ invariant 8b — a REPAYABLE personal expense routes to 1260, a receivable, not to equity', () => {
    const result = routeExpense(personal('repayable'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const classification = result.lines.find((l) => l.side === 'debit')!;
    // ⛔ Booking this as a drawing would reduce equity for money the business intends to get back.
    expect(classification.accountCode).toBe('1260');
    expect(classification.partyType).toBe('owner');
  });

  it('⛔ invariant 8c — a personal expense with NO owner BLOCKS, naming the reason', () => {
    const { owner: _omitted, ...noOwner } = personal('drawing');
    const result = routeExpense(noOwner);
    // Invariant 7's rule, unchanged: an unresolvable posting blocks. It never defaults to "some
    // owner", because an unattributed personal expense escapes that owner's drawing limit entirely.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/belongs to a specific owner/);
  });

  it('invariant 9 — CAPEX routes to a 15xx asset, not a P&L line', () => {
    const result = routeExpense({
      totalAmount: money('25000.00'),
      supplierId: null,
      categoryName: 'Capital expenditure',
      categoryAccountCode: '1510',
      payments: [cash('25000.00')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const classification = result.lines.find((l) => l.side === 'debit')!;
    expect(classification.accountCode).toBe('1510');
  });

  it('invariant 10 — "other" BLOCKS posting with a named reason (DEF-054)', () => {
    const result = routeExpense({
      totalAmount: money('300.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [{ method: 'other', amount: money('300.00') }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('other');
    expect(result.reason).toContain('DEF-054');
  });

  it('invariant 10 — "ar_collection" BLOCKS posting with a named reason (DEF-054)', () => {
    const result = routeExpense({
      totalAmount: money('300.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [{ method: 'ar_collection', amount: money('300.00') }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ar_collection');
  });

  // ⭐ These two used to assert the FLAGS: a `cashRequestId` routed to 1120 and a free-text
  // `accountCode: 'office'` routed to 1130. DEF-058 removed both — Ian: *"payments must
  // automatically know who owns the account chosen from the dropdown, so the office drawer
  // checkbox must not exist."* The destination is unchanged; what changed is that the user picks
  // a PLACE instead of ticking a property of one.
  it('a staff float routes to 1120 — because the ACCOUNT says so, not a cashRequestId', () => {
    const result = routeExpense({
      totalAmount: money('200.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [
        {
          method: 'cash',
          amount: money('200.00'),
          moneyAccountId: 'float-maria',
          moneyAccountGlCode: '1120',
          // Still carried, now as metadata: WHICH request funded the float, not where it posts.
          cashRequestId: 'cr-9',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.find((l) => l.side === 'credit')!.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF);
  });

  it('the office safe routes to 1130 — a chosen account, not a ticked checkbox', () => {
    const result = routeExpense({
      totalAmount: money('200.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [
        { method: 'cash', amount: money('200.00'), moneyAccountId: 'safe', moneyAccountGlCode: '1130' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines.find((l) => l.side === 'credit')!.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.CASH_OFFICE);
  });

  it('⛔ cash with NO account is refused — every peso leaves somewhere nameable', () => {
    const result = routeExpense({
      totalAmount: money('200.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [{ method: 'cash', amount: money('200.00') }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('names no money account');
  });

  it('rejects when sum(payments) != totalAmount', () => {
    const result = routeExpense({
      totalAmount: money('100.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [cash('50.00')],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an expense with zero payments', () => {
    const result = routeExpense({
      totalAmount: money('0.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [],
    });
    expect(result.ok).toBe(false);
  });
});
