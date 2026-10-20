FINDINGS: 7 in latest audit (5 MED, 2 LOW), corrected locally; release held for full CI and runtime check
- MED · packages/domain/src/recurring-expenses/index.ts:242 · Omitted update fields were judged blank; name-only edits failed. Supplied-field checks now preserve patch semantics, with five explicit-blank/unchanged-row controls and a valid one-field edit.
- MED · packages/domain/src/field-rules/cutover.ts:35 · Generic number rules refused valid .5 / 1. costs. The existing unchanged four-decimal pattern is shared, with decimal keyboard hints retained (DEF-697).
- MED · docs/tasks/440-live-field-checks.md:63 · Conflicting money privacy contracts made old and new sentence tests disagree. Ian ruled to quote invalid money amounts only; progress, raw field diagnostics and non-money requirements retain privacy (DEF-698).
- MED · packages/domain/src/sales-days/create.ts:91 · Strict dates hid the established duplicate refusal for 2026-1-10. Calendar-check-only padding retains it; blank/absent input has a required sentence and zero rows (DEF-701).
- MED · packages/domain/src/field-rules/check.ts:216 · A UUID or newline pasted into money gave a different live hint from the sanitized server refusal. Shared import-free core wording restores parity and identifier hiding; expanded matrix failed first (DEF-702).
- LOW · packages/domain/src/field-rules/check.ts:158 · Generic bounds replaced established explanations. rangeSays preserves range-only wording without changing blank/syntax failures or thresholds (DEF-699).
- LOW · apps/erp/src/app/items/page.tsx:164 · Native item-code patterns disappeared from override fields. Original patterns restored; existing render control passes (DEF-700).
CHECKED CLEAN
- Earlier corrections remain under DEF-682–685, DEF-688 and DEF-692: auth-first proof, exact money bounds, menu parser preflight, scoped fixtures, raw-error limits and decimal keyboard hint.
- Previously failing 33 PostgreSQL files: 615 passed; final sales-day/auth rerun: 46 passed. Final rule/refusal/responsive checks: 1,326 passed; guards/censuses: 217 passed. Final root/ERP typechecks and production build passed; 62 number-box checks passed with a local 30-second cold-import budget (CI settings unchanged).
- Sentence oracles reviewed individually; row snapshots, valid controls, business codes, denial events and prerequisite counters retained. No guard ceilings or CI timeouts raised.
- Synthetic preview is running on 9008 for Ian's conditional-field check; saved browser policy denies automation, so no runtime claim yet. Last full CI 39354321744 was red (77 failed / 8,856 passed); next exact-head CI is required.
FOR IAN: dashboard fd8af80 is live and healthy. Validation repairs remain separate until all release gates pass.
Model: GPT-6 (Codex).
