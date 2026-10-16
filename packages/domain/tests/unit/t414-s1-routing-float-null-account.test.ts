import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { routeExpense, type RoutingPayment } from '../../src/expenses/routing';

/**
 * T-414 S1 (I4, ruling 3) - `docs/tasks/414-expense-cash-request-source.md`.
 *
 * A float is spendable whether or not its store has a staff-custody money account. A cash leg that names a cash request and
 * NO money account therefore credits 1120 with the REQUEST as party, at the expense's own store (no `storeId` on the line,
 * which `approve.ts` reads as "the expense's store"). A cash leg naming neither still refuses (routing.ts:166).
 *
 * MUTANT M4 (routing drops the party on the null-account path) turns the party asserts red.
 * Red on HEAD: the null-account leg returns the "names no money account" refusal.
 */
const cash = (over: Partial<RoutingPayment>): RoutingPayment => ({
  method: 'cash',
  amount: money('600.00'),
  moneyAccountId: null,
  moneyAccountGlCode: null,
  cashRequestId: null,
  ...over,
});
const route = (payments: RoutingPayment[], total: string) =>
  routeExpense({ totalAmount: money(total), supplierId: null, categoryName: 'Supplies', categoryAccountCode: '6200', payments });

describe('T-414 I4 - a cash leg that names a cash request and no money account', () => {
  it('credits 1120 with party cash_request = that request, at the expense store', () => {
    const r = route([cash({ cashRequestId: 'req-1' })], '600.00');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const credit = r.lines.find((l) => l.side === 'credit')!;
    expect(credit.accountCode).toBe('1120');
    expect(credit.partyType).toBe('cash_request');
    expect(credit.partyId).toBe('req-1');
    expect(String(credit.amount)).toBe('600.00');
    // "the expense's store": no per-line store override.
    expect(credit.storeId).toBeUndefined();
  });

  it('two such legs on two requests keep their own parties', () => {
    const r = route([cash({ cashRequestId: 'req-1' }), cash({ cashRequestId: 'req-2', amount: money('400.00') })], '1000.00');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const credits = r.lines.filter((l) => l.side === 'credit');
    expect(credits.map((c) => [c.accountCode, c.partyType, c.partyId])).toEqual([
      ['1120', 'cash_request', 'req-1'],
      ['1120', 'cash_request', 'req-2'],
    ]);
  });

  it('control: a cash leg with NO account and NO request still refuses', () => {
    const r = route([cash({})], '600.00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/names no money account/);
  });

  it('control: the existing path (staff-float account + request) is unchanged', () => {
    const r = route([cash({ cashRequestId: 'req-1', moneyAccountId: 'acct-1', moneyAccountGlCode: '1120', moneyAccountStoreId: 'store-1' })], '600.00');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const credit = r.lines.find((l) => l.side === 'credit')!;
    expect([credit.accountCode, credit.partyType, credit.partyId, credit.storeId]).toEqual(['1120', 'cash_request', 'req-1', 'store-1']);
  });
});
