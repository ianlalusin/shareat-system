# T-341 red tests — parked, not run (2026-09-25)

Written by the T-341 tester and seen RED for the spec's stated reasons, but parked here so `main` stays green
(a push to `main` runs CI and a green CI deploys). T-341's source and migration 0159 are NOT built.

Restore before building T-341:
    mv docs/tasks/341-wip/t341-position-grants-per-store.test.ts.txt packages/domain/tests/integration/t341-position-grants-per-store.test.ts
    mv docs/tasks/341-wip/t341-person-grants-store-migration.test.ts.txt packages/db/tests/integration/t341-person-grants-store-migration.test.ts
    git apply docs/tasks/341-wip/position-defaults.cases-3-12.patch

Recorded red (DB shareat_test_t341_tester, 2026-09-25):
- P1 `promise resolved "undefined" instead of rejecting`
- P2 `AuthorizationError: role 'staff' may not 'record_sale'` on the B assertion — ending A wipes the person's ONLY row, so B breaks too (§2.2 is worse than the spec said)
- P3 `expected [Array(1)] to deeply equal [...(2)]`
- P4 same shape as P2, on B
- P5–P8 guards green
- position-defaults cases 3/12 `expected 1 to be 2`
- M1–M4 `expected 1 migration tagged t341, found 0` (fixtures written, typecheck-clean, otherwise UNVERIFIED until 0159 exists)
Typecheck clean with these files in place.
