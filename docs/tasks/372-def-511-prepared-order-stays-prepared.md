# T-372: a prepared commissary order never goes back (DEF-511); internal freight posts at receipt (DEF-127)

**Status:** **S1 DONE 2026-10-01 (domain refusal at ready + UI; audited; screen-tested); S2 DONE 2026-10-01 (migration 0175; R5 dropped — already in 0056); S3 DONE 2026-10-01 (DEF-127 internal freight at receipt; screen-tested); S5 DONE 2026-10-03 (guard tests, 10d84c5); S6 DONE 2026-10-03 (DEF-512, 513; migration 0179; full suite 4645/4645); S4 (posting pattern) next** — APPROVED 2026-09-30 (orchestrator, Ian's Q1/Q2). Written 2026-09-30 by the Opus planner at HEAD `3ed900f`.
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
- **The trap is already named.** `docs/archive/HANDOFF-INVENTORY-LANE.md:123-128` warns that the obvious shape can drive
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
   - **Erratum (orchestrator, 2026-10-01, builder QUESTION):** `:236` guards ONE section holding both the propose form (`:238-296`) and the Mark-ready/Dispatch/Reject controls (`:297-320`). Split it: the propose form moves under `stage === 'accepted' && commissarySide`; the controls keep `packing && commissarySide`. Bullet 4 is the intent.

**S1 BUILDER paths:** `packages/domain/src/commissary/fulfilment.ts`, `packages/db/src/repo/trade.ts`,
`apps/erp/src/app/commissary/orders/[id]/page.tsx`.

### S1 audit (auditor, read-only, 2026-10-01) — triage
Matches R2/R3 and the :241 erratum. Findings: (1) `decideProposedLine` (`commissary/orders.ts:557`) still admits
`ready` — dead only because `markReady` refuses while a proposal is pending → TESTER red R5 (state built by SQL),
BUILDER adds `refuseIfReady` there (scope widened to `orders.ts` by the orchestrator). (2) `refusal()` helper must
assert the raw `(DEF-511)` diagnostic → TESTER. (3) `clearReady`-absent leg needs a positive control → TESTER.
(4) the split left the controls' `border-t` as the first child of its new panel (`page.tsx:299-301`) → BUILDER,
tester screenshots before/after. (5) UI helper text vs `READY_IS_FINAL_SENTENCE` — **dismissed**: the UI sentence is
spec-mandated copy for a different reader (the commissary before marking ready), not the refusal; tying them would
make either wording change the other.

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

- **Erratum (orchestrator, 2026-10-01, tester RED):** **drop R5 from the S2 migration.** `trade_orders_fees_non_negative_check` already exists, byte-identical, from `0056_t151_landed_cost_and_branch_price.sql:32-33` (verified in migration history and live via `pg_get_constraintdef`); `ADD CONSTRAINT` would fail 42710 and abort the migration. R5b is genuinely new and stays. T7/T8 remain as standing proof of the 0056 constraint, not as reds. Migration index for S2 = **0175**.

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

- **S4 note (orchestrator, 2026-10-01, auditor):** also re-read every existing commissary pattern in POSTING-PATTERNS that may still say the fee rides the goods posting (true until T-165, false since) — fix it in the same edit, the `remittance.overage` trap.

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


### S6 amendment (2026-10-01, planner)
Verified at HEAD `8a3f35c` after the tester's findings. **This subsection supersedes S6a's D1 "Red today" and all of
S6b above** (including its "20.004 books 20.004 as today" control, which was wrong: it is refused today).

**1. D1's "red today" was stale. The target stands.**
- 0175 already carries `trade_order_lines_received_quantity_non_negative_check`, and `receiveTradeOrder` writes
  `setLineReceivedQuantity` (`trade/index.ts:919`) before `confirmReceipt`. So today `-5` rejects with the **raw**
  CHECK name, not a sentence.
- D1 red today: rejects `/trade_order_lines_received_quantity_non_negative_check/`, and `userMessage` is not
  the sentence. D1's target is unchanged: the exact S6a sentence, and nothing written. D2 is a **guard** (green today).
- BUILDER: the refusal goes in the line loop right after `const override = …` (`:900`), before `receiptLines.push`
  and before `setLineReceivedQuantity`. Use `refuse` from `@shareat/db`, so the trade raw-throw ratchet stays at 52.

**2. The over-receipt refusal is the T-166 SUPPLIER trigger, hit by accident. It is KEPT, unchanged, as a backstop.**
- What it is: `delivery_lines_shortage_explained()` (`0066_t166_deliveries.sql:115-141`, trigger `:144`; registry
  `triggers/registry.ts:343`, origin/validator). It raises `line % received over (% of %) without an over-receipt
  approval` when `received_quantity > ordered_quantity AND NOT over_receipt_allowed`.
  - The approval mechanism is `delivery_lines.over_receipt_allowed` (schema `deliveries.ts:168`).
  - That flag is set only by `receiveDelivery` (`deliveries/documents.ts:237`, `:338`) after
    `authorize(…, 'allow_over_receipt')`, which is manager or above (`capabilities.ts:822`).
  - The UI is one checkbox in `apps/erp/src/app/inventory/deliveries/actions.ts:195`, and the sentence is at `:88-89`.
  - It is a **supplier** control. Commissary receipts only reach it because `confirmReceipt` writes the branch's
    `deliveries` row (`transfer.ts:471-490`) with `receivedQuantity` = the count and the flag at its default, false.
- **There is NO tolerance in the trigger.** It is an exact `numeric >`, so 20.004 of 20.000 is refused today.
- **The decision:** under Q3 (i), the domain caps first, so the trigger never sees an over line from a commissary
  receipt.
  - The branch `deliveries` row records the **booked** quantity, `min(counted, dispatched)`.
  - The counted excess lives on the `over` row in `trade_discrepancies`, which is the surface where a manager
    resolves it.
  - ⛔ Do **not** set `over_receipt_allowed = true` from code. That flag means "a manager approved it under
    `allow_over_receipt`", and setting it silently would counterfeit that approval.
  - The trigger and the supplier path are untouched, so there is **no migration change to `delivery_lines`**.
  - If the cap is ever removed, the trigger refuses the receipt, and X1 sees that.
- **Tolerance for the `over` row:** v1's `RECEIPT_DISCREPANCY_TOLERANCE` = 0.005 (`transfer.ts:124`), strict `>`,
  which mirrors the shortage check (`:377`).
  - 20.004 of 20 is inside tolerance. It books **20.000** (capped, not 20.004) and raises no row.
  - 20.005 also raises no row; 20.006 raises an `over` row of 0.006.
  - In every over case the booked quantity is the dispatched quantity. "Books only what was sent" has no
    tolerance exception: a booked quantity above dispatched would relieve `1340` and `5175` against goods
    the commissary never released.

**3. The shapes.**
- **The cap is in one place.** Add `export function bookedReceiptQuantity(dispatched, counted): Quantity`
  (= `min`) in `commissary/transfer.ts`.
  - `confirmReceipt` keeps `ReceiptLineInput.receivedQuantity` meaning **what the branch counted**. It uses
    `booked` for the movement, layer, `value`, `cost`, the `deliveries` line and its `shortage_reason` test, and
    `counted` only for the two discrepancy tests.
  - `receiveTradeOrder` writes `setLineReceivedQuantity(line.id, bookedReceiptQuantity(dispatchedQuantity,
    receivedQuantity))`.
  - ⚠️ `trade_order_lines.received_quantity` must be the **booked** figure. Three readers treat it as what entered
    the branch's books:
    - `commissary-kpis.ts:360`, `goods_received = Σ received × rate`;
    - `returns.ts:88-93`, where the returnable quantity is capped at it;
    - `findings.ts:1521`, `signed_for`.
  - Counted = booked + the `over` row's `quantity`.
- **The `over` row.** It is raised in `confirmReceipt`, in the same transaction and the same loop as shortfalls,
  when `counted − dispatched > 0.005`. Its fields:
  - `direction 'over'`;
  - `quantity = counted − dispatched`;
  - `storeId` = the commissary (the same as a short row, so the same manager and the same block);
  - `value` = the excess at the line's dispatch unit cost. Use a new uncapped helper `costOfQuantity(dispatchCost,
    q, dispatched)`, with the same half-up centavo arithmetic as `proportionOfCost` but without its
    `r >= d → dispatchCost` cap. `proportionOfCost` would understate 30 of 20 at the full dispatch cost.
    The value is informational only. It posts nothing and can be `0` when `dispatch_cost` is 0.
  - `ConfirmReceiptResult.discrepancies` items gain `direction`.
- **Dispositions** (`DISCREPANCY_DISPOSITIONS`, the `Disposition` type, and the repo `ResolveInput` union) gain
  `top_up` and `return`. The labels are `top_up: 'Top-up dispatch'` and `return: 'Returned to commissary'`.

  | direction | allowed | posts |
  |---|---|---|
  | `short` | `audit`, `loss`, `charge`, `late_receipt` (unchanged) | as today |
  | `over` | `audit` (stays open, still blocks), `top_up`, `return` | **nothing**, ever |

  - **`return` posts nothing.** This corrects Q3's draft, which pointed at `customer.return-internal`. That pattern
    relieves branch stock, and the excess was never on the branch's books. Sending the goods back is physical
    only. It **requires a note** (who carried it back, and when).
  - **`top_up` posts nothing here.** The excess is booked by an ordinary commissary-initiated internal trade order
    (C to the same branch) that is dispatched and received through the existing flow, so it reuses the existing
    dispatch and receipt legs with no new pattern.
    - The resolution must name that order's line, `topUpOrderLineId`, stored in a new column
      `top_up_order_line_id`. The domain accepts it only if all of these hold:
      - its order is `received`;
      - its order's `storeId` is the row's commissary;
      - its customer's `counterpartyStoreId` is the over row's branch (the same derivation as
        `trade/index.ts:844`);
      - its `item_id` equals the over line's `item_id`;
      - its `received_quantity >= quantity − 0.005`;
      - it is not on the over row's own order;
      - it is not already linked to another row.
    - This is what stops `top_up` from becoming a click that clears the block while the excess stays off the books.
  - The refusals are `Outcome` reasons, shown by `back()` on the page. Exact text:
    - over + `loss`/`charge`/`late_receipt`: `This is an over-receipt — the extra goods were never on either store's books, so there is nothing to write off or charge. Resolve it as a top-up dispatch or a return.`
    - short + `top_up`/`return`: `This is a shortage — top-up and return apply only to goods that arrived over what was sent.`
    - `top_up` with no line: `A top-up must name the received top-up order line that booked the extra goods.`
    - `top_up` with an invalid line: `That top-up line does not cover this excess: it must be a received order from this commissary to the same branch, for the same item, of at least <quantity>, and not already used.`
    - `return` with no note: `A return must say how the extra goods went back — who carried them, and when.`
    - `topUpOrderLineId` given for any other disposition: `Only a top-up names a top-up order line.`
  - In `resolveDiscrepancy`, the existing `value <= 0` guard moves inside the `loss`/`charge` branch only.
  - No new capability: `resolve_trade_discrepancy` covers both new dispositions.
