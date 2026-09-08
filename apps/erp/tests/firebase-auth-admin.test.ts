/**
 * `verifyFirebaseIdToken` — its refusal paths, executed. T-232 slice 1, review item 6.
 *
 * ## ⭐ Why this test exists
 *
 * This function is the gate the whole email sign-in stands on, and until now **it had never run in
 * any test** — the integration suite exercises the decision that follows verification by handing it a
 * uid string. A gate nothing executes is a gate nobody has watched fail.
 *
 * ## ⛔ What it does NOT test, stated plainly
 *
 * A *successful* verification. That needs a real ID token minted by Firebase for a real account, so
 * it belongs to the live smoketest and cannot be faked here: a token this test could produce is
 * exactly a token `verifyIdToken` must reject. So this file covers the two refusals that are
 * deterministic and offline, and the success path stays the orchestrator's browser pass on 9008.
 *
 * ⚠️ **No network is touched.** An empty token is refused before an app is even initialised, and a
 * malformed one fails while `firebase-admin` is still decoding the JWT locally — before it would
 * fetch Google's public keys. That is why the token here is unmistakably not a JWT rather than a
 * plausible-looking forgery, which WOULD reach the network.
 *
 * ⚠️ Statically imported, and `process.env` is set in `beforeEach` rather than around a dynamic
 * `import()`: `vi.resetModules()` plus a re-import of this module tree cost ~4.6 s cold, which alone
 * blows the unit project's 5 s default timeout — the trap that made T-232's first unit test fail for
 * a reason unrelated to the code under test.
 *
 * ⚠️ **The missing-`FIREBASE_PROJECT_ID` path is deliberately not here.** `authApp()` memoises the
 * Firebase app by name and `env()` caches its parse, so whichever test ran first would decide the
 * answer for every test after it — the assertion would be about ordering, not about the code. It
 * needs its own file, and it is recorded as such rather than written wrongly here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthenticationError } from '@shareat/auth';
import { verifyFirebaseIdToken } from '../src/lib/firebase-auth-admin';

/** `env()` validates the WHOLE server contract, so the two non-negotiable secrets must be present
 *  even though nothing on this path reads them. */
const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:pw@localhost:5435/shareat_dev',
  SESSION_SECRET: 'x'.repeat(48),
  APP_TIMEZONE: 'Asia/Manila',
  // ⭐ Set, because the point of these cases is the VERIFICATION refusing — not the configuration.
  FIREBASE_PROJECT_ID: 'studio-test-identity',
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = process.env;
  process.env = { ...BASE } as unknown as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = saved;
});

describe('verifyFirebaseIdToken — every refusal is one sentence, and none of them names the token', () => {
  it('⛔ refuses an empty token before it initialises anything', async () => {
    await expect(verifyFirebaseIdToken('')).rejects.toThrow(AuthenticationError);
    await expect(verifyFirebaseIdToken('')).rejects.toThrow(/no sign-in token was presented/);
  });

  it('⛔ refuses a malformed token as unverifiable — an AuthenticationError, not a crash', async () => {
    const rubbish = 'this-is-not-a-jwt';

    await expect(verifyFirebaseIdToken(rubbish)).rejects.toThrow(AuthenticationError);

    // ⚠️ The sentence is the flat one, and it must stay flat: expired, tampered, wrong project and
    // nonsense all say this, because distinguishing them tells an attacker which half to work on.
    const err = await verifyFirebaseIdToken(rubbish).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).message).toMatch(/could not be verified/);

    // ⛔ The token is a bearer credential for the next hour. It must not appear in the message a
    // browser is shown, nor in anything derived from it.
    expect((err as Error).message).not.toContain(rubbish);
  });

  it('⛔ an AuthenticationError is what the action treats as "tell the visitor" — it is not a plain Error', async () => {
    // The action's message policy turns on exactly this distinction: an `AuthenticationError` is
    // written for a person and is shown; anything else is a server problem, logged and reduced to one
    // sentence in production. If this ever became a plain Error, a configuration bug and a bad
    // password would start reading the same to both the visitor and the log.
    const err = await verifyFirebaseIdToken('still-not-a-jwt').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as Error).name).toBe('AuthenticationError');
  });
});
