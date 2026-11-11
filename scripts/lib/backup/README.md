# scripts/lib/backup

## Overview

Backup/restore orchestration, PostgreSQL tools, object storage and retention planning.

## Interface

- run-backup.ts exports runBackup, BackupDeps, BackupResult, MANIFEST_VERSION, manilaDate, utcStamp, sha256OfFile and readManifestFile in the inspected source.
- run-drill.ts exports DRILL_DB_RE, assertDrillTarget, runDrill, sequenceMismatches and drill result/dependency types in the inspected source.
- fingerprint.ts exports computeFingerprint, normalizeDecimal, emptyLedgerReason, compareFingerprints and Fingerprint; retention.ts exports planPrune and its retention constants.
- object-store.ts supplies fsStore/spacesStore and configuration helpers; pg-tools.ts supplies guarded PostgreSQL subprocess arguments/execution and redaction; heartbeat.ts supplies httpHeartbeat.

## Invariants

- Only complete manifest-backed backups count; manifest upload follows dump and roles upload/verification.
- An empty ledger fingerprint is a failure; numeric values remain text for exact comparison.
- Restore drills guard scratch target identity before connecting; retention can delete only allowed daily backup key shapes.
- Connection passwords stay out of argv and logs; heartbeat delivery failure must not alter the underlying operation result.

## Side Effects

- Reads database snapshots, starts pg_dump/pg_dumpall/pg_restore, reads/writes local temporary files and uploads/downloads object-store objects.
- Restore drills create/drop the guarded scratch database; successful backup retention may delete allowed old objects.
- Heartbeat implementations issue HTTP requests; the retention planner itself is pure. No backup/drill was run by bootstrap.

## Verification

- From the repository root: `npm run test` (unit) and affected `npm run test:integration` cases against real PostgreSQL. CLI operations are not a documentation verification step.

### Source coverage

The bootstrap inspected 7 implementation files (50000 bytes), at most 300 lines per file and 50,000 bytes per directory. This contract is a bounded index, not a full correctness audit.
