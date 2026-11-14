# apps/customer/android/app/src

## Overview

Android source/build namespace for the Shareat Order wrapper.

## Interface

- Build/source grouping with no directly declared callable symbols; the child contract locates the activity or next namespace.
- [main](./main/README.md) — Android source/build namespace for the Shareat Order wrapper.

## Invariants

- Java package ancestry must remain consistent with net.shareat.order.MainActivity and the Capacitor app identity.

## Side Effects

- This directory has no directly executable source; Gradle/Capacitor and activity behavior are owned by descendants.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
- Android packaging is a separate Gradle/Capacitor check; the Java activity was inspected but no APK build was run for this documentation change.
