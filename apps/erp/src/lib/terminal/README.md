# terminal

## Overview

Browser-only Firebase initialization and the attendance mirror/inbox lane.

Parent blueprint: [up one directory](../README.md).

## Interface

- [firebase.ts](./firebase.ts) — `TERMINAL_APP_NAME`, `terminalFirebase`, `requestPersistentStorage`.
- [lane.ts](./lane.ts) — `CredentialKind`, `PunchIntent`, `MirroredCredential`, `MirroredRoster`, `MirroredDayFeed`, `MirroredConfig`, `watchMirrors`, `resolveScan`, `PunchInput`, `writePunch`, `watchPending`.

## Invariants

- Preserve the declared input/output types; domain rules and authorization remain with the callers and shared packages.
- Offline clock dependencies use Firebase client SDK only: no Server Actions, `@shareat/db`, `@shareat/domain` or `next/headers` imports.

## Side Effects

- Invokes `setDoc`; persistence or external operations belong to those called services.
- Loads screen/report data through `getApp`, `getApps`, `getAuth`.
- Installs Firestore snapshot subscriptions and returns listener cleanup callbacks.
- Reads mirrored roster/configuration/credentials and appends attendance punch events through the Firebase edge lane; browser persistence and network acknowledgements are observable.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 2 local production/configuration files scanned; 19,094 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
