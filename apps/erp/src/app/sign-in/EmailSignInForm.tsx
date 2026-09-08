'use client';

/**
 * Email and password sign-in — the browser's half. T-232 slice 1.
 * `docs/tasks/232-email-sign-in-and-first-run-setup.md`, bible §7.1.
 *
 * ## ⭐ Why this is a client component when nothing else in this app is
 *
 * The password is exchanged **between the browser and Google**, and this server never sees it. The
 * only thing that crosses to `signInWithEmailAction` is the ID token Google hands back — a
 * one-hour, signed assertion of *"this uid authenticated"*. So there is no password to store, to
 * hash, to rate-limit or to leak here, and v1's `login-form.tsx` works the same way for the same
 * reason. A server-side password check would mean this app holding Ian's password, which is the one
 * thing the Firebase-as-IdP decision exists to avoid.
 *
 * ⛔ **The uid is never posted.** The form sends the *token*; the server derives the uid from it with
 * `verifyIdToken`. Posting a uid would be the exact `actorUid` shape
 * `tests/unit/no-client-supplied-actor.test.ts` forbids repo-wide — a name the server cannot check.
 *
 * ## Its own Firebase app, and why that is safe here
 *
 * `terminal/firebase.ts` carries a standing warning that its app NAME is part of the clock
 * terminal's durable identity, because Firestore's offline store is keyed by it. This app is
 * **auth-only** — no `initializeFirestore`, no persistent cache, so it opens no IndexedDB store and
 * cannot orphan a punch. It exists separately so the sign-in page does not pull the terminal's
 * Firestore bundle (measured at 127 KB gzipped) into a screen that only needs a token.
 *
 * ⭐ **`inMemoryPersistence`, deliberately.** Firebase would otherwise keep its own refresh token in
 * IndexedDB, leaving a second, longer-lived credential in the browser that this system never reads
 * and cannot revoke. After this component has its ID token the Firebase session has no further job:
 * v2's authority is the `shareat_session` cookie, minted from Postgres. One durable credential per
 * browser, and it is ours.
 */
import { useState } from 'react';
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  inMemoryPersistence,
  setPersistence,
  signInWithEmailAndPassword,
  type Auth,
} from 'firebase/auth';
import { publicEnv } from '@shareat/core/env';
import { signInWithEmailAction } from './actions';

/** ⛔ Never `TERMINAL_APP_NAME`. See the header — that name owns an offline Firestore store. */
const SIGN_IN_APP_NAME = 'shareat-sign-in';

let cached: { app: FirebaseApp; auth: Auth } | null = null;

/**
 * The one Firebase instance this form ever uses.
 *
 * ⚠️ Memoised and name-matched rather than re-initialised, because `initializeApp` throws on a
 * second call with the same name — and React's development double-render makes that a certainty
 * rather than a risk.
 */
function signInFirebase(): { app: FirebaseApp; auth: Auth } {
  if (cached) return cached;

  // ⚠️ Every value here is inlined by Next at BUILD time from the deploy workflow's
  // `NEXT_PUBLIC_FIREBASE_*` secrets. If they are wrong, the browser talks to the wrong Firebase
  // project and Ian's password is "incorrect" against a project his account does not exist in —
  // which is why `publicEnv()` validates them loudly instead of defaulting them.
  const cfg = publicEnv();
  const existing = getApps().find((a) => a.name === SIGN_IN_APP_NAME);
  const app =
    existing ??
    initializeApp(
      {
        apiKey: cfg.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: cfg.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: cfg.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      },
      SIGN_IN_APP_NAME,
    );

  cached = { app, auth: getAuth(app) };
  return cached;
}

/**
 * ⚠️ **One sentence for every wrong-credential shape.** `auth/user-not-found`,
 * `auth/wrong-password` and `auth/invalid-credential` all say the same thing to the visitor, for the
 * reason `signInWithPin` gives: distinguishing them tells someone guessing which half to keep
 * working on. The two cases that get their own sentence are the ones where the visitor's next action
 * is genuinely different — being throttled, and having no network.
 */
function firebaseSignInMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Firebase has paused sign-in for this account for a few minutes — wait, then try again.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Could not reach the sign-in service. Check the connection and try again.';
  }
  if (code === 'auth/invalid-email') return 'That does not look like an email address.';
  return 'Wrong email or password.';
}

