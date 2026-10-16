/**
 * The statutory engine - T-190 S2. `docs/tasks/190-payroll-statutory.md`.
 *
 * PURE: rate ROWS and month-to-date totals go in, peso amounts come out. ⛔ **No rate, ceiling, step, floor or bracket lives in
 * this file** - every figure is arithmetic on the rows passed in (the rows are the accountant's confirmed data, effective-dated).
 *
 * The rule (spec "Semi-monthly and weekly: month-to-date true-up"): contributions are MONTHLY obligations. For each agency and side:
 *   1. month-to-date base = this payslip's base + the base of the person's earlier payslips that month where the agency WAS deducted;
 *   2. the monthly figure = the table applied to that base, rounded half-up to the centavo, once;
 *   3. this payslip = the monthly figure minus what was already deducted that month, floor 0.
 * Then the employee shares are cut (SSS -> PhilHealth -> Pag-IBIG) until they fit inside the gross, withholding is taken on the rest,
 * and only then is an advance recovered, so net never goes below zero. The employer share always posts in full.
 */
import { ZERO, add, compare, fromCentavos, money, multiply, subtract, toCentavos, type Money } from '@shareat/core/money';
import { advanceToRecover } from './compute';

export type Agency = 'sss' | 'philhealth' | 'pagibig';
export const AGENCIES: readonly Agency[] = ['sss', 'philhealth', 'pagibig'];

/** One row of `statutory_rates`, as the engine reads it (numerics arrive as their table strings). */
export interface ContributionRate {
  id: string;
  agency: Agency;
  effectiveFrom: string;
  eeRate: string;
  erRate: string;
  baseKind: 'gross' | 'basic';
  floor: string | null;
  ceiling: string | null;
  step: string | null;
  lowThreshold: string | null;
  lowEeRate: string | null;
  ecThreshold: string | null;
  ecLow: string | null;
  ecHigh: string | null;
}

/** One row of `withholding_brackets`: tax = baseTax + rate x (taxable - over) for the last row whose `over` is below the taxable pay. */
export interface WithholdingBracket {
  over: string;
  baseTax: string;
  rate: string;
}

/** What the person's earlier payslips of the month deducted for one agency (only payslips where the agency WAS deducted). */
export interface AgencyPrior {
  base: Money;
  ee: Money;
  er: Money;
  ec: Money;
}

export interface MonthlyContribution {
  ee: Money;
  er: Money;
  ec: Money;
}

function mulHalfUp(amount: Money, rate: string): Money {
  return multiply(amount, rate);
}

/** Rounds `base` to the nearest `step`, half up. */
function toStep(base: Money, step: Money): Money {
  const b = toCentavos(base);
  const s = toCentavos(step);
  const units = (b * 2n + s) / (s * 2n); // floor((b/s) + 1/2): half up for non-negative b
  return fromCentavos(units * s);
}

/**
 * The FULL monthly figure for a month-to-date base: compensation rounded to the row's step (if any), clamped to its floor and
 * ceiling, then the employee and employer rates (Pag-IBIG's low band swaps the employee rate), plus the employer-only EC chosen by
 * the compensation bracket. A non-positive base owes nothing.
 */
export function monthlyContribution(rate: ContributionRate, mtdBase: Money): MonthlyContribution {
  if (compare(mtdBase, ZERO) <= 0) return { ee: ZERO, er: ZERO, ec: ZERO };
  let comp: Money = rate.step !== null ? toStep(mtdBase, money(rate.step)) : mtdBase;
  if (rate.floor !== null && compare(comp, money(rate.floor)) < 0) comp = money(rate.floor);
  if (rate.ceiling !== null && compare(comp, money(rate.ceiling)) > 0) comp = money(rate.ceiling);
  const low = rate.lowThreshold !== null && rate.lowEeRate !== null && compare(mtdBase, money(rate.lowThreshold)) <= 0;
  const ee = mulHalfUp(comp, low ? rate.lowEeRate! : rate.eeRate);
  const er = mulHalfUp(comp, rate.erRate);
  const ec =
    rate.ecThreshold !== null && rate.ecLow !== null && rate.ecHigh !== null
      ? compare(comp, money(rate.ecThreshold)) < 0
        ? money(rate.ecLow)
        : money(rate.ecHigh)
      : ZERO;
  return { ee, er, ec };
}

