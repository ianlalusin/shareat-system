/**
 * T-440 field rules for app/staff. The government-numbers record (EditableRecord on the employment page).
 * Wording and shapes are the ones `setGovernmentIds` spoke before this module (blank clears; dashes and spaces are ignored).
 */
import { defineFieldRules } from './check';

export const STAFF_GOV_ID_RULES = defineFieldRules('staff.setGovernmentIds', {
  sssNo: { label: 'The SSS number', optional: true, kind: 'digits', min: 10, max: 10, strip: 'spaces-dashes' },
  philhealthNo: { label: 'The PhilHealth number', optional: true, kind: 'digits', min: 12, max: 12, strip: 'spaces-dashes' },
  pagibigNo: { label: 'The Pag-IBIG number', optional: true, kind: 'digits', min: 12, max: 12, strip: 'spaces-dashes' },
  tin: { label: 'The TIN', optional: true, kind: 'digits', min: 9, max: 12, strip: 'spaces-dashes' },
});

/** The hire form. The start date is the only ruled field on it (the name halves and the radio are cross-field, Q4). */
export const STAFF_HIRE_RULES = defineFieldRules('staff.hire', {
  startedOn: { label: 'The start date', kind: 'date' },
});

/** Retype a person's name. `middleName` has no rule. */
export const STAFF_RENAME_RULES = defineFieldRules('staff.renamePerson', {
  lastName: { label: 'The last name', kind: 'text' },
  firstName: { label: 'The first name', kind: 'text' },
});

/** Issue a sign-in PIN (employment page and the administrator-PIN list share the one sentence `setPin` already speaks). */
export const STAFF_PIN_RULES = defineFieldRules('staff.issuePin', {
  pin: { label: 'The PIN', kind: 'digits', min: 6, max: 6, requires: 'A PIN must be exactly 6 digits.' },
});

/** Add a store position. */
export const STAFF_POSITION_RULES = defineFieldRules('staff.upsertStorePosition', {
  name: { label: 'The position name', kind: 'text', requires: 'A position needs a name.' },
});

/** End an employment. The status is a pick from the ended statuses (membership stays server-only). */
export const STAFF_END_RULES = defineFieldRules('staff.endEmployment', {
  endedOn: { label: 'The end date', kind: 'date' },
  employmentStatus: { label: 'The status', kind: 'text' },
});

/** Revoke an attendance credential: a reason is mandatory. */
export const STAFF_CREDENTIAL_REVOKE_RULES = defineFieldRules('staff.revokeCredential', {
  reason: { label: 'The reason', kind: 'text' },
});

/** Enrol a card by id. */
export const STAFF_CARD_RULES = defineFieldRules('staff.enrolCard', {
  cardId: { label: 'The card id', kind: 'text', requires: 'A card needs an id — that is the whole credential.' },
});
