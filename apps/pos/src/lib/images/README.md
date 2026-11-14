# src/lib/images contract

## Overview

Shared client image loading, resizing and ImageData generation for QR decoding and proof uploads.

## Interface

- [downscale.ts](./downscale.ts) — `DownscaleOptions`, `DownscaleResult`, `QR_DECODE_MAX_EDGE`, `PROOF_UPLOAD_MAX_EDGE`, `loadDrawable`, `releaseDrawable`, `drawToImageData`, `downscaleImage`.

## Invariants

- QR decode and proof upload use separate maximum-edge constants.
- Missing canvas contexts are refused; callers can release drawable resources.

## Side Effects

- Decodes blobs, allocates canvas/image resources and produces resized image bytes.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (6241 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
