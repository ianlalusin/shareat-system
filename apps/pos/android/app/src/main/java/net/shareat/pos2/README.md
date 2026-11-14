# android/app/src/main/java/net/shareat/pos2 contract

## Overview

Capacitor MainActivity and native ThermalPrinter plugin.

## Interface

- [MainActivity.java](./MainActivity.java) — `MainActivity`, `onCreate`.
- [ThermalPrinterPlugin.java](./ThermalPrinterPlugin.java) — `ThermalPrinterPlugin`, `load`, `listBluetoothPrinters`, `connectBluetoothPrinter`, `disconnectBluetoothPrinter`, `printReceipt`, `printPinSlip`.

## Invariants

- MainActivity registers ThermalPrinterPlugin before the bridge starts.
- Bluetooth availability and Android permissions are checked before printer access.

## Side Effects

- Requests Bluetooth permissions, manages native printer connections and emits thermal/ESC-POS output through the plugin.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
- Native compilation/device/printer behavior needs the Android toolchain and device checks described in the app runbook; the Node tests do not verify native hardware.

## Inspection scope

Inspected 2 direct source files (12759 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
