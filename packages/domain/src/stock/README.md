# Stock
## Overview
Inventory quantity, FIFO cost and the ledger postings that follow stock events (Phase 3). It splits into pure engines (`layers`, `quantity`, `transfer-rules`, tolerance maths), tx-level engines that carry no `authorize()` (`consume`, `usage`, `count-sessions`, `receipt-posting`), and actor-facing document layers that authorize and orchestrate them (`transfers`, `count-workflow`, `usage-records`, `supplier-returns`). Cost always comes from FIFO layers, never from a price list.

## Interface
- `quantity.ts`: `Quantity`, `quantity`, `ZERO_QUANTITY`, `toThousandths`, `fromThousandths`, `addQuantity`, `subtractQuantity`, `compareQuantity`, `isZeroQuantity`, `isPositiveQuantity`. `quantity-field.ts`: `parseRequiredQuantity`.
- `layers.ts` (pure FIFO): `CostLayer`, `ConsumedLine`, `ConsumptionPlan`, `PlanRefused`, `ConsumptionResult`, `planConsumption`, `planReversal`, `lineCost`.
- `consume.ts`: `ConsumeInput`, `ConsumeResult`, `ConsumeOutcome`, `consume`, `reverseConsumption`.
- `receipt-posting.ts`: `INVOICE_MATCH_TOLERANCE`, `INVENTORY_ACCOUNT_BY_ITEM_KIND`, `GRNI_ACCOUNT`, `AP_ACCOUNT`, `PRICE_VARIANCE_ACCOUNT`, `ReceiptLine`, `PostReceiptInput`, `PostingResult`, `postReceiptValue`.
- `invoice-link.ts`: `VarianceSplit`, `splitVariance`, `LinkInvoiceInput`, `LinkInvoiceResult`, `linkInvoiceToReceipt`.
- `consumption-posting.ts`: `WASTAGE_ACCOUNT`, `INVENTORY_ADJUSTMENT_ACCOUNT`, `COGS_ACCOUNT_BY_CATEGORY`, `ConsumptionPostingInput`, `ConsumptionPostingResult`, `postConsumption`, `postWastage`, `postCountVariance`.
- `transfer-rules.ts`: `TransferLineRequest`, `TransferRequest`, `ValidationOutcome`, `validateTransferRequest`, `DEFAULT_STUCK_TRANSFER_THRESHOLD_DAYS`. `transfers.ts`: `TransferLineInput`, `CreateTransferInput`, `TransferOutcome`, `transferNow`, `saveDraft`, `dispatch`, `receiveTransfer`, `voidTransfer`, `StuckTransfer`, `stuckTransfers`.
- `count-sessions.ts` (engine): `CountLineInput`, `CommitCountInput`, `VarianceLine`, `CommitCountResult`, `CommitCountOutcome`, `commitCountSession`. `count-workflow.ts`: `openCountSession`, `recordCount`, `advanceCountSession`, `commitCount`, `cancelCountSession`, `isFrozenBySessions`, plus their input/outcome types and `FreezingSessionLike`.
- `usage.ts` (engine): `UsageLineInput`, `PostUsageInput`, `PostUsageResult`, `PostUsageOutcome`, `postUsageRecord`, `VoidUsageInput`, `voidUsageRecord`.
- `usage-records.ts` (document): `cogsCategoryForItemKind`, `saveUsageDraft`, `addUsageLine`, `removeUsageLine`, `deleteUsageDraft`, `postUsage`, `voidUsage`, plus `UsageDraftLine`, `SaveUsageDraftInput`, `DraftOutcome`, `LineOutcome`, `VoidableOutcome`, `VoidUsageOutcome`, `PostOutcome`.
- `usage-post-core.ts`: `postLoadedUsageRecord`. `void-pull-usage-record.ts`: `voidPullUsageRecord`. Both are actor-less and deliberately NOT in the domain barrel.
- `usage-tolerance.ts`: `isWithinUsageTolerance`, `setOrgUsageTolerance`, `setItemUsageTolerance`, `UsageVariance`, `usageVariancesFor`, `listUsageVariances`, `listStoreUsageQueue`, `ToleranceGate`, `snapshotVariancesFor`, `checkUsageTolerance`, `writeToleranceVerified`.
- `usage-auto-post.ts`: `AutoPostedRecord`, `AutoPostResult`, `autoPostDueUsageDrafts`. `usage-check-report.ts`: `usageCloseRefusal`, `UsageCheckScorecardRow`, `usageCheckScorecard`, `unpostedUsageDraftCount`.
- `supplier-returns.ts`: `ReturnLineInput`, `RecordReturnInput`, `RecordReturnOutcome`, `recordReturn`, `VoidReturnOutcome`, `voidReturn`, `returnableQuantity`, `supplierCreditBalance`, `RefundCreditInput`, `RefundCreditOutcome`, `refundSupplierCredit`.
- `period-guard.ts`: `closedStockPeriodSentence`, `closedStockPeriodSentenceToday`. `wastage-reasons.ts`: `WASTAGE_REASONS`, `WastageReason`, `WASTAGE_REASON_LABEL`, `wastageReasonLabel`, `isWastageReason`, `RESERVED_USAGE_CATEGORIES`, `isReservedUsageCategory`.

