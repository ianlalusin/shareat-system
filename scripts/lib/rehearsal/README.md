# scripts/lib/rehearsal

## Overview

Guarded cutover rehearsal against a database copy, with journals, verification and reports.

## Interface

- guards.ts exports checkTargetGuards, resolveTargetUrl, parseDbUrl, productionHosts, databaseRefusals and target constants.
- children.ts exports childEnv, runPurgeChildren, runMigrateChild, runPredumpChild, realSpawn and child/dependency shapes.
- checks.ts and verify.ts expose liveness, RLS, fiscal coverage, purge/rollback, freeze, sequence and opening tie-out checks.
- journal.ts exports journal path/read/write/marking helpers; report.ts exports reportFileName/buildReports; app-env.ts exports checkAppEnvText/isForbiddenAppEnvName.

## Invariants

- The target comes from REHEARSAL_DATABASE_URL, matches the scratch naming rule, and must not match a pinned production host or source database.
- Child environments explicitly use the guarded target and blank live integration credentials so dotenv cannot reintroduce them.
- Read-only checks do not advance sequences; a missing end timestamp is NOT TIMED rather than zero.
- Private journals/full reports live outside the repository; sanitized reports use an allow-list rather than free-text details.

## Side Effects

- Guards/report construction are pure; check functions read the copy via SQL.
- Child helpers start the actual purge/migrate/backup commands against the guarded target; journal helpers write restricted local files.
- No rehearsal command or destructive child was executed during bootstrap.

## Verification

- From the repository root: `npm run test` (unit) and affected `npm run test:integration` cases against real PostgreSQL. CLI operations are not a documentation verification step.

### Source coverage

The bootstrap inspected 7 implementation files (38415 bytes), at most 300 lines per file and 50,000 bytes per directory. This contract is a bounded index, not a full correctness audit.
