/**
 * Shared predicates for telling a machine-generated error apart from one written for a person.
 *
 * T-326 / Amendment 1 — extracted so `constraint-messages.ts` and `pre-session-message.ts` share
 * ONE definition of "leaky" instead of each growing its own and drifting (RULES.md §6's argument
 * against a second copy of a rule the database already enforces, applied here to a rule this repo
 * already learned once in `pre-session-message.ts`).
 *
 * ⛔ This module imports NEITHER consumer, on purpose. `pre-session-message.ts` evaluates
 * `new Set(Object.values(CONSTRAINT_MESSAGES))` at module scope; a reverse import from
 * `constraint-messages.ts` back into that file would complete a cycle that enters
 * `pre-session-message.ts` while `CONSTRAINT_MESSAGES` is still in the temporal dead zone —
 * `ReferenceError: Cannot access 'CONSTRAINT_MESSAGES' before initialization`, at import time, on
 * every screen importing either file. Staying a leaf is what makes this safe to import from both.
 */

/**
 * ⭐ **ANY string `code` marks an infrastructure error — not a five-character (SQLSTATE-shaped)
 * one.** The five-character version was a real leak, tried and reverted in this project:
 * `node_modules/postgres/src/errors.js`'s `connection()` builds every connection failure as
 * `Object.assign(new Error('write ' + code + ' ' + host + ':' + port), { code, errno, address })`
 * — single line, **no SQLSTATE** — so `ECONNREFUSED` and its siblings would sail through a
 * five-character check and put the database host and port on screen.
 *
 * ⭐ The wider test still works, and works better: SQLSTATE, `ECONNREFUSED`, `ENOTFOUND` and Node's
 * own `ENOENT` are all `code`s, and a domain `Error` has none at all.
 *
 * ⛔ **Null-guarded on purpose.** In this predicate's old home (`pre-session-message.ts`) the
 * `instanceof Error` check above it made `null`/`undefined` unreachable here. `errorMessage` in
 * `constraint-messages.ts` has no such guard and is called from every `catch` in 52 production
 * files — `typeof (err as {code}).code` on `null`/`undefined` throws `TypeError: Cannot read
 * properties of null`, turning a handled refusal into an unhandled 500 with no text at all.
 */
export function hasStringCode(err: unknown): boolean {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

/**
 * ⭐ A sentence written for a person is one line. A multi-line message is a dump, whoever wrote
 * it — a stack trace, a validation report, a banner.
 *
 * ⛔ Not decoration: `packages/core/src/env.ts`'s `env()` throws a plain `Error` with **no** `code`
 * whose text names every unset environment variable, so `hasStringCode` alone lets it straight
 * through. **Deliberately shape, not wording** — matching one banner's text would close exactly
 * one thrower and silently miss the next.
 */
export function looksLikeADump(message: string): boolean {
  return message.trim().includes('\n');
}

/**
 * T-343 S1 / DEF-417 part 2 — a UUID (any version, case-insensitive), word-bounded so it never
 * matches inside a longer hex run. `\b` on both ends is deliberate: it is what keeps this from
 * firing on, say, a 32-hex-character hash with no dashes, which is not the shape this task exists
 * to hide (the census's whole point is UUIDs specifically — see the task's Goal).
 */
export const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Does this text carry a raw identifier a user must never see? Today, exactly `UUID_SHAPE`. */
export function containsIdentifier(s: string): boolean {
  return UUID_SHAPE.test(s);
}

/**
 * T-343 S1 — an `Error` carrying its own, ready-to-show sentence. Producers: `AuthorizationError`
 * (S2), `RecordGoneError` (S3), `RefusalError` (S5+). `errorMessage()` in `./constraint-messages`
 * prefers this over every other resolution step.
 *
 * ⭐ Amendment R1 §4 — `!hasStringCode(err)` is required too: a DB error can carry a `code` AND
 * (accidentally, or via a poorly-typed catch) a `userMessage`-shaped property, and without this
 * guard it would jump the constraint map's own mapped sentence for that `code`. A real domain
 * throw never has a `code` at all, so this excludes nothing `AuthorizationError`/`RecordGoneError`/
 * `RefusalError` would ever legitimately set.
 */
export function isPresentable(err: unknown): err is Error & { userMessage: string } {
  if (!(err instanceof Error)) return false;
  const userMessage = (err as { userMessage?: unknown }).userMessage;
  if (typeof userMessage !== 'string') return false;
  if (userMessage.trim() === '') return false;
  if (looksLikeADump(userMessage)) return false;
  if (hasStringCode(err)) return false;
  return true;
}
