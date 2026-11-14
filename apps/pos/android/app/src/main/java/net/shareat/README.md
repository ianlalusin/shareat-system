# android/app/src/main/java/net/shareat contract

## Overview

Android host hierarchy leading to the Capacitor activity and native ThermalPrinter implementation.

## Interface

- [pos2](./pos2/README.md) — Capacitor MainActivity and native ThermalPrinter plugin.

## Invariants

The following child-contract rules apply within their owning child boundaries.

- MainActivity registers ThermalPrinterPlugin before the bridge starts.
- Bluetooth availability and Android permissions are checked before printer access.

## Side Effects

- Child boundary behavior: Requests Bluetooth permissions, manages native printer connections and emits thermal/ESC-POS output through the plugin.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.
- Native compilation/device/printer behavior needs the Android toolchain and device checks described in the app runbook; the Node tests do not verify native hardware.
