/**
 * `signInFirebase()` — the auth-emulator wiring T-323/DEF-371 adds (Contract 1). Its own file,
 * and that is not a style preference: `firebase-auth-admin.test.ts:27-30` already paid for this
 * lesson — a memoised Firebase app means whichever case ran first would decide the answer for
 * every case after it if they shared one.
 *
 * ⚠️ `vi.resetModules()` ALONE is not enough here: vitest externalises `firebase/app` and
 * `firebase/auth` (node_modules), so their own internal registries would otherwise survive a
 * reset. `vi.doMock` replaces both with brand-new spies inside `freshSignInFirebase` on every
 * call, so `firebase-client.ts`'s module-level `cached` (`:27`) is genuinely `null` at the start
 * of every case regardless of order — the isolation the negative leg below depends on to mean
 * anything at all (DEF-363 with the legs swapped: a positive leg running first must not silently
 * make the negative leg pass by touching no code).
 *
 * This file imports `firebase-client.ts` directly, not a form component — no `'use server'`
 * import chain here, so the ~4.6s `./actions` cost documented in the other two files does not
 * apply.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const firebaseClientSource = readFileSync(
  resolve(here, '..', 'src', 'app', 'sign-in', 'firebase-client.ts'),
  'utf8',
);

/** The three values `publicEnv()` hard-requires. `signInFirebase()` calls it before anything
 *  else, and this suite is about the emulator branch, not about `publicEnv()` throwing. */
const BASE_ENV = {
  NODE_ENV: 'test',
  NEXT_PUBLIC_FIREBASE_API_KEY: 'test-api-key',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'test-project',
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = process.env;
});

afterEach(() => {
  process.env = saved;
});

/**
 * Fresh mocks, a fresh module registry, and a fresh import per call — never a shared spy, never
 * a shared `cached`.
 */
async function freshSignInFirebase(envOverrides: Record<string, string | undefined>) {
  process.env = { ...BASE_ENV, ...envOverrides } as unknown as NodeJS.ProcessEnv;

  const connectAuthEmulator = vi.fn();
  const setPersistence = vi.fn();
  const getAuth = vi.fn(() => ({}));
  const initializeApp = vi.fn((_cfg: unknown, name: string) => ({ name }));
  const getApps = vi.fn(() => [] as Array<{ name: string }>);

  vi.resetModules();
  vi.doMock('firebase/app', () => ({ initializeApp, getApps }));
  vi.doMock('firebase/auth', () => ({
    getAuth,
    inMemoryPersistence: 'IN_MEMORY_PERSISTENCE',
    setPersistence,
    connectAuthEmulator,
  }));

  const mod = await import('../src/app/sign-in/firebase-client');
  return { mod, connectAuthEmulator, getAuth, initializeApp, getApps, setPersistence };
}