/** The withholding tax on a payroll period's taxable pay, from a bracket table (rows in any order). Zero when no row is below it. */
export function withholdingTax(brackets: readonly WithholdingBracket[], taxable: Money): Money {
  if (compare(taxable, ZERO) <= 0) return ZERO;
  let hit: WithholdingBracket | null = null;
  let hitOver: Money | null = null;
  for (const b of brackets) {
    const over = money(b.over);
    if (compare(over, taxable) < 0 && (hitOver === null || compare(over, hitOver) > 0)) {
      hit = b;
      hitOver = over;
    }
  }
  if (!hit || !hitOver) return ZERO;
  return add(money(hit.baseTax), mulHalfUp(subtract(taxable, hitOver), hit.rate));
}

export interface StatutoryInput {
  basicPay: Money;
  grossPay: Money;
  /** The daily rate is at or under the store's minimum wage: the pay is exempt from withholding (contributions still apply). */
  isMwe: boolean;
  rates: Record<Agency, ContributionRate>;
  prior: Record<Agency, AgencyPrior>;
  /** Agencies with no number on file: both shares are zero. */
  skipped: readonly Agency[];
  brackets: readonly WithholdingBracket[];
  advanceOutstanding: Money;
}

export interface StatutoryResult {
  sss: { ee: Money; er: Money; ec: Money };
  philhealth: { ee: Money; er: Money };
  pagibig: { ee: Money; er: Money };
  taxablePay: Money;
  withholding: Money;
  advanceRecovered: Money;
  netPay: Money;
}

function nonNegativeDifference(figure: Money, already: Money): Money {
  const d = subtract(figure, already);
  return compare(d, ZERO) < 0 ? ZERO : d;
}

/** One payslip: every statutory line, the withholding, the advance and the net. */
export function computeStatutory(input: StatutoryInput): StatutoryResult {
  const shareOf = (agency: Agency): MonthlyContribution => {
    if (input.skipped.includes(agency)) return { ee: ZERO, er: ZERO, ec: ZERO };
    const rate = input.rates[agency];
    const base = rate.baseKind === 'gross' ? input.grossPay : input.basicPay;
    const prior = input.prior[agency];
    const monthly = monthlyContribution(rate, add(prior.base, base));
    return {
      ee: nonNegativeDifference(monthly.ee, prior.ee),
      er: nonNegativeDifference(monthly.er, prior.er),
      ec: nonNegativeDifference(monthly.ec, prior.ec),
    };
  };
  const shares: Record<Agency, MonthlyContribution> = { sss: shareOf('sss'), philhealth: shareOf('philhealth'), pagibig: shareOf('pagibig') };

  // The employee shares must fit inside the gross: cut SSS first, then PhilHealth, then Pag-IBIG; never proportionally, never the employer.
  let excess = subtract(add(shares.sss.ee, shares.philhealth.ee, shares.pagibig.ee), input.grossPay);
  for (const agency of AGENCIES) {
    if (compare(excess, ZERO) <= 0) break;
    const cut = compare(shares[agency].ee, excess) < 0 ? shares[agency].ee : excess;
    shares[agency] = { ...shares[agency], ee: subtract(shares[agency].ee, cut) };
    excess = subtract(excess, cut);
  }

  const eeTotal = add(shares.sss.ee, shares.philhealth.ee, shares.pagibig.ee);
  const taxablePay = input.isMwe ? ZERO : subtract(input.grossPay, eeTotal);
  const withholding = input.isMwe ? ZERO : withholdingTax(input.brackets, taxablePay);
  const afterTax = subtract(subtract(input.grossPay, eeTotal), withholding);
  const advanceRecovered = advanceToRecover(afterTax, input.advanceOutstanding);
  const netPay = subtract(afterTax, advanceRecovered);

  return {
    sss: shares.sss,
    philhealth: { ee: shares.philhealth.ee, er: shares.philhealth.er },
    pagibig: { ee: shares.pagibig.ee, er: shares.pagibig.er },
    taxablePay,
    withholding,
    advanceRecovered,
    netPay,
  };
}
