import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-558 R2 (TESTER) - `completeSale` records a short-paid sale instead of refusing it, and flags the gap. docs/tasks/558-pos-sale-variance-tolerance.md R2; bible row 453.
 *
 * THE RULE UNDER TEST (replaces T-524 R9(3) "paid >= total exactly"): after the server recompute, gap = server total - sum(payments).
 *   gap <= 0                 unchanged: change only from cash (an overpayment by a non-cash tender is still refused).
 *   0 < gap <= tolerance     recorded, change 0, audit `pos.sale_payment_variance`, severity LOW.
 *   gap > tolerance          recorded the same way, audit `pos.sale_payment_shortfall`, severity HIGH (the finding): lists the gap and the tolerance. NEVER refuses.
 * The tolerance is the rule `pos.sale_variance_tolerance` read on the sale's own business date (default 0.01, ceiling 0.10).
 * Every sale is built through the real domain with device figures from priceSession (see _fixtures/t531-day-close.ts `sell`); the 100.00 item is P-002's price.
 *
 * ASSUMED API (all named in the hand-back):
 *   - PosRules.saleVarianceToleranceCentavos: bigint (spec R1); the injectable `readRules` (T-524 PosDeps) may return it, and the default reader (readPosRules) does.
 *   - audit actions `pos.sale_payment_variance` (sensitivity low, category money) and `pos.sale_payment_shortfall` (sensitivity high, category money), owner T-558, scope store.
 *   - the audit rows' `after` carries the figures as text; this file only checks that each named figure appears in it (key names are the builder's).
 *
 * RED NOW FOR THE RIGHT REASON: completeSale refuses "The payments add up to less than the total." (pos: underpaid) where the cases expect a recorded sale; the audit actions are
 * not in the catalogue.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { RefusalError, catalogueEntry } from '@shareat/db';
import { completeSale } from '../../src/pos';
import { putRule } from './_fixtures/t512-rules';
import { closeAll, asOrg, auditsOf, sql, D2 } from './_fixtures/t531-day-close';
import {
  D1, auditRowsOf, jsonText, manila, ratesWith, receiptCount, receiptPayments, receiptRow, sellHundred, sessionStatus, world58, type World58,
} from './_fixtures/t558-variance';

afterAll(closeAll);

const AT = manila(D1, '12:00');
const VARIANCE = 'pos.sale_payment_variance';
const SHORTFALL = 'pos.sale_payment_shortfall';
const UNDERPAID = 'The payments add up to less than the total.';
const NOT_CASH = 'Change can only be given in cash.';

async function refusalOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  return (err as RefusalError).userMessage;
}

/** What a sale left in the audit: how many of each of the two new actions. */
async function flags(w: World58) {
  return { variance: (await auditRowsOf(w.orgId, VARIANCE)).length, shortfall: (await auditRowsOf(w.orgId, SHORTFALL)).length };
}

// ======================================================================================================================
describe('R2 - the P-002 case: 99.99 paid against a server total of 100.00', () => {
  it('is RECORDED: the receipt exists at 100.00, the table is paid, the payment row holds 99.99 and gives no change [kills: the old "underpaid" refusal]', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], AT);
    expect(sale.total).toBe('100.00');
    expect((await receiptRow(sale.receiptId))?.total).toBe('100.00');
    expect(await sessionStatus(sale.sessionId)).toBe('paid');
    expect((await receiptPayments(sale.receiptId)).map((p) => [p.tender_id, p.amount, p.change_given])).toEqual([[w.cash, '99.99', '0.00']]);
  });

  it('writes ONE low-severity variance audit holding the gap 0.01, the device total, the server total and the payment; no finding, and the sale is still audited as completed', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], AT);
    expect(await flags(w)).toEqual({ variance: 1, shortfall: 0 });
    const [a] = await auditRowsOf(w.orgId, VARIANCE);
    expect(a).toMatchObject({ entity_id: sale.receiptId, sensitivity: 'low', severity: 6 });
    const text = jsonText(a!.after);
    for (const figure of ['0.01', '100.00', '99.99', w.cash]) expect(text, figure).toContain(figure);
    expect(await auditsOf(w, 'pos.sale_completed')).toHaveLength(1);
  });

  it('the real P-002: the TABLET priced it 99.99 and paid 99.99, the server prices 100.00 - recorded, with BOTH the recompute-mismatch audit and the variance audit, the device total kept', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], AT, {
      mutate: (input) => {
        (input.device as { total: string }).total = '99.99';
      },
    });
    expect((await receiptRow(sale.receiptId))).toMatchObject({ total: '100.00', device_total: '99.99' });
    expect(await auditsOf(w, 'pos.sale_recompute_mismatch')).toHaveLength(1);
    const [a] = await auditRowsOf(w.orgId, VARIANCE);
    expect(a, 'the variance audit exists').toBeDefined();
    expect(jsonText(a!.after)).toContain('99.99');
    expect(jsonText(a!.after)).toContain('100.00');
  });

  it('the same short payment by a wallet tender is recorded too (a short payment is not only a cash matter), with its reference kept', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.gcash, amount: '99.99', ref: 'GC-558-0001' }], AT);
    expect((await receiptPayments(sale.receiptId)).map((p) => [p.tender_id, p.amount, p.change_given])).toEqual([[w.gcash, '99.99', '0.00']]);
    expect(await flags(w)).toEqual({ variance: 1, shortfall: 0 });
  });
});

