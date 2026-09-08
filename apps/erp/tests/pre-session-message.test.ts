import { afterEach, describe, expect, it, vi } from 'vitest';
// ⚠️ The leaf, for the reason §5 of the spec gives: this file asserts on two class identities
// and a pure function, and has no business paying for the database schema to do it.
import { AuthenticationError, AuthorizationError } from '@shareat/auth/errors';
import { logger } from '@shareat/core/logger';
import { CONSTRAINT_MESSAGES } from '../src/lib/constraint-messages';
import { preSessionMessage, SETUP_POLICY, SIGN_IN_POLICY } from '../src/lib/pre-session-message';

/**
 * T-235 / DEF-222 — **what a stranger is told when the server breaks.**
 *
 * ⛔ `/sign-in` and `/setup` are the only two screens reachable with no session, and both report
 * failure **in the URL**. A raw error there puts a table name, an unset variable or a connection
 * host into a query string, a browser history and any proxy log, for someone who has proved
 * nothing. `api/health/route.ts` settled the rule: *"this endpoint is unauthenticated; in
 * production it must not describe which variables are unset."*
 *
 * ⚠️ **The opposite risk is the one these tests mostly defend.** Mask too much and `/setup` — six
 * fields, filled in once, by someone who has never seen it — stops saying which field is wrong.
 * That is why there are two policies rather than one, and why case 7 exists.
 */

/**
 * `process.env.NODE_ENV` is typed readonly once Next's types are in scope. One deliberately-typed
 * accessor rather than scattered casts — the same helper, and the same reasoning, as
 * `tests/unit/env.test.ts:26-29`.
 */
type MutableEnv = Record<string, string | undefined>;
const E = () => process.env as unknown as MutableEnv;

const REAL_NODE_ENV = process.env.NODE_ENV;

/** ⚠️ Set per case and restored, never once at module scope: a suite that leaves `NODE_ENV`
 *  mutated makes every later test file's behaviour depend on file order. */
function withNodeEnv<T>(value: string, fn: () => T): T {
  E().NODE_ENV = value;
  try {
    return fn();
  } finally {
    E().NODE_ENV = REAL_NODE_ENV;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  E().NODE_ENV = REAL_NODE_ENV;
});

/** postgres.js's shape: SQLSTATE on `code`, always five characters. */
const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/**
 * ⛔ The real shape of `packages/core/src/env.ts`'s refusal — a multi-line banner that names every
 * unset variable. Reproduced rather than provoked: `env()` caches on success, so a test cannot
 * make the real one fail without corrupting every later test in the process.
 */
const ENV_FAILURE = new Error(
  '\n' +
    '='.repeat(72) +
    '\nShareat System REFUSED TO START — environment is incomplete or invalid.\n' +
    '='.repeat(72) +
    '\n  SESSION_SECRET: Required\n  DATABASE_URL: Required\n' +
    '\n\nFix .env.local (see .env.example for the full contract).\n' +
    '='.repeat(72) +
    '\n',
);

const DRIVER_ERROR = pgError('42P01', 'relation "person_credentials" does not exist');

