/** T-524 field rules for the POS v2 floor and till (docs/tasks/524-pos-v2-domain.md). One set per input; the reasons are 3 to 200 characters (R5, R8). */
import { defineFieldRules } from './check';

export const POS_REASON_RULES = defineFieldRules('pos.reason', {
  reason: { label: 'The reason', kind: 'text', min: 3, max: 200, requires: 'The reason must be 3 to 200 characters.' },
});

/** A line's kitchen note: optional, up to 200 characters (the column's CHECK). */
export const POS_LINE_NOTE_RULES = defineFieldRules('pos.lineNote', {
  note: { label: 'The note', optional: true, kind: 'text', max: 200, requires: 'The note can be up to 200 characters.' },
});

/** A payment reference (a wallet reference number): 4 to 40 characters (the column's CHECK). */
export const POS_PAYMENT_REFERENCE_RULES = defineFieldRules('pos.paymentReference', {
  referenceNo: { label: 'The reference number', kind: 'text', min: 4, max: 40, requires: 'The reference number must be 4 to 40 characters.' },
});

/** The card details of a senior or PWD diner, written only to the statutory register (row 353). */
export const POS_STATUTORY_HOLDER_RULES = defineFieldRules('pos.statutoryHolder', {
  holderName: { label: 'The card holder name', kind: 'text', max: 120, requires: 'Enter the name on the senior or PWD card.' },
  idNumber: { label: 'The card number', kind: 'text', max: 60, requires: 'Enter the senior or PWD card number.' },
});
