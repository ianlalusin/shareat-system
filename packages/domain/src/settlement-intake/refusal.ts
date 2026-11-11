/**
 * T-511 S3 - the typed refusals of the settlement file readers. A refusal carries an UPPER_SNAKE `code` the caller can count and branch on
 * (`ZIP_TOO_MANY_ENTRIES`) and one plain sentence that names the column, value or line, never an order id, a customer or a Store ID
 * (`refuse()` turns every UUID in the sentence into `[hidden]`, so a sentence must not depend on printing one). Built like `leave/refusal.ts`;
 * raw `throw new Error` is not used in this folder (T-343 ratchet).
 */
import { RefusalError, refuse } from '../shared/refusal';
import { groupedMoney } from './text';

export const SETTLEMENT_INTAKE_REFUSAL_CODES = [
  'FILE_EMPTY',
  'FILE_TOO_BIG',
  'ZIP_NOT_A_ZIP',
  'ZIP_TOO_MANY_ENTRIES',
  'ZIP_TOO_BIG_EXPANDED',
  'ZIP_UNSAFE_NAME',
  'ZIP_NESTED_ARCHIVE',
  'ZIP_ENTRY_NOT_ALLOWED',
  'ZIP_SIZE_MISMATCH',
  'ZIP_NO_WORKBOOK',
  'GRAB_MISSING_COLUMN',
  'GRAB_UNKNOWN_COLUMN',
  'GRAB_BAD_ROW',
  'GRAB_BAD_VALUE',
  'GRAB_UNKNOWN_VALUE',
  'GRAB_MIXED_STORES',
  'GRAB_TOO_MANY_ROWS',
  'GRAB_NO_ROWS',
  'FOODPANDA_MISSING_COLUMN',
  'FOODPANDA_UNKNOWN_COLUMN',
  'FOODPANDA_UNKNOWN_LAYOUT',
  'FOODPANDA_NO_SHEETS',
  'FOODPANDA_MIXED_INVOICE',
  'FOODPANDA_TOO_MANY_ROWS',
  'FOODPANDA_BAD_VALUE',
  'XLSX_MALFORMED',
  'XLSX_TOO_HEAVY',
  'XLSX_TOO_SLOW',
  'XLSX_WORKER_UNAVAILABLE',
  // Slice 4 (ingest): the file's type, the store it names, and a staged figure the tables would refuse.
  'FILE_TYPE_NOT_ALLOWED',
  'CHANNEL_NOT_SET_UP',
  'NOT_YOUR_STORE',
  'STAGED_BAD_VALUE',
  // Slice 5b (review): a day that is gone, replaced, already decided, not decided yet, or an override that does not add up.
  'LINE_NOT_FOUND',
  'LINE_NOT_CURRENT',
  'LINE_ALREADY_DECIDED',
  'LINE_NOT_REJECTED',
  'LOAN_OVERRIDE_REFUSED',
  // Slice 7a (approve): the day is held by a blocker, the person uploaded the file, or the books ask for the approver's reason.
  'DAY_BLOCKED',
  'UPLOADER_CANNOT_APPROVE',
  'NEEDS_REASON',
] as const;
export type SettlementIntakeRefusalCode = (typeof SETTLEMENT_INTAKE_REFUSAL_CODES)[number];

export class SettlementIntakeRefusal extends RefusalError {
  readonly code: SettlementIntakeRefusalCode;
  constructor(code: SettlementIntakeRefusalCode, message: string, userMessage: string) {
    super(message, userMessage);
    this.name = 'SettlementIntakeRefusal';
    this.code = code;
  }
}

/** `sentence` is what the person reads AND what the message carries: the column, value or line belongs in both. */
export function intakeRefusal(code: SettlementIntakeRefusalCode, sentence: string): SettlementIntakeRefusal {
  const r = refuse(sentence, sentence);
  return new SettlementIntakeRefusal(code, r.message, r.userMessage);
}

/** The sentence that asks for the approver's reason: `difference` is the ABSOLUTE difference (numeric(14,2) text), `sign` which way it goes. */
export function needsReasonSentence(difference: string, sign: 'short' | 'over'): string {
  const gap = groupedMoney(difference);
  return `The payout is ${gap} ${sign === 'over' ? 'more' : 'less'} than this day still owed. Type a reason to accept the difference, then approve again.`;
}

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A cell or header text made safe to print in a sentence: one line, at most 40 characters, any UUID dropped. */
export function shown(text: string): string {
  const flat = text.replace(UUID_SHAPE, '(id)').replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}...` : flat;
}

/** `1.5` MB-style size text for a sentence. */
export function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