describe('DEF-222 — /sign-in and /setup may not put a server failure in a URL', () => {
  describe('case 1 ⭐ — the one that would have caught the defect', () => {
    it('masks a driver error in production, and the driver words are ABSENT from what is returned', () => {
      const shown = withNodeEnv('production', () => preSessionMessage(DRIVER_ERROR, SIGN_IN_POLICY));

      // ⛔ Not "contains the opaque sentence" — that would pass if the real text were appended.
      expect(shown).not.toContain('person_credentials');
      expect(shown).not.toContain('relation');
      expect(shown).toBe(SIGN_IN_POLICY.opaque);
    });
  });

  describe('case 2 — outside production the reason is named in full', () => {
    it('returns the real message on a developer machine', () => {
      const shown = withNodeEnv('development', () => preSessionMessage(DRIVER_ERROR, SIGN_IN_POLICY));
      expect(shown).toBe(DRIVER_ERROR.message);
    });
  });

  describe('case 3 ⛔ — a ratified refusal survives production', () => {
    it('keeps an AuthenticationError verbatim — the wrong-PIN sentence must reach the cashier', () => {
      const err = new AuthenticationError('Sign-in failed: wrong store or PIN.');
      const shown = withNodeEnv('production', () => preSessionMessage(err, SIGN_IN_POLICY));
      expect(shown).toBe('Sign-in failed: wrong store or PIN.');
    });
  });

  describe('case 4 ⛔ — the non-zero control', () => {
    it('SETUP_POLICY keeps the first-run domain\'s own sentence in production', () => {
      // Without this the whole suite would pass against a formatter that masked everything, and
      // /setup would become a six-field form that will not say which field is wrong. T-232's
      // mutation test measured exactly this: five assertions red when the discriminator went.
      const err = new Error('the PIN must be exactly 6 digits.');
      const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));
      expect(shown).toBe('the PIN must be exactly 6 digits.');
    });

    it('and the first-run-is-closed refusal too', () => {
      const err = new Error('this system already has an organization, so first-run setup is closed.');
      const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));
      expect(shown).toContain('first-run setup is closed');
    });
  });

  describe('case 5 — a mapped constraint sentence survives, SQLSTATE and all', () => {
    it('keeps it, because errorMessage already replaced the driver words', () => {
      const sentence = Object.values(CONSTRAINT_MESSAGES)[0]!;
      const err = pgError('23514', 'new row violates check constraint "pay_rates_amount_positive_check"');
      // ⚠️ The caller applies `errorMessage()` first, so the policy is asked about the SENTENCE
      // while holding the original error. That pairing is the whole reason both are parameters.
      const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY, sentence));
      expect(shown).toBe(sentence);
    });

    it('the constraint map is non-empty — otherwise the case above proves nothing', () => {
      expect(Object.values(CONSTRAINT_MESSAGES).length).toBeGreaterThan(10);
    });
  });

  describe('case 6 — an unclaimed driver error is masked even on /setup', () => {
    it('SETUP_POLICY masks a SQLSTATE error no constraint sentence mapped', () => {
      const shown = withNodeEnv('production', () => preSessionMessage(DRIVER_ERROR, SETUP_POLICY));
      expect(shown).toBe(SETUP_POLICY.opaque);
      expect(shown).not.toContain('person_credentials');
    });
  });

  describe('case 7 ⭐ — the two policies genuinely differ, and must keep differing', () => {
    it('the same person-facing plain Error: /sign-in masks it, /setup does not', () => {
      // ⛔ If this ever passes with both agreeing, one policy has silently become the other and
      // the reason for having two has been lost. /setup is the only pre-session screen whose
      // business logic refuses IN SENTENCES addressed to the visitor; /sign-in's does not.
      const err = new Error('an organization needs a code.');

      const onSignIn = withNodeEnv('production', () => preSessionMessage(err, SIGN_IN_POLICY));
      const onSetup = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));

      expect(onSignIn).toBe(SIGN_IN_POLICY.opaque);
      expect(onSetup).toBe('an organization needs a code.');
      expect(onSignIn).not.toBe(onSetup);
    });
  });

  describe('case 8 — every masked path is logged, and no failure is silent', () => {
    it('logs the real reason when it masks', () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      withNodeEnv('production', () => preSessionMessage(DRIVER_ERROR, SIGN_IN_POLICY));

      expect(spy).toHaveBeenCalledTimes(1);
      // ⭐ The reason must be IN the log, or masking has simply destroyed it.
      //
      // ⚠️ Asserted on the OBJECT, not on `JSON.stringify` of it. `Error.message` is not an
      // enumerable property, so a stringified payload shows `{"err":{}}` — this assertion used to
      // pass only because the payload was a flattened string, and it would have gone quietly
      // vacuous the moment the whole error was logged instead. pino's own `err` serializer is what
      // renders it at runtime.
      const [payload] = spy.mock.calls[0]!;
      expect((payload as { err: unknown }).err).toBe(DRIVER_ERROR);
      expect(((payload as { err: Error }).err).message).toContain('person_credentials');
    });

    it('logs outside production too — the screen showing it is not a reason for the log not to', () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      withNodeEnv('development', () => preSessionMessage(DRIVER_ERROR, SIGN_IN_POLICY));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT log a refusal written for a person — that is not a server failure', () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
      withNodeEnv('production', () =>
        preSessionMessage(new AuthenticationError('Sign-in failed: wrong store or PIN.'), SIGN_IN_POLICY),
      );
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('case 9 — a thrown non-Error does not crash the formatter', () => {
    const thrown: readonly unknown[] = ['a string', null, undefined, 42, { nope: true }];

    it('returns a non-empty string for anything that is not an Error', () => {
      for (const value of thrown) {
        const shown = withNodeEnv('production', () => preSessionMessage(value, SIGN_IN_POLICY));
        expect(typeof shown, `for ${String(value)}`).toBe('string');
        expect(shown.length, `for ${String(value)}`).toBeGreaterThan(0);
      }
    });
  });

  describe('case 10 ⛔ — the environment failure, which the blacklist would otherwise leak', () => {
    /**
     * ⭐ **This is the hole the orchestrator asked me to enumerate, and it is real.** `env()`
     * (`packages/core/src/env.ts:145-164`) throws a plain `Error` with **no SQLSTATE** whose text
     * names every unset variable. It is reachable from `createFirstRunAction` by three routes —
     * `transaction()` → `db/src/client.ts:30`, `setPin` → `pinLookupHash` →
     * `auth/src/credentials.ts:51`, and `signInWithFirebase` → `sessionTokenHash` → the same line.
     *
     * Under the blacklist as slice 2 shipped it, that banner would have gone into the address bar
     * of an unauthenticated page, in production, naming `SESSION_SECRET` and `DATABASE_URL`.
     */
    it('SETUP_POLICY masks it, and names no variable', () => {
      const shown = withNodeEnv('production', () => preSessionMessage(ENV_FAILURE, SETUP_POLICY));

      expect(shown).toBe(SETUP_POLICY.opaque);
      expect(shown).not.toContain('SESSION_SECRET');
      expect(shown).not.toContain('DATABASE_URL');
      expect(shown).not.toContain('REFUSED TO START');
    });

    it('SIGN_IN_POLICY masks it too — it was never an AuthenticationError', () => {
      const shown = withNodeEnv('production', () => preSessionMessage(ENV_FAILURE, SIGN_IN_POLICY));
      expect(shown).toBe(SIGN_IN_POLICY.opaque);
      expect(shown).not.toContain('SESSION_SECRET');
    });

    it('⭐ the discriminator is that it is a DUMP, not a sentence — any multi-line message is masked', () => {
      // ⚠️ Deliberately not a match on "REFUSED TO START". A sentence written for a visitor is one
      // line; a multi-line message on an unauthenticated screen is a dump, whoever wrote it. That
      // generalises to the next thrower, which is the point — the enumeration bounds what exists
      // today, this bounds what arrives tomorrow.
      const dump = new Error('Something failed.\n  at connectToHost db.internal:5432\n  at pool.connect');
      const shown = withNodeEnv('production', () => preSessionMessage(dump, SETUP_POLICY));
      expect(shown).toBe(SETUP_POLICY.opaque);
      expect(shown).not.toContain('db.internal');
    });

    it('but a single-sentence refusal is still not a dump — the control for the line above', () => {
      const shown = withNodeEnv('production', () =>
        preSessionMessage(new Error('the first admin needs a name.'), SETUP_POLICY),
      );
      expect(shown).toBe('the first admin needs a name.');
    });
  });

/**
 * ⛔ **Case 11 — the driver's CONNECTION errors, which carry a code that is not a SQLSTATE.**
 *
 * The Opus second read rejected the first cut of this file over exactly this, and it was right.
 * `node_modules/postgres/src/errors.js:16-27` builds every connection failure as
 * `Object.assign(new Error('write ' + code + ' ' + host + ':' + port), { code, errno, address, port })`
 * — **single line, no SQLSTATE, not a mapped sentence.** A five-character check let it straight
 * through, so `/setup` would have printed the database host and port into the URL of an
 * unauthenticated page in production.
 *
 * ⚠️ **And database-down is the most likely failure this screen will ever see**, because first run
 * happens on a box nobody has finished configuring. My own docstring called this residual "a
 * future single-line message that names a host". It was not future. It was the default.
 *
 * `Errors.generic` (`errors.js:36-40`) has the same shape with an arbitrary-length code.
 */
describe('case 11 ⛔ — a connection error names a host, and its code is not five characters', () => {
  /** The driver's exact construction — reproduced from errors.js:16-27, not approximated. */
  const connectionError = (code: string): Error =>
    Object.assign(new Error(`write ${code} db.internal:5432`), {
      code,
      errno: code,
      address: 'db.internal',
      port: 5432,
    });

  it('SETUP_POLICY masks ECONNREFUSED, and leaks neither the host nor the port', () => {
    const err = connectionError('ECONNREFUSED');
    const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));

    expect(shown).toBe(SETUP_POLICY.opaque);
    expect(shown).not.toContain('db.internal');
    expect(shown).not.toContain('5432');
    expect(shown).not.toContain('ECONNREFUSED');
  });

  it('and ENOTFOUND, ETIMEDOUT and ECONNRESET the same way — the length was never the point', () => {
    for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']) {
      const shown = withNodeEnv('production', () => preSessionMessage(connectionError(code), SETUP_POLICY));
      expect(shown, `for ${code}`).toBe(SETUP_POLICY.opaque);
      expect(shown, `for ${code}`).not.toContain('db.internal');
    }
  });

  it("Errors.generic's shape too — an arbitrary-length code, message prefixed with it", () => {
    // errors.js:36-40 — `new Error(code + ': ' + message)` with `{ code }`.
    const err = Object.assign(new Error('CONNECTION_CLOSED: write CONNECTION_CLOSED db.internal:5432'), {
      code: 'CONNECTION_CLOSED',
    });
    const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));
    expect(shown).toBe(SETUP_POLICY.opaque);
    expect(shown).not.toContain('db.internal');
  });

  it('⭐ but the domain still speaks — a plain Error with NO code at all is untouched', () => {
    // The non-zero control for the whole case. `typeof code === 'string'` is a discriminator only
    // because a domain Error has no `code`; if that stopped being true this would go red rather
    // than /setup silently going mute.
    const shown = withNodeEnv('production', () =>
      preSessionMessage(new Error('the PIN must be exactly 6 digits.'), SETUP_POLICY),
    );
    expect(shown).toBe('the PIN must be exactly 6 digits.');
  });
});