- **The day-open block needs no code change, and that is the point.**
  - `tradeDiscrepanciesRepo.blocking` (`repo/trade-discrepancies.ts:94-115`) selects every non-resolved row for the
    store with no direction filter.
  - `createSalesDay` (`sales-days/create.ts:188-208`) throws `TransitShortfallBlockedError` for the
    **commissary's** day.
  - ⛔ The builder must not add a `direction` filter there. X4 kills that mutant.
- **The order-level total is derived, never stored** (DEF-075).
  - v1's `discrepancyTotalAmount` is `Σ value` over the order's rows, split by `direction`. That is already
    queryable, so there is **no new column and no new read**; X16 asserts the derivation in SQL.
  - Showing it on the order page is out of scope.
- **The migration: YES, one, `0179_t372_s6b_over_receipt.sql`, hand-authored (ADR-012 §5).** It is needed for the
  column, CHECK and trigger changes below.
  - `ADD COLUMN "direction" text NOT NULL DEFAULT 'short'`, plus `trade_discrepancies_direction_check CHECK
    (direction IN ('short','over'))`. Every existing row is a shortfall, so the default is the truth.
  - `ADD COLUMN "top_up_order_line_id" uuid REFERENCES trade_order_lines(id) ON DELETE RESTRICT`, plus
    `CREATE UNIQUE INDEX trade_discrepancies_top_up_line_key ON trade_discrepancies (top_up_order_line_id) WHERE
    top_up_order_line_id IS NOT NULL`.
  - Drop `trade_discrepancies_disposition_check`, and re-add it with `'top_up','return'`.
  - `trade_discrepancies_disposition_direction_check CHECK (disposition IS NULL OR disposition = 'audit' OR
    (direction = 'short' AND disposition IN ('loss','charge','late_receipt')) OR (direction = 'over' AND disposition
    IN ('top_up','return')))`.
  - `trade_discrepancies_top_up_shape_check CHECK ((coalesce(disposition,'') = 'top_up') = (top_up_order_line_id IS
    NOT NULL))`. The `coalesce` matters: a bare `=` on a NULL disposition passes a dangling line.
  - Drop `trade_discrepancies_value_positive_check`, and add `trade_discrepancies_value_check CHECK (value > 0 OR
    (direction = 'over' AND value >= 0))`.
  - `CREATE OR REPLACE FUNCTION trade_discrepancies_resolution_terminal()`, adding `OR NEW.top_up_order_line_id IS
    DISTINCT FROM OLD.top_up_order_line_id` to its list. The trigger is already ALWAYS (0168).
  - A new `trade_discrepancies_direction_fixed_trg`:
    - `BEFORE UPDATE OF direction … WHEN (NEW.direction IS DISTINCT FROM OLD.direction)`, which raises
      `discrepancy % is %: its direction is fixed when the receipt raises it`;
    - `ENABLE ALWAYS`;
    - registered in `triggers/registry.ts` as `mode: 'always', kind: 'history_guard'`.
  - Mirror every change in `packages/db/schema/trade-discrepancies.ts`, with a `// NOTE: … migration 0179` comment.
    Also fix the `quantity` doc ("an over-receipt is not this") and the module header.
  - Precheck: none. The value rewrite only relaxes the rule, and every existing row is `short` with `value > 0`.
    The builder still runs `select count(*) from trade_discrepancies where value <= 0` on the lane DB and expects 0.
