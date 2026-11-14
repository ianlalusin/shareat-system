# scripts

## Overview

Operator and scheduler command-line entry points.

## Interface

- package.json scripts are the supported command entry points; these files are not a shared application API.
- The bounded scan covers apk-signing-gate.mjs, attendance-sweep.ts, audit.ts, backfill-canonical-positions.ts, backfill-file-links.ts, backfill-fiscal-periods.ts, backfill-store-attendance-config.ts and part of backtick-parity.mjs. Other script names are discoverable in package.json; their behavior is not certified by this scan.
- Observed named exports include backfillOrgPositions and the file-link backfill parseArgs.
- [lib](./lib/README.md) — child interface, invariants and side effects.

## Invariants

- Each write command retains its own confirmation/target guards; documenting a command does not authorize running it.
- Do not run scheduler or cutover tools against production as part of a documentation check; preserve the CLI exit status that monitoring consumes.

## Side Effects

- Depending on the entry point: database transactions and backfills, scheduler work, local audit reports and command output.
- The APK signing gate inspects environment variable presence without printing values; the audit CLI reads landed PostgreSQL documents and writes a Markdown report.
- Backfill confirmation is explicit; previews either read only or deliberately roll back. The commands were not executed by bootstrap.

## Verification

- From the repository root: `npm run test` (unit) and affected `npm run test:integration` cases against real PostgreSQL. CLI operations are not a documentation verification step.

### Source coverage

The bootstrap inspected 8 implementation files (50000 bytes), at most 300 lines per file and 50,000 bytes per directory. This contract is a bounded index, not a full correctness audit.
