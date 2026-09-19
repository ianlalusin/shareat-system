/**
 * **What a stranger is told when something breaks on a pre-session screen.** T-235, DEF-222.
 *
 * ## ⛔ The problem, and why it needs one place
 *
 * `/sign-in` and `/setup` are the only two screens in this app reachable with **no session at
 * all**, and both report failure by putting a sentence **in the URL**. A raw error there lands a
 * table name, an unset variable or a connection host in a query string, a browser history and any
 * proxy log, shown to someone who has proved nothing. `api/health/route.ts` settled the rule
 * already: *"this endpoint is unauthenticated; in production it must not describe which variables
 * are unset."*
 *
 * Three call sites report failure that way — `signInAction`, `signInWithEmailAction`,
 * `createFirstRunAction` — and before this file they had three different answers: a full gate, a
 * different full gate, and **no gate at all** on the PIN path, which is the defect DEF-222 was
 * opened for. `signInAction` did not even log.
 *
 * ## ⭐ One formatter, two policies — and the difference is real, not tidiness
 *
 * The two surfaces need **opposite** defaults, and each is right for a reason that does not
 * transfer:
 *
 * | | `/sign-in` | `/setup` |
 * |---|---|---|
 * | Who talks to the visitor | only `AuthenticationError` | **the domain itself**, in plain `Error` sentences |
 * | Default | mask | show |
 *
 * `/setup` is the one pre-session screen that runs business logic whose refusals are *addressed to
 * the person reading them* — *"the PIN must be exactly 6 digits."*, *"an organization needs a
 * code."* Mask those and the screen becomes six fields that will not say which one is wrong, on
 * the one page that is filled in once, by someone who has never seen it. ⛔ Not a prediction:
 * T-232's mutation test removed exactly that allowance and five assertions went red.
 *
 * Conversely `/sign-in` must mask plain `Error`s, because the thing it is defending against —
 * *"a missing `FIREBASE_PROJECT_ID`, a database that is down, a bug"* — arrives as one.
 *
 * So: everything shared lives in `preSessionMessage`; the one genuine difference lives in a
 * `PreSessionMessagePolicy`, named and tested, rather than being an accident of who wrote which
 * file first.
 */
// ⭐ T-237's LEAF, not the `@shareat/auth` barrel. The barrel reaches `@shareat/db` through
// `sessions.ts` and `authorize.ts` — where these two classes are USED — so importing it here
// dragged the whole schema in to read two class identities. `errors.ts` imports only
// `type Capability`, which is erased at runtime, so it costs nothing.
//
// ⚠️ `instanceof` stays correct because the old homes RE-EXPORT these (`sessions.ts:37`,
// `authorize.ts:43`) rather than re-declaring them: one class object, two import paths. If
// that ever became a re-declaration, both policies here would silently mask everything and
// no test outside this file would fail.
import { AuthenticationError, AuthorizationError } from '@shareat/auth/errors';
import { logger } from '@shareat/core/logger';
import { CONSTRAINT_MESSAGES } from './constraint-messages';
import { hasStringCode, looksLikeADump } from './error-shape';

export interface PreSessionMessagePolicy {
  /**
   * Does this error already carry a sentence written for the person reading it?
   *
   * ⚠️ Takes BOTH the error and the message the caller intends to show, because they can differ:
   * `errorMessage()` may already have replaced a driver's words with a mapped constraint sentence,
   * and that sentence is safe even though the error underneath it is not.
   */
  readonly isWrittenForAPerson: (err: unknown, message: string) => boolean;
  /** What a stranger is told in production when it is not. */
  readonly opaque: string;
  /** What the server log calls it. */
  readonly logged: string;
}

/**
 * ⭐ **The whole environment gate, in one place.**
 *
 * 1. A refusal written for a person is returned verbatim, and **not logged** — it is not a server
 *    failure, and logging every wrong PIN would bury the failures that matter.
 * 2. Anything else is **always logged**, whatever the environment. The screen showing the reason
 *    is not a reason for the log not to have it.
 * 3. Outside production it is then returned in full — a developer needs the real text.
 * 4. In production it becomes `policy.opaque`.
 *
 * @param message the sentence the caller would otherwise show. Defaults to the error's own,
 *                which is what both `/sign-in` call sites want; `/setup` passes `errorMessage(err)`.
 */
