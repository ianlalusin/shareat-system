# Commissary
## Overview
Owns the commissary-to-branch supply flow: the commissary catalogue (links, offerings, item map), the branch's order, the commissary's fulfilment, dispatch, receipt posting, and resolution of what went missing or arrived extra. Orders are `trade_orders`; the stages are derived from the row, not stored. There is no `index.ts`; callers import each file directly.

## Interface
- `catalogue.ts`: `upsertCommissaryLink`, `upsertOffering`, `upsertMap`, `removeMap`, `parseFourDecimalCost`, `LinkStatus`, `UpsertCommissaryLinkInput`/`Result`, `UpsertOfferingInput`, `UpsertMapInput`
- `orders.ts` (branch side): `saveBranchOrderDraft`, `addBranchOrderLine`, `updateBranchOrderLine`, `removeBranchOrderLine`, `submitOrder`, `decideProposedLine`, `orderableCatalogue`, `listAvailableCommissaries`, `branchOrderStage`, `BranchOrderStage`, `BRANCH_ORDER_STAGE_LABEL`, `OPEN_STAGES`, `READY_IS_FINAL_SENTENCE`, `refuseIfReady`, `loadBranchOrder`, `parseQuantity`, `normaliseRate`, `resolveBranchRate`, `noteOnThread`, `CatalogueLine`, `ResolvedRate`, `BranchLineDraft`, `SaveBranchOrderDraftInput`
- `fulfilment.ts` (commissary side): `acceptOrder`, `rejectOrder`, `fulfilLine`, `proposeLine`, `markReady`, `dispatchBranchOrder`, `FulfilLineInput`, `ProposeLineInput`
- `transfer.ts`: `dispatchOrder`, `confirmReceipt`, `postInternalFreight`, `proportionOfCost`, `costOfQuantity`, `bookedReceiptQuantity`, `IN_TRANSIT_ACCOUNT`, `DUE_FROM_ACCOUNT`, `DUE_TO_ACCOUNT`, `TRANSFER_OUT_ACCOUNT`, `HAULAGE_ACCOUNT`, `RECEIPT_DISCREPANCY_TOLERANCE`, `DispatchLineInput`, `DispatchInput`, `ReceiptLineInput`, `ConfirmReceiptInput`/`Result`, `PostInternalFreightInput`
- `discrepancy.ts`: `resolveDiscrepancy`, `deferDiscrepancy`, `LOSS_ACCOUNT`, `STAFF_CHARGE_ACCOUNT`, `Disposition`, `ResolveDiscrepancyInput`
- `auto-order.ts`: `ensureAutoOrderLines`, `replenishAfterUsage`, `suggestFor`, `AutoOrderInput`, `AutoOrderReport`
- `messages.ts`: `postOrderMessage`, `listOrderMessages`, `MAX_MESSAGE_LENGTH`, `PostMessageInput`
- `outcome.ts`: `Outcome<T>` (the one shared result type)

## Invariants
- Everything posts at CONFIRM RECEIPT, keyed to what the branch actually received, never to what was fulfilled or dispatched. Dispatch: Dr 1340 / Cr inventory at cost. Receipt: 1340 is relieved at COST; the margin goes to 5175; the branch books Cr 2150 and the commissary Dr 1250.
- 1340 is a cost account. Crediting it at the transfer rate would leave it permanently negative by the margin while the trial balance still ties.
- Outbound freight posts as its own entry (`postInternalFreight`, key `trade_order:<id>:receipt-freight`), never as extra legs on the goods entry; the receiving branch bears the haulage (6630).
- Branch-side functions in `orders.ts` authorize `place_branch_order` against the requesting branch; `fulfilment.ts` authorizes `fulfil_branch_order` (or `dispatch_branch_order`) against the commissary. This is how invariant 10 holds.
- `submitOrder` captures `expense_category_id` and `is_ledger_only` from the item map onto each line and refuses if a line resolves to neither a branch item nor a ledger-only decision; the receipt reads that copy.
- Discrepancies belong to the commissary (invariant 11). Dispositions: `audit` waits and still blocks (row stays open); `loss` Dr 5300 / Cr 1340; `charge` Dr 1230 / Cr 1340; `late_receipt`, `extra_dispatch`, `return` as documented in `discrepancy.ts`. The direction gate runs before any posting branch.
- Order messages are append-only (enforced by a database trigger, not this module).
- `ensureAutoOrderLines` runs after the usage transaction commits and returns a report instead of throwing; a failure must never fail the usage post.
- `transfer.ts`, `discrepancy.ts`, `auto-order.ts` return `Outcome` (`ok: false` with `reason`) rather than throwing for business refusals.

## Side Effects
- DB writes via `tradeRepo`, `commissaryRepo`, `tradeDiscrepanciesRepo`, `stockLayersRepo`, `stockLedgerRepo`, `deliveriesRepo`, `moneyTransfersRepo` and others.
- Ledger posting: `transfer.ts` and `discrepancy.ts` call `postEntry`; stock is relieved through `consume`.
- `transfer.ts`, `discrepancy.ts` and `auto-order.ts` take a caller-owned `tx` (no authorize in them; callers authorize). `catalogue.ts`, `orders.ts`, `fulfilment.ts` call `authorize()` and open their own `transaction` when `tx` is null. `auto-order.ts` also opens `withOrgPrincipal`.
- Clock reads (`new Date`) in `transfer.ts` and `discrepancy.ts`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
