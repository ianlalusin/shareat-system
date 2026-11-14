# src/lib/terminal contract

## Overview

Terminal claim/release ports, monotonic receipt numbering and the shared tablet IndexedDB opener.

## Interface

- [claim.ts](./claim.ts) — `FirestorePort`, `RELEASE_GAP`, `RF_CODE_MESSAGE`, `claimTerminal`, `releaseTerminal`, `checkTerminalHolder`.
- [counter.ts](./counter.ts) — `MAX_TERMINAL_SEQ`, `TerminalRecord`, `ReservedNumber`, `TERMINAL_NOT_CLAIMED_MESSAGE`, `TerminalNotClaimedError`, `normalizeStoreCode`, `formatTerminalReceiptNumber`, `saveTerminalClaim`, `readTerminal`, `TERMINAL_ROW_KEY`, `planReservation`, `reserveNext`.
- [db.ts](./db.ts) — `DB_NAME`, `DB_VERSION`, `STORE_TERMINAL`, `STORE_EVENTS`, `STORE_EFFECTS`, `STORE_META`, `openTerminalDb`, `inTerminalTransaction`.
- [port.ts](./port.ts) — `getFirestorePort`.

## Invariants

- Terminal numbers are whole numbers from 1 to 99 and store codes must be receipt-safe.
- Reservation resolves only after the IndexedDB transaction completes.
- The shared opener owns terminal/events/effects/meta store upgrades; receipt counters never use localStorage.

## Side Effects

- Claims/releases terminal rows through injected Firestore transactions and persists local counter state in IndexedDB.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 4 direct source files (18120 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
