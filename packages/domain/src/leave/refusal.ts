/**
 * T-436 - the typed leave refusals. A refusal carries a string `code` the caller can branch on (`LEAVE_CAP_MONTHLY`) and a
 * sentence with the numbers in it ("sick: 2 of 2 this month"), never a raw throw (the T-343 ratchet).
 */
import { RefusalError, refuse } from '../shared/refusal';

export const LEAVE_REFUSAL_CODES = [
  'LEAVE_CAP_MONTHLY',
  'LEAVE_CAP_YEARLY',
  'LEAVE_BIRTH_LIMIT',
  'LEAVE_BIRTH_REQUIRED',
  'SIL_BALANCE_EXHAUSTED',
  'SIL_BEFORE_ANNIVERSARY',
  'SIL_YEAR_CLOSED',
  'LEAVE_DAY_WORKED',
  'LEAVE_OWN_APPROVAL',
  'LEAVE_DAY_PAID',
  'LEAVE_PERIOD_PAID',
  'LEAVE_NOT_PENDING',
  'LEAVE_NOT_APPROVED',
  'LEAVE_DATE_TAKEN',
  'LEAVE_FUTURE_RECORD',
  'LEAVE_NOT_REQUESTABLE',
  'LEAVE_TYPE_UNKNOWN',
  'LEAVE_WHOLE_DAYS',
  'LEAVE_NO_DAYS',
  'LEAVE_BAD_DATE',
  'LEAVE_OUTSIDE_EMPLOYMENT',
  'LEAVE_REASON_REQUIRED',
  'LEAVE_CAP_INVALID',
  'LEAVE_CAP_BELOW_LEGAL',
  'LEAVE_NOT_FOUND',
  'LEAVE_DOCUMENT_REFUSED',
  'LEAVE_TYPE_EXISTS',
] as const;
export type LeaveRefusalCode = (typeof LEAVE_REFUSAL_CODES)[number];

export class LeaveRefusal extends RefusalError {
  readonly code: LeaveRefusalCode;
  constructor(code: LeaveRefusalCode, message: string, userMessage: string) {
    super(message, userMessage);
    this.name = 'LeaveRefusal';
    this.code = code;
  }
}

/** `sentence` is what the person reads AND what the message carries: the numbers belong in both. */
export function leaveRefusal(code: LeaveRefusalCode, sentence: string): LeaveRefusal {
  const r = refuse(sentence, sentence);
  return new LeaveRefusal(code, r.message, r.userMessage);
}
