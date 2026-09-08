/**
 * The two error classes, in a leaf that imports nothing but a type.
 *
 * ## ⭐ Why they live here rather than beside the code that throws them
 *
 * `AuthenticationError` was declared in `sessions.ts` and `AuthorizationError` in `authorize.ts`,
 * and both of those modules import `@shareat/db` — so a caller that only wanted to say
 * `err instanceof AuthenticationError` had to pull the database client, the schema barrel and
 * everything under them. For a **unit** test that is not a style problem: `apps/erp`'s own
 * measurement put that import chain at ~4.6 s cold, which alone exceeds the unit project's 5 s
 * default timeout, so a test whose subject was one `instanceof` failed for a reason that had
 * nothing to do with the code under test.
 *
 * ⛔ **The only import allowed in this file is `type Capability`**, and `capabilities.ts` imports
 * nothing at all — that is what keeps this a leaf. Adding a value import here would silently undo
 * the whole point, because the cost is paid by everyone who reaches for an error class.
 *
 * ⚠️ **The classes are unchanged and their old homes still re-export them**, so every existing
 * `import { AuthenticationError } from '@shareat/auth'` — and every internal `from './sessions'` —
 * keeps working exactly as before. An app that wants the cheap path imports `@shareat/auth/errors`.
 */
import type { Capability } from './capabilities';

/** Sign-in failed: the credential is wrong, unknown, revoked, or the session is gone. */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/**
 * The actor is known, and is not allowed to do this.
 *
 * ⚠️ It carries the `capability` it was refused, so a caller can say *which* permission is missing
 * without parsing the sentence.
 */
export class AuthorizationError extends Error {
  readonly capability: Capability;

  constructor(message: string, capability: Capability) {
    super(message);
    this.name = 'AuthorizationError';
    this.capability = capability;
  }
}
