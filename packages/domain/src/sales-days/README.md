# Sales Days
## Overview
Owns the sales-day lifecycle: a store's daily sales report is opened (typed, or imported from the POS v1 day feed), edited while unverified, submitted, verified and voided. Verification IS the posting: an unverified day has no journal entry and contributes no revenue to any reader. The pure `routeSalesDay` turns a day's figures into balanced journal lines (docs/tasks/123-sales-day.md, docs/POSTING-PATTERNS.md `sale.*`).

## Interface
- `routing.ts`: `SALES_DAY_ACCOUNTS`, `SalesDayChannelInput`, `RouteSalesDayInput`, `SalesDayTenderInput`, `RoutedLine`, `RouteSalesDayResult`, `routeSalesDay` (pure)
- `compose.ts`: `platformSalesTotal`, `routeInputForDay` (the one place a stored day becomes `routeSalesDay` input)
- `create.ts`: `createSalesDay`, `CreateSalesDayInput`/`CreateSalesDayChannelInput`/`CreateSalesDayTenderInput`, `writeChannels`, `writeTenders`, `sumTender`, `parseSalesDayFigures`; re-exports `SalesDayBlockedError`, `TransitShortfallBlockedError`, `canBypassBlock`
- `create-block.ts`: `assertCanOpenDay`, `assertStoreTakesTypedDays`, `canBypassBlock`, `safeHumanDate`, `SalesDayBlockedError`, `TransitShortfallBlockedError`
- `edit.ts`: `editSalesDay`, `EditSalesDayInput`
- `verify.ts`: `submitSalesDay`, `verifySalesDay`, `voidSalesDay`, `VerifySalesDayResult`
- `import.ts`: `importSalesDay`, `reimportSalesDay`, `ImportFetchers`, `ImportSalesDayInput`, `ImportSalesDayOutcome`
- `platform.ts`: `setPlatformSales`, `SetPlatformSalesInput`
- `correction.ts`: `postPosCorrection`, `PostPosCorrectionInput`, `PostPosCorrectionResult`
- `live-day.ts`: `lockLiveSalesDay`
- `index.ts` re-exports routing, create, edit, verify, live-day, import, compose, platform, correction (not `create-block` directly).

## Invariants
- `routeSalesDay` is pure and checks three balances: revenue (unli + a-la-carte = totalSales), channels (all channels = totalSales), tenders (cash + online + credit + non-remitted channels + discounts + comps = totalSales). A day that fails quarantines (named refusal) rather than posting a guessed entry; derived cash is never floored at zero.
- v2 records GROSS sales; discounts and charges sit on their own lines. Service charge goes to the 2160 float (neither revenue nor expense); other charges go to 4500 income.
- Verification is the posting. `submit_sales_day` includes staff; `verify_sales_day` does not (segregation of duties). Verify requires status `submitted`; submit requires `open`.
- Create-block: opening a new day is refused while a strictly older unverified day exists; admins bypass; editing a draft and backfilling an older date are never blocked. Do not "restore" the stricter no-exemption version.
- A feed day's own figures are never typed; platform sales (non-remitted channel rows) are added at routing time only, in `compose.ts`. A correction must compose via `routeInputForDay` exactly as verify did.
- `postPosCorrection` posts only the delta (new minus old per account/party) from `journal_lines`; the day's own figures, status and entry never change; an all-zero delta is refused. The correction row and its entry share an id.
- An absent channel row and a confirmed no-sales row (`noSales`) must stay distinct.
- Writers against a day (usage, wastage) go through `lockLiveSalesDay` (takes `FOR SHARE`, refuses missing, other-store or voided days) after `authorize()` and before the first write.
- Refusals use `refuse`/`gone`/`internalFault` from `../shared/refusal`.

## Side Effects
- DB writes via `salesDaysRepo`, `posV1Repo`, `moneyAccountsRepo`, `auditLogRepo` inside a transaction. Functions taking `tx: Tx | null` open their own `transaction` when `null`.
- Ledger: `verifySalesDay` and `postPosCorrection` call `postEntry`; `voidSalesDay` reverses via `reverseEntry`.
- `authorize()` runs first in every writer; a refusal is audit-logged by `authorize`.
- `importSalesDay`/`reimportSalesDay` accept injected fetchers for POS data (network happens in the fetchers, never while holding a lock).
- `routing.ts` and `compose.ts` are pure (no DB, clock or env).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