export function preSessionMessage(
  err: unknown,
  policy: PreSessionMessagePolicy,
  message: string = err instanceof Error ? err.message : String(err),
): string {
  // ⛔ An empty message is not an answer. It renders as an error banner with no text in it, which
  // reads as a rendering bug and tells the visitor nothing — so it takes the opaque sentence and
  // is logged, whoever produced it and however well-intentioned they were.
  if (message.trim() !== '' && policy.isWrittenForAPerson(err, message)) return message;

  // ⛔ The WHOLE error, not `err.message`. The opaque sentence promises the reason is in the log;
  // flattening to a string discards the stack and `cause`, which is most of what makes a
  // connection failure diagnosable, and the promise is then false. `api/health/route.ts:43` logs
  // `{ err: error }` for the same reason.
  logger.error({ err }, policy.logged);

  if (process.env.NODE_ENV !== 'production' && message.trim() !== '') return message;
  return policy.opaque;
}

/**
 * `/sign-in`, **both** paths.
 *
 * ⛔ A whitelist: only an `AuthenticationError` survives. Nothing on that screen is addressed to
 * the visitor except a refusal the domain wrote — the flat wrong-PIN sentence, the ratified
 * not-linked one — and `signInWithPin` throws `AuthenticationError` on every path that matters.
 * Everything else is a *server* problem by definition.
 */
export const SIGN_IN_POLICY: PreSessionMessagePolicy = {
  isWrittenForAPerson: (err) => err instanceof AuthenticationError,
  opaque: 'Sign-in failed. Something on the server is wrong — the reason is in the server log.',
  logged: 'sign-in failed for a reason that is not an authentication failure',
};

/**
 * `/setup`, the first-run screen.
 *
 * A blacklist, because the first-run domain refuses **in sentences**. Three things are masked:
 *
 * 1. anything that is not an `Error` at all — the domain throws `Error`s;
 * 2. any **multi-line** message, which is a dump rather than a sentence — see `looksLikeADump`;
 * 3. any error carrying a string `code` that no constraint sentence claimed — a SQLSTATE, an
 *    `ECONNREFUSED`, an `ENOENT`. A domain `Error` has no `code`.
 *
 * ⭐ Everything else is shown, and that is the point: *"the PIN must be exactly 6 digits."* is the
 * sentence that makes this screen usable.
 */
export const SETUP_POLICY: PreSessionMessagePolicy = {
  isWrittenForAPerson: (err, message) => !isUnfitForAStranger(err, message),
  opaque: 'Setup failed. The reason is in the server log.',
  logged: 'first-run setup failed for a reason that is not a refusal written for a person',
};

/** Every sentence `constraint-messages.ts` is willing to show a person. A message that IS one of
 *  these was written for exactly this purpose and is safe wherever it appears. */
const WRITTEN_FOR_A_PERSON: ReadonlySet<string> = new Set(Object.values(CONSTRAINT_MESSAGES));

/**
 * ⛔ **Is this text unfit to put in the URL of an unauthenticated page?** `/setup`'s half of the
 * decision, moved here from `app/setup/lib.ts` so both policies can be read side by side.
 *
 * ⚠️ **It masks narrowly, and the narrowness is the point.** What survives:
 *
 * | Kept | Example |
 * |---|---|
 * | `AuthenticationError` / `AuthorizationError` | the ratified refusals |
 * | A mapped constraint sentence | *"A channel that settles later needs a receivable account…"* |
 * | Any other single-line plain `Error` | *"the PIN must be exactly 6 digits."* |
 */
export function isUnfitForAStranger(err: unknown, message: string): boolean {
  if (err instanceof AuthenticationError || err instanceof AuthorizationError) return false;
  if (WRITTEN_FOR_A_PERSON.has(message)) return false;

  // ⛔ The domain throws `Error`s. Anything else arrived from somewhere unaudited and gets no
  // benefit of the doubt on a screen a stranger can open.
  if (!(err instanceof Error)) return true;

  // ⭐ T-326 — `looksLikeADump` and the `code` check below now live in `./error-shape`, shared
  // with `constraint-messages.ts`'s `errorMessage()` rather than redefined here. See that module
  // for the reasoning (the postgres driver shape, and why this stays a shape check, not a wording
  // match); neither predicate's behaviour changed by the move.
  if (looksLikeADump(message)) return true;

  return hasStringCode(err);
}
