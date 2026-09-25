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
 *
 * ⭐ T-343 S2 — the optional third argument is the human sentence `refusal-text.ts` builds
 * (`packages/auth/src/authorize.ts`'s seven throw sites all pass one). `message` is UNCHANGED — the
 * raw diagnostic ~40 app regexes still match — `userMessage` is an ADDED field, never a rewrite.
 * Set only when non-empty, so `isPresentable` (`apps/erp/src/lib/error-shape.ts`) never treats a
 * blank string as a sentence. Other construction sites (`roles.ts`, `credentials-admin.ts`,
 * `trade/index.ts`, and one test) keep passing only two arguments — the third stays optional so
 * those compile unchanged and are simply non-presentable until a later slice converts them.
 */
export class AuthorizationError extends Error {
  readonly capability: Capability;
  readonly userMessage?: string;

  constructor(message: string, capability: Capability, userMessage?: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.capability = capability;
    if (userMessage !== undefined && userMessage.trim() !== '') this.userMessage = userMessage;
  }
}