/**
 * ⚠️ **Restored after the second read.** Four assertions from `setup-failure-redirect.test.ts` were
 * dropped rather than moved when the predicate came here, and §3.2 of the spec said they would move
 * unchanged. Each is here for a reason that was learned the hard way once already.
 */
describe('case 12 — the four assertions that were dropped in the move', () => {
  it('an AuthorizationError is kept verbatim', () => {
    const err = new AuthorizationError('nope', 'manage_users');
    const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));
    expect(shown).toBe('nope');
  });

  it('⭐ an AuthenticationError that ALSO carries a code — the class wins', () => {
    // ⛔ This one exists because a MUTATION test proved the class guard untested: removing it left
    // every other assertion green, since a plain AuthenticationError has no `code` and the code
    // check alone already answered correctly. Dropping it silently un-tested the guard again.
    const err = Object.assign(
      new AuthenticationError('Sign-in failed: this account is not linked to a person in this system.'),
      { code: '08006' },
    );
    const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));
    expect(shown).toContain('not linked to a person');
  });

  it('⛔ ENOTFOUND is masked — the written record of the blocker, which is why losing it mattered', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND db.internal'), { code: 'ENOTFOUND' });
    const shown = withNodeEnv('production', () => preSessionMessage(err, SETUP_POLICY));
    expect(shown).toBe(SETUP_POLICY.opaque);
    expect(shown).not.toContain('db.internal');
  });

  it('a plain Error with no code is never masked, however alarming it reads', () => {
    // ⚠️ Deliberate: no `code` means it did not come from the driver, so it came from our own
    // code, where every thrown sentence on this path is written for a person.
    const message = 'relation "person_credentials" does not exist';
    const shown = withNodeEnv('production', () => preSessionMessage(new Error(message), SETUP_POLICY));
    expect(shown).toBe(message);
  });
});

