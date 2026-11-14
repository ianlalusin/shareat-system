# src/app/pending contract

## Overview

Pending-account approval notice.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/pending`; `PendingPage`.

## Invariants

- The screen offers sign-out and support while approval is outstanding.

## Side Effects

- Sign-out ends the client authentication session; support action changes route.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (2047 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
