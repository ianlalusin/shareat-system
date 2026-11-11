# People
## Overview
The staff master record (T-154): persons, employments, positions, store rosters, position access defaults (T-289), and staff photo/signature (T-434). Every function takes an `Actor` resolved server-side; no function accepts an actor identity as a parameter.

## Interface
- `index.ts`: `EmploymentError`, `createEmployment`, `createPerson`, `renamePerson`, `searchPersons`, `endEmployment`, `setEmploymentPositions`, `upsertStorePosition`, `listPositions`, `listRoster`, `seedCanonicalPositions`, types `CreateEmploymentInput`, `CreatePersonInput`, `PersonSearchHit`. Re-exports `OFFERABLE_TO_POSITIONS`, `CANONICAL_POSITION_DEFAULTS` and related position-default symbols, the `person-name` helpers, and `staff-media`.
- `person-name.ts` (pure): `normaliseNamePart`, `normaliseName`, `formatDisplayName`, `nameKey`, type `NameParts`.
- `position-defaults.ts`: `PositionDefaultError`, `OFFERABLE_TO_POSITIONS`, `CANONICAL_POSITION_DEFAULTS`, `seedStoreAccessDefaults`, `reconcilePositionGrants`, `setPositionDefault`, `retireStorePosition`, types `SeedStoreAccessDefaultsResult`, `ReconcileResult`, `SetPositionDefaultInput`.
- `staff-media.ts`: `setStaffPhoto`, `removeStaffPhoto`, `setStaffSignature`, `removeStaffSignature`, `signatureForPrint`, `staffMediaView`.

## Invariants
- Acting identity comes from the `Actor`, never a client-sent id (bible 7.1).
- `authorize()` is never touched by position defaults: a position is stored as `position_capability_defaults` rows and materialised as ordinary `person_grants` tagged `grant_source = 'position'`.
- `reconcilePositionGrants` is deliberately not re-exported from `index.ts` (closed-importer guard test).
- `OFFERABLE_TO_POSITIONS` is derived, never hand-listed; import it instead of re-deriving.
- `formatDisplayName` must agree with the SQL `persons_name_parts_check` (migration 0207); names are NFC, trimmed, whitespace-collapsed, first letter capitalised, blank middle name is `null`.
- Signatures must be real PNG bytes (magic-number checked); a `data:` URL is refused. Staff cannot change their own photo/signature. Signature viewing is decided only by `files/signature.ts`; `staffMediaView` returns `signatureFileId` only when allowed.

## Side Effects
- Writes persons, employments, positions, grants, files and `audit_log` rows via repos (`personsRepo`, `employmentRepo`, `accessRepo`, `filesRepo`, `auditLogRepo`).
- All functions take the caller's `Tx`.
- `person-name.ts`: None (pure functions).
- Authorizes `enrol_staff`, `manage_stores`, `manage_store_settings`, `grant_capability`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
