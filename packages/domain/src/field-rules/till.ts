/**
 * T-440 field rules for app/till (S6): open a shift. The per-pocket count boxes (`count:${id}`) are templated and stay in the
 * guard's EXEMPT list (S8).
 */
import { defineFieldRules } from './check';

export const TILL_OPEN_SHIFT_RULES = defineFieldRules('till.openShift', {
  businessDate: { label: 'The trading date', kind: 'date' },
});
