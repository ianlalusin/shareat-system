import { describe, expect, it } from 'vitest';
import { ZERO, money, type Money } from '@shareat/core/money';
import {
  computeStatutory,
  monthlyContribution,
  withholdingTax,
  type Agency,
  type AgencyPrior,
  type ContributionRate,
  type WithholdingBracket,
} from './statutory';

/**
 * T-190 S2 - the statutory ENGINE. `docs/tasks/190-payroll-statutory.md` ("Cases", "Semi-monthly and weekly").
 * Pure: rate ROWS and month-to-date totals go in, peso amounts come out. **No rate, ceiling, step or bracket
 * lives in `statutory.ts`** - every figure below is arithmetic from the rows passed in, so the second test of
 * each family feeds a DIFFERENT table and must get a different answer (the "hard-coded constants" mutant).
 *
 * THE CONTRACT THIS FILE PINS (the builder implements exactly this; names are the tester's, figures are the spec's):
 *   monthlyContribution(rate, mtdBase)  -> { ee, er, ec }   the FULL monthly figure for a month-to-date base
 *   withholdingTax(brackets, taxable)   -> Money            bracket = last row with `over` < taxable (nil if none)
 *   computeStatutory(input)             -> StatutoryResult  one payslip: monthly figure minus what `prior` already
 *                                                           deducted this month, floor 0; then cut/withhold/advance.
 * `prior[agency]` = sums over the person's POSTED, non-voided payslips of the month WHERE THAT AGENCY WAS DEDUCTED.
 * Rates are the table's strings ('0.05'); brackets are unsorted-tolerant.
 */

const row = (over: Partial<ContributionRate> & Pick<ContributionRate, 'agency'>): ContributionRate => ({
  id: `rate-${over.agency}`,
  effectiveFrom: '2026-01-01',
  eeRate: '0',
  erRate: '0',
  baseKind: 'basic',
  floor: null,
  ceiling: null,
  step: null,
  lowThreshold: null,
  lowEeRate: null,
  ecThreshold: null,
  ecLow: null,
  ecHigh: null,
  ...over,
});

const SSS = row({
  agency: 'sss', eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', step: '500',
  ecThreshold: '15000', ecLow: '10', ecHigh: '30',
});
const PH = row({ agency: 'philhealth', eeRate: '0.025', erRate: '0.025', baseKind: 'basic', floor: '10000', ceiling: '100000' });
const PI = row({
  agency: 'pagibig', eeRate: '0.02', erRate: '0.02', baseKind: 'basic', floor: '0', ceiling: '10000',
  lowThreshold: '1500', lowEeRate: '0.01',
});
const RATES: Record<Agency, ContributionRate> = { sss: SSS, philhealth: PH, pagibig: PI };

/** Semi-monthly TRAIN table, RR 11-2018 Annex E "1 Jan 2023 onwards". */
const SEMI: WithholdingBracket[] = [
  { over: '0', baseTax: '0', rate: '0' },
  { over: '10417', baseTax: '0', rate: '0.15' },
  { over: '16667', baseTax: '937.50', rate: '0.20' },
  { over: '33333', baseTax: '4270.70', rate: '0.25' },
  { over: '83333', baseTax: '16770.70', rate: '0.30' },
  { over: '333333', baseTax: '91770.70', rate: '0.35' },
];
/** Only what the weekly case needs: nil up to 4,808. */
const WEEKLY: WithholdingBracket[] = [
  { over: '0', baseTax: '0', rate: '0' },
  { over: '4808', baseTax: '0', rate: '0.15' },
];

const zeroPrior = (): AgencyPrior => ({ base: ZERO, ee: ZERO, er: ZERO, ec: ZERO });
const priors = (over: Partial<Record<Agency, AgencyPrior>> = {}): Record<Agency, AgencyPrior> => ({
  sss: zeroPrior(), philhealth: zeroPrior(), pagibig: zeroPrior(), ...over,
});
const P = (base: string, ee: string, er: string, ec = '0'): AgencyPrior => ({
  base: money(base), ee: money(ee), er: money(er), ec: money(ec),
});

function run(over: {
  basic: string; gross?: string; isMwe?: boolean; prior?: Record<Agency, AgencyPrior>; skipped?: Agency[];
  brackets?: WithholdingBracket[]; advance?: string; rates?: Record<Agency, ContributionRate>;
}) {
  return computeStatutory({
    basicPay: money(over.basic),
    grossPay: money(over.gross ?? over.basic),
    isMwe: over.isMwe ?? false,
    rates: over.rates ?? RATES,
    prior: over.prior ?? priors(),
    skipped: over.skipped ?? [],
    brackets: over.brackets ?? SEMI,
    advanceOutstanding: money(over.advance ?? '0'),
  });
}

