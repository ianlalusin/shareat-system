# src/lib/export contract

## Overview

Browser XLSX export helper.

## Interface

- [export-xlsx-client.ts](./export-xlsx-client.ts) — `exportToXlsx`.

## Invariants

- The XLSX library is loaded dynamically at export time.
- Callers supply the data and output options.

## Side Effects

- Creates and downloads a spreadsheet in the browser.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (1907 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
