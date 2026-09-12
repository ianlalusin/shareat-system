/**
 * T-280 / DEF-311 — compares a DEPLOYED configuration value against what this repo documents it
 * OUGHT to be, and fails loudly on disagreement.
 *
 * ## Why this exists
 *
 * Production ran `FIREBASE_STORAGE_BUCKET=shareat-hub-v2.firebasestorage.app` — v1's bucket, not
 * v2's — for the deployment's entire life. The correct value was written down in TWO places
 * (`.env.example:55-60`, `docs/reference/private-bucket-storage-rules.md:62-63`), one of them
 * warning by name against the exact value that was deployed. `npm run storage-smoke`'s five
 * checks all went green anyway, because every one of them asks "is this bucket reachable and
 * private?" and v1's bucket is reachable and private too. Nothing compared the deployed value
 * against the documented one. This is that comparison.
 *
 * ## What this deliberately is not
 *
 * Both functions here are pure and take the ALREADY-RESOLVED value the caller is about to use
 * (e.g. `cfg.bucket`), never `process.env` itself — so the thing being checked and the thing a
 * driver actually uses cannot diverge by construction, and both are unit-testable with no
 * Firebase credentials and no network.
 *
 * `allowedValues`/citations are a hand-maintained copy of what the cited docs say TODAY. If a
 * future change edits the docs but not this file, this check enforces the STALE value — a
 * smaller, more visible version of DEF-311's own shape (a wrong constant here fails loudly and
 * immediately; a wrong deployed value that nothing checks fails silently, for the life of a
 * deployment). Not eliminated; substantially reduced.
 */

export interface ConfigExpectation {
  /** The env var name, for the message only — callers pass the resolved value separately. */
  envVar: string;
  /** The exact value(s) documentation says a real deployment must hold. */
  allowedValues: readonly string[];
  /** file:line citations naming where this expectation is written down. */
  citations: readonly string[];
  /** One sentence: what goes wrong if the deployed value silently disagrees. */
  consequence: string;
}

export interface ConfigContractResult {
  envVar: string;
  ok: boolean;
  actual: string;
  message: string;
}

/**
 * Pure. `actual` must be the value the caller is about to USE (e.g. `cfg.bucket`), not a fresh
 * read of `process.env` — that is what keeps this from ever checking a different value than the
 * one that actually gets used.
 */
export function checkValueAgainstDocs(
  actual: string,
  expectation: ConfigExpectation,
): ConfigContractResult {
  const ok = expectation.allowedValues.includes(actual);
  const message = ok
    ? `${expectation.envVar}="${actual}" matches ${expectation.citations.join(' and ')}.`
    : `${expectation.envVar} is "${actual}" but ${expectation.citations.join(' and ')} say it ` +
      `must be ${expectation.allowedValues.map((v) => `"${v}"`).join(' or ')}. ` +
      expectation.consequence;
  return { envVar: expectation.envVar, ok, actual, message };
}

/**
 * .env.example:56,71-73 — `FIREBASE_STORAGE_BUCKET` and `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
 * "must never hold the same value": one is the private accounting bucket, the other names the
 * project's world-readable default. `mustDiffer` may be undefined/blank — that side is optional
 * and a blank value can never collide with anything.
 */
export function checkValuesDiffer(
  primary: { envVar: string; value: string },
  mustDiffer: { envVar: string; value: string | undefined },
  citation: string,
): ConfigContractResult {
  const collides = mustDiffer.value !== undefined && mustDiffer.value === primary.value;
  const message = collides
    ? `${primary.envVar} and ${mustDiffer.envVar} are both "${primary.value}". ${citation} says ` +
      'they must never match — one is the private accounting bucket, the other names the ' +
      "project's world-readable default."
    : `${primary.envVar} and ${mustDiffer.envVar} do not collide.`;
  return { envVar: primary.envVar, ok: !collides, actual: primary.value, message };
}

/**
 * T-292 / DEF-315 — the inverse of `checkValuesDiffer`: two variables that MUST hold the same
 * value. `mustMatch`'s value may be undefined/blank — absence is treated as "nothing to compare,"
 * not a contradiction, mirroring `checkValuesDiffer`'s own convention for its optional side. That
 * is what makes this safe to call unconditionally: it is a no-op whenever one side is not visible,
 * which — measured for both of this task's uses, not assumed — is the common case today for
 * `FIREBASE_PROJECT_ID`/`NEXT_PUBLIC_FIREBASE_PROJECT_ID` (never both set in production; see
 * `docs/tasks/292-def-315-timezone-and-project-id-contracts.md` Finding 2) and never happens at
 * all for `APP_TIMEZONE`/`BUSINESS_TIMEZONE`, where the second side is always a defined constant.
 *
 * ⚠️ **This exact comparison also exists, DUPLICATED, inline inside
 * `packages/core/src/env.ts`'s `loadServerEnv()`** — deliberately, not by accident. `env.ts` is a
 * package; this file lives under `scripts/`; the monorepo's own dependency direction (RULES §1
 * rule 13 / `tests/unit/app-boundaries.test.ts`'s sibling rule one level up) means a package must
 * never import from `scripts/`. So `env.ts` cannot call this function — it re-implements the same
 * three-line comparison locally instead. If this function's behaviour ever changes, check
 * `packages/core/src/env.ts`'s copy too; nothing enforces that the two stay in sync beyond this
 * comment and `tests/unit/env.test.ts`'s own executed proof of `env.ts`'s copy.
 */
export function checkValuesMatch(
  primary: { envVar: string; value: string },
  mustMatch: { envVar: string; value: string | undefined },
  citation: string,
  consequence: string,
): ConfigContractResult {
  const matches = mustMatch.value === undefined || mustMatch.value === primary.value;
  const message = matches
    ? mustMatch.value === undefined
      ? `${primary.envVar} has no ${mustMatch.envVar} to compare against right now — nothing to check.`
      : `${primary.envVar} and ${mustMatch.envVar} match ("${primary.value}").`
    : `${primary.envVar} is "${primary.value}" but ${mustMatch.envVar} is "${mustMatch.value}". ` +
      `${citation} says they must match. ${consequence}`;
  return { envVar: primary.envVar, ok: matches, actual: primary.value, message };
}

/** DEF-311. The one populated expectation this task wires up. */
export const STORAGE_BUCKET_EXPECTATION: ConfigExpectation = {
  envVar: 'FIREBASE_STORAGE_BUCKET',
  allowedValues: ['shareat-hub-v2'],
  citations: ['.env.example:55-60', 'docs/reference/private-bucket-storage-rules.md:62-63'],
  consequence:
    'DEF-311: every receipt, payment proof and export would be written to a bucket this ' +
    'project does not control — reachable and private, so every existing check would still pass.',
};