describe('SSS - MSC, ceiling, EC (all read from the row)', () => {
  it('case 1: base 10,400 -> MSC 10,500 -> ee 525.00, er 1,050.00, EC 10.00  [mutant: v1 4.5% / 30,000 -> 472.50]', () => {
    expect(monthlyContribution(SSS, money('10400.00'))).toEqual({ ee: '525.00', er: '1050.00', ec: '10.00' });
  });
  it('case 2: month-to-date 20,800 -> MSC 21,000 -> ee 1,050.00, er 2,100.00, EC 30.00', () => {
    expect(monthlyContribution(SSS, money('20800.00'))).toEqual({ ee: '1050.00', er: '2100.00', ec: '30.00' });
  });
  it('case 5: month-to-date 40,000 is capped at the 35,000 ceiling -> ee 1,750.00  [mutant: ceiling dropped -> 2,000]', () => {
    expect(monthlyContribution(SSS, money('40000.00'))).toEqual({ ee: '1750.00', er: '3500.00', ec: '30.00' });
  });
  it('floor: 400 pays on the 5,000 floor -> ee 250.00, er 500.00, EC 10.00', () => {
    expect(monthlyContribution(SSS, money('400.00'))).toEqual({ ee: '250.00', er: '500.00', ec: '10.00' });
  });
  it('MSC rounds to the nearest 500, HALF UP: 10,250.00 -> 10,500; 10,249.99 -> 10,000', () => {
    expect(monthlyContribution(SSS, money('10250.00')).ee).toBe('525.00');
    expect(monthlyContribution(SSS, money('10249.99')).ee).toBe('500.00');
  });
  it('EC is chosen by the MSC, not the raw base: 14,749.99 -> MSC 14,500 -> 10.00; 14,750.00 -> MSC 15,000 -> 30.00', () => {
    expect(monthlyContribution(SSS, money('14749.99')).ec).toBe('10.00');
    expect(monthlyContribution(SSS, money('14750.00')).ec).toBe('30.00');
  });
  it('NO CONSTANTS IN CODE: the same base on a 6% / 12% row with a 1,000 step gives that row\'s answer', () => {
    const r = row({ agency: 'sss', eeRate: '0.06', erRate: '0.12', baseKind: 'gross', floor: '5000', ceiling: '35000', step: '1000', ecThreshold: '15000', ecLow: '10', ecHigh: '30' });
    // 10,400 -> nearest 1,000 -> 10,000 -> 600.00 / 1,200.00
    expect(monthlyContribution(r, money('10400.00'))).toEqual({ ee: '600.00', er: '1200.00', ec: '10.00' });
  });
});

describe('PhilHealth - rate on the base, floor, ceiling', () => {
  it('case 1: 10,400 -> ee 260.00, er 260.00', () => {
    expect(monthlyContribution(PH, money('10400.00'))).toEqual({ ee: '260.00', er: '260.00', ec: '0.00' });
  });
  it('floor 10,000: a 9,035 base pays on 10,000 -> 250.00 each', () => {
    expect(monthlyContribution(PH, money('9035.00'))).toEqual({ ee: '250.00', er: '250.00', ec: '0.00' });
  });
  it('ceiling 100,000: 120,000 pays on 100,000 -> 2,500.00 each', () => {
    expect(monthlyContribution(PH, money('120000.00'))).toEqual({ ee: '2500.00', er: '2500.00', ec: '0.00' });
  });
  it('NO CONSTANTS IN CODE: a 2% / 2% row, floor 8,000 -> 160.00 each on 7,000', () => {
    const r = row({ agency: 'philhealth', eeRate: '0.02', erRate: '0.02', floor: '8000', ceiling: '100000' });
    expect(monthlyContribution(r, money('7000.00')).ee).toBe('160.00');
  });
});

describe('Pag-IBIG - low band, cap', () => {
  it('case 9: 700 is under the 1,500 low band -> ee 1% = 7.00, er 2% = 14.00  [mutant: er at 1%]', () => {
    expect(monthlyContribution(PI, money('700.00'))).toEqual({ ee: '7.00', er: '14.00', ec: '0.00' });
  });
  it('the band edge: 1,500.00 is still low (ee 15.00); 1,500.01 is not (ee 30.00); er is 2% either way', () => {
    expect(monthlyContribution(PI, money('1500.00'))).toEqual({ ee: '15.00', er: '30.00', ec: '0.00' });
    expect(monthlyContribution(PI, money('1500.01')).ee).toBe('30.00');
  });
  it('case 1: 10,400 is capped at 10,000 -> 200.00 each', () => {
    expect(monthlyContribution(PI, money('10400.00'))).toEqual({ ee: '200.00', er: '200.00', ec: '0.00' });
  });
});

