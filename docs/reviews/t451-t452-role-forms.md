FINDINGS: 2 corrected (1 MED, 1 LOW); two existing follow-ups reported.
- MED · packages/domain/src/people/index.ts:595 · Privileged roles inherited a job title/default assignment; a manager with Cashier now displays Manager and may clear legacy assignments without changing role authority (DEF-723).
- LOW · apps/erp/src/components/ui/FormGrid.tsx:97 · Numeric-width inference and help above inputs caused cramped, misaligned cards; government identifiers and settlement groups now use aligned paired tracks with sized controls (DEF-724).
CHECKED CLEAN
- Role-first cards/roster, active-org role reads, staff-only primary display, no arbitrary-secondary fallback; original lanyard ID cards retained after Ian correction, including identity, photo, live state and navigation.
- Real PostgreSQL: 82 distinct checks passed across five files; three-role clearing and stale-form refusals preserve role authority; revoked roles do not bypass staff requirements. Two historical grant-test fixtures now seed legacy assignments, with every authorization assertion retained.
- 506 distinct affected unit/guard checks passed across 20 files (353 main, 149 kit, four settlement-preview checks); focused preview/width repeats also passed.
- Typecheck and final production build passed with the same-checkout server stopped; preview moved to localhost shareat_dev so Lipa is visible; test runs isolated in shareat_test_codex_t451.
- Shared paired layout covers record cards plus width-based entry forms; inventory records 57 bordered-section groups, 55 inside native/checked forms. Settlement uses one form with a split entry/check workspace.
- No schema, role matrix, payroll math, posting or production-data changes. Staff-code integer overflow (DEF-725) and existing float preview formatting (DEF-726) are reported, not claimed fixed.
- CI found two control registrations missing; focused rerun 63 passed/one existing skip after registering the new command/count. ID-card preservation test failed first, then passed.
- Visual geometry remains unverified by automation: saved browser denial respected; manual review requested. Full exact-head PR CI and postcommit checks remain release gates.
Model: Codex (GPT-6).
## FOR IAN
Preview ready for staff cards, government fields and settlements; keep draft until visual approval and full CI pass. Planner bible amendment for the new role/position ruling remains owed.