/**
 * Next signals a redirect from a server action by throwing an error carrying a `digest` that starts
 * with `NEXT_REDIRECT`. There is no exported helper for this on the client, so it is matched on the
 * documented prefix — deliberately narrow, so an unrelated failure is never mistaken for a
 * navigation and silently swallowed.
 */
function isRedirectError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('digest' in err)) return false;
  const { digest } = err as { digest?: unknown };
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

export function EmailSignInForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ⚠️ Configuration is read INSIDE the render so a missing value degrades to a sentence on this
  // one form rather than throwing out of the sign-in page and taking the PIN form — the path every
  // terminal in every store uses — down with it. Decision 6: the PIN sign-in stays exactly as it is.
  //
  // ⛔ And it is read HERE, in the client component, rather than in the server page: a
  // `NEXT_PUBLIC_*` value is guaranteed to be inlined into the browser bundle at build time, which
  // is the one place this check cannot be wrong about what the browser will actually get.
  let configError: string | null = null;
  try {
    publicEnv();
  } catch (err) {
    configError = err instanceof Error ? err.message : 'Public Firebase config is incomplete.';
  }

  if (configError) {
    return (
      <div className="rounded-lg border border-dashed border-amber-400 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <strong className="block text-sm">Email sign-in is not configured on this server.</strong>
        <span className="mt-1 block">
          The build is missing its Firebase identity values, so there is no project to sign in
          against. PIN sign-in is unaffected.
        </span>
        {/**
         * ⛔ **The list of missing variables is shown OUTSIDE production only.** `/sign-in` is an
         * unauthenticated page, and naming which secrets a server is missing tells a stranger more
         * about the deployment than it tells the operator, who has the log and the workflow. Same
         * rule `api/health/route.ts` states for the same reason, and the same one
         * `emailSignInMessage` applies on the server side of this form.
         */}
        {process.env.NODE_ENV !== 'production' ? (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono">{configError}</pre>
        ) : (
          <span className="mt-2 block">
            An administrator can compare this deployment&apos;s Firebase values against
            <code className="mx-1">.env.example</code>.
          </span>
        )}
      </div>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    let idToken: string;
    try {
      const { auth } = signInFirebase();
      // Must be set before signing in — see the header. Persistence chosen per app instance.
      await setPersistence(auth, inMemoryPersistence);
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      idToken = await credential.user.getIdToken();
    } catch (err) {
      setError(firebaseSignInMessage(err));
      setBusy(false);
      return;
    }

    const fd = new FormData();
    fd.set('idToken', idToken);
    fd.set('next', next);

    /**
     * ⚠️ **`busy` must be released here, and a `finally` is the only place that is true.** Every
     * outcome of this action is a redirect, and the failure ones redirect back to
     * `/sign-in?error=…` — the **same route segment**, so Next soft-navigates and this component is
     * re-rendered rather than re-mounted. Its state survives. Without the `finally` the button stays
     * disabled and reading "Signing in…" beside the error message it just produced, until the
     * visitor reloads by hand.
     *
     * ⛔ A redirect is re-thrown rather than reported. Next signals one by throwing an error whose
     * `digest` begins `NEXT_REDIRECT`; turning that into "something went wrong" would replace a
     * working navigation with a false sentence. Everything else — the server unreachable, the action
     * failing to serialise — is real and gets a sentence, because the alternative is a spinner that
     * never resolves and no explanation anywhere.
     */
    try {
      await signInWithEmailAction(fd);
    } catch (err) {
      if (isRedirectError(err)) throw err;
      setError('Could not reach the server to finish signing in. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 text-sm">
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Email</span>
        <input
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          // Touch-first: py-3 keeps the tap target comfortable on a phone in portrait, the same
          // sizing the PIN input beside it uses.
          className="rounded border border-neutral-300 bg-white px-3 py-3 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border border-neutral-300 bg-white px-3 py-3 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-neutral-900 px-4 py-3 font-medium text-white hover:bg-neutral-700 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        {busy ? 'Signing in…' : 'Sign in with email'}
      </button>
    </form>
  );
}
