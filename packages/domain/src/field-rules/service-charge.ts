/**
 * T-440 field rules for app/service-charge (S6): the distribution form. "No more than the store's own float" is a ledger
 * comparison and stays a server refusal (Q4).
 */
import { defineFieldRules } from './check';

export const SERVICE_CHARGE_DISTRIBUTE_RULES = defineFieldRules('service-charge.distribute', {
  amount: { label: 'The amount', kind: 'money', min: 0.01 },
  moneyAccountId: { label: 'The account', kind: 'text', requires: 'Choose the account the money comes from.' },
  paidOn: { label: 'The payday', kind: 'date' },
});
