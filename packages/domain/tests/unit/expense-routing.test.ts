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

  // invariant 10 (DEF-054): retired methods are refused in t367-s5-routing-retired.test.ts (T-367 S5, F3c).

  // ⭐ These two used to assert the FLAGS: a `cashRequestId` routed to 1120 and a free-text
  // `accountCode: 'office'` routed to 1130. DEF-058 removed both — Ian: *"payments must
  // automatically know who owns the account chosen from the dropdown, so the office drawer
  // checkbox must not exist."* The destination is unchanged; what changed is that the user picks
  // a PLACE instead of ticking a property of one.
  // ⚠️ The ACCOUNT decides WHERE the credit lands (1120). The REQUEST decides WHOSE float it was.
  // Those are two different questions and this test used to ask only the first — see the T-266
  // block at the bottom of this file for why that mattered.
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

/**
 * ⛔ T-266 / the 1120 party defect — docs/tasks/266-money-lines.md §4.
 *
 * `1120` is seeded `requiresParty: true` (packages/db/seed/chart-of-accounts.ts:133) because ONE
 * staff-float account per store serves MANY holders — the party is the only thing that decomposes
 * it. `fundingLine` attached a party only for `1140`, so the credit line went in party-less and
 * `journal_lines_party_requirement` (migration 0007) raised. An expense paid from a staff float
 * could not post at all.
 *
 * ⚠️ **A test already routed a 1120 payment and passed** — "a staff float routes to 1120", above.
 * It asserted the account code and never the party, so it covered the line without covering the
 * property that was wrong. That is why this block asserts the party explicitly, on every branch.
 *
 * ⛔ The tempting wrong fix is to drop `requiresParty` from 1120. Then `floatPositionOf`'s `spent`
 * bucket (party_type='cash_request') never sees the spend, `outstanding` never falls, the request
 * never reaches `liquidated`, and DEF-159's gate refuses that person every future float.
 */
describe('routeExpense — the staff-float party (T-266)', () => {
  const floatPayment = (over: Partial<RoutingPayment> = {}): RoutingPayment => ({
    method: 'cash',
    amount: money('1500.00'),
    moneyAccountId: 'staff-float-lipa',
    moneyAccountGlCode: '1120',
    cashRequestId: 'cr-ana-447',
    ...over,
  });

  const route = (payments: RoutingPayment[], total = '1500.00') =>
    routeExpense({
      totalAmount: money(total),
      supplierId: null,
      categoryName: 'Supplies and Stocks',
      categoryAccountCode: '6500',
      payments,
    });

  it('⭐ credits 1120 WITH the cash request as the party — the shape releaseCashRequest already uses', () => {
    const result = route([floatPayment()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const credit = result.lines.find((l) => l.side === 'credit')!;
    expect(credit.accountCode).toBe(EXPENSE_FUNDING_ACCOUNTS.CASH_STAFF);
    // ⭐ Not 'money_account'. The float's identity is the REQUEST (T-266 §7.2): one staff-float
    // account per store, so the account cannot decompose itself.
    expect(credit.partyType).toBe('cash_request');
    expect(credit.partyId).toBe('cr-ana-447');
  });

  it('⛔ BLOCKS with a named reason when a staff float names no cash request', () => {
    const result = route([floatPayment({ cashRequestId: null })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The refusal has to name the float and say why — never reach the database and come back
    // as `account 1120 requires a party on every line, but none was given`.
    expect(result.reason).toContain('staff float');
    expect(result.reason).toContain('liquidated');
  });

  it('the cashier drawer (1110) still carries NO party — the trigger refuses one there', () => {
    const result = route([
      { method: 'cash', amount: money('1500.00'), moneyAccountId: 'drawer', moneyAccountGlCode: '1110' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const credit = result.lines.find((l) => l.side === 'credit')!;
    expect(credit.partyType).toBeUndefined();
    expect(credit.partyId).toBeUndefined();
  });

  it('the office safe (1130) still carries NO party either', () => {
    const result = route([
      { method: 'cash', amount: money('1500.00'), moneyAccountId: 'safe', moneyAccountGlCode: '1130' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const credit = result.lines.find((l) => l.side === 'credit')!;
    expect(credit.partyType).toBeUndefined();
  });

  it('a wallet (1140) still carries the MONEY ACCOUNT as its party — unchanged', () => {
    const result = route([
      { method: 'online', amount: money('1500.00'), moneyAccountId: 'gcash-1', moneyAccountGlCode: '1140' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const credit = result.lines.find((l) => l.side === 'credit')!;
    expect(credit.partyType).toBe('money_account');
    expect(credit.partyId).toBe('gcash-1');
  });

  it('⭐ a split across the office safe and TWO different floats parties each line separately', () => {
    const result = route(
      [
        { method: 'cash', amount: money('2000.00'), moneyAccountId: 'safe', moneyAccountGlCode: '1130' },
        floatPayment({ amount: money('1500.00'), cashRequestId: 'cr-ana-447' }),
        floatPayment({ amount: money('380.00'), cashRequestId: 'cr-ben-448' }),
      ],
      '3880.00',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const credits = result.lines.filter((l) => l.side === 'credit');
    expect(credits).toHaveLength(3);
    // ⚠️ Two lines on the SAME account and the same GL code, told apart only by the party. This is
    // the case that makes 1120 a control account rather than a place.
    expect(credits.map((l) => l.partyId)).toEqual([undefined, 'cr-ana-447', 'cr-ben-448']);
  });
});
