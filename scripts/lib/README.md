# scripts/lib

## Overview

Reusable helpers for operator scripts, master-data loading and configuration checks.

## Interface

- config-contract.ts exports ConfigExpectation, ConfigContractResult, checkValueAgainstDocs, checkValuesDiffer, checkValuesMatch and STORAGE_BUCKET_EXPECTATION.
- dual-run-extract.ts exports runDualRunExtract, loadSnapshotFile and removeSnapshotFile with their option/result types.
- master-data-apply.ts exposes applyItems/loadItemState plus party-loading types/helpers in the inspected portion; master-data-readiness.ts exports readiness and readiness shapes.
- storage-bootstrap.ts exports installScriptStorageDriver for standalone processes.
- [backup](./backup/README.md) — child interface, invariants and side effects.
- [rehearsal](./rehearsal/README.md) — child interface, invariants and side effects.

## Invariants

- Configuration comparisons operate on already-resolved values; they do not choose an alternate configuration.
- Readiness authorizes every requested store before reading its report facts; the caller supplies the open org-scoped transaction.
- Snapshot extraction uses a read-only v1 client and refuses extraction in production; snapshots are whitelisted and hashed.

## Side Effects

- Configuration comparison helpers are pure; readiness reads PostgreSQL.
- Master-data apply uses domain functions, a per-org transaction/lock and audit records; extraction reads v1 and writes restricted local snapshot/hash files.
- Storage bootstrap installs the configured Firebase driver in the domain registry for the standalone process.

## Verification

- From the repository root: `npm run test` (unit) and affected `npm run test:integration` cases against real PostgreSQL. CLI operations are not a documentation verification step.

### Source coverage

The bootstrap inspected 5 implementation files (34167 bytes), at most 300 lines per file and 50,000 bytes per directory. This contract is a bounded index, not a full correctness audit.