- **BUILDER paths:**
  - `packages/domain/src/trade/index.ts`;
  - `packages/domain/src/commissary/transfer.ts`;
  - `packages/domain/src/commissary/discrepancy.ts`;
  - `packages/db/src/repo/trade-discrepancies.ts`: the `resolve` union and `topUpOrderLineId`, plus
    `topUpCandidates(tx, orgId, discrepancyId)`, a read for the picker;
  - `packages/db/schema/trade-discrepancies.ts`;
  - `packages/db/migrations/0179_t372_s6b_over_receipt.sql` (and meta, per ADR-012);
  - `packages/db/src/triggers/registry.ts`;
  - `apps/erp/src/app/commissary/discrepancies/{page.tsx,actions.ts}`: dispositions offered by `row.direction`,
    and a `top_up` select fed by `topUpCandidates`;
  - `docs/POSTING-PATTERNS.md`: rename "The two dispositions that post NOTHING" to "The dispositions that post
    NOTHING"; add `top_up` and `return`, plus one paragraph saying an over-receipt books the dispatched quantity
    and its receipt entry is byte-identical to a full receipt. Then run `npm run toc`.
  - Not a backticked id, so the doc-parity test is unaffected.
- **TESTER paths:** `packages/domain/tests/integration/t372-receipt-discrepancy.test.ts` (D1's red is rewritten;
  the provisional S6b block is replaced by X1 to X16). Raw-SQL legs X13 and X14 run as the migration role.

