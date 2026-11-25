/**
 * T-635 field rules for app/inventory/production/slicer-pay: setting the per-kg slicer rate. `setSlicerPayRate` checks the same
 * limits again and owns the sentences. "Which item" is a Select, not a text rule.
 */
import { defineFieldRules } from './check';

export const SLICER_RATE_RULES = defineFieldRules('slicerPay.setRate', {
  ratePerKg: { label: 'The rate per kg', kind: 'money', min: 0.01, requires: 'The rate per kg must be more than 0.', rangeSays: 'The rate per kg must be more than 0.' },
  effectiveFrom: { label: 'The start date', kind: 'date' },
});
