import { describe, expect, it } from 'vitest';
import { AuthenticationError, AuthorizationError } from '@shareat/auth';
import { CONSTRAINT_MESSAGES } from '../src/lib/constraint-messages';
import { isUnmappedInfrastructureError, setupFailureRedirect } from '../src/app/setup/lib';

/**
 * T-232 slice 2 — **where a failed first run sends you, and why the answer changes halfway.**
 *
 * ⛔ **The bug this exists to prevent, found by lane C's review.** `/setup`'s action clears the
 * setup cookie the moment `bootstrapOrganization` commits. If the step AFTER that — signing the
 * new owner in — then failed, the action redirected to `/setup?error=<the real reason>`, and
 * `/setup` immediately re-redirected to `/sign-in?error="Your setup window has closed…"`, because
 * its own `readSetupIdentity` found the cookie gone. **The real error was swallowed and replaced
 * by a sentence that is false**: the window had not closed, the organisation had been created.
 *
 * ⭐ The decision is extracted here, as a pure function, precisely so it can be executed. The
 * action itself needs a Next runtime and a live Postgres to run at all; this rule needs neither,
 * and a rule that can only be verified by reading is the one that regresses.
 */
describe('setupFailureRedirect — the answer changes once the organisation exists', () => {
  describe('BEFORE the transaction commits — nothing was written, so retry the form', () => {
    it('goes back to /setup carrying the real reason', () => {
      const to = setupFailureRedirect(false, 'the PIN must be exactly 6 digits.');
      expect(to.startsWith('/setup?error=')).toBe(true);
      expect(decodeURIComponent(to.slice('/setup?error='.length))).toBe(
        'the PIN must be exactly 6 digits.',
      );
    });

    it('keeps the form usable — the setup cookie is untouched on this path, so it is a re-submit', () => {
      // ⚠️ This asserts the ROUTE, which is what makes the re-submit possible. The cookie itself is
      // the action's business; what matters here is that we do not send him through sign-in for a
      // typo, which is the whole reason the clear-on-success amendment was made.
      expect(setupFailureRedirect(false, 'anything at all')).not.toContain('/sign-in');
    });
  });

  describe('AFTER the transaction commits — the organisation exists, so sign in normally', () => {
    it('goes to /sign-in, says the organisation WAS created, and keeps the real reason', () => {
      const to = setupFailureRedirect(true, 'the session store is unreachable.');
      expect(to.startsWith('/sign-in?error=')).toBe(true);

      const message = decodeURIComponent(to.slice('/sign-in?error='.length));
      // ⛔ All three, because dropping any one of them is a different bug: without the first he
      // thinks nothing happened and retries; without the second we have hidden the cause; without
      // the third he does not know what to do next.
      expect(message).toContain('Your organisation was created');
      expect(message).toContain('the session store is unreachable.');
      expect(message).toContain('Sign in with your email to continue.');
    });

    it('⛔ never says the setup window closed — the false sentence this test exists to prevent', () => {
      const message = decodeURIComponent(
        setupFailureRedirect(true, 'boom').slice('/sign-in?error='.length),
      );
      expect(message).not.toMatch(/window has closed/i);
    });
  });

  it('punctuates a reason that has none, so two sentences do not run together', () => {
    const message = decodeURIComponent(
      setupFailureRedirect(true, 'connection reset').slice('/sign-in?error='.length),
    );
    expect(message).toContain('connection reset. Sign in');
  });

  it('URL-encodes the reason — an & or a # in a message would truncate the query string', () => {
    const to = setupFailureRedirect(false, 'bad value: a & b #1');
    expect(to).not.toContain(' & ');
    expect(to).not.toContain('#');
    expect(decodeURIComponent(to.slice('/setup?error='.length))).toBe('bad value: a & b #1');
  });
});

/**
 * ⛔ **`/setup` is an UNAUTHENTICATED surface and its refusals travel in the URL.**
 *
 * A bare driver error there puts a table name, a column or a connection detail into a query string,
 * a browser history and any proxy log, shown to someone who has proved nothing but that they hold a
 * Firebase account. The same posture `api/health/route.ts` states — *"this endpoint is
 * unauthenticated; in production it must not describe which variables are unset."*
 *
 * ⚠️ **The risk of masking is the opposite one**, and these tests exist mostly to hold that line:
 * mask too much and the screen becomes useless, because "the PIN must be exactly 6 digits" is the
 * sentence that tells Ian what to fix.
 */
