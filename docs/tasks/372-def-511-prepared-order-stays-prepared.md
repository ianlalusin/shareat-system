# T-372: a prepared commissary order never goes back (DEF-511); internal freight posts at receipt (DEF-127)

**Status:** APPROVED 2026-09-30 (orchestrator, Ian's Q1/Q2). Written 2026-09-30 by the Opus planner at HEAD `3ed900f`.
**Lane:** commissary, one lane. **Model:** Sonnet (tester first, then builder, per slice).
**Migration:** YES, one hand-authored migration (ADR-012 §5). T-366 holds 0172 and T-368 takes the next index, so
use **0174** (after T-366's 0172 and T-368's 0173) unless the index is reassigned at build. It carries S2 and nothing else.
S1 to S5 are un-gated: Ian answered Q1 and Q2 on 2026-09-30. ⛔ **Part b of S6 (over-receipt) is gated on Q3.**
**Line numbers** were checked at `3ed900f`. None of the BUILDER paths is dirty at that HEAD.

## Goal
1. **DEF-511.** Once the commissary marks a branch order **ready** (Ian's word: *prepared*), it stays ready.
   It leaves `ready` only by being **dispatched** or **cancelled** (rejected or voided). The domain refuses the
   edit, and the database refuses to clear `ready_at`.
2. **DEF-127.** Outbound freight on an **internal** trade order (`trade_orders.delivery_fee + other_fees`) posts
   at receipt as a **haulage expense on the RECEIVING branch**. Ian's ruling (a), 2026-09-30.
3. **Open-order block.** Ian ruled that v1's rule stands: a branch stays blocked until its order is **received**
   or **cancelled**, and dispatch does not free it. v2 already enforces this, so this task adds **guard tests
   only**.

## Census (verified at source)

### DEF-511
- **The edits that un-prepare.**
  - `fulfilLine` accepts `ready` at `packages/domain/src/commissary/fulfilment.ts:141`. At `:159` it calls
    `tradeRepo.clearReady`.
  - `proposeLine` does the same at `:187` and `:245`.
  - `clearReady` is at `packages/db/src/repo/trade.ts:390-394`. It sets `ready_at` and `ready_by` to NULL.
  - The file header says the same thing as design, at `fulfilment.ts:19-20`: *"A fulfilment edit or a new
    proposal after it drops the order back to accepted"*.
- **`clearReady` callers.** Its only callers are `fulfilment.ts:159` and `:245`. Once both go, it is dead, so
  **delete it** (no dead exports).
- **The UI offers the edit.**
  - `apps/erp/src/app/commissary/orders/[id]/page.tsx:73` sets `packing = accepted || ready`.
  - That shows the propose panel at `:236` and the per-line fulfil form (`editPack`, `:461`, form at `:541`) at
    `ready`.
  - The helper text at `:315-317` promises *"Any change after it drops the order back here."*
- **There is no database rule.**
  - 0121's CHECK (`0121_t172_branch_order_workflow.sql:49-52`) checks shape only: ready implies accepted, and
    ready_at is null exactly when ready_by is null.
  - 0121's trigger guards submit and dispatch only.
  - Nothing stops `ready_at` going from set to NULL.
- **v1** allows edits only in `preparing`:
  - `ERP-rebuild/src/lib/actions/branch-order-fulfilment.actions.ts:155` (edit fulfilment);
  - `:644` (add item).
- **Other stage checks, audited.**
  - `decideProposedLine` (`packages/domain/src/commissary/orders.ts:557`) accepts `ready`, but after this task
    no pending line can exist at `ready`: `markReady` refuses pending lines (`fulfilment.ts:272-278`), and
    `proposeLine` will be refused. It **stays as is**, and S1's P5 leg pins that it cannot mutate a ready order.
  - `rejectOrder` accepts `ready` (`fulfilment.ts:108`). It **stays**, because it is the cancel path.
  - `voidTradeOrder` covers a ready branch order (status `confirmed`) through `authorizeEither`
    (`packages/domain/src/trade/index.ts:684-696`). It **stays**.
- **Neither void path touches `ready_at`.**
  - `markRejected` (`repo/trade.ts:~402-420`) sets status, reject and void columns only.
  - The S2 trigger therefore does not collide with the cancel paths. T3 proves it.
- **Existing tests that encode the retired behaviour.** These are tester edits (S1/S2 TESTER):
  - `packages/domain/tests/integration/branch-orders.test.ts:539-558` asserts *"any change after READY drops the
    order back to accepted"*. It is rewritten to the target.
  - `branch-orders.test.ts:499-503` sets `ready_at` by raw SQL and clears it again at `:503`. The S2 trigger
    would refuse `:503`.

### DEF-127
- **Where freight enters.**
  - `createTradeOrder` (`packages/domain/src/trade/index.ts:305-311`) adds both fees to `total_amount`. They are
    stored at `:348-349`.
  - The field doc (`:148-154`) says freight *"rides the posting, so it lands on the receiving store"*. Since
    T-165 that is false.
- **Where it should post, and does not.**
  - `receiveTradeOrder` (`trade/index.ts:791-942`) calls `confirmReceipt` (`packages/domain/src/commissary/transfer.ts:312-523`).
  - `ConfirmReceiptInput` (`:264-282`) has no fee field.
  - The receipt entry (`:474-511`) moves the goods only.
  - `trade.test.ts:1039-1076` pins the gap: *"never ₱19,000"*.
- **Census correction: only commissary-initiated internal orders carry freight.**
  - Branch orders (`saveBranchOrderDraft` → `lowStockRepo.createDraftOrder`) never set a fee, so it stays at
    the column default 0.
  - `refreshOrderTotal` (`repo/low-stock.ts:228-237`) sums lines only.
  - The fee path is the `/trade/orders/new` form (`apps/erp/src/app/trade/orders/NewOrderForm.tsx:232-236`),
    through `createTradeOrder`, to a customer whose treatment is `internal`.
- **External orders are unaffected.** Their freight reaches `4300` through `recordCharge`'s `totalAmount` at
  dispatch (register row, DEF-127).
- **There is no posting pattern.** `docs/POSTING-PATTERNS.md` (TOC, `:1-106`) has no haulage, freight or
  outbound-fee pattern. The commissary section (`:643-812`) covers dispatch, the historical periodic shape and
  discrepancies only.
- **COA.**
  - `6630 Vehicle and transportation`, expense/debit (`packages/db/seed/chart-of-accounts.ts:392`;
    COA-ALIGNMENT `:349`, "Vehicle Expense"). **This is the haulage account.**
  - `1250 Due from related store`, party required (`:148`).
  - `2150 Due to related store`, party required (`:228`).
  - There is no freight-specific account and no haulage contra account.
- **v1 treats both fees as one figure.**
  - At receipt, `fees = deliveryFee + otherFees` rides into what the branch owes the commissary
    (`ERP-rebuild/src/lib/actions/branch-order-receive.actions.ts:136-137`).
  - v2 therefore posts **both** fees, as one haulage figure (R6).
- **The trap is already named.** `docs/HANDOFF-INVENTORY-LANE.md:123-128` warns that the obvious shape can drive
  the commissary's expense **negative** when the haulage was its own driver's time. That is Q1.
- **There is no DB rule that fees are non-negative.**
  - `trade_orders` has finite CHECKs only (`packages/db/schema/trade.ts:171-172`).
  - Only the domain refuses a negative fee (`trade/index.ts:307`).
  - Once fees post, a negative one would post a reversed expense. S2 adds the CHECK.

### Open-order block
- The index is `trade_orders_one_open_per_branch_key` (`0070_t172_branch_orders.sql:41-43`). It covers
  `status IN ('draft','confirmed','dispatched')`.
- The domain check is `openOrderFor` (`packages/db/src/repo/low-stock.ts:133-151`), used by `saveBranchOrderDraft`
  (`orders.ts:380-386`) and the auto-order (`auto-order.ts:102-115`).
- The existing test 3 (`branch-orders.test.ts:386-400`) covers a **draft** only. The **dispatched** and
  **ready** blocks, and freeing on **receipt**, have no test.

## Rulings (planner)
- **R1. The rule lives in two layers, and the database layer is not optional** (bible §15.11; RULES §6.3 means
  §15.11).
  - The domain gives the sentence.
  - The trigger refuses the erase for every writer, including raw SQL, the ETL and a future repo helper.
- **R2. The domain refusal.**
  - In `fulfilLine` and `proposeLine`, the stage lists become `['accepted']`.
  - Before `refuseUnless`, an explicit branch `if (stage === 'ready') throw refuse(raw, READY_IS_FINAL_SENTENCE)`,
    where:
    - `raw` is `` `${verb}: order ${order.id} is ready — ready is final (DEF-511)` ``;
    - `export const READY_IS_FINAL_SENTENCE = 'This order is marked ready, so its packing list is final. It can now only be dispatched, or rejected so the branch can order again.'`
  - The sentence lives in `fulfilment.ts` and is exported for the tests.
  - Use `refuse` from `@shareat/db` (`packages/db/src/refusal.ts:52`). It is not a raw throw, so the T-343 ratchet
    for `packages/domain/src/commissary` stays at **48** (`tests/unit/t343-throw-ratchet.test.ts:80`).
  - ⛔ **The refusal comes after `authorize`**, as today. A non-holder still gets the authorization refusal, not
    this sentence.
- **R3. `clearReady` is deleted** from `repo/trade.ts`. Its doc comment (`:386-389`) goes with it.
  - The `fulfilment.ts` header lines `:19-20` are rewritten to: *"Ready is final (DEF-511, Ian 2026-09-30): after
    it the list cannot change; the order is dispatched or rejected."*
- **R4. The trigger.**
  - Name: `trade_orders_ready_is_final_trg`. It is `BEFORE UPDATE OF ready_at, ready_by ON trade_orders FOR EACH
    ROW`.
  - Condition: `WHEN (OLD.ready_at IS NOT NULL AND (NEW.ready_at IS DISTINCT FROM OLD.ready_at OR NEW.ready_by
    IS DISTINCT FROM OLD.ready_by))`.
  - It does `RAISE EXCEPTION 'order % is ready — ready is final and cannot be cleared or changed (DEF-511)', OLD.id`.
  - It judges only OLD and NEW, and refuses the erasure of history, so it is a **`history_guard`**:
    - `ALTER TABLE trade_orders ENABLE ALWAYS TRIGGER trade_orders_ready_is_final_trg` goes in the same
      migration;
    - it is registered in `packages/db/src/triggers/registry.ts` with `mode: 'always', kind: 'history_guard'`
      (bible §13 row 241, T-354 R1).
  - A null-to-set change (`markReady`) does not match the `WHEN` and is untouched.
- **R5. The fee CHECK** goes in the same migration:
  - `trade_orders_fees_non_negative_check CHECK (delivery_fee >= 0 AND other_fees >= 0)`;
  - ⛔ **Production precheck, read-only, before deploy:** run
    `select count(*) from trade_orders where delivery_fee < 0 or other_fees < 0` on production (`159.223.46.224`).
    Expect 0. If it is not 0, STOP and report; nothing is deployed.
    - The builder runs the same count on the lane DB and `shareat_dev`.
  - **The ETL mapping was checked, and there is none.** `packages/etl/src` has no reader or writer of
    `trade_orders` (grep for `trade_orders`/`tradeOrders` is empty at `3ed900f`), so no v1 fee value reaches this
    table through the ETL. The only writer is `createTradeOrder`, which already refuses a negative fee
    (`trade/index.ts:307`).
  - **So it is a plain `ADD CONSTRAINT`, not `NOT VALID` + `VALIDATE`.** The two-step form only buys a shorter
    lock on a large table with rows of unknown shape. This table is small, it has one writer, and the precheck
    proves 0 violators;
  - mirrored in `packages/db/schema/trade.ts` beside `:171-172`, with a `// NOTE: … migration NNNN` comment.
- **R5b (S6a). A second CHECK in the same migration:**
  - `trade_order_lines_received_quantity_non_negative_check CHECK (received_quantity IS NULL OR received_quantity >= 0)`.
  - It gets the same read-only production precheck: `select count(*) from trade_order_lines where received_quantity < 0`.
    Expect 0; if not, STOP.
  - It is mirrored in `packages/db/schema/trade.ts` beside `:301`.
  - The sibling `delivery_lines` already has this rule (`0066_t166_deliveries.sql:93`), and `trade_order_lines`
    never got it.
- **R6. Freight is ONE figure**, `delivery_fee + other_fees` (v1 `:136`), posted to `6630` on the branch.
  - A split of `other_fees` to `6900` was considered and declined: v1 never split them, and both are
    per-shipment charges from the commissary.
- **R7. The freight posting is its own entry, in the same transaction as the receipt.** It is not extra legs on
  the goods entry, for two reasons:
  - The goods entry is **absent** in two real cases: `confirmReceipt` returns `entryId: null` when nothing was
    accepted (`transfer.ts:452-458`), and `receiveTradeOrder` skips `confirmReceipt` entirely when every line is
    ledger-only (`trade/index.ts:895`). The truck still made the trip, so the freight is owed.
  - A separate idempotency key keeps the goods entry byte-identical. Existing goods-leg tests (`trade.test.ts`,
    `commissary-transfer.test.ts`) stay green, which is part of the proof.
- **R8. The primitive** is `postInternalFreight(tx, input): Promise<{ entryId: string } | null>`, in
  `commissary/transfer.ts`, next to `confirmReceipt`.
  - Input: `{ orgId, commissaryStoreId, branchStoreId, commissaryStoreCode, branchStoreCode, orderId, receivedOn,
    freight: Money, postedBy }`.
  - It returns `null` when `freight` is zero.
  - When `freight` is negative it does `throw internalFault(...)` (from `../shared/refusal`), **never**
    `throw new Error(`. That keeps the commissary raw-throw ratchet at ≤48. R5 makes the case unreachable, and
    the message says so.
  - It calls `postEntry` with:
    - `sourceType: 'trade_order_receipt'`, `sourceId: orderId`;
    - `idempotencyKey: \`trade_order:${orderId}:receipt-freight\``;
    - `memo: 'Branch confirmed receipt — outbound freight charged to the branch'`;
    - `entryDate: receivedOn`.
  - `receiveTradeOrder` calls it in the internal branch after the goods block (`:894-909`) and before
    `markReceived` (`:913`), with `freight = add(deliveryFee, otherFees)`. That runs **whether or not**
    `receiptLines` is empty.
  - `ReceiveTradeOrderResult` gains `freightEntryId: string | null`. The existing `entryId` keeps its meaning (the
    goods entry).
  - The field doc at `trade/index.ts:148-154` is corrected to name T-372.
- **R9. The legs, each store balanced on its own.** `F` is the freight, and `C` and `B` are the store codes.

  | # | Account | Store | Dr | Cr | Party |
  |---|---|---|---|---|---|
  | 1 | `6630` Vehicle and transportation | branch | F | | |
  | 2 | `2150` Due to related store | branch | | F | store `C` |
  | 3 | `1250` Due from related store | commissary | F | | store `B` |
  | 4 | `6630` Vehicle and transportation (**Ian, Q1 (a)**) | commissary | | F | |

  - **The debit side is Ian's ruling:** the receiving branch bears the haulage in its P&L.
  - **The credit side is who owed and paid the freight.**
    - The commissary ran the truck. Its real cost (fuel, driver) is already in its own books through its own
      expenses.
    - The branch now owes the commissary F on the same `2150`/`1250` reciprocal pair as the goods, so the due-to
      equals what v1's branch owed (goods received plus fees).
    - The commissary's P&L credit **recovers** that cost. Consolidated, legs 1 and 4 net to zero, and the company's
      haulage is only what it really spent.
    - That is the same elimination `5175` does for the goods margin (`transfer.ts:46-52`).
  - ⛔ **A franchise is out of scope.** For a franchise the credit would be revenue, not a recovery (bible row
    111; `POSTING-PATTERNS.md:645-652`). `postInternalFreight` is called only on the `internal` treatment branch,
    and T4 pins that.
- **R10. The posting pattern is documented before it is trusted.** S4 adds `commissary.receipt-freight` to
  `docs/POSTING-PATTERNS.md` (in the commissary section, after `commissary.discrepancy-charge`) and a matching
  fixture to `tests/worked-examples/fixtures.ts`.
  - The doc-parity test (`tests/unit/posting-patterns-doc.test.ts`) and `tests/integration/posting-patterns.test.ts`
    then prove it.
  - Regenerate the TOC with `npm run toc`.

## Slices (sequential; one lane)
| Slice | What | Gate |
|---|---|---|
| S1 | DEF-511 domain + UI: refuse at ready, delete `clearReady`, hide the edit forms | none |
| S2 | DEF-511 DB backstop + fee CHECK: the migration, schema NOTE, trigger registry | after S1 (T-legs need S1's domain refusal to write the positive controls) |
| S3 | DEF-127 posting: `postInternalFreight` + wiring | after S2 |
| S4 | DEF-127 posting pattern + fixture | after S3 and after T-366 commits |
| S5 | Open-order guard tests (no source change) | none; may run first |
| S6 | Receipt discrepancy hardening (Ian: "copy and harden" v1) | a: after S2 · b: ⛔ Q3 |

### S1: BUILDER
1. `packages/domain/src/commissary/fulfilment.ts`:
   - apply R2 in `fulfilLine` (`:140-141`) and `proposeLine` (`:186-187`);
   - delete `:158-159` and `:245`;
   - export `READY_IS_FINAL_SENTENCE`;
   - apply R3 to the header.
2. `packages/db/src/repo/trade.ts`: delete `clearReady` (`:386-394`).
3. `apps/erp/src/app/commissary/orders/[id]/page.tsx`:
   - the propose panel shows at `stage === 'accepted'` only: `:236` becomes `stage === 'accepted' && commissarySide`;
   - `editPack` (`:461`) becomes `stage === 'accepted' && commissarySide && !declined`;
   - the `:315-317` accepted-stage text becomes *"Ready means the list is final — after it the order can only be
     dispatched or rejected."*;
   - the `packing` panel keeps rendering at `ready` for Dispatch and Reject.
   - No other change. That includes the `:569` branch-side pending block, which is unreachable at `ready`.

**S1 BUILDER paths:** `packages/domain/src/commissary/fulfilment.ts`, `packages/db/src/repo/trade.ts`,
`apps/erp/src/app/commissary/orders/[id]/page.tsx`.

### S1: TESTER (disjoint)
- **New:** `packages/domain/tests/integration/t372-ready-is-final.test.ts`. It uses the `branch-orders.test.ts`
  fixture shape (`fixture()`, `accepted()`, `lines()`, `order()`).
- **Edit (existing):** `branch-orders.test.ts:539-558`.
  - Keep the substitution half, proposing at **accepted**.
  - Replace *"drops back to accepted"* with a pointer to t372.
  - Rename the `it`.

### S2: BUILDER
1. `packages/db/migrations/NNNN_t372_def511_ready_is_final.sql` (NNNN is the next free index at build):
   - R4: the function, the trigger, and `ENABLE ALWAYS`;
   - R5 and R5b: the two CHECKs, each a plain `ADD CONSTRAINT`, after the production prechecks;
   - a header naming T-372, DEF-511, DEF-127 R5 and the rulings.
2. `packages/db/migrations/meta/_journal.json`: the entry on the one-day grid (README step 5).
3. `packages/db/src/triggers/registry.ts`: add `trade_orders_ready_is_final_trg` (R4).
4. `packages/db/schema/trade.ts`: the CHECK (R5), plus a `// NOTE: trigger trade_orders_ready_is_final_trg
   hand-added in migration NNNN` comment beside `readyAt`.

**S2 BUILDER paths:** the new migration, `packages/db/migrations/meta/_journal.json`,
`packages/db/src/triggers/registry.ts`, `packages/db/schema/trade.ts`.

### S2: TESTER (disjoint)
- **New:** `packages/db/tests/integration/t372-ready-at-trigger.test.ts`.
- **Edit (existing):** `branch-orders.test.ts:499-503`.
  - Wrap the raw `ready_at` set and the refused dispatch in `sql.begin(async (t) => { … })` and assert that the
    `begin` rejects with `/awaiting the branch decision/`. The aborted transaction rolls `ready_at` back.
  - Delete `:503`.
  - Then assert `readyAt` is null.

### S3: BUILDER
1. `packages/domain/src/commissary/transfer.ts`: add `postInternalFreight` (R8, R9) and a header paragraph
   "Outbound freight (T-372/DEF-127)".
2. `packages/domain/src/trade/index.ts`: wire it into `receiveTradeOrder` (R8), extend `ReceiveTradeOrderResult`,
   and fix the `:148-154` doc.

**S3 BUILDER paths:** `packages/domain/src/commissary/transfer.ts`, `packages/domain/src/trade/index.ts`.

### S3: TESTER (disjoint)
- **New:** `packages/domain/tests/integration/t372-internal-freight.test.ts`. It uses the `trade.test.ts`
  fixture shape (`fixture`, `wholesaleItem`, `stock`, `mapSelf`, `ownStore`/`createCustomer` internal).
- **Edit (existing):** `trade.test.ts:1039-1076` is rewritten to the target, as the positive twin of F1, and its
  `it` is renamed without "⚠️ DEF-127: not yet posted".
  - Keep its two ⛔ assertions: the goods entry's `1250`/`2150` are 18000, and the rate stays 18000.
  - Change `legs.some(… 1000 …)` to scan the **goods** entry only.

### S4: BUILDER (after S3, and after T-366 commits)
- ⛔ T-366 also edits `docs/POSTING-PATTERNS.md` and runs `npm run toc`. **S4 starts only after T-366's commit
  lands.**
- `docs/POSTING-PATTERNS.md` gets the new pattern (R10).
- The TOC is regenerated **last**, as the final step of S4.
- `tests/worked-examples/fixtures.ts` gets the matching fixture. It is the doc's source of truth and belongs to
  the builder, not the tester: the doc and the fixture must be changed together.

**S4 TESTER:** none new. `tests/unit/posting-patterns-doc.test.ts` and `tests/integration/posting-patterns.test.ts`
are the proof, and they run green.

### S5: TESTER only
- **New:** `packages/domain/tests/integration/t372-open-order-block.test.ts`.
- **BUILDER:** none. If any leg is red, STOP and report it: a red leg here is a new defect, not a fix.

## S6: receipt discrepancy (Ian, 2026-09-30: "copy and harden" v1)

### v1, studied at source (RULES §1.2d step 1)
- Source: `ERP-rebuild/src/lib/actions/branch-order-receive.actions.ts`.
- `:106-128`: per line, the branch supplies `receivedQuantity`, which defaults to fulfilled and is clamped at 0
  (`:121`). v1 stamps `hasDiscrepancy = |received − fulfilled| > 0.005`, **in both directions**, plus an optional
  `discrepancyNote`.
- `:131-144`: the order-level `discrepancyTotalAmount = dispatched total − received total`.
- `:380-381`: a short line's reason is `count_correction` and its note is carried.
- Resolution happens later, by manager or admin (`branch-order-fulfilment.actions.ts:~390-445`):
  - `audit`, write-off as loss, or `charge` to a named staffer (the charge needs a grant);
  - only after `status === 'received'`.
- v1 **books both sides at the received quantity** (`:60-70`). A discrepancy is "a pure audit flag"; neither
  side's books are adjusted for the gap.

### Its GOAL (step 2)
- Every line records what the branch actually counted against what the commissary says it sent.
- Any variance beyond scale noise is flagged, with who received it, when, and why.
- A manager decides what the gap was, so a transit loss is never silently absorbed by either store's books.

### What v2 already has (step 3). It beats v1 on SHORTAGES, and needs no change there.
- **Per-line received quantity** is recorded: `trade/index.ts:874-875` (override, else dispatched) and `:892`
  (`setLineReceivedQuantity`). It is also written to the branch `deliveries` row with `orderedQuantity`,
  `receivedQuantity` and `shortageReason` (`transfer.ts:433-449`).
- **Flag at receipt, same transaction:** a shortfall above `RECEIPT_DISCREPANCY_TOLERANCE` (0.005, v1's figure,
  `transfer.ts:89`, check at `:341-344`) raises a `trade_discrepancies` row (`:405-430`). There is no separate
  "raise" step that could fail.
- **Books are honest where v1's were not:** only what arrived posts. The short value stays in `1340` **at cost**
  until somebody decides (`transfer.ts:452-458`, `:519-522`).
- **Resolution:** `resolveDiscrepancy`/`deferDiscrepancy` (`commissary/discrepancy.ts:57`, `:149`) with
  `audit | loss | charge | late_receipt`.
  - Documented postings: `commissary.discrepancy-loss` (Dr 5300 / Cr 1340) and `commissary.discrepancy-charge`
    (Dr 1230 employee / Cr 1340), plus the two that post nothing (`POSTING-PATTERNS.md:769-812`).
  - The row is locked `FOR UPDATE`, and a terminality trigger backs it.
- **It blocks** day-open until decided (`packages/db/src/repo/findings.ts:1620-1623`). The UI is
  `apps/erp/src/app/commissary/discrepancies/`.
- **Who and when:** `trade_discrepancies.created_at`, `resolved_by`/`resolved_at` and `note`
  (`packages/db/schema/trade-discrepancies.ts`), and the order's `received_by` (`markReceived`).

### Gaps where v2 is WEAKER than v1 (verified), and the slice
- **G1: a negative received quantity is accepted, and it corrupts the dispute value.**
  - `quantity()` is signed, so `receiveTradeOrder` passes it through (`:874-875`).
  - `trade_order_lines.received_quantity` has only a finite CHECK (`0155…sql:420-421`).
  - In `confirmReceipt` a negative `r` makes `shortfall > dispatched` (`:341`), and `proportionOfCost` goes
    negative (`:99-108`), so the discrepancy `value` exceeds the line's `dispatchCost` (`:425-428`).
  - A later `loss`/`charge` then relieves `1340` by **more than the dispatch put in**, with a trial balance that
    still ties.
  - v1 clamps at 0.
- **G2: an over-receipt is neither flagged nor booked correctly.**
  - v2 flags shortfalls only (`:341-344`).
  - For `received > dispatched`, `proportionOfCost` caps cost at `dispatchCost` (`:104`) while `value =
    lineCost(received, rate)` does not. So:
    - the branch gains stock and `2150` for units the commissary never relieved;
    - the excess value lands in `5175` as fake margin;
    - no discrepancy row is raised.
  - v1 at least flagged it (`|…|`).

**S6a (un-gated; after S2).**
- **BUILDER**, `packages/domain/src/trade/index.ts`: `receiveTradeOrder` refuses a negative received quantity
  before any write.
  - `throw refuse('receiveTradeOrder: line <id> received quantity <q> is negative', '<item name> — a received quantity cannot be negative. Enter 0 if none arrived.')`.
  - The DB CHECK is R5b, in S2's migration and S2's BUILDER paths.
- **TESTER:** new `packages/domain/tests/integration/t372-receipt-discrepancy.test.ts`.

| Id | Target | Red today | Kills mutant |
|---|---|---|---|
| D1 | receive with `receivedQuantity:'-5'` on a 20-unit line: rejects with that exact sentence; nothing written (no journal entry, no `trade_discrepancies` row, `received_quantity` still null, status `dispatched`) | resolves; a discrepancy row with `quantity 25.000` and `value > dispatch_cost` | the refusal removed |
| D2 | raw `update trade_order_lines set received_quantity = -1` rejects `/received_quantity_non_negative/` | succeeds | CHECK absent |
| D3 | **positive.** `receivedQuantity:'0'`: resolves; one discrepancy row with `quantity` = dispatched and `value` = `dispatch_cost` exactly | green | refusal written as `<= 0` |
| D4 | **positive (guard on T-174).** 18 of 20: row `quantity 2.000`, `value = dispatch_cost − proportionOfCost(dispatch_cost, 18, 20)`; the goods entry books 18 | green | — |

**S6b (⛔ Q3; spec amended after the answer).**
- Under Q3 (i) the build needs:
  - an `over` direction on `trade_discrepancies`, i.e. a `direction` column and a CHECK, in the **next** migration
    after S2's, plus `recount_dispatch`/`return` dispositions;
  - `confirmReceipt` capping the booked quantity at dispatched and raising the `over` row.
- Legs, to be finalised after Q3:
  - receive 22 of 20: branch stock +20; `2150`/`1250` at 20 × rate; an `over` row with `quantity 2.000`;
    `5175` only the real margin on 20;
  - positive control: 20.004 of 20 (inside tolerance) books 20.004 as today, and no row is raised.
- Paths: `commissary/transfer.ts`, `commissary/discrepancy.ts`, `packages/db/schema/trade-discrepancies.ts`,
  the migration, and `POSTING-PATTERNS.md` (the "posts nothing" section gains `over`).

## Contract
- `fulfilLine` / `proposeLine` at `ready` refuse with `READY_IS_FINAL_SENTENCE` and write nothing. At
  `accepted` they are unchanged.
- `trade_orders.ready_at` and `ready_by` are write-once. No writer may clear or change them. Cancel paths and
  dispatch never touch them.
- `trade_orders.delivery_fee` and `other_fees` are `>= 0` in the database.
- Receiving an **internal** trade order with `F = delivery_fee + other_fees > 0` posts exactly one extra entry,
  with the R9 legs, keyed `trade_order:<id>:receipt-freight`, dated `receivedOn`, in the receipt's transaction.
  - With `F = 0` there is no extra entry.
  - An **external** order never gets one.
- `receiveTradeOrder` returns `freightEntryId`.
- ⚠️ **No journal reader may assume one receipt entry per order.** The freight entry shares
  `source_type = 'trade_order_receipt'` and `source_id = <order id>` with the goods entry.
  - A reader tells the two apart by `idempotency_key` (`…:receipt` against `…:receipt-freight`).
  - The only reader of that pair today is `packages/db/src/repo/findings.ts:1458`, and it joins
    `stock_movements`, not `journal_entries`, so it is unaffected. The builder re-greps for readers at build.

## Invariants
- **I1.** Ready is final (Ian, 2026-09-30; record as a bible §13 row at wrap-up). There are two layers, §15.11.
- **I2.** Every journal entry this task posts balances **per store**, not only in total. Each store's side is a
  Dr/Cr pair on its own `store_id`. No trigger enforces per-store balance, so F2 asserts it.
- **I3.** The reciprocal pair is keyed by store **code** as party (DEF-040, `transfer.ts:268`).
- **I4.** A history_guard trigger fires `ALWAYS` (bible §13 row 241).
- **I5.** Internal only. A franchise or external counterparty never takes this shape (bible row 111).
- **I6.** No money in floats (bible §2.5). `F` is computed with `@shareat/core/money` `add`, never `Number()`.

## Tests
All tests are integration tests against real Postgres, on **the lane's own `_test` DB** (RULES §2). Record the raw
red for each red leg. The authorization baseline is never hard-coded.

### S1: t372-ready-is-final
| Id | Setup / call | Target | Red today | Kills mutant |
|---|---|---|---|---|
| R1 | ready order; `fulfilLine(comStaff, {line, quantity:'5'})` | rejects; `userMessage === READY_IS_FINAL_SENTENCE`; `ready_at`/`ready_by` byte-equal to before; the line's `fulfilled_quantity`, `rate`, `line_total` and the order's `total_amount` unchanged | resolves; stage `accepted`; `ready_at` null | `'ready'` put back in `fulfilLine`'s allowed list |
| R2 | ready order; `proposeLine(comStaff, {itemId: sauce, quantity:'5'})` | rejects with the same sentence; the line count is unchanged; no new thread message; `ready_at` unchanged | resolves; new pending line | `'ready'` put back in `proposeLine`'s list |
| R3 | ready order; `proposeLine` with `replacesLineId` | rejects; the replaced line's `fulfilled_quantity` is **not** zeroed | zeroes it | the replace-zeroing moved above the stage check |
| R4 | ready order; `fulfilLine` by `outsider` | rejects with the outsider's authorization baseline, **not** the sentence | same (guard) | the stage check moved above `authorize` |
| P1 | **positive.** accepted order; `fulfilLine` quantity `'5'` | resolves; line updated; total refreshed; stage still `accepted` | green | the refusal widened to `accepted` |
| P2 | **positive.** accepted order; `proposeLine` | resolves; pending line | green | same |
| P3 | **positive.** ready order; `rejectOrder(comStaff, {reason})` | status `void`, `rejected_at` set, `ready_at` unchanged | green | the cancel path blocked |
| P4 | **positive.** ready order; `voidTradeOrder(branchStaff, {reason})` | status `void` | green | same |
| P5 | **positive.** ready order; `dispatchBranchOrder(manager)` | status `dispatched`; a dispatch entry exists | green | dispatch blocked |
| P6 | `tradeRepo` has no `clearReady` export (`expect('clearReady' in tradeRepo).toBe(false)`) | pass | red (the export exists) | `clearReady` restored |

### S2: t372-ready-at-trigger (raw SQL, as the migration role)
| Id | Call | Target | Red today | Kills mutant |
|---|---|---|---|---|
| T1 | ready order; `update trade_orders set ready_at=null, ready_by=null` | rejects `/ready is final/` | succeeds | trigger absent |
| T2 | ready order; `update … set ready_at = ready_at + interval '1 day'` | rejects `/ready is final/` | succeeds | `WHEN` tests only `NEW.ready_at IS NULL` |
| T3 | ready order; `update … set ready_by = <other person>` | rejects | succeeds | `ready_by` left out of `UPDATE OF` / `WHEN` |
| T4 | ready order, inside `sql.begin`: `set local session_replication_role = 'replica'`; T1's update | rejects | succeeds | `ENABLE ALWAYS` omitted |
| T5 | **positive.** accepted order; `update … set ready_at=now(), ready_by=<p>` | succeeds (null to set) | green | trigger fires on null to set |
| T6 | **positive.** ready order; `update … set notes='x'`; and `status='void', voided_at=now(), voided_by=<p>, void_reason='x'` | succeeds | green | `UPDATE OF` dropped (fires on any column) |
| T7 | `update trade_orders set delivery_fee = -1` on any order; the same for `other_fees` | rejects `/trade_orders_fees_non_negative_check/` | succeeds | the CHECK absent or one column left out |
| T8 | **positive.** `delivery_fee = 0` and `= 250.00` | succeed | green | CHECK `> 0` |

The registry guard (`t354-immutability-triggers-always.test.ts`) must stay green. That proves R4's
classification.

### S3: t372-internal-freight
- Fixture: a commissary C and a branch B with codes; an internal customer for B; a Prepped item stocked at C and
  mapped.
- The order is `createTradeOrder` qty 1 @ 18000, `deliveryFee:'1000'`, `otherFees:'200'`. It is dispatched, then
  received on `2026-01-15`.
- **L(e)** means the entry's legs as `(code, store, debit, credit, party_type, party_id)`.

| Id | Target | Red today | Kills mutant |
|---|---|---|---|
| F1 | exactly one entry with `idempotency_key = 'trade_order:<id>:receipt-freight'`, `source_type='trade_order_receipt'`, `source_id=<id>`, `entry_date='2026-01-15'`; L(e) is exactly the four R9 legs at **1200.00** (Ian's Q1 (a): leg 4 = `6630`/C credit 1200.00), parties `store`/C on leg 2 and `store`/B on leg 3, and no other legs | no such entry | freight to `6900`; `delivery_fee` only (1000); party omitted |
| F2 | per store `sum(debit) = sum(credit)` for that entry: B 1200 = 1200, C 1200 = 1200 | (no entry) | leg 2 posted on C's store (balanced in total, not per store) |
| F3 | the goods entry (`received.entryId`) is unchanged: `1250` Dr 18000, `2150` Cr 18000, no leg of 1000 / 200 / 1200 | green (guard) | freight folded into the goods entry |
| F4 | `received.freightEntryId` equals F1's id; `received.entryId` differs | property absent | not returned |
| F5 | **positive / negative control.** Same order with no fees: no `…:receipt-freight` entry, `freightEntryId === null`, and the journal count is +1 at receipt (as `trade.test.ts:817-830`) | green | a zero-value freight entry posted |
| F6 | **negative control.** An EXTERNAL order with `deliveryFee:'1000'`, dispatched and received: no freight entry | green | the call placed before the internal/external branch |
| F7 (Ian, Q2) | every line received short to zero (`receivedQuantity:'0'`): the goods `entryId === null`, **and F1's entry still posts** | no entry | the call placed inside `if (receiptLines.length > 0)` or gated on `confirmed.entryId` |
| F8 | the branch's `6630` balance for the period = +1200; consolidated (both stores) `6630` from this entry = 0 | no entry | leg 4 at another account |
| F9 | `postInternalFreight` called directly with `freight = -1.00` throws, and nothing posts | n/a (new) | the negative guard removed |


### S5: t372-open-order-block (guards: green today, and they must stay green)
| Id | Target | Kills mutant |
|---|---|---|
| O1 | branch order **dispatched**: `saveBranchOrderDraft` for the same pair rejects `/already has an open order.*dispatched/`; a raw insert rejects `/trade_orders_one_open_per_branch_key/` | `'dispatched'` dropped from `openOrderFor` or the index |
| O2 | the order **ready** (status `confirmed`): same refusal naming `confirmed` | `'confirmed'` dropped |
| O3 | **positive.** After `receiveTradeOrder`, a new draft succeeds | `received` counted as open |
| O4 | **positive.** A ready order `rejectOrder`ed: a new draft succeeds | `void` counted as open |
| O5 | auto-order (`ensureAutoOrderLines`) with a dispatched open order: returns `created:false`, note `/dispatched, not a draft/`, and no second order row | the auto-order creating a second order |

## Smoketest (§9.4, `docs/SMOKETEST.md`, http://localhost:9008, smoke DB `shareat_test_setup`)
⚠️ Fiscal periods Jan 2026 to Jan 2027 are **CLOSED** there. Every order date and received date is **≥
2027-02-01**. Dispatch posts on the order date (`trade/index.ts:507`).

1. **DEF-511.** As the branch: order date 2027-02-10, submit.
   - As the commissary: accept, fulfil a line, mark ready.
   - Screenshot: the ready order shows **no** propose panel and **no** per-line fulfil form, but does show
     Dispatch and Reject.
   - Reject a second ready order: it goes void.
2. **DEF-127 (after S3).** `/trade/orders/new`, as the commissary, to the internal branch customer:
   - order date 2027-02-10, one line, delivery fee 1000, other 200;
   - confirm, dispatch, then receive with received date 2027-02-11.
   - `/reports/journal-lines`, filtered to that date: screenshot the four freight legs (B `6630` Dr 1200, B
     `2150` Cr 1200, C `1250` Dr 1200, C `6630` Cr 1200).
   - `/reports/income-statement` for B, February 2027: `6630` shows 1200.

## Out of scope
- A reverse transfer after receipt (still refused, T-165).
- Freight on a **franchise** order (bible row 111, ADR-008 §4).
- Inbound (supplier) freight.
- Splitting `other_fees` (R6).
- Letting the commissary set freight on a **branch** order (no UI sets it today; that is a feature, not this
  defect).
- DEF-302's closed-period refusals in `confirmReceipt` (T-368/T-369).
- Recording the rulings as bible rows (the orchestrator, at wrap-up).

## Done when
- S1 to S5 are green, and each red leg's raw red is recorded.
- `rg clearReady packages apps` returns nothing.
- The T-343 ratchet is unchanged (commissary 48, trade 52).
- The t354 registry guard, `branch-orders.test.ts`, `trade.test.ts`, `commissary-transfer.test.ts` and the
  posting-patterns doc and integration tests are green.
- The migration is proved on a scratch DB (README step 7).
- Typecheck is clean, and the full integration suite passes before any push (RULES §2).
- The smoketest screenshots are attached.
- S6a's D1 to D4 are green.
- DEF-511 and DEF-127 are marked FIXED in the register, citing T-372.
- The orchestrator logs G1 and G2 as new section-E DEFs, cites T-372 S6, and marks G1 fixed by S6a.

## Ian's rulings (2026-09-30), recorded here; the orchestrator adds them as bible §13 rows at wrap-up
- **Q1 → (a).** The commissary credits its own `6630`, so leg 4 of R9 is `6630` at the commissary.
  - Consolidated, the internal charge nets to zero.
  - ⚠️ Accepted consequence: the commissary's `6630` can read negative when its real trucking cost sits in wages
    (`6100`). That is visible, and not a defect.
  - No new account.
- **Q2 → YES.** The freight posts even when nothing arrives (every line short to zero, or all ledger-only),
  because the truck made the trip. F7 pins this.
- **"v1 has a way of recording how much was received and flagging the discrepancy — copy and harden it."** This
  becomes S6.

## Questions only Ian can answer
- **Q3 (gates S6b). When the branch receives MORE than was dispatched, what happens?**
  - **(i) Recommended: book up to what was dispatched, and flag the excess.** The excess becomes an `over`
    discrepancy row that posts nothing. The commissary manager then resolves it:
    - `recount_dispatch`: the commissary finds its dispatch count was wrong and posts a supplementary dispatch and
      receipt for the excess, using the existing `dispatchOrder`/`confirmReceipt` legs;
    - `return`: the branch sends it back, using the existing `customer.return-internal` pattern
      (`POSTING-PATTERNS.md:589-608`).
    - No new posting pattern is needed. ⚠️ Until it is resolved, the excess is physically at the branch but on
      nobody's books, which is honest and blocks day-open like a shortage does.
  - **(ii) Refuse the receipt** above the dispatched quantity plus the 0.005 tolerance, with a sentence telling
    the branch to record what was dispatched and message the commissary. It is simpler, but the physical fact of
    the excess is lost, which is weaker than v1.
  - (iii) Post the excess as a normal transfer. **Not recommended:** the commissary's stock and `1340` were never
    relieved for it, so this needs a new posting (commissary FIFO relief at receipt) that is not in
    `POSTING-PATTERNS.md`.

## Amendment A1 — Ian's Q3 (2026-09-30, orchestrator)
**Q3 → (i).** A branch that receives MORE than was dispatched books only what was sent; the excess is an "over"
discrepancy that blocks day-open until resolved — the commissary recounts and sends a top-up dispatch, or the branch
returns the excess — both reusing existing postings. S6b is un-gated. Its direction column rides S2's migration if
S6b is built in the same cycle, else the next free index at build. DEF-513.
