# Master-data planning

## Overview

Read-only extraction boundary and planners for item, party and staff decision sheets, including local HR validation.

## Interface

- [index.ts](./index.ts): re-exports the module boundary.
- [hr-sheet.ts](./hr-sheet.ts): includes `HrError`, `HrResult`, `validateHr`.
- [items-plan.ts](./items-plan.ts): includes `ITEM_KINDS`, `REAL_UNITS`, `CONTAINER_UNITS`, `SnapshotItem`, `ItemsSnapshot`, `ExistingItem`, `ExistingLink`, `PlannedLink`, `ItemWrite`, `Row`, `ITEM_SHEETS`, `ItemSheet`.
- [keys.ts](./keys.ts): includes `key`, `loose`, `isJunkName`.
- [parties-plan.ts](./parties-plan.ts): includes `PARTY_SHEETS`, `PartySheet`, `PARTY_SHEET_COLUMNS`, `PartiesSnapshot`, `ExistingParty`, `PartyLink`, `PartyEntity`, `PlannedPartyLink`, `SupplierCreate`, `CustomerCreate`, `PartyLinkWrite`, `PartyWrite`.
- [sheets.ts](./sheets.ts): includes `toCsv`, `parseCsv`, `rowKey`, `assertSheetsOutsideRepo`.
- [snapshot.ts](./snapshot.ts): includes `V1DocSnapshotLike`, `V1FirestoreLike`, `ReadOnlyV1Client`, `makeReadOnlyV1Client`, `maskAccount`, `RunExtractResult`, `runExtract`, `parseServiceAccountKey`, `verifySnapshotSha`.

## Invariants

- The supplied v1 reader exposes read operations only; this package does not import the Firebase SDK.
- Snapshots use an explicit field whitelist; mask account numbers and keep pay-rate sheets local, outside the repository.
- Exact name keys may establish identity; loose keys identify candidates for review and must never merge records automatically.
- Planners return proposed writes and unanswered sheets; they do not apply those writes to PostgreSQL.

## Side Effects

- Planning/CSV/HR helpers transform supplied values. Snapshot extraction calls the injected read-only client; snapshot verification reads a local file and hashes its bytes.
- The CLI owns snapshot/sheet file writes and applies approved plans through the domain layer.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
- Contract scan samples entry/schema files first (50 KB per directory, at most 300 lines per implementation); consult the owning source before changing an unlisted operation.
