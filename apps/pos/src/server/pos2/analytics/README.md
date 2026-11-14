# src/server/pos2/analytics contract

## Overview

Server analytics contribution/delta core shared by the protected apply-delta handler.

## Interface

- [apply-delta-core.ts](./apply-delta-core.ts) — `applyAnalyticsDeltaServer`.
- [delta-core.ts](./delta-core.ts) — `ContributionSet`, `getContributions`, `pickDayContribution`, `dayStartMsOf`, `safeKey`, `getApplicablePresets`, `buildDeltaIncrements`, `affectedDayIds`.

## Invariants

- Contribution math consumes receipt state, including reversal/void state.
- The writer accepts an Admin-SDK-shaped transaction/batch and uses merge/increment operations.

## Side Effects

- Produces analytics writes through the supplied writer; contribution calculation itself does not fetch records.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (20380 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
