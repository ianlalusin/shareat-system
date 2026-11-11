# src/app/cashier/sessions contract

## Overview

Compatibility redirect from cashier sessions.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/cashier/sessions`; `CashierSessionsRedirectPage`.

## Invariants

- The redirect replaces browser history.

## Side Effects

- Navigates to `/cashier` on mount.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (281 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
