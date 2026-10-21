/**
 * T-440 field rules for app/wastage. One set per form; the sentences are the ones `recordOrderWastage` and the reversal path
 * already spoke. The allocation percentages (three rows sharing the name `percent`) are a repeated line family: left to S8.
 */
import { defineFieldRules } from './check';

/** The "Record a wastage" form on /wastage. */
export const WASTAGE_RECORD_RULES = defineFieldRules('wastage.record', {
  channel: { label: 'The channel', kind: 'text', requires: 'Choose the channel the wastage happened on.' },
  businessDate: { label: 'The business date', kind: 'date' },
  amount: { label: 'The wastage amount', kind: 'money', min: 0.01 },
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this wastage happened.' },
});

/** The "Reverse the backstop's decision" form on /wastage/[id]. */
export const WASTAGE_REVERSE_RULES = defineFieldRules('wastage.reverseAutoCharge', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this auto-charge is being reversed.' },
});
