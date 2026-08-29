/**
 * The clock terminal's Firebase app. T-184.
 * `docs/tasks/184-offline-clock-terminal.md`, bible §5.2.
 *
 * ⛔ **CLIENT SDK ONLY.** Bible §5.2 is binding: *"the clock terminal reads and writes Firestore via
 * the client SDK, never via Server Actions. A Server Action cannot function offline."* Nothing in
 * this directory may import `@shareat/db`, `@shareat/domain`, `next/headers`, or a `'use server'`
 * module — and `apps/erp/tests/clock-route-is-client-only.test.ts` fails the build if it does,
 * because a rule nothing enforces is a comment.
 *
 * 📏 The import surface is deliberate and measured: T-180 finding 4 put `app` + `auth` + exactly
 * these Firestore functions at **127 KB gzipped**. No barrel imports, no `firebase/analytics`.
 */
import { initializeApp, getApp, getApps, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  type Firestore,
} from 'firebase/firestore';

/**
 * ⭐⭐ **THE APP NAME IS PART OF THE TERMINAL'S DURABLE IDENTITY. DO NOT CHANGE IT. EVER.**
 *
 * T-180 finding 2. Firestore's offline store is an IndexedDB database named literally:
 *
 * ```
 * firestore/{firebaseAppName}/{projectId}/main
 * ```
 *
 * Not the project alone, and not the Firestore database id — **the app name**. So renaming this
 * constant, or calling `initializeApp` with a different label anywhere, **silently orphans every
 * punch that has not yet synced.** No error, no warning, nothing in a log: the new instance opens a
 * different database, finds it empty, and carries on.
 *
 * ⚠️ This cost the spike two false negatives before it was found — its first attempt gave each
 * instance a fresh name to dodge the SDK's instance cache, so the "restarted" terminal opened a
 * different store, found nothing, and the suite reported that offline persistence does not survive
 * a restart. **It does. The test was wrong.**
 *
 * ⛔ Never derive this from anything that can vary per build, per store or per device.
 */
export const TERMINAL_APP_NAME = 'shareat-clock-terminal';

function firebaseConfig() {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID is not set. The terminal cannot open its offline store ' +
        'without a project id — see .env.example.',
    );
  }
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? 'emulator',
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${projectId}.appspot.com`,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? 'emulator',
  };
}

/** Set when the terminal is pointed at the local emulator suite rather than a real project. */
const emulatorHost = () => process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST;

let cached: { app: FirebaseApp; db: Firestore; auth: Auth } | null = null;

/**
 * The one Firebase instance this page ever uses.
 *
 * ⚠️ Memoised rather than re-initialised, because `initializeFirestore` throws if called twice on
 * one app — and React's development double-render makes that a certainty rather than a risk.
 */
export function terminalFirebase(): { app: FirebaseApp; db: Firestore; auth: Auth } {
  if (cached) return cached;

  const existing = getApps().find((a) => a.name === TERMINAL_APP_NAME);
  const app = existing ?? initializeApp(firebaseConfig(), TERMINAL_APP_NAME);

  /**
   * ⭐ `persistentLocalCache` is the entire bet. Bible §5.2: the SDK provides *"offline
   * persistence, automatic replay, and conflict-free append-only writes **as platform behaviour**,
   * which v1 reimplemented by hand and got partly wrong."* T-180 confirmed all three.
   *
   * ⛔ There is no queue module in this codebase, and there must never be one. v1's
   * `punch-queue.ts` + `sync-engine.ts` are what this line replaces.
   */
  const db = existing
    ? initializeFirestoreOnce(app)
    : initializeFirestore(app, { localCache: persistentLocalCache() });

  const auth = getAuth(app);

  const host = emulatorHost();
  if (host) {
    const [name, port] = host.split(':');
    connectFirestoreEmulator(db, name!, Number(port ?? 8182));
    // `disableWarnings` only silences the console banner; the emulator is still obvious on screen.
    connectAuthEmulator(auth, `http://${name}:${process.env.NEXT_PUBLIC_FIREBASE_AUTH_PORT ?? 9198}`, {
      disableWarnings: true,
    });
  }

  cached = { app, db, auth };
  return cached;
}

/** A second `initializeFirestore` on the same app throws; this recovers the existing one. */
function initializeFirestoreOnce(app: FirebaseApp): Firestore {
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache() });
  } catch {
    // Already initialised — the module was re-evaluated, not the app re-created.
    return initializeFirestore(getApp(TERMINAL_APP_NAME), {});
  }
}

/**
 * ⭐ Ask the browser not to evict our IndexedDB under storage pressure.
 *
 * T-180 finding 5 names eviction as *"the one that could actually lose a punch"*, and v1 already
 * calls this (`credential-cache.ts:31`) — carried forward rather than rediscovered.
 *
 * ⚠️ Best-effort by design: browsers may refuse, and Safari/WebView policies vary. A refusal is
 * reported on screen rather than thrown, because a terminal that will not start because storage is
 * merely *probably* durable is worse than one that says so and keeps working.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