describe('withholding - bracket table passed in', () => {
  it('case 1: 9,415.00 is under the nil bracket -> 0.00', () => {
    expect(withholdingTax(SEMI, money('9415.00'))).toBe('0.00');
  });
  it('case 4: 18,300.00 -> 937.50 + 20% of 1,633 = 1,264.10  [mutant: tax on gross 20,000 -> 1,604.10]', () => {
    expect(withholdingTax(SEMI, money('18300.00'))).toBe('1264.10');
  });
  it('case 7: 11,747.04 -> 15% of 1,330.04 = 199.506 -> 199.51 (rounded half up, once)', () => {
    expect(withholdingTax(SEMI, money('11747.04'))).toBe('199.51');
  });
  it('the bracket edges: 10,417.00 -> 0.00; 16,667.00 -> 937.50; 33,333.00 -> 4,270.70', () => {
    expect(withholdingTax(SEMI, money('10417.00'))).toBe('0.00');
    expect(withholdingTax(SEMI, money('16667.00'))).toBe('937.50');
    expect(withholdingTax(SEMI, money('33333.00'))).toBe('4270.70');
  });
  it('the 25% and the top bracket: 40,000.00 -> 5,937.45; 400,000.00 -> 91,770.70 + 35% of 66,667 = 115,103.15', () => {
    expect(withholdingTax(SEMI, money('40000.00'))).toBe('5937.45');
    expect(withholdingTax(SEMI, money('400000.00'))).toBe('115104.15');
  });
  it('rows may arrive in any order', () => {
    expect(withholdingTax([...SEMI].reverse(), money('18300.00'))).toBe('1264.10');
  });
  it('zero taxable pays nothing', () => {
    expect(withholdingTax(SEMI, ZERO)).toBe('0.00');
  });
});

