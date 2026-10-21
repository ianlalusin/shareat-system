/**
 * T-440 field rules for app/loans: record the agreement, draw the money, record a payment, reverse an entry.
 */
import { defineFieldRules } from './check';

/** "Record a loan" (createLoanAction). The interest-rate shape is the domain's own (".5" and "1." stay valid); its ceiling stays the domain's. */
export const LOAN_ADD_RULES = defineFieldRules('loans.createLoan', {
  name: { label: 'The loan name', kind: 'text', max: 120 },
  lenderName: { label: 'The lender', kind: 'text', max: 120 },
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  principalAmount: { label: 'The amount agreed', kind: 'money', min: 0.01, requires: 'The amount agreed must be an amount greater than zero.' },
  interestRate: {
    label: 'The interest rate',
    kind: 'pattern',
    pattern: '^(?=.*\\d)\\d*(?:\\.\\d{0,4})?$',
    patternSays: 'a number from 0 to 9999.9999 with up to four decimal places',
  },
  ratePeriod: { label: 'The rate period', kind: 'text', requires: 'Say whether the interest rate is per month or per year.' },
  termPeriods: { label: 'The number of payments', kind: 'number', integer: true, min: 1, max: 99999 },
  startDate: { label: 'The start date', kind: 'date' },
});

/** "Draw the money" (disburseLoanAction). */
export const LOAN_DRAW_RULES = defineFieldRules('loans.disburseLoan', {
  amount: { label: 'The loan amount', kind: 'money', min: 0.01, requires: 'The loan amount must be an amount greater than zero.' },
  intoMoneyAccountId: { label: 'The account', kind: 'text', requires: 'Choose the account the money went into.' },
  on: { label: 'The draw date', kind: 'date' },
});

/** "Record a payment" (recordPaymentAction). */
export const LOAN_PAYMENT_RULES = defineFieldRules('loans.recordLoanPayment', {
  amount: { label: 'The payment amount', kind: 'money', min: 0.01, requires: 'The payment amount must be an amount greater than zero.' },
  fromMoneyAccountId: { label: 'The account', kind: 'text', requires: 'Choose the account the payment comes from.' },
  on: { label: 'The payment date', kind: 'date' },
});

/** The reason box beside a payment (reverseEntryAction). */
export const LOAN_REVERSE_RULES = defineFieldRules('loans.reverseLoanEntry', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this is being reversed.' },
});
