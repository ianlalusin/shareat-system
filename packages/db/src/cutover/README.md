# Cutover classification and purge

## Overview

Explicit table lifecycle classification and the plan/apply machinery used by the operational cutover command.

## Interface

- [classification.ts](./classification.ts): includes `CutoverClass`, `KeepEntry`, `PurgeEntry`, `KeepShellEntry`, `DateScopedEntry`, `CutoverEntry`, `CUTOVER_CLASSIFICATION`.
- [purge.ts](./purge.ts): includes `Sql`, `Tx`, `SEQUENCES_NEVER_RESET`, `ForeignKeyToPurge`, `ShellPlan`, `DateScopedPlan`, `PurgePlan`, `planPurge`.

## Invariants

- Every operational table needs an explicit classification; absence is a guard failure, never a default purge decision.
- Planning inspects table counts, dependencies and kept data. Applying a purge requires a real transaction and operator ceremony at the CLI.
- Preserve the sequences named by SEQUENCES_NEVER_RESET and the kept-table state recorded in the purge plan.

## Side Effects

- Planning reads database metadata and data. The apply path deletes classified operational data and handles shell/date-scoped rows in PostgreSQL.
- This is destructive operational machinery; importing its classification data does not itself run a purge.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