| Id | Target | Red today | Kills mutant |
|---|---|---|---|
| X1 | 22 of 20, rate 500: resolves. Branch on-hand +20.000; `trade_order_lines.received_quantity = 20.000`; the branch `delivery_lines.received_quantity = 20.000`, with `over_receipt_allowed = false`. The goods entry has `2150` Cr 10,000.00, `1340` Cr = `dispatch_cost` exactly, and `5175` = 10,000 − `dispatch_cost`. One row: `direction 'over'`, `quantity 2.000`, `value = costOfQuantity(dispatch_cost, 2, 20)`, `status 'open'`, `store_id` = the commissary | rejects `/received over \(22\.000 of 20\.000\) without an over-receipt approval/` | the cap removed (the trigger refuses); the cap without a row; `received_quantity` stored as counted (22) |
| X2 | **positive.** 20.004 of 20 resolves: booked 20.000 everywhere X1 checks, and no row. The same for 20.005 | rejects `/received over \(20\.004 of 20\.000\)/` | the over test written `>= 0` or `> 0`; 20.004 booked uncapped |
| X3 | 20.006 of 20: one `over` row of `0.006` | rejects (trigger) | the tolerance widened |
| X4 | after X1: `tradeDiscrepanciesRepo.blocking(org, commissary, date)` contains the row, and `createSalesDay` for the commissary rejects with `TransitShortfallBlockedError` whose ids include it | no row exists | a `direction = 'short'` filter added to `blocking` |
| X5 | **positive.** `return` with a note resolves: `entryId null`, journal count unchanged, status `resolved`; then X4's `createSalesDay` succeeds | `return` is not a disposition | `return` posting anything; status left open |
| X6 | `return` with no note: the exact sentence; the row is still `open` | n/a | the note check removed |
| X7 | over row resolved as each of `loss`, `charge`, `late_receipt` (`it.each`): the exact over sentence, no entry, still `open`, `1340` unchanged | no over row | the direction gate removed (`loss` would drive `1340` negative) |
| X8 | short row (18/20) resolved as `top_up` or `return`: the exact short sentence | value not a disposition | the direction gate removed |
| X9 | `top_up` with no line: the exact sentence | n/a | the line check removed |
| X10 | **positive.** A C to B internal order: the same item, qty 2, dispatched and received; `top_up` names its line. It resolves, `entryId null`, `top_up_order_line_id` is set, and branch on-hand is now 22.000 | n/a | a valid top-up refused |
| X11 | `top_up` naming an invalid line (`it.each`): (a) the order is only dispatched; (b) a different item; (c) received 1.000 < 2; (d) a line to a different branch; (e) the over row's own order line. Each gives the invalid-line sentence | n/a | each validation clause removed |
| X12 | X10's line reused for a second over row: the domain gives the invalid-line sentence, and raw SQL rejects `/trade_discrepancies_top_up_line_key/` | n/a | the "already used" check removed; the unique index absent |
| X13 | raw SQL: (a) `disposition='loss'` on an over row rejects `/disposition_direction_check/`; (b) `disposition='top_up'` with a null line rejects `/top_up_shape_check/`; (c) `update … set direction='short'` rejects `/direction is fixed/`, also under `session_replication_role='replica'`; (d) **positive:** an over row with `value 0` inserts; (e) a short row with `value 0` rejects `/trade_discrepancies_value_check/` | (a)–(c) the column is absent | each constraint absent; `ENABLE ALWAYS` omitted |
| X14 | raw SQL: on X10's resolved row, `update … set top_up_order_line_id = null` rejects `/reverse it and resolve again/` | the column is absent | the column left out of the terminality function |
| X15 | **guard.** The existing supplier over-receipt tests (`receive-delivery.test.ts`, `deliveries.test.ts`, `t343-s5-1d-wrapper-refusals.test.ts`) stay green, unchanged | green | the T-166 trigger loosened |
| X16 | a two-line order received 18/20 and 22/20: by direction, `sum(value)` equals each row's value; the D4 short value plus the X1 over value; no order-level column exists | the over row is absent | an order total column added (DEF-075) |