// ======================================================================================================================
describe('R2 - a gap above the tolerance is a FINDING, never a refusal', () => {
  it('a 0.50 gap (paid 99.50) with tolerance 0.01 is recorded; ONE high-severity shortfall audit lists the gap and the tolerance; no variance audit [kills: refusing the big gap; the wrong severity]', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '99.50' }], AT);
    expect(await sessionStatus(sale.sessionId)).toBe('paid');
    expect((await receiptPayments(sale.receiptId)).map((p) => [p.amount, p.change_given])).toEqual([['99.50', '0.00']]);
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 1 });
    const [a] = await auditRowsOf(w.orgId, SHORTFALL);
    expect(a).toMatchObject({ entity_id: sale.receiptId, sensitivity: 'high', severity: 4 });
    const text = jsonText(a!.after);
    expect(text, 'the gap').toContain('0.50');
    expect(text, 'the tolerance in force').toContain('0.01');
  });

  it('even a wildly short payment (1.00 against 100.00) is recorded with a finding: a sale the customer already left is never lost', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '1.00' }], AT);
    expect((await receiptRow(sale.receiptId))?.total).toBe('100.00');
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 1 });
  });

  it('two payments that together fall short (cash 50.00 + GCash 49.00) are summed: a 1.00 gap, one finding', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '50.00' }, { tenderId: w.gcash, amount: '49.00', ref: 'GC-558-0002' }], AT);
    expect((await receiptPayments(sale.receiptId)).map((p) => p.change_given)).toEqual(['0.00', '0.00']);
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 1 });
    expect(jsonText((await auditRowsOf(w.orgId, SHORTFALL))[0]!.after)).toContain('1.00');
  });

  it('a payment that is zero or no payment at all is STILL refused (the rest of R9(3) stands): nothing is recorded', async () => {
    const w = await world58();
    expect(await refusalOf(sellHundred(w, [], AT))).toBe('Take between 1 and 20 payments.');
    expect(await refusalOf(sellHundred(w, [{ tenderId: w.cash, amount: '0.00' }], AT))).toBe('Each payment must be more than zero.');
    expect(await receiptCount(w.orgId)).toBe(0);
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 0 });
  });
});

// ======================================================================================================================
describe('R2 - the boundary: a gap of exactly the tolerance is a variance, one centavo above is a finding', () => {
  const cases: { tolerance: bigint; label: string; paid: string; kind: 'variance' | 'shortfall' }[] = [
    { tolerance: 1n, label: 'tolerance 0.01, gap 0.01', paid: '99.99', kind: 'variance' },
    { tolerance: 1n, label: 'tolerance 0.01, gap 0.02', paid: '99.98', kind: 'shortfall' },
    { tolerance: 10n, label: 'tolerance 0.10 (the ceiling), gap 0.10', paid: '99.90', kind: 'variance' },
    { tolerance: 10n, label: 'tolerance 0.10, gap 0.11', paid: '99.89', kind: 'shortfall' },
    { tolerance: 0n, label: 'tolerance 0 (an admin turned the allowance off), gap 0.01', paid: '99.99', kind: 'shortfall' },
  ];
  for (const c of cases) {
    it(`${c.label}: recorded as a ${c.kind} [kills: < for <= at the boundary; a tolerance hard-coded to 0.01]`, async () => {
      const w = await world58();
      const sale = await sellHundred(w, [{ tenderId: w.cash, amount: c.paid }], AT, { deps: ratesWith(c.tolerance) });
      expect(await sessionStatus(sale.sessionId)).toBe('paid');
      expect(await flags(w)).toEqual(c.kind === 'variance' ? { variance: 1, shortfall: 0 } : { variance: 0, shortfall: 1 });
    });
  }

  it('a sale paid in full, or over in cash, raises NEITHER flag (the gap is <= 0)', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '100.00' }], AT);
    const over = await sellHundred(w, [{ tenderId: w.cash, amount: '120.00' }], AT);
    expect((await receiptPayments(over.receiptId)).map((p) => [p.amount, p.change_given])).toEqual([['120.00', '20.00']]);
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 0 });
  });
});

