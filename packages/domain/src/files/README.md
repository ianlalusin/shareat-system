# Files
## Overview
The upload broker (T-141): the only code that touches the storage bucket. It authorizes uploads and reads per file purpose, validates content, hands out short-lived signed URLs, links files to the records that own them, and sweeps orphaned files. Postgres stores the path, never the bytes; isolation lives in `authorize()`, not in bucket rules.
## Interface
- `index.ts`: `uploadFile`, `canUploadFile`, `canReadFile`, `canReadFiles`, `readFileUrl`, `claimUpload`, `assertUnclaimedUploadRoom`, `UNCLAIMED_UPLOAD_CAP` (30), `UploadCapError`, `FileNotFoundError`, `linkFile`, `sweepOrphanedFiles`, types `UploadInput`/`UploadResult`; re-exports `./driver`, `mayViewSignature`, `SIGNATURE_LINK_SECONDS`, `fileBytesMatchType`, `isImageContentType`, `MAX_IMAGE_BYTES`, `PURPOSE_LIMITS`.
- `driver.ts`: types `PutInput`/`StorageDriver`; `inMemoryDriver`, `setStorageDriver`, `resolveStorageDriver`.
- `limits.ts` (db-free leaf, browser-importable as `@shareat/domain/files/limits`): `LIMIT_PURPOSES`, `LimitPurpose`, `PURPOSE_LIMITS`, `MAX_IMAGE_BYTES` (1 MB), `isImageContentType`.
- `magic.ts` (pure): `fileBytesMatchType`.
- `signature.ts`: `SIGNATURE_LINK_SECONDS` (60), `SignatureFile`, `mayViewSignature`, `auditSignatureChange`, `assertMayLearnSignatureAbsent`, `signatureUrl`, `signatureBytes`.
- `backfill-links.ts`: `backfillFileLinks`, types `FileLinkProblem`, `BackfillFileLinksResult`.
## Invariants
- Nothing but this module touches the bucket; paths come from the session, reads are `authorize()`d with the capability that governs the file's PURPOSE at the file's store (`PURPOSE_CAPABILITY`, one shared `assertCanRead`).
- `leave_document` and `staff_signature` reads never use `PURPOSE_CAPABILITY` (it governs upload only); they route through `leave/document-access` and `mayViewSignature`.
- The declared content type is not trusted: the first bytes must match (`fileBytesMatchType`); per-purpose type allow-list; photos capped at `MAX_IMAGE_BYTES` everywhere; EXIF/metadata is stripped.
- `limits.ts` must not import the database package; a compile-time check in `index.ts` keeps `LIMIT_PURPOSES` equal to the schema's `FILE_PURPOSES`.
- `claimUpload` is one conditional UPDATE (own, unlinked, same purpose and store, under 24 h); every failure returns the same sentence so a probe learns nothing.
- `sweepOrphanedFiles` is per org, deletes the DB row BEFORE the bytes (a file claimed in between keeps both), and reports counts; stranded bytes after a failed `driver.remove` are an accepted, currently undetectable residual (DEF-307).
- `resolveStorageDriver` refuses to fall back to memory when `FIREBASE_STORAGE_BUCKET` is set and no driver is installed.
- Signed URLs are never stored or logged; signature audit payloads carry no file id, path or URL; a refused signature view is audited in a separate transaction.
- `backfillFileLinks` touches no bytes, never deletes a row, reports problems rather than writing them; a dry run rolls back.
## Side Effects
- Storage: `put`, `get`, `remove`, `signedUrl` via the installed `StorageDriver` (in-memory when no bucket is configured).
- DB writes via `filesRepo` and `auditLogRepo` on the caller's `Tx` (or a fresh `transaction` when `tx` is `null`); `sweepOrphanedFiles` and the backfill use `withSystemOrgPrincipal`.
- Reads `process.env.FIREBASE_STORAGE_BUCKET`, hashes bytes with `node:crypto`, and logs via the logger.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
