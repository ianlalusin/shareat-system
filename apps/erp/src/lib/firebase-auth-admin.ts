/**
 * Verifying a Firebase ID token, server-side. T-232 slice 1, decision 2.
 * `docs/tasks/232-email-sign-in-and-first-run-setup.md`, bible §7.1.
 *
 * ## ⭐ What this file establishes — and what it deliberately does not
 *
 * It turns a token the browser presents into a **uid that Google's own signature vouches for**.
 * That is a *name*, not an authority: it says which Firebase account is on the other end, and
 * nothing whatever about who that is in this system or what they may do. `signInWithFirebase`
 * answers the first question (`person_credentials`), `authorize` answers the second. Bible §7.1:
 * *Firebase is the identity provider; Postgres owns authority.* Nothing here reads a person, a
 * role, or an org.
 *
 * ⚠️ **The password never reaches this server.** The browser exchanges it with Google directly and
 * posts the resulting token — so this app has no password to store, log, or leak. That is the whole
 * reason the client half of the form exists rather than a server-side password check.
 *
 * ## ⛔ No service account, and that is a property of the mechanism rather than a shortcut
 *
 * `verifyIdToken` validates the token's RS256 signature against **Google's public signing keys**,
 * then checks that `aud` is this project and `iss` is `securetoken.google.com/<project>`. All of
 * that is public-key work: it needs a project id and nothing else. A service account would buy
 * exactly one extra thing — `checkRevoked: true`, which calls the Auth API to ask whether the
 * account was disabled since the token was minted. That is a 5-minute window on a 1-hour token and
 * it is not what stands between Ian and his own books today, so it is not required here. Written
 * down rather than left implicit, because *"we could not verify revocation"* is a real limitation
 * and a silent one.
 *
 * ## ⛔ Its own admin app, and never the storage driver's
 *
 * v2's identity project and its STORAGE project are **different projects on purpose** (decision 1;
 * `.env.example`: identity is v1's `studio-…`, storage is `shareat-hub-v2`). So this file
 * initialises its own `firebase-admin` app under its own name, configured with a project id and no
 * credential. `@shareat/storage-firebase` keeps `'shareat-storage'`, initialised with a
 * service-account `cert()`. Neither can inherit the other's project or credential, which is what
 * makes "identity and storage are separate" true in the process and not only in the env file.
 *
 * ⚠️ Server-only. It is imported by `sign-in/actions.ts` (`'use server'`) and by nothing that
 * renders — `firebase-admin` is in `next.config.js`'s `serverExternalPackages` and must stay out of
 * every client bundle. The browser's half of this flow uses the *client* SDK in
 * `sign-in/EmailSignInForm.tsx`.
 */
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { AuthenticationError } from '@shareat/auth';
import { env } from '@shareat/core/env';
import { logger } from '@shareat/core/logger';

/** Fixed name so a second call in the same process reuses the app — `initializeApp` is a
 *  singleton-per-name API and throws "app already exists" otherwise. ⛔ Never
 *  `'shareat-storage'`: that one is the storage project, holding a service-account credential. */
const AUTH_APP_NAME = 'shareat-auth';

/** A Firebase identity whose signature has been checked. **Every field came out of the token.** */
export interface VerifiedFirebaseIdentity {
  /** The Firebase uid — the `external_id` of a `person_credentials` row of kind `firebase`. */
  readonly uid: string;
  /** ⚠️ Display only. It is what the account was created with, not proof of anything. */
  readonly email: string | null;
  readonly displayName: string | null;
}

function authApp(): App {
  const existing = getApps().find((a) => a.name === AUTH_APP_NAME);
  if (existing) return existing;

  const { FIREBASE_PROJECT_ID } = env();
  if (!FIREBASE_PROJECT_ID) {
    // ⚠️ A configuration failure, not a sign-in failure, and it says so. Without a project id
    // there is no `aud` to compare against, so "verification" would either be skipped or would
    // trust whatever project the token came from — the fail-OPEN shape bible §7 rule 9 exists to
    // forbid. In production `env()` has already refused to start for this; this branch is
    // development, where the variable is allowed to be blank.
    throw new Error(
      'FIREBASE_PROJECT_ID is not set, so no email sign-in can be verified. Set it to the ' +
        'identity project in .env.local (see .env.example — it is v1\'s project, not the ' +
        'storage project). PIN sign-in does not need it and still works.',
    );
  }

  // ⛔ No `credential`. See the header: token verification is public-key work. Passing the project
  // id explicitly is what makes `aud`/`iss` checkable without one.
  return initializeApp({ projectId: FIREBASE_PROJECT_ID }, AUTH_APP_NAME);
}

/**
 * The verified identity behind an ID token, or `AuthenticationError`.
 *
 * ⚠️ **Every failure is the same sentence to the caller** — expired, wrong project, tampered,
 * truncated, or plain nonsense. The distinction is worth having in a server log and nowhere else:
 * telling the browser *which* check failed tells an attacker which half to keep working on. Same
 * flat-refusal idiom as `signInWithPin`.
 *
 * ⚠️ `email_verified` is **not** required. Ian's v1 admin account is years old and the ERP is not
 * the place to start enforcing email verification — Firebase's console is. Requiring it here would
 * lock the owner out of his own system to make a point about hygiene.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseIdentity> {
  if (!idToken) throw new AuthenticationError('Sign-in failed: no sign-in token was presented.');

  let decoded;
  try {
    decoded = await getAuth(authApp()).verifyIdToken(idToken);
  } catch (err) {
    // The reason goes to the log, never to the response. ⛔ The token itself is never logged: it is
    // a bearer credential for the next hour, and a log line is a place credentials survive.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'firebase id token verification failed',
    );
    throw new AuthenticationError(
      'Sign-in failed: that sign-in could not be verified. Try signing in again.',
    );
  }

  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email : null,
    // `name` is Firebase's display-name claim. It is absent on accounts created by email and
    // password without a profile, which is why the setup screen lets Ian type his own.
    displayName: typeof decoded.name === 'string' ? decoded.name : null,
  };
}
