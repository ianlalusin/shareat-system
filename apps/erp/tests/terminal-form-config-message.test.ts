/**
 * `TerminalSignInForm` — Contract 5 (T-323, new in v2). The two-layer terminal sign-in
 * (`TerminalSignInForm.tsx`, T-304) authenticates the tablet via the same `signInFirebase()` /
 * `publicEnv()` path `EmailSignInForm` uses (`:97`, `:123` — layer 1 and layer 2) — so with the
 * three identity values missing,
 * an unguarded form would render a normal, submittable PIN screen, and a real operator's correct
 * PIN would fail with "Wrong email or password.", blaming a password that was never involved.
 * This is the louder of the two DEF-368 lies, and it sits on the screen the notice in
 * `sign-in-config-notice.test.ts` does not touch.
 *
 * ⚠️ Same import-cost trap as the other rendering test in this task: `TerminalSignInForm.tsx:25`
 * imports the identical `./actions` → `@shareat/auth` → `@shareat/db` → `next/headers` tree
 * (~4.6s cold measured in `sign-in-safe-next.test.ts:20-23`), and it is dragged in by this file
 * too, not only by `sign-in-config-notice.test.ts`. Mocked below for the same reason: nothing here
 * submits either form.
 *
 * ⛔ THE RED WAS DELIBERATELY ONE ASSERTION. "The markup does not contain 'Wrong email or
 * password.'" was never part of it: that string is absent from an UNMODIFIED, fully-submittable
 * form on a static render — `error` is `null` before any submission, and the string only ever
 * reaches the markup via `setError(...)` in the submit `catch`. Asserting its absence would have
 * been vacuously true before the builder touched anything. The regression guard below is where
 * that string belongs instead — it is what makes the outage real (a genuine PIN attempt hitting
 * the missing-config path once wired), not what proved this task's red.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSignInForm, firebaseSignInMessage } from '../src/app/sign-in/TerminalSignInForm';

vi.mock('../src/app/sign-in/actions', () => ({
  verifyTerminalAction: vi.fn(),
  signInWithTerminalPinAction: vi.fn(),
}));

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = process.env;
  // No NEXT_PUBLIC_FIREBASE_* keys at all — the missing-config path this contract adds.
  process.env = { NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = saved;
});

describe('TerminalSignInForm — Contract 5, the terminal form must not blame the password for a missing build value', () => {
  it('⭐ the red this task needed: with the three identity values unset, the rendered terminal form offers no submit control', () => {
    const html = renderToStaticMarkup(createElement(TerminalSignInForm, { next: '/' }));

    // Was red before Contract 5's publicEnv() gate landed (TerminalSignInForm.tsx had no such
    // check at all, so the 'terminal' step's submit button rendered unconditionally). The
    // assertion is unchanged now that it passes — it passes because the gate suppresses the
    // submit control, not because this check got weaker.
    expect(html).not.toMatch(/<button[^>]*type="submit"/);
    // Positive anchor, added because the absence check alone would also pass if the config branch
    // returned null instead of an unavailable line — Contract 5 requires BOTH "a short unavailable
    // line" AND "no submit control"; this is the half the no-button check doesn't cover. String
    // read from TerminalSignInForm.tsx:85, not retyped from memory.
    expect(html).toContain('Terminal sign-in is unavailable');
  });
});

describe('firebaseSignInMessage — regression guard, not red: unchanged, correct code', () => {
  it("⚠️ covers ONLY TerminalSignInForm.tsx's exported copy. EmailSignInForm.tsx:47 has its own separate, unexported, identical-looking local that ALSO now carries the two auth/emulator-config-failed / auth/invalid-emulator-scheme branches below — and stays uncovered by this guard. That copy is the PRIMARY path for DEF-371 (email sign-in, not the terminal), so the uncovered half is the one that matters most; closing it needs its own guard against an export this file cannot reach, filed separately, not attempted here.", () => {
    expect(firebaseSignInMessage({ code: 'auth/too-many-requests' })).toBe(
      'Too many attempts. Firebase has paused sign-in for this device for a few minutes — wait, then try again.',
    );
    expect(firebaseSignInMessage({ code: 'auth/network-request-failed' })).toBe(
      'Could not reach the sign-in service. Check the connection and try again.',
    );
    // T-323/Contract 1: signInFirebase()'s emulator wiring can throw these two codes when the
    // emulator is configured but unreachable — asserting the MAPPING (both codes reach this one
    // sentence), not the branch's position in the function, which is an implementation detail.
    expect(firebaseSignInMessage({ code: 'auth/emulator-config-failed' })).toBe(
      'The local emulator configuration failed to apply — this is not a wrong credential. Reload and check NEXT_PUBLIC_FIREBASE_EMULATOR_HOST.',
    );
    expect(firebaseSignInMessage({ code: 'auth/invalid-emulator-scheme' })).toBe(
      'The local emulator configuration failed to apply — this is not a wrong credential. Reload and check NEXT_PUBLIC_FIREBASE_EMULATOR_HOST.',
    );
    expect(firebaseSignInMessage({ code: 'auth/invalid-email' })).toBe(
      'That does not look like an email address.',
    );
    // The default branch — a genuine credential failure must still say this. Contract 5's
    // publicEnv() gate never reaches this function at all (it returns before onTerminalSubmit
    // exists to call it), so proving the default branch is untouched is what rules out this task
    // having quietly changed what a REAL auth/… failure tells the operator.
    expect(firebaseSignInMessage({ code: 'auth/wrong-password' })).toBe('Wrong email or password.');
    expect(firebaseSignInMessage(new Error('no code property at all'))).toBe(
      'Wrong email or password.',
    );
  });
});
