# firebase

## Overview

Isolated emulator harness and deployed Firestore two-lane rules contract.

## Interface

- firestore.rules defines mirror, biometricMirror/<storeId>/credentials and inbox rule paths; firestore.indexes.json carries query indexes.
- vitest.config.ts configures a serialized Node test harness; package.json runs Firestore/Auth emulators under the shareat-rules project.

## Invariants

- Clients cannot write mirror or biometric mirror documents; biometric reads require a terminal of that store.
- Inbox creates require terminal identity, matching document/clientPunchId and matching device/store claims; updates and deletes are denied.
- Inbox reads are scoped to the terminal device id; client queries must carry that filter.
- General mirror reads permit a same-store terminal or an ordinary signed-in person; this rule does not itself consult PostgreSQL store membership.
- The rules-testing SDK stays outside shipped workspace dependencies.

## Side Effects

- The rules constrain client Firestore operations; the Admin SDK bypasses client rules.
- The harness starts local Firestore/Auth emulators and clears emulator data in tests; bootstrap did not start it.

## Verification

- From the repository root: `npm --prefix firebase test` (requires the emulator CLI and local harness dependencies).
