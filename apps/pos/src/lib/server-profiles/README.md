# src/lib/server-profiles contract

## Overview

Local actor identity bridge, profile HTTP operations and account-level gate bypass predicate.

## Interface

- [activeLocalProfile.ts](./activeLocalProfile.ts) — `ActiveLocalProfile`, `setActiveLocalProfile`, `getActiveLocalProfile`.
- [api.ts](./api.ts) — `postServerProfileOp`.
- [localGate.ts](./localGate.ts) — `bypassesLocalUserGate`.

## Invariants

- Managers/admins use account attribution; other floor roles use the local-profile gate.
- Profile operations require a current authenticated account.
- The active profile cache is module state for non-React loggers.

## Side Effects

- POSTs to `/api/server-profiles` with a bearer token and updates in-memory active-profile state.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 3 direct source files (2155 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
