/**
 * Registered-identity **identifier normalisation** — pure, leaf, and imported by both sides of what
 * used to be an import cycle.
 *
 * ## ⛔ Why this file exists at all
 *
 * `organizations/index.ts` imports `createStore` from `stores/service.ts`, and `stores/service.ts`
 * imported `normaliseBranchCode` back from `organizations/index.ts`. That cycle resolved **only**
 * because every symbol crossing it in both directions was a hoisted `function` declaration. A
 * single module-scope `const X = normaliseBranchCode(…)` added to either file later would have
 * become a TDZ error at import time — not a type error a build catches, but a crash on boot, and
 * because `packages/domain/src/index.ts` is one barrel, it would have taken the whole ERP app down
 * rather than one screen.
 *
 * ⭐ **The fix is the boring one:** the two pure functions were the only thing `stores` wanted from
 * `organizations`, so they move to a leaf module both sides import. Nothing imports back out of
 * here, so the cycle cannot re-form.
 *
 * ⚠️ `normaliseBranchCode` is still re-exported from `organizations/index.ts`, so no existing
 * caller changes and `@shareat/domain`'s barrel surface is identical.
 */

/**
 * ⭐ **Normalises a typed identifier to digits.** A person may type `123-456-789` or
 * `123 456 789`; the column stores one canonical shape so two spellings of one number cannot read
 * as two numbers.
 *
 * ⛔ **Format only — no checksum, and no rule tying a branch code to its TIN.** A format check
 * catches a typo; a checksum starts to look like validating a registration, which is the compliance
 * posture bible §13 row 75 refuses. If a legitimate PH form is ever refused here, WIDEN the pattern
 * with the source recorded — never drop the check. The DATABASE holds the same rule and is the
 * authority (RULES §6 item 3, bible §15.11).
 */
export function normaliseDigits(
  raw: string | null,
  field: string,
  min: number,
  max: number,
): string | null {
  if (raw === null) return null;
  const stripped = raw.replace(/[\s-]/g, '');
  if (stripped === '') return null;
  if (!new RegExp(`^[0-9]{${min},${max}}$`).test(stripped)) {
    throw new Error(
      `${field} must be ${min === max ? String(min) : `${min}-${max}`} digits — dashes and spaces ` +
        `are fine and are removed, but "${raw}" is not a number of that length.`,
    );
  }
  return stripped;
}

/** ⭐ Used by the store screen and by `setOrganizationIdentity`, which normalise the same way. */
export function normaliseBranchCode(raw: string | null): string | null {
  return normaliseDigits(raw, 'A branch code', 3, 5);
}
