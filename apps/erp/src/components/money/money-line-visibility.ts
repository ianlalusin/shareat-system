/**
 * DEF-484 / T-353 — WHEN a `MoneyLines` issue is shown, never WHAT is wrong. `validateMoneyLines`
 * (the domain, the server truth) judges every line it is given, untouched or not; a client that
 * hid an "untouched" line from the domain would have to tell the server what was touched, which is
 * exactly the trust RULES rule 7 forbids. This is presentation only — pure, no React, no
 * `'use client'`, so it is tested without a DOM (the repo has none: no jsdom/happy-dom/
 * testing-library, and the unit glob is `apps/**\/*.test.ts`, never `.tsx`).
 *
 * An issue shows once: the field it names has been touched (R2), OR the enclosing form saw a
 * submit attempt that reveals its line (R4/S2 K2), OR it came in as `initialLines` — that third
 * case is the caller's job (`MoneyLines.tsx` seeds `touched` as all-fields-set per initial line),
 * not this function's.
 *
 * T-353 S2 (K2/K3, review of `f69a9ff`) — two rulings that narrow S1's "any touch, or attempted":
 *   - K2: `attempted` widened from a boolean to `attemptedLineCount: number | null`. `null` means no
 *     submit attempt yet; a number is the count of lines that existed AT the attempt.
 *   - K3: a document-level issue no longer unlocks on "any field on any line" — a bare tab-through
 *     the method select (which has a default value and marks touched on blur) must not reveal a
 *     `mustTotal` sentence nobody asked for. It shows only once an AMOUNT field has been touched, or
 *     once a submit was attempted (`attemptedLineCount !== null`).
 *
 * T-353 S3 (H1, review of `aa14108`) — `attemptedLineCount` is RETIRED as the per-line gate. K2's own
 * `issue.line < attemptedLineCount` could not survive a remove: the count is fixed at the attempt,
 * but a later remove re-indexes the remaining rows, so a row APPENDED after the attempt and never
 * touched could land at an index the stale count still covers, showing both DEF-484 sentences on a
 * row nobody touched — a pure function fed only (issues, touched, attemptedLineCount) has no way to
 * tell "this row existed at the attempt" from "this row was re-indexed into that slot afterwards".
 * The fix moves per-line reveal onto `touched` alone: `MoneyLines.tsx`'s `onAttempt` now marks every
 * THEN-EXISTING line's fields touched directly, and `touched`'s OWN remove handling (already
 * index-filtered) carries that identity through a later remove correctly, which a bare count cannot.
 * `attemptedLineCount` survives only for the DOCUMENT-level gate (K3), which needs no per-row
 * identity — "was there ever an attempt" is enough.
 */
import type { MoneyLineIssue } from '@shareat/domain/money-lines'; // ⛔ subpath, never the barrel

export type LineField = 'method' | 'amount' | 'moneyAccountId' | 'cashRequestId' | 'staffId';

function isLineField(field: MoneyLineIssue['field']): field is LineField {
  return (
    field === 'method' || field === 'amount' || field === 'moneyAccountId' || field === 'cashRequestId' || field === 'staffId'
  );
}

/** `touched` is index-aligned with the lines `issues` was computed from. */
export function visibleIssues(
  issues: readonly MoneyLineIssue[],
  touched: readonly ReadonlySet<LineField>[],
  attemptedLineCount: number | null,
): MoneyLineIssue[] {
  return issues.filter((issue) => {
    if (issue.line === null) {
      return attemptedLineCount !== null || touched.some((t) => t.has('amount'));
    }
    return isLineField(issue.field) && (touched[issue.line]?.has(issue.field) ?? false);
  });
}
