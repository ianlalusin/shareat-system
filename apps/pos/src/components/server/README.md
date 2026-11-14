# src/components/server contract

## Overview

Server tables, guest verification, refill ordering and device-local profile controls.

## Interface

- [ActiveSessionsGrid.tsx](./ActiveSessionsGrid.tsx) — `ActiveSessionsGrid`.
- [CreateServerProfileModal.tsx](./CreateServerProfileModal.tsx) — `CreateServerProfileModal`.
- [GuestCountModal.tsx](./GuestCountModal.tsx) — `GuestCountModal`.
- [PasscodePad.tsx](./PasscodePad.tsx) — `PasscodePad`.
- [PendingVerificationCard.tsx](./PendingVerificationCard.tsx) — `PendingVerificationCard`.
- [RefillPOSModal.tsx](./RefillPOSModal.tsx) — module implementation; exports may occur beyond the bounded source excerpt.
- [ServerPageClient.tsx](./ServerPageClient.tsx) — `ServerPageClient`.
- [ServerProfileSwitcher.tsx](./ServerProfileSwitcher.tsx) — `ServerProfileSwitcher`.

## Invariants

- Profile passcode hashes stay server-side.
- The main client signs the local profile out after thirty minutes idle.
- Refill visibility reads global disabled records as well as enabled store records.

## Side Effects

- Subscribes to sessions/refills/profiles and invokes Firestore or profile-API actions; timers and dialogs manage interaction state.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 8 direct source files (48384 UTF-8 bytes), at most 300 lines per file. The 50,000-byte directory budget left these files outside the scan: `ServerSignInGate.tsx`, `SessionCard.tsx`, `VerifyAverageCard.tsx`, `request-change-dialog.tsx`. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
