import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { routeExpense } from '../../src/expenses/routing';

/**
 * T-367 S5 (DEF-054) F3c — `routeExpense` refuses a payment whose method is not one of the four live ones, with
 * `payment #1: ` + the SAME sentence the create/edit guard gives (docs/tasks/367-ap-ar-money.md S5 step 4, R-6).
 * `RoutingPayment.method` is a plain string (R-3), so a legacy DB row's value reaches the refusal intact.
 * ⚠️ SPEC DEFECT: the spec writes `payment #0:`, but `routing.ts` numbers payments from 1 (`fundingLine(payment, i + 1, …)`),
 * so the first payment is `payment #1:`. These legs pin the real, 1-based numbering.
 * ⛔ TESTER. The sentences are pinned literally, so this fails today on the OLD text ("has no account mapping (DEF-054)").
 */
const SENTENCES = {
  ar_collection: 'That payment method is no longer used. A platform fee is recorded on the channel settlement.',
  other: "'Other' is no longer a payment method. Choose how the money actually left: cash, online, credit or reimbursable.",
  bogus: 'That payment method is not recognised.',
} as const;

const route = (method: string, index = 0) =>
  routeExpense({
    totalAmount: money('300.00'),
    supplierId: null,
    categoryName: 'Rent',
    categoryAccountCode: '6200',
    payments: Array.from({ length: index + 1 }, (_, i) =>
      i === index
        ? ({ method, amount: money('300.00'), moneyAccountId: 'drawer', moneyAccountGlCode: '1110' } as never)
        : ({ method: 'cash', amount: money('0.01'), moneyAccountId: 'drawer', moneyAccountGlCode: '1110' } as never),
    ),
  });

describe('F3c — routeExpense refuses a retired or unknown method with the shared sentence, and builds no funding line', () => {
  for (const method of ['other', 'ar_collection', 'bogus'] as const) {
    it(`'${method}' -> exactly "payment #1: ${SENTENCES[method]}" (Mutant: default maps to 1110 -> ok:true, red)`, () => {
      const result = route(method);
      expect(result.ok, `'${method}' must be refused, not routed to an account`).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(`payment #1: ${SENTENCES[method]}`);
    });
  }

  it('the index in the refusal is the offending payment, not always #0', () => {
    const result = routeExpense({
      totalAmount: money('300.01'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [
        { method: 'cash', amount: money('0.01'), moneyAccountId: 'drawer', moneyAccountGlCode: '1110' },
        { method: 'other', amount: money('300.00') } as never,
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`payment #2: ${SENTENCES.other}`);
  });

  it('+control: a cash payment of the same total still routes (the refusal is the method, not the fixture)', () => {
    const result = route('cash');
    expect(result.ok).toBe(true);
  });

  it("+control: 'reimbursable' with a staff party still routes", () => {
    const result = routeExpense({
      totalAmount: money('300.00'),
      supplierId: null,
      categoryName: 'Rent',
      categoryAccountCode: '6200',
      payments: [{ method: 'reimbursable', amount: money('300.00'), staffId: 'staff-1' }],
    });
    expect(result.ok).toBe(true);
  });
});
