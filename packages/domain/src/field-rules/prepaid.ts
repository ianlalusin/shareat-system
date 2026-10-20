/**
 * T-440 field rules for app/prepaid: record an item, confirm its term, release months, reverse a month, end it early.
 */
import { defineFieldRules } from './check';

/** "Record a prepaid item" (createPrepaidItemAction). The ceiling of 120 months is the domain's own. */
export const PREPAID_ADD_RULES = defineFieldRules('prepaid.createPrepaidItem', {
  name: { label: 'The name', kind: 'text', max: 120 },
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  totalCost: { label: 'The total cost', kind: 'money', min: 0.01, requires: 'The total cost must be an amount greater than zero.' },
  coverageStartDate: { label: 'The coverage start', kind: 'date' },
  coverageMonths: { label: 'The coverage in months', kind: 'number', integer: true, min: 1, max: 120 },
});

/** "Confirm term" on an item that needs review (confirmTermAction). */
export const PREPAID_TERM_RULES = defineFieldRules('prepaid.confirmPrepaidTerm', {
  coverageStartDate: { label: 'The coverage start', kind: 'date' },
  coverageMonths: { label: 'The coverage in months', kind: 'number', integer: true, min: 1, max: 120 },
});

/** "Release through" (amortiseAction): a month, written YYYY-MM. */
export const PREPAID_RELEASE_RULES = defineFieldRules('prepaid.amortisePrepaidItem', {
  asOfPeriod: {
    label: 'The release month',
    kind: 'pattern',
    pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
    patternSays: 'a month written like 2026-10',
  },
});

/** The reason box beside a released month (reverseMonthAction). */
export const PREPAID_MONTH_REVERSE_RULES = defineFieldRules('prepaid.reverseAmortisation', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this month is being reversed.' },
});

/** "End it early" (writeOffAction). The refund account is a pick-list and stays a server check. */
export const PREPAID_WRITE_OFF_RULES = defineFieldRules('prepaid.writeOffPrepaidItem', {
  writtenOffOn: { label: 'The write-off date', kind: 'date' },
  reason: { label: 'The reason', kind: 'text', max: 200 },
  refundAmount: { label: 'The refund amount', optional: true, kind: 'money', min: 0 },
});
