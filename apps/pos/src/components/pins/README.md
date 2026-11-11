# src/components/pins contract

## Overview

Customer administration and legacy-loyalty-points panel.

## Interface

- [customers-admin.tsx](./customers-admin.tsx) — `CustomersAdmin`.
- [legacy-points-panel.tsx](./legacy-points-panel.tsx) — `LegacyRow`, `LegacyPointsPanel`.

## Invariants

- Customer operations are scoped by the selected store.
- Legacy claim/unclaim actions use explicit API operations.

## Side Effects

- Fetches customer/legacy data, polls scoped customers and submits loyalty changes through HTTP.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (24387 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
