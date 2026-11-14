# apps/customer/android/app/src/main/java/net/shareat/order

## Overview

Android entry activity for the Shareat Order Capacitor wrapper.

## Interface

- MainActivity extends com.getcapacitor.BridgeActivity in package net.shareat.order.

## Invariants

- The activity contains no custom overrides or native order-data implementation.

## Side Effects

- When launched on Android, inherits Capacitor bridge/WebView lifecycle behavior; the class defines no additional side effects.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
- Android packaging is a separate Gradle/Capacitor check; the Java activity was inspected but no APK build was run for this documentation change.