// ======================================================================================================================
describe('R2 - the tolerance is read through the rule, on the SALE\'s business date', () => {
  it('with the real reader: a rule of 0.05 from D2 does not apply to a sale on D1 (0.05 short is a finding) and does apply to one on D2 (a variance) [kills: reading the rule at "now"; ignoring the date]', async () => {
    const w = await world58();
    await putRule(sql, w.orgId, 'pos.sale_variance_tolerance', '0.050000', D2);
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.95' }], manila(D1, '12:00'), { deps: {} });
    expect(await flags(w), 'D1: the default 0.01 is in force').toEqual({ variance: 0, shortfall: 1 });
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.95' }], manila(D2, '12:00'), { deps: {} });
    expect(await flags(w), 'D2: 0.05 is in force').toEqual({ variance: 1, shortfall: 1 });
  });

  it('with the real reader and no row at all: the registry default 0.01 holds (0.01 short is a variance, 0.02 a finding)', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], AT, { deps: {} });
    await sellHundred(w, [{ tenderId: w.cash, amount: '99.98' }], AT, { deps: {} });
    expect(await flags(w)).toEqual({ variance: 1, shortfall: 1 });
  });
});

// ======================================================================================================================
describe('R2 - an OVERPAYMENT keeps today\'s rule: change comes only from cash', () => {
  it('GCash 100.01 on 100.00 is refused "Change can only be given in cash." and nothing is written [kills: loosening the change rule when the short rule was added]', async () => {
    const w = await world58();
    expect(await refusalOf(sellHundred(w, [{ tenderId: w.gcash, amount: '100.01', ref: 'GC-558-0003' }], AT))).toBe(NOT_CASH);
    expect(await receiptCount(w.orgId)).toBe(0);
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 0 });
  });

  it('cash 100.01 on 100.00 is recorded with 0.01 change and NO variance flag (control)', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '100.01' }], AT);
    expect((await receiptPayments(sale.receiptId)).map((p) => [p.amount, p.change_given])).toEqual([['100.01', '0.01']]);
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 0 });
  });

  it('cash 10.00 + GCash 95.00 on 100.00 (5.00 change, backed by the 10.00 cash) is recorded; so is GCash 100.00 + cash 0.50 (0.50 change, backed by the 0.50 cash); neither is a variance', async () => {
    const w = await world58();
    await sellHundred(w, [{ tenderId: w.cash, amount: '10.00' }, { tenderId: w.gcash, amount: '95.00', ref: 'GC-558-0004' }], AT);
    await sellHundred(w, [{ tenderId: w.gcash, amount: '100.00', ref: 'GC-558-0005' }, { tenderId: w.cash, amount: '0.50' }], AT);
    expect(await receiptCount(w.orgId)).toBe(2);
    expect(await flags(w)).toEqual({ variance: 0, shortfall: 0 });
  });

  it('change bigger than the cash taken is refused: cash 3.00 + GCash 105.00 needs 8.00 change from 3.00 of cash', async () => {
    const w = await world58();
    expect(await refusalOf(sellHundred(w, [{ tenderId: w.cash, amount: '3.00' }, { tenderId: w.gcash, amount: '105.00', ref: 'GC-558-0006' }], AT))).toBe(NOT_CASH);
    expect(await receiptCount(w.orgId)).toBe(0);
  });
});

// ======================================================================================================================
describe('R2 - the two audit actions are in the catalogue', () => {
  it('pos.sale_payment_variance is a low-sensitivity money action of T-558; pos.sale_payment_shortfall is a high-sensitivity money action of T-558', () => {
    expect(catalogueEntry(VARIANCE), VARIANCE).toMatchObject({ category: 'money', sensitivity: 'low', scope: 'store', owner: 'T-558' });
    expect(catalogueEntry(SHORTFALL), SHORTFALL).toMatchObject({ category: 'money', sensitivity: 'high', scope: 'store', owner: 'T-558' });
  });
});

// ======================================================================================================================
describe('R2 - the money truth is unchanged by a short payment', () => {
  it('the receipt total is the SERVER\'s figure whatever was paid: it never becomes the amount taken', async () => {
    const w = await world58();
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '99.50' }], AT);
    expect((await receiptRow(sale.receiptId))?.total).toBe('100.00');
  });

  it('completeSale called twice with one input records ONE receipt and ONE flag (the replay is a no-op)', async () => {
    const w = await world58();
    let input: Parameters<typeof completeSale>[2] | undefined;
    const sale = await sellHundred(w, [{ tenderId: w.cash, amount: '99.99' }], AT, {
      mutate: (i) => {
        input = JSON.parse(JSON.stringify(i)) as Parameters<typeof completeSale>[2];
      },
    });
    const again = await asOrg(w.orgId, (tx) => completeSale(tx, w.counter, input!, { ...ratesWith(1n), now: () => AT }));
    expect(again).toEqual({ wrote: false, receiptId: sale.receiptId });
    expect(await receiptCount(w.orgId)).toBe(1);
    expect(await flags(w)).toEqual({ variance: 1, shortfall: 0 });
  });
});
