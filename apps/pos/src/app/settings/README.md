# src/app/settings contract

## Overview

Printer/device settings with Bluetooth/USB and terminal/outbox controls.

## Interface

- [page.tsx](./page.tsx) — Next.js page for `/settings`; `SettingsPage`.

## Invariants

- The role guard allows admin/manager/cashier.
- Bluetooth device refresh is skipped outside native Capacitor.

## Side Effects

- Reads/saves printer preferences, queries paired devices, connects printers and emits test prints; child controls own terminal/outbox effects.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (13104 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