describe('computeStatutory - one payslip', () => {
  it('case 1: first half 10,400 -> every line, taxable 9,415.00, net 9,415.00', () => {
    const r = run({ basic: '10400.00' });
    expect(r.sss).toEqual({ ee: '525.00', er: '1050.00', ec: '10.00' });
    expect(r.philhealth).toEqual({ ee: '260.00', er: '260.00' });
    expect(r.pagibig).toEqual({ ee: '200.00', er: '200.00' });
    expect(r.taxablePay).toBe('9415.00');
    expect(r.withholding).toBe('0.00');
    expect(r.advanceRecovered).toBe('0.00');
    expect(r.netPay).toBe('9415.00');
  });

  it('case 2: second half, same pay, month-to-date 20,800 -> the DIFFERENCE: sss 525/1,050/20, ph 260/260, pagibig 0/0, net 9,615.00  [mutant: period base -> pagibig 200 again]', () => {
    const r = run({
      basic: '10400.00',
      prior: priors({ sss: P('10400', '525', '1050', '10'), philhealth: P('10400', '260', '260'), pagibig: P('10400', '200', '200') }),
    });
    expect(r.sss).toEqual({ ee: '525.00', er: '1050.00', ec: '20.00' });
    expect(r.philhealth).toEqual({ ee: '260.00', er: '260.00' });
    expect(r.pagibig).toEqual({ ee: '0.00', er: '0.00' });
    expect(r.netPay).toBe('9615.00');
  });

  it('case 4: 20,000 first half -> 1,000 / 500 / 200, taxable 18,300.00, withholding 1,264.10, net 17,035.90', () => {
    const r = run({ basic: '20000.00' });
    expect(r.sss.ee).toBe('1000.00');
    expect(r.philhealth.ee).toBe('500.00');
    expect(r.pagibig.ee).toBe('200.00');
    expect(r.taxablePay).toBe('18300.00');
    expect(r.withholding).toBe('1264.10');
    expect(r.netPay).toBe('17035.90');
  });

  it('case 5: same person second half (month-to-date 40,000) -> SSS 1,750 - 1,000 = 750.00  [mutant: ceiling dropped -> 1,000.00]', () => {
    const r = run({
      basic: '20000.00',
      prior: priors({ sss: P('20000', '1000', '2000', '30'), philhealth: P('20000', '500', '500'), pagibig: P('20000', '200', '200') }),
    });
    expect(r.sss.ee).toBe('750.00');
    expect(r.sss.er).toBe('1500.00');
    expect(r.philhealth.ee).toBe('500.00');
    expect(r.pagibig.ee).toBe('0.00');
    // taxable 20,000 - 750 - 500 = 18,750 -> 937.50 + 20% of 2,083 = 1,354.10
    expect(r.taxablePay).toBe('18750.00');
    expect(r.withholding).toBe('1354.10');
  });

  it('case 6: MWE - SSS on GROSS 12,815 (MSC 13,000) 650; PhilHealth on basic 9,035 floors to 250; Pag-IBIG 180.70; withholding 0.00  [mutant: MWE ignored -> 197.60]', () => {
    const r = run({ basic: '9035.00', gross: '12815.00', isMwe: true });
    expect(r.sss.ee).toBe('650.00');
    expect(r.philhealth.ee).toBe('250.00');
    expect(r.pagibig.ee).toBe('180.70');
    expect(r.withholding).toBe('0.00');
    expect(r.netPay).toBe('11734.30');
  });

  it('case 7: one peso above the minimum is NOT MWE - Pag-IBIG 180.96, taxable 11,747.04, withholding 199.51, net 11,547.53', () => {
    const r = run({ basic: '9048.00', gross: '12828.00', isMwe: false });
    expect(r.sss.ee).toBe('650.00');
    expect(r.philhealth.ee).toBe('250.00');
    expect(r.pagibig.ee).toBe('180.96');
    expect(r.taxablePay).toBe('11747.04');
    expect(r.withholding).toBe('199.51');
    expect(r.netPay).toBe('11547.53');
  });

  it('case 8: statutory BEFORE the advance - 1,600 pay, 2,000 owed -> 250 + 250 + 32 = 532, advance recovered 1,068.00, net 0.00  [mutant: advance first]', () => {
    const r = run({ basic: '1600.00', advance: '2000.00' });
    expect(r.sss.ee).toBe('250.00');
    expect(r.philhealth.ee).toBe('250.00');
    expect(r.pagibig.ee).toBe('32.00');
    expect(r.taxablePay).toBe('1068.00');
    expect(r.advanceRecovered).toBe('1068.00');
    expect(r.netPay).toBe('0.00');
  });

  it('case 16: a skipped agency is ZERO on BOTH sides - no SSS: ee/er/EC 0, taxable 9,940.00, net 9,940.00  [mutant: only the employee share skipped]', () => {
    const r = run({ basic: '10400.00', skipped: ['sss'] });
    expect(r.sss).toEqual({ ee: '0.00', er: '0.00', ec: '0.00' });
    expect(r.philhealth).toEqual({ ee: '260.00', er: '260.00' });
    expect(r.pagibig).toEqual({ ee: '200.00', er: '200.00' });
    expect(r.taxablePay).toBe('9940.00');
    expect(r.netPay).toBe('9940.00');
  });

  it('case 17: no back-deduction - first half skipped (prior SSS all zero), second half 10,400 -> SSS 525.00 / 1,050.00 / 10.00 while PhilHealth is the difference 260.00', () => {
    const r = run({
      basic: '10400.00',
      prior: priors({ sss: zeroPrior(), philhealth: P('10400', '260', '260'), pagibig: P('10400', '200', '200') }),
    });
    expect(r.sss).toEqual({ ee: '525.00', er: '1050.00', ec: '10.00' });
    expect(r.philhealth.ee).toBe('260.00');
    expect(r.pagibig.ee).toBe('0.00');
  });

  it('case 18: contributions exceed gross - 400 pay: SSS cut to 146.00, PhilHealth 250.00, Pag-IBIG 4.00, net 0.00; the EMPLOYER share posts in full  [mutant: proportional scale (198.41) or employer cut]', () => {
    const r = run({ basic: '400.00' });
    expect(r.sss.ee).toBe('146.00');
    expect(r.philhealth.ee).toBe('250.00');
    expect(r.pagibig.ee).toBe('4.00');
    expect(r.netPay).toBe('0.00');
    expect(r.taxablePay).toBe('0.00');
    expect(r.sss.er).toBe('500.00');
    expect(r.sss.ec).toBe('10.00');
    expect(r.philhealth.er).toBe('250.00');
    expect(r.pagibig.er).toBe('8.00');
  });

  it('the cut runs SSS -> PhilHealth -> Pag-IBIG: 200 pay -> SSS 0.00, PhilHealth 198.00, Pag-IBIG 2.00, net 0.00', () => {
    const r = run({ basic: '200.00' });
    expect(r.sss.ee).toBe('0.00');
    expect(r.philhealth.ee).toBe('198.00');
    expect(r.pagibig.ee).toBe('2.00');
    expect(r.netPay).toBe('0.00');
    expect(r.sss.er).toBe('500.00');
  });

  it('a cut share is RETRIED by the next payslip of the month: first 400 (SSS cut to 146), then 10,400 -> SSS monthly(10,800 -> MSC 11,000) 550 - 146 = 404.00', () => {
    const first = run({ basic: '400.00' });
    const r = run({
      basic: '10400.00',
      prior: priors({
        sss: { base: money('400'), ee: money(first.sss.ee), er: money(first.sss.er), ec: money(first.sss.ec) },
        philhealth: { base: money('400'), ee: money(first.philhealth.ee), er: money(first.philhealth.er), ec: ZERO },
        pagibig: { base: money('400'), ee: money(first.pagibig.ee), er: money(first.pagibig.er), ec: ZERO },
      }),
    });
    expect(r.sss.ee).toBe('404.00');
  });

  it('NO CONSTANTS IN CODE: the whole slip on a 6%-SSS table is that table\'s answer (case 12\'s engine half)', () => {
    const six = { ...SSS, eeRate: '0.06' };
    const r = run({ basic: '10400.00', rates: { sss: six, philhealth: PH, pagibig: PI } });
    expect(r.sss.ee).toBe('630.00');
    expect(r.sss.er).toBe('1050.00');
  });

  it('the result never goes negative: a month whose prior already exceeds the monthly figure (120 owed, 200 taken) deducts 0.00, not a refund', () => {
    const r = run({ basic: '1000.00', prior: priors({ pagibig: P('5000', '200', '200') }) });
    expect(r.pagibig).toEqual({ ee: '0.00', er: '0.00' });
  });
});

