# apps/customer/scripts

## Overview

Static-export build entry point for the Android wrapper.

## Interface

- build-cap.mjs spawns npx next build with BUILD_TARGET=capacitor and propagates its exit status.

## Invariants

- The static build uses the same app with the Capacitor export switch; stop this app dev server before building.
- This build helper is not a runtime ordering API.

## Side Effects

- Starts a child build process, inherits its output, and writes build artifacts under the customer app; it was not executed during documentation bootstrap.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
