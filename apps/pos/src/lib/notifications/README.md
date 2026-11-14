# src/lib/notifications contract

## Overview

Kitchen alert adapter for native notifications/haptics and browser audio/notifications.

## Interface

- [kitchenAlert.ts](./kitchenAlert.ts) — `primeKitchenAudio`, `requestKitchenAlertPermission`, `fireKitchenAlert`.

## Invariants

- primeKitchenAudio must run in a user gesture before browser audio alerts can play.

## Side Effects

- Requests notification permissions, creates a native notification channel and schedules alerts/haptics on Capacitor; browser fallback plays audio and may display a Notification.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (6546 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