describe('case 19 - weekly store, five paydays of 4,000 basic (month-to-date true-up, not "2nd run only")', () => {
  it('SSS ee 250/150/200/200/200, PhilHealth ee 250/0/50/100/100, Pag-IBIG ee 80/80/40/0/0, withholding 0 each week; totals are the MONTHLY figures', () => {
    const acc: Record<Agency, AgencyPrior> = priors();
    const out: Record<'sss' | 'philhealth' | 'pagibig' | 'tax', string[]> = { sss: [], philhealth: [], pagibig: [], tax: [] };
    let er = { sss: ZERO as Money, ph: ZERO as Money, pi: ZERO as Money, ec: ZERO as Money };
    const add = (a: Money, b: string): Money => money((Number(a) + Number(b)).toFixed(2));
    for (let week = 1; week <= 5; week++) {
      const r = run({ basic: '4000.00', brackets: WEEKLY, prior: structuredClone(acc) });
      out.sss.push(r.sss.ee); out.philhealth.push(r.philhealth.ee); out.pagibig.push(r.pagibig.ee); out.tax.push(r.withholding);
      acc.sss = { base: add(acc.sss.base, '4000'), ee: add(acc.sss.ee, r.sss.ee), er: add(acc.sss.er, r.sss.er), ec: add(acc.sss.ec, r.sss.ec) };
      acc.philhealth = { base: add(acc.philhealth.base, '4000'), ee: add(acc.philhealth.ee, r.philhealth.ee), er: add(acc.philhealth.er, r.philhealth.er), ec: ZERO };
      acc.pagibig = { base: add(acc.pagibig.base, '4000'), ee: add(acc.pagibig.ee, r.pagibig.ee), er: add(acc.pagibig.er, r.pagibig.er), ec: ZERO };
      er = { sss: add(er.sss, r.sss.er), ph: add(er.ph, r.philhealth.er), pi: add(er.pi, r.pagibig.er), ec: add(er.ec, r.sss.ec) };
    }
    expect(out.sss).toEqual(['250.00', '150.00', '200.00', '200.00', '200.00']);
    expect(out.philhealth).toEqual(['250.00', '0.00', '50.00', '100.00', '100.00']);
    expect(out.pagibig).toEqual(['80.00', '80.00', '40.00', '0.00', '0.00']);
    expect(out.tax).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00']);
    // The month lands the exact monthly figure: base 20,000 -> SSS er 2,000 + EC 30, PhilHealth er 500, Pag-IBIG er 200.
    expect([er.sss, er.ph, er.pi, er.ec]).toEqual(['2000.00', '500.00', '200.00', '30.00']);
  });
});
