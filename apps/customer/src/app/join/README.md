# apps/customer/src/app/join

## Overview

QR-token landing screen at /join?t=... .

## Interface

- Default Page renders QrJoin in Suspense; QrJoin reads t through useSearchParams.

## Invariants

- A device id and a nonempty table token are needed; a ref prevents the effect from starting twice.
- Suspense around useSearchParams permits static prerendering.

## Side Effects

- Calls joinByQr, updates provider session and replaces navigation with /menu on success.

## Verification

- From the repository root: `npm test -w @shareat/customer`. This app has its own Vitest configuration; the root unit project excludes it.
