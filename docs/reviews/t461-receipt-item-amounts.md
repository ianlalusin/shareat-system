FINDINGS: 3 corrected locally (2 MED, 1 LOW); release gates remain open.
- MED · apps/pos/src/lib/printing/receiptFormatter.ts:65 · Free units were charged in printed item amounts and modifier prices omitted; three ordered/one void/one free at 100 + 12.50 now displays 112.50, not 200.00 (DEF-716).
- MED · apps/pos/src/components/receipt/receipt-view.tsx:150 · Preview still charged free units and ignored modern line discounts; shared billing stages now show the paid modified amount and 20% of gross 112 as 22.40.
- LOW · apps/pos/src/lib/printing/receipt-line-amounts.ts:12 · Independent fractional-line rounding overstated displayed gross; three half-units at 0.01 now share the rounded 0.02 stage as 0.01/0.01/0.00.
CHECKED CLEAN
- Tests first: five target failures/one positive control before correction; signed historical-modifier regression also failed before its correction. No fixture math copies the production calculation.
- Focused receipt checks: 23 passed across two files. Earlier POS suite: 900 passed/one existing skip across 85 files, before four additional edge checks were added; final postcommit repeat remains required.
- POS typecheck, web production build and Capacitor export passed; all 34 moved source files restored identically, no stash remains. Final root guards/census are tracked in the PR evidence.
- Saved analytics/grand totals, receipt documents, payment writers, Firestore rules and package primitives are unchanged. Package-first order is stable; source lines are not mutated.
- Runtime/printer/device/visual checks remain unverified; no live Firebase read/write, test-store-on-live check, or browser-policy bypass was used. Separate test backend still required.
Model: GPT-6 (Codex).
## FOR IAN
Receipt presentation is corrected locally; POS remains draft pending exact-head CI and its runtime gates. Distinct-request handover overlap (DEF-712) remains a separate follow-up.
