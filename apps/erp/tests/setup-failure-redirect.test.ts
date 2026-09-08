import { describe, expect, it } from 'vitest';
import { setupFailureRedirect } from '../src/app/setup/lib';

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