describe('signInFirebase() — the auth emulator wiring, Contract 1', () => {
  it('⛔⛔ positive: the documented localhost:8182 fixture reaches port 9198, never the Firestore port carried in the fixture', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
    });

    mod.signInFirebase();

    expect(connectAuthEmulator).toHaveBeenCalledTimes(1);
    // ⚠️ The third argument is asserted deliberately — see Contract 1's "options" bullet: leaving
    // it out would pass even if the builder dropped `{ disableWarnings: true }`, and the SDK's
    // fixed-position red "Running in emulator mode" banner would paint over the screen in dev.
    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://localhost:9198', {
      disableWarnings: true,
    });
  });

  it('honours NEXT_PUBLIC_FIREBASE_AUTH_PORT when it overrides the 9198 default', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
      NEXT_PUBLIC_FIREBASE_AUTH_PORT: '9500',
    });

    mod.signInFirebase();

    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://localhost:9500', {
      disableWarnings: true,
    });
  });

  it('⛔ a scheme-bearing host still reaches port 9198 on the bare host name — deleting the scheme-strip would leave every OTHER case in this file green', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'http://localhost:8182',
    });

    mod.signInFirebase();

    // Without stripping the scheme first, `"http://localhost:8182".split(':')` is
    // ['http', '//localhost', '8182'] and only the FIRST element is used as the host name — so the
    // URL would read "http://http:9198": an outright wrong host, not a DNS error dressed up as
    // anything. No other case in this file passes a scheme-bearing value, so this is the only
    // thing that would notice that line being deleted.
    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://localhost:9198', {
      disableWarnings: true,
    });
  });

  it('⛔ a host that strips to nothing (a bare scheme, no host behind it) skips the emulator call entirely rather than building a broken "http://:9198" — the round-5 !name branch', async () => {
    const { mod, connectAuthEmulator, initializeApp } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'http://',
    });

    mod.signInFirebase();

    // 'http://' is the discriminating fixture: it is TRUTHY, so it passes the pre-existing
    // `if (host)` gate the same as every other case here — under the code as it stood before this
    // round's !name check existed, stripping the scheme would leave an empty name and this would
    // have built "http://:9198", a broken URL the SDK's scheme assert still accepts silently. A
    // value that was already falsy (like the existing empty-string-host case) only exercises the
    // OLDER `if (host)` gate, not this one.
    expect(connectAuthEmulator).not.toHaveBeenCalled();
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('⛔ a port value that is not a clean integer falls back to the 9198 default, not to a blank port — asserted against the BEHAVIOUR, not the `||` operator, since the builder is separately adding numeric validation this round', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
      NEXT_PUBLIC_FIREBASE_AUTH_PORT: '',
    });

    mod.signInFirebase();

    // Guards the empty-string divergence the `||` (not `??`) comment in firebase-client.ts exists
    // to explain: "harmonising" that operator back to `??` would let an empty string flow through
    // and produce "http://localhost:" instead of falling back to 9198. Written against the
    // outcome so it keeps meaning the same thing once the builder's numeric-validation fix lands.
    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://localhost:9198', {
      disableWarnings: true,
    });
  });

  it('⛔⛔ a quoted port (Windows `set VAR="9500"` keeps the quotes) falls back to 9198, never to the quoted number and never to a blank port', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
      NEXT_PUBLIC_FIREBASE_AUTH_PORT: '"9500"',
    });

    mod.signInFirebase();

    // The fixture deliberately asks for a port (9500) that DIFFERS from the fallback (9198) — a
    // fixture of '"9198"' cannot discriminate a working validation from a deleted one, since the
    // malformed value and the fallback would be the same number either way (Contract 1's own
    // colon-less-host lesson, applied to the port). Deleting the builder's Number.isInteger check
    // makes this go green on 9500 (Number('"9500"') is NaN, `??` would still reject null/undefined
    // only) or produce a null-port "http://localhost/" — either way this assertion catches it.
    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://localhost:9198', {
      disableWarnings: true,
    });
  });

  it('⛔ an out-of-range port (a clean integer, but not a real port) falls back to 9198 — Number.isInteger(99999) is true, so only the round-5 range check catches this', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
      NEXT_PUBLIC_FIREBASE_AUTH_PORT: '99999',
    });

    mod.signInFirebase();

    // 99999 is the discriminating fixture, same rule as the quoted-port case above: it is a VALID
    // integer, so it fails if `parsedPort > 0 && parsedPort <= 65535` is removed while
    // Number.isInteger stays — a non-numeric fixture (already covered above) would not notice that
    // specific line disappearing.
    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://localhost:9198', {
      disableWarnings: true,
    });
  });

  it('a whitespace-padded port is trimmed and honoured, not rejected — the other half of the pair above: rejecting malformed input must not mean rejecting anything with whitespace', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
      NEXT_PUBLIC_FIREBASE_AUTH_PORT: ' 9500 ',
    });

    mod.signInFirebase();

    // Pins the .trim() specifically: nothing else in this file exercises it. Without a case like
    // this, "reject anything containing whitespace" would satisfy the quoted-port guard above and
    // still pass every other test here, while silently breaking a real, valid, merely-padded value.
    expect(connectAuthEmulator).toHaveBeenCalledWith(expect.anything(), 'http://localhost:9500', {
      disableWarnings: true,
    });
  });

  it('⛔⛔ negative, the one that matters: unset means connectAuthEmulator is never called', async () => {
    const { mod, connectAuthEmulator, initializeApp } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: undefined,
    });

    mod.signInFirebase();

    expect(connectAuthEmulator).not.toHaveBeenCalled();
    // ⚠️ Without this line, `not.toHaveBeenCalled()` alone would pass identically whether the
    // module genuinely re-executed or `cached` leaked in from a previous case and short-circuited
    // before ever reaching the emulator branch — the isolation would stop being falsifiable and
    // nothing here would notice. `initializeApp` only fires on a real, fresh evaluation of
    // `signInFirebase()`, so this is what turns "the spy saw nothing" into "the module ran and
    // chose not to call it".
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('an empty-string host is also "no call" — the gate is non-empty, not merely set (extra leg per spec, not required)', async () => {
    const { mod, connectAuthEmulator, initializeApp } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: '',
    });

    mod.signInFirebase();

    expect(connectAuthEmulator).not.toHaveBeenCalled();
    // Same reason as the unset case above: a fresh spy seeing zero calls is only meaningful if the
    // module genuinely re-ran rather than short-circuiting on a leaked `cached`.
    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('⛔⛔ Invariant 1, the code-level half: in production, connectAuthEmulator is never called even with a valid, present host — the contract amendment this guards was sitting completely unguarded until this case existed', async () => {
    const { mod, connectAuthEmulator, initializeApp } = await freshSignInFirebase({
      NODE_ENV: 'production',
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
    });

    mod.signInFirebase();

    // The host is deliberately VALID and PRESENT, not unset — an unset host would pass on the
    // `host` half of `NODE_ENV !== 'production' && host` alone and prove nothing about the
    // NODE_ENV half, indistinguishable from the plain negative leg above. Deleting
    // `process.env.NODE_ENV !== 'production' &&` from firebase-client.ts leaves every OTHER case
    // in this file green — this is the only one that would notice.
    expect(connectAuthEmulator).not.toHaveBeenCalled();
    expect(initializeApp).toHaveBeenCalledTimes(1);

    // ⚠️ THE LIMIT OF THIS TEST, STATED SO NOBODY LATER CITES IT AS MORE THAN IT IS: `NODE_ENV` is
    // read here at RUNTIME, inside vitest — this proves the BRANCH LOGIC is correct, not the
    // stronger property the amendment actually rests on. In a real production build, Next.js
    // INLINES `NODE_ENV` at build time and eliminates this whole branch as dead code, so the
    // emulator wiring cannot ship regardless of what any environment variable holds at runtime on
    // the server. Nothing in this file exercises that build-time elimination — only the logic a
    // build would be eliminating.
  });

  it('⭐ Invariant 5: a second signInFirebase() call on the SAME module instance never calls connectAuthEmulator again — the memo, not merely "called once when called once"', async () => {
    const { mod, connectAuthEmulator } = await freshSignInFirebase({
      NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
    });

    mod.signInFirebase();
    mod.signInFirebase();

    // Would stay green under the obvious wrong refactor of hoisting the emulator block above the
    // `if (cached) return cached` guard (firebase-client.ts:43) if this test only ever called
    // signInFirebase() once per case, the way the other tests in this file do — `toHaveBeenCalled
    // Times(1)` there proves "called once when called once", not the memo. Calling it twice here
    // is what makes a second, unwanted connectAuthEmulator call something this suite can catch.
    expect(connectAuthEmulator).toHaveBeenCalledTimes(1);
  });
});

describe('firebase-client.ts — Contract 2, regression guard: auth-only, never Firestore', () => {
  it('never references the firebase/firestore module family, in any import form or entrypoint — can never go red, kept per v3: the file this app was extracted from is exactly where a divergent second copy would grow back', () => {
    // One regex on the quoted module specifier, not three on individual call sites. Three
    // separate `from '...'` / `connectFirestoreEmulator(` / `initializeFirestore(` checks missed
    // `from 'firebase/firestore/lite'` (a real entrypoint), `await import('firebase/firestore')`
    // and `require('firebase/firestore')` (no `from`), `from '@firebase/firestore'` (the
    // underlying package), and any call to `getFirestore(` — the ordinary way to obtain a store,
    // which none of the three call-site patterns named at all. Every one of those forms contains
    // the quoted specifier this single regex matches; the import itself is the gate, regardless of
    // which Firestore function gets called after it. It still can't false-positive on the file's
    // own header prose, which names `initializeFirestore` without quoting a module path.
    expect(firebaseClientSource).not.toMatch(/['"]@?firebase\/firestore(\/[\w-]+)?['"]/);
  });
});
