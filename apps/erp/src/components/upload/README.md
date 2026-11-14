# upload

## Overview

Photo/document selection, compression, byte-progress uploads and guarded evidence viewing.

Parent blueprint: [up one directory](../README.md).

## Interface

- [FileTile.tsx](./FileTile.tsx) — `FileTile`.
- [Lightbox.tsx](./Lightbox.tsx) — `useLightbox`, `Lightbox`.
- [PhotoThumb.tsx](./PhotoThumb.tsx) — `PhotoThumbProps`, `PhotoThumb`.
- [PhotoUpload.tsx](./PhotoUpload.tsx) — `PhotoUploadProps`, `PhotoUpload`.
- [WaterFill.tsx](./WaterFill.tsx) — `WaterFill`.
- [photo-compression.ts](./photo-compression.ts) — `PHOTO_TARGET_BYTES`, `EDGE_LADDER`, `QUALITY_LADDER`, `OUTPUT_TYPE`, `isCompressibleImage`, `compressionAttempts`, `scaleToEdge`, `MAX_CANVAS_PIXELS`, `needsPreScale`, `formatBytes`.
- [upload-compress.ts](./upload-compress.ts) — `CompressionRefused`, `CompressionUnavailable`, `needsCompression`, `shrinkPhoto`.
- [upload-rules.ts](./upload-rules.ts) — `UploadPurpose`, `acceptFor`, `allowsPdf`, `shapeFor`, `GUARDED_PURPOSES`.
- [upload-state.ts](./upload-state.ts) — `ExistingFile`, `UploadState`, `UploadAction`, `initialState`, `reduce`, `shouldAbort`, `percent`.
- [upload-xhr.ts](./upload-xhr.ts) — `SentFile`, `UploadSendError`, `sendFile`.

## Invariants

- Files declaring `use client` execute browser state/effects; props and callbacks form their component boundary.
- Guarded files use authenticated viewing rather than public permanent URLs. Upload progress measures bytes; completed uploads return file ids for a later record save.

## Side Effects

- Issues browser/server HTTP requests from the linked request helpers; upload controls report transport progress.
- Browser effects synchronize component state with DOM, timers or external subscriptions; cleanup is owned by the relevant effect.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 10 local production/configuration files scanned; 39,731 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
