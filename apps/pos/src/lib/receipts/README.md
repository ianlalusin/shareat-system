# src/lib/receipts contract

## Overview

Validated receipt-print settings, live/cache-first settings reads and post-payment destination choice.

## Interface

- [offline-payment-destination.ts](./offline-payment-destination.ts) — `offlinePaymentDestination`.
- [receipt-settings.ts](./receipt-settings.ts) — `receiptSettingsSchema`, `ReceiptSettingsFormValues`, `DEFAULT_RECEIPT_SETTINGS`, `mergeReceiptSettings`, `subscribeReceiptSettings`, `getReceiptSettings`, `getReceiptSettingsCacheFirst`.

## Invariants

- Stored settings merge with defaults.
- A print-preference failure cannot change the outcome of an already durable sale.
- Cache-first reads are used on print hot paths without inventing stored preferences.

## Side Effects

- Reads/subscribes to the store receipt-settings document; destination selection invokes supplied callbacks.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (4569 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
