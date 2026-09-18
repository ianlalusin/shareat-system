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
import {
  getAuth,
  inMemoryPersistence,
  setPersistence,
  connectAuthEmulator,
  type Auth,
} from 'firebase/auth';
import { publicEnv } from '@shareat/core/env';

const SIGN_IN_APP_NAME = 'shareat-sign-in';

let cached: { app: FirebaseApp; auth: Auth } | null = null;

/**
 * ⚠️ Memoised and name-matched rather than re-initialised, because `initializeApp` throws on a
 * second call with the same name — and React's development double-render makes that a certainty
 * rather than a risk.
 *
 * ⚠️ The memo does NOT by itself guarantee `connectAuthEmulator` below runs at most once per Auth
 * instance. On a module re-evaluation (Fast Refresh — the mode this emulator wiring exists for)
 * `cached` is null again, `existing` recovers the same Firebase app, and `getAuth(app)` hands back
 * the SAME Auth object, so the call can be reached again on an Auth that already issued requests.
 * Measured in firebase 11.10.0: a second call with a byte-identical URL and options is a silent
 * no-op; anything different throws `auth/emulator-config-failed`. Severity is low in a browser
 * bundle, where the URL cannot change between evaluations.
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

  const auth = getAuth(app);

  // Connects to the auth emulator when, and only when, NEXT_PUBLIC_FIREBASE_EMULATOR_HOST is set
  // — the shape terminal/firebase.ts:101-108 already uses.
  //
  // ⛔⛔ terminal/firebase.ts:102 gates on the host alone, with no NODE_ENV check, and calls
  // connectAuthEmulator at :106 on /clock — a production page every store uses. That is not a
  // deliberate difference in approach; it is the SAME HOLE this amendment exists to close, still
  // open in that file. It is must-not-touch (the worked example) and stays that way — filed as
  // its own defect row rather than fixed here. This file's `NODE_ENV !== 'production'` guard
  // exists so the emulator wiring cannot ship at all: a misrouted Firestore emulator is a bug;
  // authentication for every store silently targeting localhost is worse, and this invariant
  // does not get to depend on deploy.yml's allowlist and deploy-preflight's missing denylist
  // holding forever.
  const host = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST;
  if (process.env.NODE_ENV !== 'production' && host) {
    // The documented value is `localhost:8182`, and 8182 is the FIRESTORE port
    // (firebase/firebase.json) — only the host name before the colon is used here. Passing the
    // raw value through would produce `http://localhost:8182:9198`, which firebase 11.10.0's
    // connectAuthEmulator accepts silently (it splits on ':' and keeps the first pair), pointing
    // auth at the Firestore port instead and failing every request opaquely.
    // ⚠️ A scheme prefix is stripped first for the same reason: `.env.example` documents the bare
    // `host:port` form, but if a `http://` prefix reaches here uncaught, `http://localhost:8182`
    // splits to name `http` — the assert on the URL scheme still passes, and every request then
    // fails with a DNS error dressed up as "Could not reach the sign-in service."
    const [name] = host.trim().replace(/^https?:\/\//, '').split(':');
    if (!name) {
      // Same opaque-failure shape the port validation below exists to end, on the other half of
      // the same URL: a leading colon or a bare scheme (`http://`, `:8182`) would otherwise
      // produce `http://:9198`, which the SDK's scheme assert accepts — config silently applied
      // with no usable host. Dev-only console noise, same reasoning as the port warning below:
      // this branch is dead code in production, so it can only reach the developer who set it.
      console.warn(
        `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST=${JSON.stringify(host)} has no usable host after stripping its scheme — the emulator was not wired.`,
      );
    } else {
      // Empty-string safe, not `??`-safe: `??` only replaces null/undefined, so an empty
      // NEXT_PUBLIC_FIREBASE_AUTH_PORT (this repo's habit — DEF-369: all five NEXT_PUBLIC_FIREBASE_*
      // values sit empty in .env.local today) would flow straight through. The `rawPort !== ''`
      // check below is what catches that now; terminal/firebase.ts:106 uses `??` for its own
      // fallback because its values are never expected empty in the same way.
      // ⛔ Validated and range-checked, not merely defaulted: the installed SDK's own port parser
      // treats anything that isn't a clean number as `null`, and a null port collapses the
      // authority to `http://<host>/` — auth silently targets port 80. A quoted value
      // (`set VAR="9198"` on Windows keeps the quotes) or a stray space produces exactly this;
      // an out-of-range integer (99999, 0, -1) parses cleanly but names no real port. Falls back
      // to 9198 rather than passing a malformed or nonsensical value through, the same failure
      // shape the host split above already guards.
      const rawPort = (process.env.NEXT_PUBLIC_FIREBASE_AUTH_PORT ?? '').trim();
      const parsedPort = Number(rawPort);
      const validPort =
        rawPort !== '' && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535;
      // Loud on purpose: this whole branch is dead code in production (the NODE_ENV guard above),
      // so this can only ever reach the developer who set the value, never a store operator — and
      // a silent substitution here is the exact failure class this task exists to end (someone
      // sets a port, it is quietly discarded, and nothing says so).
      if (rawPort !== '' && !validPort) {
        console.warn(
          `NEXT_PUBLIC_FIREBASE_AUTH_PORT=${JSON.stringify(rawPort)} is not a valid port — falling back to port 9198.`,
        );
      }
      const port = validPort ? parsedPort : 9198;
      connectAuthEmulator(auth, `http://${name}:${port}`, { disableWarnings: true });
    }
  }

  // Assigned AFTER the emulator call, deliberately: if connectAuthEmulator throws above, `cached`
  // stays null rather than handing back an Auth that never got pointed at the emulator — which
  // would go live against production while the caller believes it is sandboxed (invariant 1's
  // mirror image). ⚠️ This is fail-closed, not retry-and-recover: the SDK does not return to a
  // callable state on that Auth instance after the first throw, so re-entering this function
  // re-throws PERMANENTLY, by design, until a full reload. What makes that survivable is the
  // auth/emulator-config-failed branch in firebaseSignInMessage — the failure is readable, even
  // though it does not go away on its own.
  cached = { app, auth };
  return cached;
}

/** Every form on this page calls this before signing in — see the header for why. */
export async function prepareSignInPersistence(auth: Auth): Promise<void> {
  await setPersistence(auth, inMemoryPersistence);
}
