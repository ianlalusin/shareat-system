/**
 * T-440 field rules for app/findings (S7). The two "why" boxes on the close screen: creating a missing month inside closed
 * books and booking a missed month. Both say the reason is needed; the domain keeps its own backstop for its other callers.
 */
import { defineFieldRules } from './check';

export const FINDINGS_MISSING_PERIOD_RULES = defineFieldRules('findings.createMissingClosedPeriod', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this month is being created now.' },
});

export const FINDINGS_MISSED_MONTH_RULES = defineFieldRules('findings.bookMissedMonth', {
  reason: { label: 'The reason', kind: 'text', requires: 'Say why this month is being booked now.' },
});
