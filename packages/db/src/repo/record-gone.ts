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
 *
 * S5.0: re-parented onto `RefusalError` (`../refusal.ts`) — `name`, `message` and `userMessage`
 * unchanged (S5 Design). `goneSentence` itself now lives there too, one wording shared with
 * `gone(...)` (`packages/domain/src/shared/refusal.ts`).
 *
 * The `userMessage` is built through `refuse()` (code-review CHANGES item 5, 2026-09-26) — the
 * SAME sanitisation `gone(...)` gets, so an interpolated `what`/`notLonger` is redacted/collapsed
 * identically from either entry point. A no-op for today's literal callers (`recordGone`'s own
 * test is unedited, byte-identical).
 */
import { RefusalError, refuse, goneSentence } from '../refusal';

export class RecordGoneError extends RefusalError {
  constructor(message: string, userMessage: string) {
    super(message, userMessage);
    this.name = 'RecordGoneError';
  }
}

/**
 * `what` — the kind of record, lower-case, singular (`'supplier'`, `'expense'`, `'sales day'`).
 * `notLonger` — optional, the state it may have moved out of (`'posted'`, `'open'`) when the row
 * exists but no longer qualifies, as opposed to never having existed at all; omitted when the repo
 * cannot tell the two apart.
 */
export function recordGone(rawMessage: string, what: string, notLonger?: string): RecordGoneError {
  return new RecordGoneError(rawMessage, refuse(rawMessage, goneSentence(what, notLonger)).userMessage);
}
