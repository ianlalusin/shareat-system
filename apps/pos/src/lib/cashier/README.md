# src/lib/cashier contract

## Overview

Cashier behavior-tip text, milestone classification and next-tip selection.

## Interface

- [tips.ts](./tips.ts) — `BEHAVIOR_TIPS`, `Milestone`, `currentMilestone`, `PickTipResult`, `pickTip`.

## Invariants

- The highest reached milestone is selected from the configured threshold levels.
- Tip selection accepts explicit timing/progress inputs.

## Side Effects

- Returns tip/milestone values; no network or persistence calls in the inspected module.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (3200 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
