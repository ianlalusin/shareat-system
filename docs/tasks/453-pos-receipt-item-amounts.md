# T-453 — accurate POS receipt item amounts (DEF-716)
Status: implemented locally 21 October; focused tests/typecheck/web build/Capacitor export passed. Postcommit checks/full CI/runtime gates pending.
Goal: printed and preview item gross amounts include priced modifiers and exclude free/void units.
Reuse T-423 lineAmounts and allocateExact: round each bill stage once, allocate its centavos
back to the displayed lines in stable receipt order; do not independently round each line.
Display active quantity with an explicit free-quantity note. Preserve package-first order,
modifier descriptions, receipt identities, stored analytics, tax/statutory totals and payments.
Preview discount breakdown must reuse the same allocated line-discount stage, including
modern lineAdjustments, instead of recomputing the old VAT-exclusive discount base.
Scope: apps/pos/src/lib/printing/{receipt-line-amounts.ts,receipt-line-amounts.test.ts,receiptFormatter.ts};
apps/pos/src/components/receipt/receipt-view.tsx; this task; docs/DEFECTS-REGISTER.md;
docs/reviews/t453-receipt-item-amounts.md. Supporting caller baseline only if the unchanged
generator reports legitimate drift, with each name explained before regeneration.
No receipt write, analytics recalculation, Firestore rule, data-shape or packages/ change.
Checks: literal free/modifier/void cases; all-free zero; fractional quantities with a half-centavo
aggregate and deterministic allocation; both renderers; line adjustments; unchanged grand total;
positive ordinary line and historical missing-store fallback. Affected tests/typecheck/build,
postcommit guards/census, full PR CI. Printer/runtime remains a separate test-backend gate.
