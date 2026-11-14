# src/lib/billing contract

## Overview

Additional-griller charge lookup, adjustment construction and bundle headcount rules.

## Interface

- [adjustments.ts](./adjustments.ts) — `resolveGrillerCharge`, `buildChargeAdjustment`, `appendSessionAdjustment`.
- [bundle.ts](./bundle.ts) — `bundleExtraPax`.
- [constants.ts](./constants.ts) — `GRILLER_CHARGE_ID`.

## Invariants

- The griller constant identifies a configured charge; its price is resolved from configuration.
- Bundle capacity is a billing threshold; invalid/nonpositive coverage yields zero extra pax.

## Side Effects

- Reads charge configuration and appends adjustments to a Firestore session.
- Bundle arithmetic and adjustment construction operate on supplied values.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 3 direct source files (3903 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