## Invariants
- Quantity is a decimal string computed in integer thousandths; no floats and no 1e-6 tolerance. Cost is rounded PER LINE so the journal entry equals the sum of subledger rows.
- Engines take `tx` and join the caller's transaction; refusals are returned as `{ ok: false, reason }`. A refusal found after a write must throw, so every precondition is checked before the first write.
- `consume` locks the item's open layers (`FOR UPDATE`) BEFORE planning; a shortfall is refused, never made negative. A reversal walks consumption newest-first at original cost.
- Consumption posts to COGS 5110/5120/..., wastage to 5300, count variance to 5400: three different accounts. A count has no zero-cost layers: counted-long cost falls back to latest layer, then price history, else the commit is refused naming the item.
- Receipt posts Dr inventory / Cr 2120; the invoice posts Dr 2120 / Cr 2110 and splits variance by open (inventory) versus consumed (5450) share. The 0.99 tolerance governs the finding, not the posting.
- A closed or locked fiscal month's stock is never touched (no override); `period-guard` supplies the sentence, the DB trigger remains the enforcement.
- Transfers stay within one store, post no journal entry, and move quantity only; frozen rooms are refused by DB trigger.
- Only posting a usage record moves stock; a drafted record does not. Void reverses stock, layers and entry.
- Actor-less cores (`usage-post-core`, `void-pull-usage-record`) must not be exported to apps. `usage.ts`, `consume.ts`, `count-sessions.ts` have no `authorize()`; the document layers call it first (`transfer_stock`, `void_transfer`, `commit_count`, `open_count_session`, `post_usage`, `void_usage_record`, `void_supplier_return`, `record_stock_movement`, `set_menu_depletion`, `view_financial_reports`).
- Typed quantities are parsed after `authorize()` via `parseRequiredQuantity`; a blank is refused, never invented as '0'.

## Side Effects
- Writes `stock_movements`, FIFO layers and consumptions, count sessions, transfer and usage-record rows through `@shareat/db` repos.
- Posts journal entries via `postEntry` and reverses via `reverseEntry` (`consumption-posting`, `receipt-posting`, `invoice-link`, `usage`, `supplier-returns`).
- Appends audit rows (`auditLogRepo`) in `usage-tolerance` and `usage-auto-post` (system actor).
- Reads the clock with `new Date()` in `transfers`, `supplier-returns`, `count-workflow`; `autoPostDueUsageDrafts` takes `now` as a parameter.
- `quantity`, `layers`, `transfer-rules`, `wastage-reasons`, `isWithinUsageTolerance`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
