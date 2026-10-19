FINDINGS: 4 (2 MED, 2 LOW); corrected in working tree, release verification continues
- MED · apps/erp/tests/t440-s9-auth-first-guard.test.ts · G6 accepted any condition mentioning can(), including an OR path that never called it; four money-transfer/trade missing-record fallbacks showed field sentences without proving permission. Added red bypass/negation controls, tightened the proof, and removed those fallbacks.
- LOW · packages/domain/src/field-rules/check.ts · Money bounds converted the parsed amount through Number(), contrary to the core-money rule. Added a red source guard plus centavo boundary cases; comparisons now use core money.
- MED · apps/erp/src/app/menu/actions.ts and menu/prices/actions.ts · Whole-number/date parsing could refuse before the new can/assert checks, so an unauthorized fractional sort order or bundle size still leaked the field sentence. Two real PostgreSQL controls failed first; the existing domain capability is now proved before parsing across the matching menu paths.
- LOW · packages/domain/tests/integration/t440-s4-ap-ar-refusals.test.ts and S3/S5/S6 fixtures · Fake targets and generic text overwrote the actor's real store, while item tests used an admin for super-admin acts; after auth-first, 60 tests failed on missing rows, UUID parsing or permission. Replaced those fixtures with real scoped targets/actors and strengthened row snapshots without relaxing sentence assertions.
CHECKED CLEAN
- S9 B: missing controller fails closed; COD ignores leftover days; credit requires days; no conditional native required attribute; controller names participate in reads/events; only the helper's own disabled flag is released.
- New state tests failed first (3/3); old conditional tests failed before implementation. Money and G6 controls also failed before their corrections.
- Focused unit run: 1,445 passed across 12 files; typecheck passed; caller/boundary/numeric/throw guards: 165 passed across seven files. Area PostgreSQL tests: 137 passed; expanded auth-first controls: seven passed (the two parser controls were red first).
- G6 has no baseline file; positive/negative controls pass. Leave rule sets are explicit calls so the existing server call-chain guard can verify all fields.
- Supporting scope includes check-dom.ts, check-state.ts and FieldCheck.tsx; three older supplier test files plus the S4/core parity fixtures now pin the S9-approved required sentence, retaining persistence/refusal assertions.
- Pending: reconcile current main/UI, recheck the combined tree, full PR CI and running-app checks. No claim of whole-branch release readiness.
FOR IAN: the local S9 failures are resolved; this branch remains separate from the approved UI deployment.
Model: GPT-6 (Codex).
