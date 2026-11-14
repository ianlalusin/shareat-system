# src/lib/payments/proof contract

## Overview

Captures payment-proof metadata and queues image uploads in an IndexedDB photo outbox.

## Interface

- [capture.ts](./capture.ts) — `PROOF_RETENTION_DAYS`, `CaptureProofArgs`, `capturePaymentProof`, `flushProofOutbox`.
- [outbox.ts](./outbox.ts) — `QueuedProofPhoto`, `MAX_UPLOAD_ATTEMPTS`, `enqueueProofPhoto`, `listQueuedProofPhotos`, `removeQueuedProofPhoto`, `markProofPhotoAttempted`.

## Invariants

- Proof metadata is written through Firestore persistence; photo bytes use a separate durable outbox.
- Retention is 15 days and the upload-attempt ceiling is six.

## Side Effects

- Writes paymentProofs documents, uploads to Firebase Storage and enqueues/removes/retries IndexedDB photo records.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 2 direct source files (9042 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
