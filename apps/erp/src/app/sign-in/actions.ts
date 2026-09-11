'use server';

/**
 * Sign in and out. docs/tasks/138-identity-and-sessions.md.
 *
 * ⭐ **Note what this file does NOT read from the form: a person.** The browser supplies a store
 * and a PIN — a *credential* — and the server decides who that is. That is the entire difference
 * from the "acting as" picker it replaces, and `tests/unit/no-client-supplied-actor.test.ts`
 * enforces it repo-wide.
 *
 * T-232 adds a second credential shape to the same rule: `signInWithEmailAction` takes a Firebase
 * **ID token** and derives the uid from its signature. Still a credential, still never a name the
 * browser chose.
 */
import { redirect } from 'next/navigation';
import { signInWithPin, signOut, AuthenticationError } from '@shareat/auth';
import { transaction } from '@shareat/db';
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionToken,
  setSetupIdentityCookie,
} from '../../lib/session';
import { verifyFirebaseIdToken } from '../../lib/firebase-auth-admin';
import { NOT_LINKED_MESSAGE, resolveVerifiedSignIn, safeNext } from './lib';
// ⭐ T-235 / DEF-222 — the one environment gate both pre-session screens share.
import { preSessionMessage, SIGN_IN_POLICY } from '../../lib/pre-session-message';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function signInAction(formData: FormData): Promise<void> {
  const storeId = str(formData, 'storeId');
  const pin = str(formData, 'pin');
  const next = safeNext(str(formData, 'next'));

  let redirectTo: string;
  try {
    if (!storeId) throw new AuthenticationError('Choose a store first.');
    // `null` — the credential lookup precedes knowing the org (DEF-288, bible row 194).
    const result = await signInWithPin(null, { storeId, pin });
    await setSessionCookie(result.token, result.expiresAt);
    redirectTo = next;
  } catch (err) {
    // ⚠️ A wrong PIN and an unknown one still say the SAME thing — `signInWithPin` decides that,
    // and nothing here distinguishes them.
    //
    // ⭐ T-235 / DEF-222: what changed is everything that is NOT an `AuthenticationError`. This
    // catch used to put `err.message` straight into the URL of an unauthenticated page with no
    // production gate, and — worse, and unrecorded until T-235 — no log line at all, so an
    // infrastructure failure on the path every store terminal uses was simultaneously leaked to
    // the browser and absent from the server log.
    const message = preSessionMessage(err, SIGN_IN_POLICY);
    redirect(`/sign-in?next=${encodeURIComponent(next)}&error=${encodeURIComponent(message)}`);
  }
  redirect(redirectTo);
}

/**
 * The email path: a **verified Firebase ID token** in, one of three outcomes out. T-232 slice 1.
 *
 * ⭐ The form posts a token, never a uid and never a person — the server derives who this is with
 * `verifyIdToken` and then asks the database what that identity means here (`./lib.ts`). The three
 * outcomes and the reasoning behind each are in that file; this function is the side effects:
 * a session cookie, or a setup-identity cookie, or a sentence.
 *
 * ⚠️ **`redirect()` is called after the `try`, never inside it.** Next signals a redirect by
 * throwing, so a `redirect()` inside this try block would be caught by its own error handler and
 * turned into `?error=NEXT_REDIRECT`. `signInAction` above is shaped the same way for the same
 * reason.
 */
export async function signInWithEmailAction(formData: FormData): Promise<void> {
  const idToken = str(formData, 'idToken');
  const next = safeNext(str(formData, 'next'));

  let redirectTo: string;
  try {
    const identity = await verifyFirebaseIdToken(idToken);
    // No transaction here — `resolveVerifiedSignIn` opens the right one for each half of the
    // question it asks (DEF-288, bible row 194).
    const outcome = await resolveVerifiedSignIn(identity.uid);

    if (outcome.kind === 'signed-in') {
      await setSessionCookie(outcome.token, outcome.expiresAt);
      redirectTo = next;
    } else if (outcome.kind === 'first-run') {
      // ⭐ The one door to `/setup`, and it opens only because the database holds ZERO
      // organizations. The cookie carries the verified identity across the redirect; it authorises
      // nothing else, and `bootstrapOrganization` refuses under an advisory lock the moment an
      // organization exists. T-232 §2.4: *the guarantee is the database, not the cookie.*
      await setSetupIdentityCookie({
        uid: identity.uid,
        email: identity.email,
        displayName: identity.displayName,
      });
      redirectTo = '/setup';
    } else {
      // A verified account that this system does not know, on a system that is already set up.
      throw new AuthenticationError(NOT_LINKED_MESSAGE);
    }
  } catch (err) {
    const message = preSessionMessage(err, SIGN_IN_POLICY);
    redirect(`/sign-in?next=${encodeURIComponent(next)}&error=${encodeURIComponent(message)}`);
  }
  redirect(redirectTo);
}

export async function signOutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    // End the SERVER session first. Clearing only the cookie would leave a live token that a
    // copy of it could still use — the browser forgetting is not the session ending.
    // `null` — DEF-288. With a bare transaction the session read returned nothing and
    // sign-out silently did not end the session.
    await signOut(null, token);
  }
  await clearSessionCookie();
  redirect('/sign-in');
}
