# src/components/guards contract

## Overview

Client RoleGuard and role-home routing.

## Interface

- [RoleGuard.tsx](./RoleGuard.tsx) — `RoleGuard`.

## Invariants

- The guard handles auth loading, pending/forced-reset state and allowed roles.
- Client presentation guards do not replace server authorization.

## Side Effects

- Reads auth context and redirects or hides/denies client content.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (4524 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
