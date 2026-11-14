# src/lib/firebase contract

## Overview

Primary client Firebase SDK handles, media upload helpers and undefined-value sanitization.

## Interface

- [account-security.ts](./account-security.ts) — `changePassword`, `linkWithGoogle`, `sendPasswordReset`.
- [client.ts](./client.ts) — `uploadProductImage`, `uploadItemPhotoLocal`, `uploadUserAvatar`, `uploadStoreLogo`, `uploadReceiptLogo`, `app`, `auth`, `db`, `storage`.
- [utils.ts](./utils.ts) — `stripUndefined`.

## Invariants

- The emulator build refuses a live Firebase app project.
- Firestore uses persistent local cache with multi-tab management.
- Undefined stripping preserves non-plain objects such as SDK values.

## Side Effects

- Initializes Auth/Firestore/Storage and connects explicit emulator endpoints.
- Uploads product/avatar/logo files and writes their URLs to Firestore.
- Account-security helpers reauthenticate/change passwords, link Google identity and send reset emails.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 3 direct source files (8913 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