- Also green: `t354-immutability-triggers-always.test.ts` (the new trigger is registered), the doc-parity and
  posting-patterns tests, the t343 ratchets (commissary 48, trade 52), D1 to D4, `commissary-transfer.test.ts`
  and `trade.test.ts`.
- **Smoketest add (≥ 2027-02-01):** receive 22 of 20 at the branch. Then:
  - on `/commissary/discrepancies`, the over row offers only Audit, Top-up dispatch and Return;
  - screenshot it;
  - resolve it as Return with a note;
  - screenshot the row resolved.
- **Done-when add:** DEF-513 is FIXED, citing T-372 S6b.
- **Open for Ian (does not gate the build):** if the branch simply miscounted (there was no excess), there is no
  disposition for it. **Default:** resolve it as `return`, with a note saying it was a recount. A distinct label
  can be added later as one CHECK value.

### S6 amendment 2 (2026-10-02, planner — Ian's answer)
Ian, 2026-10-01, Open Questions page, verbatim: *"on short or over received example order 10 when 9 is received -10
from comissary +9 to branch +1 flaoting determine if to be cherged to staff of comissary or to be absorbed as
expensed (covers broken, spoiled in flight) / when received is 11, -10 comissary +10 branch +1 floating then can be
settled by confirming comissary indeed dispatched more so another line for +1 and -1 extra item for each store / for
your question on recount lets do A / another line of transaction as return on recount only can be initiated by
manager"*. Verified at HEAD `5b8aeb7`.

**What this SUPERSEDES in amendment 1, exactly:**
- §3 "Dispositions": `top_up` is **withdrawn** everywhere (type, union, label, labels table, refusal sentences,
  `topUpOrderLineId`, `topUpCandidates`, the `top_up` select on the page). Replaced by `extra_dispatch` below.
