# src/hooks contract

## Overview

React adapters for connectivity, deferred payments, printing, receipt settings, device status and floor data.

## Interface

- [use-data-analysis.ts](./use-data-analysis.ts) — `DataAnalysisRange`, `DayRow`, `MonthRow`, `DataAnalysisResult`.
- [use-debounce.ts](./use-debounce.ts) — `useDebounce`.
- [use-mobile.tsx](./use-mobile.tsx) — `useIsMobile`.
- [use-online-status.ts](./use-online-status.ts) — `useOnlineStatus`.
- [use-payment-queue-sync.ts](./use-payment-queue-sync.ts) — `usePaymentQueueSync`.
- [use-print.ts](./use-print.ts) — `usePrint`, `UsePinPrintOptions`, `UsePinPrintReturn`, `usePinPrint`.
- [use-receipt-settings.ts](./use-receipt-settings.ts) — `useReceiptSettings`.
- [use-server-clock.ts](./use-server-clock.ts) — `useServerClockOffset`.
- [use-toast.ts](./use-toast.ts) — `reducer`, `useToast`, `toast`.
- [useConnectivity.ts](./useConnectivity.ts) — `HEALTH_PATH`, `PROBE_TIMEOUT_MS`, `ONLINE_INTERVAL_MS`, `OFFLINE_INTERVAL_MS`, `FAILURES_TO_OFFLINE`, `probeHealth`, `ConnectivityState`, `ConnectivityStore`, `createConnectivityStore`, `getConnectivityStore`, `useConnectivity`.
- [useIdleTimer.ts](./useIdleTimer.ts) — `useIdleTimer`.
- [useOutboxStatus.ts](./useOutboxStatus.ts) — `useOutboxStatus`.
- [useSavedQrCodes.ts](./useSavedQrCodes.ts) — `SavedQrCodesState`, `useSavedQrCodes`.
- [useStoreConfigDoc.ts](./useStoreConfigDoc.ts) — `StoreConfig`, `useStoreConfigDoc`.

## Invariants

- Reachability is determined by the POS health probe, not solely `navigator.onLine`.
- Deferred effects run only after the matching receipt ledger row is acknowledged.
- Print transport selection and audit writes are centralized in `use-print`.

## Side Effects

- Runs HTTP health/time probes, timers and browser event listeners.
- Subscribes to Firestore and outbox state, drains IndexedDB effects, and invokes printing/audit updates.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 14 direct source files (49642 UTF-8 bytes), at most 300 lines per file. The 50,000-byte directory budget left these files outside the scan: `useServerProfile.ts`, `useWeatherLogger.tsx`. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
