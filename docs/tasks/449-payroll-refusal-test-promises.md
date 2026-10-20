# T-449 — Consume refusal promises before starting the next payroll operation

Status: implementing 2026-10-20 during Ian's authorized all-branch audit and green-only release work.

CI 39281194661 reported 8,790 passing integration tests plus one unhandled rejection in T-190 case 20.
`[preview(...), post(...)]` starts both operations immediately, while `refusalText` only attaches to one at a time.
The second can reject before it has a rejection handler. This is a test harness defect, not permission to suppress
unhandled errors or change payroll. The same eager pattern appears in the minimum-wage case.

Scope: `packages/domain/tests/integration/t190-statutory.test.ts`, this task, `docs/DEFECTS-REGISTER.md`, and
`docs/reviews/t441-l1-release-audit.md` to document why the ready lightbox release includes this supporting repair.
Make the array entries lazy functions and invoke each inside `refusalText`. Keep all sentence, zero-row and
authorization assertions. Run the whole T-190 file against isolated real PostgreSQL; full PR CI still required.

FOR IAN: repairing the test's promise lifecycle; production payroll rules remain unchanged.