- §3 table row `over … posts **nothing**, ever`: **void**. `extra_dispatch` posts.
- §3 refusal sentences for over + `loss`/`charge`/`late_receipt`, short + `top_up`/`return`, and every `top_up`
  sentence: replaced by the sentences below.
- §3 "Migration" bullets 2 and 5 (`top_up_order_line_id`, its unique index, `trade_discrepancies_top_up_shape_check`)
  and the `top_up_order_line_id` addition to `trade_discrepancies_resolution_terminal()`: **dropped from 0179**.
- BUILDER paths: `topUpCandidates` is not written; `POSTING-PATTERNS.md` gains a pattern (below), not only a
  "posts nothing" line.
- Tests X9–X12 and X14: deleted. X7, X8, X13(b): rewritten (table below).
- The "Open for Ian" line at the end of amendment 1: **answered** (A = `return`, below).
- **Unchanged:** amendment 1 §1 (D1/D2), §2 (cap, T-166 trigger kept, tolerance 0.005 strict `>`, 20.004/20.005
  book 20.000 with no row, 20.006 raises 0.006), the `over` row's shape and `costOfQuantity`, the day-open block
  with no direction filter, DEF-075 derived total, `direction` column + fixed-direction trigger, value CHECK.

**1. SHORT (sent 10, received 9) — no code change; Ian's two outcomes are the existing dispositions.**
- Receipt as today: the commissary relieved 10 at dispatch (`Dr 1340 / Cr 1310…`, commissary, at cost); the
  receipt relieves `1340` for 9 at cost, `Dr 1250` / `Cr 5175` margin (commissary), `Dr 1310… / Cr 2150` (branch,
  9 × rate). The "+1 floating" is the `short` row; its cost stays in `1340`.
- "charged to staff of commissary" = **`charge`**: `Dr 1230` (commissary, `party_type 'employee'`, the named
  person) / `Cr 1340`, at cost (`commissary.discrepancy-charge`). Gate: `resolve_trade_discrepancy` **and**
  `charge_staff_for_discrepancy`, both manager+ (`capabilities.ts:799`, `:772`), as today (`actions.ts:37-41`).
- "absorbed as expensed (broken, spoiled in flight)" = **`loss`**: `Dr 5300` / `Cr 1340` (commissary), at cost
  (`commissary.discrepancy-loss`).
- `late_receipt` and `audit` stay: Ian named the two *final* outcomes; the rest arriving later and "waiting" are
  not alternatives to them.

**2. OVER (sent 10, received 11) — `extra_dispatch` replaces `top_up`.**
- Receipt as amendment 1: booked 10 (the cap), an `over` row of 1, posts nothing at receipt. The "+1 floating" is
  that row.
- **`extra_dispatch`** (label `'Commissary sent more — book the extra'`): the commissary manager confirms the
  commissary really did send `quantity` more. In ONE transaction, in `resolveDiscrepancy`:
  - **Commissary −q:** `consume(tx, { storeId: commissary, locationId: <the line's source location, resolved
    exactly as dispatch does, trade/index.ts:493>, itemId: line.item_id, quantity: row.quantity, kind:
    'transfer_out', sourceType: 'trade_discrepancy', sourceId: row.id, movedAt: resolvedOn })`.
  - **Branch +q:** `insertMovement` (`transfer_in`, `sourceType 'trade_discrepancy'`, `sourceId row.id`) and
    `createLayer` (`source 'transfer_in'`, `unitCost` = the line's `rate`), with the branch item and location
    resolved exactly as `receiveTradeOrder` resolves them for this line (extract the helper if it is inline).
  - **One entry**, `sourceType 'trade_discrepancy'`, `idempotencyKey trade_discrepancy:<id>:extra_dispatch`,
    memo `'Commissary confirmed it sent more than dispatched'` — new pattern
    `commissary.discrepancy-extra-dispatch` (rate 500, q 1, layer cost 300):

    | Account | Store | Debit | Credit | Party |
    |---|---|---:|---:|---|
    | 1310/1320/1330 (item kind) | branch | 500.00 | | — |
    | 2150 Due to related store | branch | | 500.00 | store (commissary) |
    | 1250 Due from related store | commissary | 500.00 | | store (branch) |
    | 1310/1320/1330 (item kind) | commissary | | 300.00 | — |
    | 5175 Cost transferred to branches | commissary | | 200.00 | — |

  - ⛔ **No `1340` leg.** These goods were never put into transit on the books; dispatch and receipt collapse
    into one event, so a `1340` debit and credit would net to zero and only add noise.
  - ⚠️ **Departure from the brief, deliberate:** the commissary's credit is `consume()`'s `totalCost`, **not**
    `costOfQuantity(dispatch_cost, q, dispatched)`. Dispatch itself relieves at layer cost (`transfer.ts:223-241`);
    any other figure makes the commissary's stock ledger and `1310` disagree. The branch side is at `rate`, as the
    receipt is. The row's `value` stays informational. Margin: positive → `Cr 5175`, negative → `Dr 5175`, zero →
    no leg, exactly as `confirmReceipt` (`transfer.ts:521-531`). Zero-value legs omitted; if every leg is zero, no
    entry and `journal_entry_id` null.
  - **Stock check: YES, refuse.** If the commissary's books do not hold `quantity`, it cannot have sent it.
    `consume` already refuses a shortfall and writes nothing (`stock/consume.ts:55`); the domain checks first and
    returns `Outcome` reason: `<item name> — the commissary's books hold only <onHand>, so it cannot have sent
    <quantity> more. Correct the commissary's count first, or resolve this as a return.`
  - The row: `status 'resolved'`, `journal_entry_id` = the entry. `trade_order_lines` is **not** touched
    (`received_quantity` stays the capped booked figure). Accepted consequence: `commissary-kpis.ts:360` and the
    returns cap (`returns.ts:88-93`) do not see the extra unit; the extra is traceable by `sourceId = row.id`.
    Follow-up only if Ian wants it returnable against the line.
- **Who:** the commissary's manager or above — `resolve_trade_discrepancy` at `row.storeId` (already manager+;
  invariant 11, the commissary owns the goods). The branch's side is already on record: its count raised the row.
  **No new capability.**

