/**
 * T-440 field rules for app/reports (S7). The dual-run disposition form: a defect reference (DEF-123) and a note.
 * The class is a select (membership stays on the server).
 */
import { defineFieldRules } from './check';

export const REPORTS_DUAL_RUN_DISPOSITION_RULES = defineFieldRules('reports.recordDualRunDisposition', {
  ref: { label: 'The defect reference', kind: 'pattern', pattern: '^DEF-[0-9]+$', patternSays: 'like DEF-123', requires: 'The defect reference must look like DEF-123.' },
  note: { label: 'The note', kind: 'text', min: 1, max: 500, requires: 'The note is required and may be at most 500 characters.' },
});
