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