describe('case 13 — the nits, each of which is a way to leak or to say nothing', () => {
  it('⛔ a thrown non-Error is masked, not passed through', () => {
    // The domain throws Errors. A bare string arriving here came from somewhere unaudited, so it
    // gets no benefit of the doubt on an unauthenticated screen.
    const shown = withNodeEnv('production', () => preSessionMessage('raw string from nowhere', SETUP_POLICY));
    expect(shown).toBe(SETUP_POLICY.opaque);
    expect(shown).not.toContain('raw string');
  });

  it('⛔ an empty message falls back to the opaque sentence rather than showing nothing', () => {
    // An AuthenticationError with an empty message used to return '' — an error banner with no
    // text in it, which reads as a rendering bug and tells the visitor nothing.
    const shown = withNodeEnv('production', () => preSessionMessage(new AuthenticationError(''), SIGN_IN_POLICY));
    expect(shown).toBe(SIGN_IN_POLICY.opaque);
  });

  it('and a blank-but-not-empty message counts as empty', () => {
    const shown = withNodeEnv('production', () => preSessionMessage(new AuthenticationError('   '), SIGN_IN_POLICY));
    expect(shown).toBe(SIGN_IN_POLICY.opaque);
  });

  it('an empty message is LOGGED — silence on both the screen and the log is the worst outcome', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    withNodeEnv('production', () => preSessionMessage(new AuthenticationError(''), SIGN_IN_POLICY));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('case 14 — the log carries the whole error, not a flattened string', () => {
  it('logs the Error object, so the stack and any cause survive', () => {
    // ⛔ The opaque sentence PROMISES the reason is in the server log. Logging only `err.message`
    // discards the stack and `cause`, which is most of what makes a connection failure diagnosable
    // — and the promise is then false. `api/health/route.ts:43` logs `{ err: error }`; so does this.
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const err = new Error('outer', { cause: new Error('the real reason') });

    withNodeEnv('production', () => preSessionMessage(Object.assign(err, { code: 'X' }), SETUP_POLICY));

    expect(spy).toHaveBeenCalledTimes(1);
    const [payload] = spy.mock.calls[0]!;
    expect((payload as { err: unknown }).err).toBe(err);
  });
});
});
