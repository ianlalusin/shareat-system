/**
 * The one Firebase app every client-side sign-in form on this page shares. Extracted from
 * `EmailSignInForm.tsx` (T-232) when `TerminalSignInForm.tsx` (T-304) needed the identical
 * setup rather than a second, divergent copy.
 *
 * ⛔ Never `TERMINAL_APP_NAME` — that name owns `clock_terminals`' offline Firestore store
 * (`terminal/firebase.ts`). This app is auth-only: no `initializeFirestore`, no persistent cache.
 *
 * ⭐ `inMemoryPersistence`, deliberately. After a form here has its ID token, the Firebase client
 * session has no further job — v2's authority is the `shareat_session` cookie minted from
 * Postgres. One durable credential per browser, and it is ours.
 */
'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, inMemoryPersistence, setPersistence, type Auth } from 'firebase/auth';
import { publicEnv } from '@shareat/core/env';

const SIGN_IN_APP_NAME = 'shareat-sign-in';

let cached: { app: FirebaseApp; auth: Auth } | null = null;

/**
 * ⚠️ Memoised and name-matched rather than re-initialised, because `initializeApp` throws on a
 * second call with the same name — and React's development double-render makes that a certainty
 * rather than a risk.
 */
export function signInFirebase(): { app: FirebaseApp; auth: Auth } {
  if (cached) return cached;

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

/** Every form on this page calls this before signing in — see the header for why. */
export async function prepareSignInPersistence(auth: Auth): Promise<void> {
  await setPersistence(auth, inMemoryPersistence);
}
