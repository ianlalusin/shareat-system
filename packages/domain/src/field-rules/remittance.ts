/**
 * T-440 field rules for app/remittance (S6): the handover, its reversal, and the store's cash policy.
 * The per-account amount and overage boxes are templated (`lineAmount_${i}`) and stay in the guard's EXEMPT list (S8).
 */
import { defineFieldRules } from './check';

export const REMITTANCE_RECORD_RULES = defineFieldRules('remittance.record', {
  remittedOn: { label: 'The handover date', kind: 'date' },
  reference: { label: 'The reference', optional: true, kind: 'text', max: 120 },
});

export const REMITTANCE_REVERSE_RULES = defineFieldRules('remittance.reverse', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this remittance is being reversed.' },
});

export const CASH_POLICY_RULES = defineFieldRules('remittance.cashPolicy', {
  unremittedCeiling: { label: 'The un-remitted ceiling', optional: true, kind: 'money', min: 0.01 },
});
