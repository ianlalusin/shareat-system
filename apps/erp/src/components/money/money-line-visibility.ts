/**
 * DEF-484 / T-353 — WHEN a `MoneyLines` issue is shown, never WHAT is wrong. `validateMoneyLines`
 * (the domain, the server truth) judges every line it is given, untouched or not; a client that
 * hid an "untouched" line from the domain would have to tell the server what was touched, which is
 * exactly the trust RULES rule 7 forbids. This is presentation only — pure, no React, no
 * `'use client'`, so it is tested without a DOM (the repo has none: no jsdom/happy-dom/
 * testing-library, and the unit glob is `apps/**\/*.test.ts`, never `.tsx`).
 *
 * An issue shows once: the field it names has been touched (R2), OR the enclosing form saw a
 * submit attempt (R4), OR it came in as `initialLines` — that third case is the caller's job
 * (`MoneyLines.tsx` seeds `touched` as all-fields-set per initial line), not this function's.
 */
import type { MoneyLineIssue } from '@shareat/domain/money-lines'; // ⛔ subpath, never the barrel

export type LineField = 'method' | 'amount' | 'moneyAccountId' | 'cashRequestId' | 'staffId';

function isLineField(field: MoneyLineIssue['field']): field is LineField {
  return (
    field === 'method' || field === 'amount' || field === 'moneyAccountId' || field === 'cashRequestId' || field === 'staffId'
  );
}

/**
 * `touched` is index-aligned with the lines `issues` was computed from. A document-level issue
 * (`line: null` — `mustTotal`, "one credit line") shows once ANY line field anywhere is touched;
 * `referenceNo`/`document` are never themselves per-field touchable, so a per-line issue naming
 * either stays hidden until a submit attempt.
 */
export function visibleIssues(
  issues: readonly MoneyLineIssue[],
  touched: readonly ReadonlySet<LineField>[],
  attempted: boolean,
): MoneyLineIssue[] {
  if (attempted) return [...issues];
  return issues.filter((issue) => {
    if (issue.line === null) return touched.some((t) => t.size > 0);
    return isLineField(issue.field) && (touched[issue.line]?.has(issue.field) ?? false);
  });
}