**3. RECOUNT (Ian: "A") — `return`, unchanged in mechanics, re-labelled.**
- "A" = amendment 1's default: a miscount is resolved as `return`. Label becomes `'Returned to commissary /
  branch recount'`. One disposition covers both "the extra went back" and "there was no extra".
- **Posts nothing**, and that is correct: the cap means the excess was never booked, so a reversing line would
  take the branch below what it really holds. The "another line of transaction" Ian asked for is the resolved row
  itself — who, when, and the required note.
- **Who:** manager only — `resolve_trade_discrepancy` is manager+, staff ✗ (`capabilities.ts:799`). No new
  capability.
- `audit` **stays** for the over row: "the commissary is checking its dispatch log" is a real wait, and it still
  blocks.

**Dispositions, final:**

| direction | allowed | posts |
|---|---|---|
| `short` | `audit`, `loss`, `charge`, `late_receipt` (unchanged) | as today |
| `over` | `audit` (stays open, still blocks), `extra_dispatch`, `return` | `extra_dispatch` only |

**Refusal sentences (`Outcome` reasons, exact):**
- over + `loss`/`charge`/`late_receipt`: `This is an over-receipt — the extra goods were never on either store's books, so there is nothing to write off or charge. Book it as an extra dispatch if the commissary sent more, or as a return if it went back or was a miscount.`
- short + `extra_dispatch`/`return`: `This is a shortage — extra dispatch and return apply only to goods counted over what was sent.`
- `return` with no note: `A return must say what happened — who carried the extra back and when, or that the branch recounted.`
- the stock refusal above.
- In `resolveDiscrepancy`, the `value <= 0` guard moves inside the `loss`/`charge` branch only (as amendment 1).

**Migration `0179_t372_s6b_over_receipt.sql` — the delta vs amendment 1:**
- Keep: `direction` + `trade_discrepancies_direction_check`; the value CHECK swap; `trade_discrepancies_direction_fixed_trg`
  (ALWAYS, registered); the schema mirror.
- Drop from the plan: `top_up_order_line_id`, `trade_discrepancies_top_up_line_key`,
  `trade_discrepancies_top_up_shape_check`, and the terminality-function change (no new column to protect, so
  `trade_discrepancies_resolution_terminal()` is **not** replaced).
- Change: `trade_discrepancies_disposition_check` re-added with `'extra_dispatch','return'` (not `'top_up'`);
  `trade_discrepancies_disposition_direction_check` → `… OR (direction = 'over' AND disposition IN
  ('extra_dispatch','return'))`.
- No change to `stock_movements` (free-text `source_type`), `stock_layers` (`transfer_in` exists), or
  `delivery_lines`. Precheck unchanged (`value <= 0` count = 0).