describe('isUnmappedInfrastructureError — what /setup may not put in a URL', () => {
  /** postgres.js's shape: SQLSTATE on `code`, always five characters. */
  const pgError = (code: string, message: string): Error =>
    Object.assign(new Error(message), { code });

  describe('MASKED — a driver error no constraint sentence claimed', () => {
    it('a unique violation nothing mapped', () => {
      const err = pgError('23505', 'duplicate key value violates unique constraint "some_internal_idx"');
      expect(isUnmappedInfrastructureError(err, err.message)).toBe(true);
    });

    it('a missing relation — the shape that names the schema', () => {
      const err = pgError('42P01', 'relation "person_credentials" does not exist');
      expect(isUnmappedInfrastructureError(err, err.message)).toBe(true);
    });

    it('a connection failure — the shape that names the host', () => {
      const err = pgError('08006', 'connection to server at "10.0.0.4", port 5432 failed');
      expect(isUnmappedInfrastructureError(err, err.message)).toBe(true);
    });
  });

  describe('⛔ KEPT — everything written for a person to read', () => {
    it("bootstrapOrganization's own sentence, which is the whole point of the screen", () => {
      // A plain Error, no SQLSTATE. Masking this would leave Ian staring at "Setup failed" with a
      // six-digit field he mistyped by one character.
      const message = 'the PIN must be exactly 6 digits.';
      expect(isUnmappedInfrastructureError(new Error(message), message)).toBe(false);
    });

    it('the first-run-is-closed refusal', () => {
      const message = 'this system already has an organization, so first-run setup is closed.';
      expect(isUnmappedInfrastructureError(new Error(message), message)).toBe(false);
    });

    it('an AuthenticationError — already a ratified sentence', () => {
      const err = new AuthenticationError('Sign-in failed: this account is not linked to a person in this system.');
      expect(isUnmappedInfrastructureError(err, err.message)).toBe(false);
    });

    it('an AuthorizationError', () => {
      const err = new AuthorizationError('nope', 'manage_users');
      expect(isUnmappedInfrastructureError(err, err.message)).toBe(false);
    });

    it('⭐ an AuthenticationError that ALSO carries a Postgres code — the class wins', () => {
      // ⚠️ Added after a mutation test: removing both class guards left every other assertion in
      // this file green, because a plain AuthenticationError carries no `code` and the SQLSTATE
      // check alone already answered `false`. The guard was untested, so it was not a guard.
      //
      // This is the case that makes it load-bearing: a refusal written for a person, wrapped
      // around — or re-thrown from — a driver failure. The sentence was authored deliberately, so
      // the class decides, not the code.
      const err = Object.assign(
        new AuthenticationError('Sign-in failed: this account is not linked to a person in this system.'),
        { code: '08006' },
      );
      expect(isUnmappedInfrastructureError(err, err.message)).toBe(false);
    });

    it('⭐ a MAPPED constraint sentence, even though the error carries a Postgres code', () => {
      // The case that makes the `code` check alone wrong: `errorMessage` already replaced the
      // driver's words with one written for a person, so there is nothing left to leak.
      const sentence = Object.values(CONSTRAINT_MESSAGES)[0]!;
      const err = pgError('23514', 'new row violates check constraint "pay_rates_amount_positive_check"');
      expect(isUnmappedInfrastructureError(err, sentence)).toBe(false);
    });

    it('the constraint map is non-empty — otherwise the test above proves nothing', () => {
      expect(Object.values(CONSTRAINT_MESSAGES).length).toBeGreaterThan(10);
    });
  });

  describe('the discriminator is the CODE, not the wording', () => {
    it('a plain Error with no code is never masked, however alarming it reads', () => {
      const message = 'relation "person_credentials" does not exist';
      // ⚠️ Deliberate: an error with no SQLSTATE did not come from the driver, so it came from our
      // own code, where every thrown sentence in this path is written for a person.
      expect(isUnmappedInfrastructureError(new Error(message), message)).toBe(false);
    });

    it('a non-five-character code is not a SQLSTATE and is not masked', () => {
      const err = pgError('ENOTFOUND', 'getaddrinfo ENOTFOUND db.internal');
      expect(isUnmappedInfrastructureError(err, err.message)).toBe(false);
    });

    it('a thrown non-Error does not crash the check', () => {
      expect(isUnmappedInfrastructureError('a string', 'a string')).toBe(false);
      expect(isUnmappedInfrastructureError(null, '')).toBe(false);
      expect(isUnmappedInfrastructureError(undefined, '')).toBe(false);
    });
  });
});
