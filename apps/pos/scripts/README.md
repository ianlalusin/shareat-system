# scripts contract

## Overview

APK/emulator build entry points, reproducible v1 copy, and human-run audit/soak/seed tools.

## Interface

- [build-cap.mjs](./build-cap.mjs) — executable/configuration module; see documented behavior below.
- [build-emulator.mjs](./build-emulator.mjs) — executable/configuration module; see documented behavior below.
- [copy-from-v1.mjs](./copy-from-v1.mjs) — executable/configuration module; see documented behavior below.
- [pos2-audit-lib.mjs](./pos2-audit-lib.mjs) — `auditDayOf`, `auditRange`, `classifyConversion`, `negativeDays`.
- [pos2-audit.mjs](./pos2-audit.mjs) — executable/configuration module; see documented behavior below.
- [pos2-soak-verify.mjs](./pos2-soak-verify.mjs) — `classifyTerminalReceipts`.
- [seed-emulator.mjs](./seed-emulator.mjs) — executable/configuration module; see documented behavior below.
- [lib](./lib/README.md) — Pure statutory logbook receipt projection and spreadsheet-safe rendering.

## Invariants

- Audit and soak tools are explicitly read-only and person-run.
- The emulator seed accepts only fixed local demo endpoints and requires confirmation.
- Copying reads source git objects and writes this app; references remain read-only.

## Side Effects

- Build scripts spawn build/Capacitor/Gradle commands and temporarily move API middleware files.
- Copy scripts write app files; audits can read credential/fixture files and remote records; the explicit emulator seed writes synthetic local data.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 7 direct source files (32645 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
