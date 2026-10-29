/**
 * T-440 field rules for app/payroll: the pay-rate row, the statutory rate / withholding table / minimum wage add forms and the
 * separation post form. Server sentences that already existed are kept verbatim through `requires`.
 */
import { defineFieldRules } from './check';

const EFFECTIVE_DATE_SAYS = 'The effective date must be a date, like 2026-07-01.';

/** One pay-rate row on /payroll. */
export const PAYROLL_PAY_RATE_RULES = defineFieldRules('payroll.setPayRate', {
  amount: { label: 'The pay rate', kind: 'money', min: 0.01 },
  effectiveFrom: { label: 'The effective date', kind: 'date', requires: EFFECTIVE_DATE_SAYS },
});

/** Add a contribution row (SSS / PhilHealth / Pag-IBIG). Rates are numbers; the domain keeps its four-decimal-place check. */
export const PAYROLL_STATUTORY_RATE_RULES = defineFieldRules('payroll.addStatutoryRate', {
  effectiveFrom: { label: 'The effective date', kind: 'date', requires: EFFECTIVE_DATE_SAYS },
  eeRate: { label: 'The employee rate', kind: 'number', min: 0 },
  erRate: { label: 'The employer rate', kind: 'number', min: 0 },
  floor: { label: 'The floor', optional: true, kind: 'money' },
  ceiling: { label: 'The ceiling', optional: true, kind: 'money' },
  step: { label: 'The step', optional: true, kind: 'money' },
  lowThreshold: { label: 'The low-band threshold', optional: true, kind: 'money' },
  lowEeRate: { label: 'The low-band employee rate', optional: true, kind: 'number', min: 0 },
  ecThreshold: { label: 'The EC threshold', optional: true, kind: 'money' },
  ecLow: { label: 'The lower EC amount', optional: true, kind: 'money' },
  ecHigh: { label: 'The higher EC amount', optional: true, kind: 'money' },
  sourceRef: { label: 'The source', kind: 'text', requires: 'Say where this rate comes from (the circular or law), so it can be checked.' },
});

/** Add a withholding tax table. */
export const PAYROLL_BRACKET_SET_RULES = defineFieldRules('payroll.addWithholdingBracketSet', {
  effectiveFrom: { label: 'The effective date', kind: 'date', requires: EFFECTIVE_DATE_SAYS },
  rows: { label: 'The bracket rows', kind: 'text', requires: 'Give the bracket rows, one per line.' },
  sourceRef: { label: 'The source', kind: 'text', requires: 'Say where the table comes from.' },
});

/** Add a store's minimum wage. */
export const PAYROLL_MIN_WAGE_RULES = defineFieldRules('payroll.addMinimumWage', {
  effectiveFrom: { label: 'The effective date', kind: 'date', requires: EFFECTIVE_DATE_SAYS },
  dailyRate: { label: 'The minimum daily wage', kind: 'money', min: 0.01 },
  wageOrderRef: { label: 'The wage order', kind: 'text' },
});

/** Post a separation. A blank separation pay is left to the column default (T-371 R6), so it is optional here. */
export const PAYROLL_SEPARATION_RULES = defineFieldRules('payroll.postSeparation', {
  separationPayAmount: { label: 'The separation pay', optional: true, kind: 'money', min: 0 },
});

/** T-193: record a payment to SSS / PhilHealth / Pag-IBIG / BIR. The per-store amounts are judged line by line in the domain. */
export const PAYROLL_STATUTORY_PAYMENT_RULES = defineFieldRules('payroll.recordStatutoryPayment', {
  month: { label: 'The month', kind: 'date', requires: 'Choose the month this payment is for.' },
  paidOn: { label: 'The payment date', kind: 'date', requires: 'The payment date must be a date, like 2026-11-10.' },
  referenceNo: { label: 'The agency receipt number', kind: 'text', requires: 'Enter the agency receipt or payment reference number.' },
  penalty: { label: 'The penalty', optional: true, kind: 'money', min: 0 },
  notes: { label: 'The notes', optional: true, kind: 'text' },
});
