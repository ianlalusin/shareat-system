# Cutover
## Overview
The guided, verified conversion from v1 to v2 on the conversion date (docs/tasks/134-cutover-wizard.md, 390-opening-stock-and-subledger-tieout.md). It declares the wizard's steps and gates, records attestations and counts, enters opening figures as balanced drafts against 3900, values opening stock and fixed assets, checks every register against its control account, and posts everything in one act (C5). It runs twice (a rehearsal on a restored database, then the real run).

## Interface
- `conversion-date.ts`: `CONVERSION_DATE` (leaf module, imports nothing; re-exported via `tie-out.ts`)
- `steps.ts` (pure declaration): `CUTOVER_STEPS`, `CUTOVER_GATES`, `stepDef`, `gatesBefore`, `StepKind`, `Phase`, `StepDef`
- `index.ts`: `cutoverProgress`, `attestStep`, `recordOpeningCount`, `openingGaps`, `StepState`, `CutoverProgress`, `OpeningGaps`; re-exports steps, opening, tie-out, opening-assets, opening-stock
- `opening.ts`: `addOpeningFigure`, `removeOpeningFigure`, `postOpeningBalances`, `OPENING_EQUITY_CODE`, `OPENING_SOURCE_TYPE`, `OpeningFigureInput`, `PostOpeningResult`
- `opening-stock.ts`: `planOpeningStock` (pure), `valueOpeningStock`, `writeOpeningStock`, `countedStockValue`, `assertOpeningWritable`, `assertPurgedAndNotOpened`, `itemKindsOf`, `openingStockKey`, `OpeningStockCount`, `OpeningItemInfo`, `OpeningStockStorePlan`, `ValueOpeningStockResult`
- `opening-assets.ts`: `valueOpeningAsset`, `ValueOpeningAssetInput`
- `tie-out.ts`: `openingTieOut`, `tieOutRefusalText`, `tieOutDetail`, `TieLine`, `NotCheckedLine`, `TieOut`, `CONVERSION_DATE`

## Invariants
- No rehearsal flag exists anywhere; isolation comes from ADR-007 (a restored database).
- A 3900 residual HALTS. There is no plug or suspense account and no override; C3 shows a running residual so C5 is never a surprise.
- Each opening figure is its own balanced DRAFT against 3900 (the database's deferred balance trigger requires every entry to balance at commit); drafts stay editable and deletable until C5 flips them all to posted in one transaction.
- `planOpeningStock` is the single implementation of the opening-stock arithmetic: the draft, the tie-out and the C5 re-check all use it. Rounding is once per item per store, half-up, in exact scaled integers (never a float). Draft: Dr 1310/1320/1330, Cr 3900; pressing it again deletes and rewrites it.
- Opening assets open at net book value: `cost` = book value, `acquired_on` = conversion date, remaining life; accumulated depreciation opens at zero.
- The tie-out is a query, never a recorded row; figures are compared in centavos. Party-derived registers can only be checked as valid, not by total (C3P attestation does that).
- Concurrency: `postOpeningBalances` takes the EXCLUSIVE opening lock before reading; every other opening writer takes the shared lock before its checks (R13). The purge (C2) must be performed and books not already opened before any opening write or post.
- `steps.ts` copy is user-facing prose with no marker glyphs. A step that cannot be checked by this database is flagged and behaves as attested, saying so.
- Every writer authorizes `run_cutover` (store-scoped where the input names a store) before any other check.
- Refusals use `refuse`/`gone` from `../shared/refusal`; screens' own rules use `assertFieldRules`.

## Side Effects
- DB writes via `cutoverRepo`, `journalRepo`, `auditLogRepo` (and stock/asset repos through the opening files). Writers take `tx: Tx | null` and open a `transaction` when null.
- Ledger: `postOpeningBalances` posts every opening draft (source type `opening_balance`); `writeOpeningStock` writes FIFO `opening` layers and movements inside that same transaction.
- `steps.ts`, `conversion-date.ts` and `planOpeningStock` are pure (no DB, clock or env).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
