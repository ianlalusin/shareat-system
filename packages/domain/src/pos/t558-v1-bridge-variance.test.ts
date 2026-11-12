/**
 * T-558 R3/R5 (TESTER) - the December bridge and short payments. docs/tasks/558-pos-sale-variance-tolerance.md R3 "The December bridge".
 * Pure builder, no database.
 *
 * Spec: `payments.totalGross` stays the GROSS; `byMethod` then sums to gross - variance (v1 tolerates a peso); a day whose `varianceTotal` is over PHP 1 refuses the write
 * with "Short payments of PHP X exceed v1's PHP 1 check; send this day by hand."
 *
 * ASSUMED API (v1-bridge-payload.ts): `V1BridgeClose` gains `varianceTotal: string` (decimal text, 0.00 when none) next to `grossTotal`. The day's variance is the SUM over its closes.
 * ASSUMED: X is the day's variance as two-decimal text with the peso sign as the spec prints it (1.01 -> "PHP 1.01" with the real sign U+20B1); exactly PHP 1.00 is allowed
 * ("over PHP 1" refuses). The existing "do not add up" refusal still guards the other direction: tenders + variance must equal gross.
 */
import { describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';
import { buildV1BridgePayload } from './v1-bridge-payload';

const PESO = '₱';
type Tender = { name: string; kind: 'cash' | 'wallet'; v1Alias: string | null; amount: string };
type Close = { receiptCount: number; grossTotal: string; varianceTotal: string; discountTotal: string; unliSales: string; heads: number; packageSessions: number; tenders: Tender[] };
const close = (o: Partial<Close> & { gross: string; tenders: Tender[] }): Close => ({
  receiptCount: 2, grossTotal: o.gross, varianceTotal: '0.00', discountTotal: '0.00', unliSales: '0.00', heads: 0, packageSessions: 0, ...o,
});
const cash = (amount: string): Tender => ({ name: 'Cash', kind: 'cash', v1Alias: 'Cash', amount });
const gcash = (amount: string): Tender => ({ name: 'GCash', kind: 'wallet', v1Alias: 'GCash', amount });
const build = (closes: Close[]) => buildV1BridgePayload({ posStoreId: 'lipa-v1', businessDate: '2026-11-02', closes: closes as never });
async function refusal(f: () => unknown): Promise<string> {
  let err: unknown = null;
  try {
    f();
  } catch (e) {
    err = e;
  }
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  return (err as RefusalError).userMessage;
}
const sentence = (x: string) => `Short payments of ${PESO}${x} exceed v1's ${PESO}1 check; send this day by hand.`;

describe('R3 bridge - a short day still goes to v1, as the gross', () => {
  it('gross 200.00, variance 0.01, cash 199.99: totalGross stays 200, byMethod sums to 199.99', () => {
    const out = build([close({ gross: '200.00', varianceTotal: '0.01', tenders: [cash('199.99')] })]);
    expect(out.data.payments.totalGross).toBe(200);
    expect(out.data.payments.byMethod).toEqual({ cash: 199.99 });
  });

  it('two tenders short by 0.51: byMethod is gross minus variance across the methods', () => {
    const out = build([close({ gross: '300.00', varianceTotal: '0.51', tenders: [cash('199.99'), gcash('99.50')] })]);
    expect(out.data.payments.totalGross).toBe(300);
    expect(out.data.payments.byMethod).toEqual({ cash: 199.99, GCash: 99.5 });
  });

  it('a day with no variance is unchanged (the T-531 document): methods equal the gross', () => {
    const out = build([close({ gross: '2896.71', varianceTotal: '0.00', tenders: [cash('2396.71'), gcash('500.00')] })]);
    expect(out.data.payments).toMatchObject({ totalGross: 2896.71, byMethod: { cash: 2396.71, GCash: 500 } });
  });

  it('tenders that do not add up to gross - variance are STILL refused (the old guard stays): variance 0.00 declared, 0.01 missing', async () => {
    const say = await refusal(() => build([close({ gross: '200.00', varianceTotal: '0.00', tenders: [cash('199.99')] })]));
    expect(say).toContain('do not add up');
  });
});

describe('R3 bridge - a day short by more than PHP 1 is not sent', () => {
  it('variance exactly 1.00 is sent (the check is "over")', () => {
    const out = build([close({ gross: '100.00', varianceTotal: '1.00', tenders: [cash('99.00')] })]);
    expect(out.data.payments.totalGross).toBe(100);
  });

  it('variance 1.01 refuses with the exact sentence', async () => {
    expect(await refusal(() => build([close({ gross: '100.00', varianceTotal: '1.01', tenders: [cash('98.99')] })]))).toBe(sentence('1.01'));
  });

  it('the DAY decides, not each Z: two closes of 0.60 and 0.41 refuse with the day total 1.01', async () => {
    const closes = [
      close({ gross: '100.00', varianceTotal: '0.60', tenders: [cash('99.40')] }),
      close({ gross: '100.00', varianceTotal: '0.41', tenders: [cash('99.59')] }),
    ];
    expect(await refusal(() => build(closes))).toBe(sentence('1.01'));
  });

  it('a large figure keeps two decimals in the sentence (25.50)', async () => {
    expect(await refusal(() => build([close({ gross: '300.00', varianceTotal: '25.50', tenders: [cash('274.50')] })]))).toBe(sentence('25.50'));
  });
});
