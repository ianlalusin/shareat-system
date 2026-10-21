/**
 * T-440 field rules for app/statutory-discounts (S6): the SC/PWD register entry and the void reason. The ID number is personal
 * data, so no sentence here ever repeats what was typed (Audit A5).
 */
import { defineFieldRules } from './check';

export const STATUTORY_DISCOUNT_RECORD_RULES = defineFieldRules('statutory-discounts.record', {
  storeId: { label: 'The store', kind: 'text', requires: 'Choose a store.' },
  businessDate: { label: 'The date of sale', kind: 'date' },
  invoiceNumber: { label: 'The invoice or OR number', kind: 'text', requires: 'The invoice or OR number is required.' },
  kind: { label: 'The discount kind', kind: 'text', requires: 'Choose the discount kind.' },
  holderName: { label: "The holder's name", kind: 'text', requires: "The holder's name is required." },
  idNumber: { label: 'The ID number', kind: 'text', requires: 'The ID number is required.' },
  grossAmount: { label: 'The gross amount', kind: 'money', min: 0.01 },
  discountAmount: { label: 'The discount granted', kind: 'money', min: 0.01 },
});

export const STATUTORY_DISCOUNT_VOID_RULES = defineFieldRules('statutory-discounts.void', {
  voidReason: { label: 'The reason', kind: 'text', requires: 'Say why this record is being voided.' },
});
