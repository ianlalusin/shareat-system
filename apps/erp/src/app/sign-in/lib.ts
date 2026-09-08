/**
 * What a verified Firebase identity means in THIS system — the three-way decision behind
 * `signInWithEmailAction`. T-232 slice 1.
 * `docs/tasks/232-email-sign-in-and-first-run-setup.md` §Slices, decision 5.
 *
 * ## ⭐ Why this is a function and not four lines inside the action
 *
 * The decision has three outcomes and every one of them is a database fact:
 *
 * | The database says | Outcome | What the browser gets |
 * |---|---|---|
 * | a `firebase` credential for this uid | `signed-in` | the session cookie, then the app |
 * | no credential, and **zero** organizations | `first-run` | the setup identity cookie, then `/setup` |
 * | no credential, and an organization exists | `not-linked` | `NOT_LINKED_MESSAGE`, on `/sign-in` |
 *
 * A `'use server'` module cannot be tested this way — every export of one is a public endpoint, and
 * exercising it needs a request, a cookie store and a redirect. So the *decision* lives here, over
 * a plain `tx`, where `tests/integration/email-sign-in.test.ts` runs all three branches against
 * real Postgres; the action keeps the cookies and the redirects, which are the parts a test would
 * only be able to assert against a mock.
 *
 * ⚠️ It takes a `tx` and never opens one. `transaction()` is reachable only from
 * `sign-in/actions.ts` and `sign-in/page.tsx`, the paths `tests/unit/no-direct-transaction-in-erp.test.ts`
 * names as pre-auth confessions — this file must not become a fourth.
 */
import type { Tx } from '@shareat/db';
import { organizationsRepo } from '@shareat/db';
import { AuthenticationError, signInWithFirebase } from '@shareat/auth';

/**
 * ⭐ The ratified sentence for a verified account this system does not know, when the system is
 * already set up. Fixed wording (orchestrator, 2026-09-08) — do not paraphrase it at a call site.
 *
 * ⚠️ It is deliberately more than `signInWithFirebase`'s own message. The domain can say the
 * account is not linked; it cannot know **what the person should do about it**, because that depends
 * on the system being set up already — which is precisely the fact this file just established.
 * Linking an email to a person is `/admin/users`' job (decision 5, a follow-up to T-232).
 */
export const NOT_LINKED_MESSAGE =
  'This account is not linked to a person. Ask an administrator to link it';

/** Where a sign-in lands when `next` says nothing usable. */
const DEFAULT_NEXT = '/sales-days';

/**
 * ⛔ **Where to land after signing in — and never anywhere but this app.** `next` comes from the URL,
 * so an open redirect here turns the sign-in page into a phishing tool: a link that shows the real
 * sign-in form on the real domain and then hands the visitor to somebody else's page.
 *
 * ⚠️ **`startsWith('/')` is not enough, and neither is also rejecting `//`.** Both of the following
 * are protocol-relative once a browser parses them, and both reached a redirect before this function
 * was tightened:
 *
 * | `next` | What the browser does with it |
 * |---|---|
 * | `//evil.com` | `https://evil.com` — the form's own check allowed it (`startsWith('/')` is true) |
 * | `/\evil.com` | `https://evil.com` — **a backslash is a slash to a URL parser**, and nothing looked for one |
 *
 * So the rule is stated positively instead: a `/`, then a character that is neither `/` nor `\`. A
 * bare `/` passes (there is no second character to be either). Everything else — an absolute URL, a
 * `javascript:` scheme, a bare path with no leading slash, an empty string — falls back to
 * `DEFAULT_NEXT`.
 *
 * ⭐ Both callers use this one function. It lived inside `actions.ts` and could not be exported from
 * there — every export of a `'use server'` module is a public endpoint and must be an async function
 * — so `page.tsx` had grown its own weaker copy of the check inline. One rule, one place.
 */
export function safeNext(raw: string): string {
  return /^\/(?![/\\])/.test(raw) ? raw : DEFAULT_NEXT;
}

export type VerifiedSignInOutcome =
  /** The credential resolved to a person and a session was issued. The token is returned ONCE. */
  | { readonly kind: 'signed-in'; readonly token: string; readonly expiresAt: Date; readonly personId: string }
  /** Nothing exists yet, so this identity may create the organisation. Decision 5's narrow gate. */
  | { readonly kind: 'first-run' }
  /** The system is set up and this account is a stranger to it. */
  | { readonly kind: 'not-linked' };

/**
 * The outcome for an **already-verified** uid.
 *
 * ⛔ `verifiedUid` must come from `verifyFirebaseIdToken`, never from a form field. That is
 * `tests/unit/no-client-supplied-actor.test.ts`' rule and bible §7.1: a login is not an
 * introduction.
 *
 * ⚠️ **The `catch` is the branch, and it cannot swallow anything else.** `signInWithFirebase`
 * raises `AuthenticationError` for exactly one reason — no active `firebase` credential for this
 * uid — and it raises it *before writing anything*, so this is a JS throw and not a failed
 * statement: the transaction is still usable and the read below really runs. (A DB error would have
 * aborted it, and the follow-up query would fail with `25P02` instead of answering. That trap is
 * why this comment exists.) Anything that is not an `AuthenticationError` is re-thrown untouched.
 *
 * ⚠️ **Under a role that does not bypass RLS, `anyOrganizationExists` answers `false` even on a
 * populated database** (`organizations` carries FORCE ROW LEVEL SECURITY and there is no principal
 * here — `repo/organizations.ts`' own warning). The consequence is bounded: a stranger's sign-in
 * would be sent to `/setup` instead of being told to ask an administrator, and `/setup` would then
 * be refused loudly by the INSERT's own `WITH CHECK`. A wrong sentence, never a second
 * organisation.
 */
export async function resolveVerifiedSignIn(tx: Tx, verifiedUid: string): Promise<VerifiedSignInOutcome> {
  try {
    const session = await signInWithFirebase(tx, { verifiedUid });
    return {
      kind: 'signed-in',
      token: session.token,
      expiresAt: session.expiresAt,
      personId: session.personId,
    };
  } catch (err) {
    if (!(err instanceof AuthenticationError)) throw err;
  }

  // ⭐ Zero organizations is the ONLY thing that opens first-run setup. It is not "no person for
  // this email" — an unknown email on a live system is a stranger, and the answer is a sentence.
  const alreadySetUp = await organizationsRepo.anyOrganizationExists(tx);
  return alreadySetUp ? { kind: 'not-linked' } : { kind: 'first-run' };
}
