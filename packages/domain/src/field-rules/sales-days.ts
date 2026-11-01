/**
 * T-440 field rules for app/sales-days (S6): create a typed day, import one from POS, post a POS correction, and the reason that
 * withdraws or voids a day. The per-channel amount boxes (`channel_${id}`) are templated and stay in the guard's EXEMPT list (S8).
 */
import { defineFieldRules } from './check';

export const SALES_DAY_CREATE_RULES = defineFieldRules('sales-days.create', {
  businessDate: { label: 'The business date', kind: 'date' },
});

/**
 * T-504: the EDIT forms (a typed day, and a feed day's Platform sales). They have no field-rule inputs: the store and the date are
 * never typed, and each channel box is judged by the business rule `salesDay.channels.tickedOrTyped`. The set exists so a
 * CheckedForm has one to name; it holds no fields.
 */
export const SALES_DAY_EDIT_RULES = defineFieldRules('sales-days.edit', {});

export const SALES_DAY_IMPORT_RULES = defineFieldRules('sales-days.import', {
  businessDate: { label: 'The business date', kind: 'date' },
});

export const SALES_DAY_CORRECTION_RULES = defineFieldRules('sales-days.correction', {
  entryDate: { label: 'The correction date', kind: 'date' },
  reason: { label: 'The reason', kind: 'text', requires: 'Say what changed in POS.' },
});

/** One reason box serves both "Withdraw this unverified day" and "Void (reverses the posting)". */
export const SALES_DAY_VOID_RULES = defineFieldRules('sales-days.void', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this sales day is being withdrawn or voided.' },
});
