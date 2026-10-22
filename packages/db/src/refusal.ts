/**
 * T-343 S5.0 — the shared refusal primitive. `docs/tasks/343-def-417-human-readable-refusals.md`
 * §S5 Design.
 *
 * ⭐ One class, at the lowest shared layer. Auth cannot import domain
 * (`packages/domain/package.json`: domain depends on auth and db; auth depends on db) so a class
 * defined only in `packages/domain/src/shared/` would be unreachable from `packages/auth/src`.
 * `RefusalError` therefore lives here, importing only the pure core sentence leaf (S2's
 * leaf rule) — `packages/domain/src/shared/refusal.ts` re-exports it as the producer API domain
 * code actually calls.
 *
 * ⛔ Not a validator: `refuse`/`goneSentence` never decide WHETHER a refusal is warranted — the
 * caller already decided that by finding no row, or by rejecting the state it found. This only
 * turns the raw diagnostic into a sentence a screen can show: every UUID redacted (S1's `[hidden]`
 * token) and every whitespace run collapsed to one space. `message` is always `raw`, byte-identical
 * (Invariant 1).
 */

/** Byte-identical to `apps/erp/src/lib/error-shape.ts`'s copy — a parity test (F7) pins the two
 *  `.source` strings equal (R1.4). Two UUID regex literals drifting apart is exactly the
 *  second-source-of-truth RULES.md §6 warns against, just for a pattern instead of a business
 *  rule. */
export { UUID_SHAPE } from '@shareat/core/sentence';
import { screenSentence } from '@shareat/core/sentence';

export class RefusalError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'RefusalError';
    this.userMessage = userMessage;
  }
}

/** Collapses every whitespace run (newlines included) to one space, trims, then redacts every
 *  UUID with `[hidden]`. Throws only when the sanitised result is empty — possible only with an
 *  empty/blank literal (R1.4); a real sentence never throws. */
function sanitise(sentence: string): string {
  const collapsed = screenSentence(sentence);
  if (!collapsed) {
    throw new Error('refuse: sentence produced an empty result');
  }
  return collapsed;
}

/**
 * Every refusal a person can act on. `sentence` interpolates particulars, invoice numbers and
 * names — sanitised, never thrown on for ordinary free text. Constructing `RefusalError` directly
 * is test-only; production code calls `refuse`/`gone`/`recordGone` (R1.5).
 */
export function refuse(raw: string, sentence: string): RefusalError {
  return new RefusalError(raw, sanitise(sentence));
}

/**
 * `recordGone`'s (`./repo/record-gone.ts`) and `gone`'s (`packages/domain/src/shared/refusal.ts`)
 * shared wording — one sentence, defined once (R1.5).
 *
 * `what` — the kind of record, lower-case, singular (`'supplier'`, `'expense'`, `'sales day'`).
 * `notLonger` — optional, the state it may have moved out of (`'posted'`, `'open'`) when the row
 * exists but no longer qualifies, as opposed to never having existed at all; omitted when the
 * caller cannot tell the two apart.
 */
export function goneSentence(what: string, notLonger?: string): string {
  return (
    `That ${what} could not be found${notLonger ? `, or it is no longer ${notLonger}` : ''}. ` +
    'Someone may have changed it — reload the page and try again.'
  );
}
