/**
 * T-343 S3 / DEF-417 part 2 (row 6) — a repo "does not exist" refusal names the KIND of record,
 * never the raw id it looked up. `docs/tasks/343-def-417-human-readable-refusals.md` §S3.
 *
 * ⭐ Same shape as `AuthorizationError` (`packages/auth/src/errors.ts`, S2): `message` is the raw
 * diagnostic, byte-identical to what the repo already threw — every existing regex/log/test
 * matching it keeps working. `userMessage` is an ADDED field, the one `errorMessage()`
 * (`apps/erp/src/lib/constraint-messages.ts`) prefers when present (S1's `isPresentable`).
 *
 * ⛔ Not a validator, not a second source of truth for WHETHER a record exists — the repo already
 * decided that by finding no row. This only turns the sentence a screen shows into one that names
 * the kind of thing that vanished, not the uuid it was looked up by.
 */
export class RecordGoneError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'RecordGoneError';
    this.userMessage = userMessage;
  }
}

/**
 * `what` — the kind of record, lower-case, singular (`'supplier'`, `'expense'`, `'sales day'`).
 * `notLonger` — optional, the state it may have moved out of (`'posted'`, `'open'`) when the row
 * exists but no longer qualifies, as opposed to never having existed at all; omitted when the repo
 * cannot tell the two apart.
 */
export function recordGone(rawMessage: string, what: string, notLonger?: string): RecordGoneError {
  const userMessage =
    `That ${what} could not be found${notLonger ? `, or it is no longer ${notLonger}` : ''}. ` +
    'Someone may have changed it — reload the page and try again.';
  return new RecordGoneError(rawMessage, userMessage);
}
