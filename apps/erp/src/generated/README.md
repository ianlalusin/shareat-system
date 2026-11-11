# generated

## Overview

Build revision constant consumed by health and shell surfaces.

Parent blueprint: [up one directory](../README.md).

## Interface

- [revision.ts](./revision.ts) — `REVISION`.

## Invariants

- `REVISION` is build metadata, independent of request-time environment validation; edit its producing script rather than treating this constant as runtime state.

## Side Effects

- Importing the revision constant has no I/O; health/shell consumers expose it in their responses.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 1 local production/configuration files scanned; 316 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
