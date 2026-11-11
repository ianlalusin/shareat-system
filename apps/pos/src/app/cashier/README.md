# src/app/cashier contract

## Overview

Cashier session list/detail route selected by the sessionId query.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/cashier`; `CashierPage`.
- [handover](./handover/README.md) — Cash handover route mounting CashHandoverClient.
- [receipts](./receipts/README.md) — Compatibility redirect from cashier receipts.
- [sessions](./sessions/README.md) — Compatibility redirect from cashier sessions.

## Invariants

- The role guard allows admin/manager/cashier; device-local inactivity signs the profile out.

## Side Effects

- Mounts session clients and chat; idle handling changes local profile state and shows a toast.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (2165 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