**BUILDER paths:** amendment 1's list minus `topUpCandidates`; `discrepancy.ts` gains the `extra_dispatch` branch
(imports `consume`, `stockLedgerRepo`, `stockLayersRepo`, the transfer account constants); `trade/index.ts` only if
the branch item/location resolution must be extracted. `POSTING-PATTERNS.md`: add
`commissary.discrepancy-extra-dispatch` after `commissary.discrepancy-charge` (table above, plus the ⛔ no-`1340`
and ⚠️ layer-cost notes), rename "The two dispositions that post NOTHING" → "The dispositions that post NOTHING",
add `return`, then `npm run toc`.

**Tests (`t372-receipt-discrepancy.test.ts`).** X1–X6, X15, X16 unchanged (X5's note may read "recount").
X9–X12, X14 deleted.

| Id | Target | Red today | Kills mutant |
|---|---|---|---|
| X7′ | over row as each of `loss`, `charge`, `late_receipt`: the new over sentence, no entry, still `open`, `1340` unchanged | no over row | the direction gate removed |
| X8′ | short row (18/20) as `extra_dispatch` or `return`: the new short sentence | not a disposition | the direction gate removed |
| X13′ | raw SQL: (a) `loss` on an over row rejects `/disposition_direction_check/`; (b) `extra_dispatch` on a **short** row rejects `/disposition_direction_check/`; (b2) `disposition='top_up'` rejects `/disposition_check/`; (c)–(e) as amendment 1 | column absent | each constraint absent; `top_up` left in the CHECK |
| E1 | X1's row (22/20, rate 500) as `extra_dispatch`: resolves; commissary on-hand −2.000; branch on-hand 22.000; one entry with exactly the five legs above, commissary credit = the `consume` cost, `5175` = 1,000.00 − that cost; **no `1340` line**; `1340` balance unchanged; row `resolved`, `journal_entry_id` set; both movements `source_type 'trade_discrepancy'`, `source_id` = row | not a disposition | posts nothing (amendment 1's rule); a `1340` leg; commissary relieved at `rate`; branch layer at cost |
| E2 | commissary holds 1.000 of the item, row is 2.000: the exact stock sentence; no entry, no movement, row `open` | n/a | stock check removed (consume bypassed) |
| E3 | rate below cost (rate 100, cost 300, q 1): `5175` is a **debit** of 200.00 | n/a | negative margin dropped or sign-flipped |
| E4 | after E1, Σ`1250` (commissary, party branch) = Σ`2150` (branch, party commissary) — invariant 6 | n/a | one side's leg omitted |
| E5 | E1 resolved twice: second gives `already resolved … reverse it and resolve again`; one entry, one movement pair | n/a | `FOR UPDATE`/status check removed |
| E6 | **positive.** over row as `return` with note `recount: branch miscounted`: resolves, no entry, branch on-hand stays 20.000, commissary unchanged | not a disposition | `return` posting a reversal |
| E7 | **guard.** manager+ / staff ✗ for `resolve_trade_discrepancy` stays as the CAPABILITY-MATRIX test pins it | green | — |

- Smoketest add (replaces amendment 1's): receive 22 of 20; the over row offers only Audit, Commissary sent more,
  Returned / recount; resolve one row as Commissary sent more and screenshot both stores' on-hand; resolve another
  as Return with a recount note.
- Done-when: DEF-513 FIXED citing T-372 S6b (unchanged).

**Still open for Ian (does not gate the build; defaults are what gets built):**
- "charged to staff **of commissary**": today `charge` accepts any person. **Default:** no new restriction (a
  driver may be the one at fault); the picker lists the commissary's staff first.
- "only can be initiated by manager" for the recount: **Default:** the **commissary's** manager, as for every
  disposition. If Ian means the **branch** manager, `resolveDiscrepancy`'s `row.storeId` check (invariant 11)
  must admit the branch for `return` only — a one-clause change, not a new capability.
- A distinct `recount` label (vs the shared `return`): **Default:** shared; one CHECK value later if reports need it.

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

- 2026-10-02, Ian (Open Questions page): the recount return is initiated by **the manager of the store initiating the return** (the branch that miscounted) — resolveDiscrepancy's store check lets the BRANCH's manager in for `return` (recount) only; the commissary's manager keeps its existing resolution rights. Short → charge (commissary staff) / loss; over → extra_dispatch (amendment 2).
