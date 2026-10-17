/**
 * T-440 field rules for app/ap. The supplier ADD form (CheckedForm on /ap). There is no TIN on this form (Audit A10);
 * "required when On credit" is cross-field and stays a server refusal (Q4).
 */
import { defineFieldRules } from './check';

export const SUPPLIER_ADD_RULES = defineFieldRules('ap.createSupplier', {
  name: { label: 'The supplier name', kind: 'text', requires: 'A supplier needs a name people will recognise.' },
  creditTermsDays: { label: 'Days to pay', optional: true, kind: 'number', integer: true, min: 0, max: 365 },
});
