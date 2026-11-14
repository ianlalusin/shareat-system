# src/lib/printing contract

## Overview

Receipt/PIN/kitchen/X-slip formatting and browser, Bluetooth and WebUSB print transports.

## Interface

- [kitchenBackupDeps.ts](./kitchenBackupDeps.ts) — `makeKitchenBackupDeps`.
- [kitchenBackupPrint.ts](./kitchenBackupPrint.ts) — `KitchenTicketDoc`, `BackupPrintDeps`, `printKitchenTicketBackup`.
- [kitchenPrinter.ts](./kitchenPrinter.ts) — `getKitchenPrinterAddress`, `setKitchenPrinterAddress`, `printKitchenText`.
- [kitchenTicketFormatter.ts](./kitchenTicketFormatter.ts) — `KitchenTicketPrintData`, `formatKitchenTicket`.
- [pinQr.ts](./pinQr.ts) — `PinQrMode`, `PIN_QR_MODES`, `DEFAULT_PIN_QR_MODE`, `PIN_QR_MODULE_DOTS`, `PIN_QR_NATIVE_DOTS`, `parsePinQrMode`, `getPinQrMode`, `setPinQrMode`, `renderPinQr`.
- [printHub.ts](./printHub.ts) — `PrintTarget`, `PrintTransport`, `PrintJob`, `isNativeBluetoothAvailable`, `getLastPrinterAddress`, `setLastPrinterAddress`, `cacheLogoForStore`, `printViaNativeBluetooth`, `printViaWebUSB`.
- [receipt-line-amounts.ts](./receipt-line-amounts.ts) — `receiptLineAmounts`.
- [receiptFormatter.ts](./receiptFormatter.ts) — `formatReceiptText`, `PinTextParts`, `formatSharelebratorPasswordText`, `formatPinText`.
- [thermalPrinter.ts](./thermalPrinter.ts) — `BluetoothDevice`, `ThermalPrinterPlugin`, `PrintDarkness`, `PRINT_DARKNESS_OPTIONS`.
- [webusbPrinter.ts](./webusbPrinter.ts) — `WebUsbPrinterState`, `escposCutFull`, `webusbRequestPrinter`, `webusbPrint`.
- [xSlipFormatter.ts](./xSlipFormatter.ts) — `XSLIP_HEADER`, `XSlipSummary`, `summarizeXSlip`, `formatXSlip`.

## Invariants

- X-slips explicitly identify themselves as cash control rather than BIR documents.
- Offline kitchen backup skips online operation and stamps successful output outside the print retry block.
- Native QR modes mirror the Android plugin; receipt line amounts reuse bill math.

## Side Effects

- Reads/writes printer/logo preferences, requests USB devices and sends ESC/POS data.
- Bluetooth goes through the Capacitor thermal-printer plugin; logo retrieval can issue HTTP requests.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 11 direct source files (38337 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
