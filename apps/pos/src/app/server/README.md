# src/app/server contract

## Overview

Client-loaded server floor workflow.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/server`; `ServerPage`.

## Invariants

- ServerPageClient is loaded dynamically behind Suspense.

## Side Effects

- Mounts the client with table/profile subscriptions and refill/verification actions.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (625 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
