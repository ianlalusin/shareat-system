# src/lib/loyalty contract

## Overview

Customer-query classification, card QR parsing, phone masking and session-link helpers.

## Interface

- [session-link.ts](./session-link.ts) — `DEFAULT_POINTS_PER_PESO`, `MIN_NAME_QUERY`, `CustomerQuery`, `classifyCustomerQuery`, `parseCardQrPayload`, `nameMatches`, `maskPhone`, `estimateEarnPoints`, `isCashierLinked`, `CardPillModel`, `cardPillModel`.

## Invariants

- A name search requires at least two characters.
- Phone-like punctuation/digits select phone lookup; other text selects name lookup.

## Side Effects

- Pure parsing/matching/label helpers; no persistence operations in the inspected module.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 1 direct source files (2858 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
