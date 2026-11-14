# src/app/support contract

## Overview

Support notice and return-to-login link.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/support`; `SupportPage`.

## Invariants

- The page renders static guidance without loading staff data.

## Side Effects

- Navigation to `/login`; no data writes in this page.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (1275 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
