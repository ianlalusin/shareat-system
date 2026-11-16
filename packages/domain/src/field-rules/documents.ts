/**
 * T-440 field rules for the document signing form (T-584 S4). The sentence on the screen and the server's refusal are the same words.
 * The Employee ID is optional here on purpose: a person with no staff code (an administrator with no job) signs with their PIN alone, and the signing
 * check itself decides whether an ID was needed. A malformed ID or PIN is refused BEFORE any PIN attempt is charged (the public format rule).
 */
import { defineFieldRules } from './check';

/** The reason kept with a revision or a void: required, plain text, at most 500 characters (the table says the same). */
export const DOCUMENT_REASON_RULES = defineFieldRules('documents.reason', {
  reason: { label: 'The reason', kind: 'text', plainText: true, max: 500, requires: 'Give the reason, in 500 characters or fewer.' },
});

export const DOCUMENT_SIGN_RULES = defineFieldRules('documents.sign', {
  employeeId: {
    label: 'The Employee ID',
    optional: true,
    kind: 'pattern',
    pattern: '^(?:[Ss][Ee]-)?[0-9]{1,3}$',
    patternSays: 'the number on the staff badge',
    requires: 'Type the Employee ID, the number on the staff badge, for example 7.',
  },
  pin: { label: 'The PIN', kind: 'digits', min: 6, max: 6, requires: 'A PIN must be exactly 6 digits.' },
});
