/**
 * T-440 field rules for app/attendance: the day-decision minute boxes, the lane discard / terminal revoke reasons and the leave
 * forms. A reason is mandatory wherever the screen asks for one.
 */
import { defineFieldRules } from './check';

/** The minute boxes the server already bounds to a whole number of 0 to 99999 (`parseMinutes`). */
export const ATTENDANCE_OVERTIME_RULES = defineFieldRules('attendance.approveOvertime', {
  approvedOtMinutes: { label: 'The minutes to pay', kind: 'number', integer: true, min: 0, max: 99999 },
});
export const ATTENDANCE_START_ANCHOR_RULES = defineFieldRules('attendance.setStartAnchor', {
  chosenAnchorMinute: { label: 'The paid-from minute', kind: 'number', integer: true, min: 0, max: 99999 },
});
export const ATTENDANCE_EARLY_OUT_RULES = defineFieldRules('attendance.approveEarlyOut', {
  effectiveOutMinute: { label: 'The paid-until minute', kind: 'number', integer: true, min: 0, max: 99999 },
});

/** Discard a quarantined clock event: it needs a reason. */
export const ATTENDANCE_DISCARD_RULES = defineFieldRules('attendance.discardEvent', {
  reason: { label: 'The reason', kind: 'text' },
});

/** Revoke a clock terminal: it needs a reason. */
export const ATTENDANCE_TERMINAL_REVOKE_RULES = defineFieldRules('attendance.revokeTerminal', {
  reason: { label: 'The reason', kind: 'text' },
});

/** A person asks for leave. The last day and the birth date are optional; the range order is cross-field (Q4). */
export const ATTENDANCE_LEAVE_REQUEST_RULES = defineFieldRules('attendance.requestLeave', {
  from: { label: 'The first day', kind: 'date' },
  to: { label: 'The last day', optional: true, kind: 'date' },
  birthDate: { label: 'The date of the birth', optional: true, kind: 'date' },
});

/** A manager records an absence that already happened: no day in the future. */
export const ATTENDANCE_LEAVE_RECORD_RULES = defineFieldRules('attendance.recordLeave', {
  from: { label: 'The first day', kind: 'date', notAfterToday: true },
  to: { label: 'The last day', optional: true, kind: 'date', notAfterToday: true },
  birthDate: { label: 'The date of the birth', optional: true, kind: 'date' },
});

/** Void approved leave: it needs a reason. */
export const ATTENDANCE_LEAVE_VOID_RULES = defineFieldRules('attendance.voidLeave', {
  reason: { label: 'The reason', kind: 'text' },
});
