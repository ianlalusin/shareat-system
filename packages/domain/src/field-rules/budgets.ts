/**
 * T-440 field rules for app/budgets (S6): the monthly cap of one expense category. Zero is a real cap ("spend nothing here");
 * "renew automatically needs an interval" is a cross-field check and stays a server refusal (Q4).
 */
import { defineFieldRules } from './check';

export const BUDGET_CAP_RULES = defineFieldRules('budgets.cap', {
  amount: { label: 'The cap', kind: 'money', min: 0 },
});
