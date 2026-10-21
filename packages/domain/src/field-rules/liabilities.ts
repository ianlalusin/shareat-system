/**
 * T-440 field rules for app/liabilities: record an obligation, charge it, pay it.
 * A reversal's reason is not ruled yet: it is a ConfirmDestructive field with no native rule today.
 */
import { defineFieldRules } from './check';

/** "Record an obligation" (createLiabilityAction). */
export const LIABILITY_ADD_RULES = defineFieldRules('liabilities.createLiability', {
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  name: { label: 'What it is', kind: 'text', requires: 'Say what this obligation is.' },
  dueOn: { label: 'The due date', optional: true, kind: 'date' },
});

/** "Charge it" (chargeAction). */
export const LIABILITY_CHARGE_RULES = defineFieldRules('liabilities.chargeLiability', {
  amount: { label: 'The charge amount', kind: 'money', min: 0.01, requires: 'The charge amount must be an amount greater than zero.' },
  againstAccountCode: { label: 'What it was for', kind: 'text', requires: 'Choose what the charge was for.' },
  on: { label: 'The charge date', kind: 'date' },
});

/** "Pay it" (payAction). */
export const LIABILITY_PAY_RULES = defineFieldRules('liabilities.payLiability', {
  amount: { label: 'The payment amount', kind: 'money', min: 0.01, requires: 'The payment amount must be an amount greater than zero.' },
  fromMoneyAccountId: { label: 'The account it is paid from', kind: 'text', requires: 'Choose the account the payment comes from.' },
  on: { label: 'The payment date', kind: 'date' },
});
