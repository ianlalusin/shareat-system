# T-166 — Deliveries: the document goods actually arrive on

> **Status:** ✅ **BUILT 2026-09-03 — the document, the receive path, AND the screen.**
> `deliveries` + `delivery_lines` (migration `0066`, 2026-08-29), `receiveDelivery`, duplicate-risk
> — plus, as of today, `createDeliveryDocument` / `receiveDeliveryDocument`
> (`packages/domain/src/deliveries/documents.ts`) and `/inventory/deliveries` +
> `/inventory/deliveries/[id]`, both wired to the real domain. **31 integration tests** (16 from
> 8/29's `receive-delivery.test.ts`, untouched, + 15 new in `deliveries.test.ts`). DEF-135's T-166
> portion is closed. ⛔ **Void is still not built** — §10.5.
> **Depends on:** T-160 (locations), T-161 (movements), T-162 (layers), T-163 (receipt posting),
> T-130 (`supplier_invoices`), T-141 (file brokering, for the photo gate).
> **v1 read at source** — `delivery.actions.ts` (1,470 lines), `receive-allocation.ts`,
> `delivery-duplicate-risk.ts`, `record-types.ts`. `docs/discovery/14` §F.

## 1. Goal

The screen a manager or cashier actually uses when a supplier's van arrives: record what is
coming, receive what actually came, put it in a room — and have the books, the stock and the cost
layer all follow from that one action.

## 2. What v1 gets right here, and it is most of it

| Capability | Keep |
|---|---|
| **Delivery vs purchase** — one document, two labels. A *delivery* is supplier-sourced; a *purchase* is staff-bought for cash and may have no registered supplier | ✅ Same table, a `kind` column |
| ⭐ **Photo-of-paper required on create** | ✅ **A real anti-fraud control, not incidental.** A purchase needs its own photo; an external-supplier delivery must link to an invoice that has one; a **commissary** delivery is exempt because it is system-generated (T-173) |
| ⭐ **Receiving parks an undecided line in "Receiving", never guesses a room** | ✅ Falls back to the default room **only** if no Receiving location exists — *"so stock is never lost."* Preserve the fallback ordering exactly |
| ⭐ **Over-receipt allowed, with an explicit flag AND manager/admin** | ✅ *"Suppliers sometimes legitimately send extra."* A gated exception, never a silent cashier bypass |
| **Short-received lines carry a typed shortage reason** | ✅ Feeds supplier-performance conversations |
| ⭐ **Duplicate-risk warnings — advisory, never blocking** | ✅ *"Our job is to put the fact in front of them at the moment they can still act on it."* Legitimate double-drops and bulk buys are normal |
| **Void cascades in the direction of causation** | ✅ Shape kept, mechanism replaced — one transaction (ADR-009 amendment 3) |
| ⛔ Auto-link / bulk-create-from-delivery | **Removed by v1 deliberately** — *"the amount-match heuristic produced false positives at scale."* Do not re-introduce |
| ⛔ Direct "receive into a room" door | **Hard-blocked by v1 by policy** — all inbound stock flows through this document. Do not port the entry point |

## 3. Scope

**Create:** `packages/db/schema/deliveries.ts` ·
`packages/db/migrations/<next>_t166_deliveries.sql` ·
`packages/domain/src/deliveries/index.ts` · `packages/domain/src/deliveries/duplicate-risk.ts`
(pure) · `packages/domain/src/deliveries/shortage-reasons.ts` ·
`packages/db/src/repo/deliveries.ts` ·
`apps/erp/src/app/inventory/deliveries/page.tsx` + `[id]/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/deliveries.test.ts` ·
`packages/domain/tests/unit/duplicate-risk.test.ts`

**Modify:** schema/domain barrels · `classification.ts` · `rls/registry.ts` ·
`CAPABILITY-MATRIX.md` · `_journal.json` · `docs/ROADMAP.html`

## 4. Contract

```
deliveries
  id, org_id, store_id
  kind            'supplier' | 'purchase' | 'commissary'  NOT NULL
  supplier_id     uuid NULL -> suppliers      -- required when kind='supplier'
  reference_no    text NULL                   -- the DR / invoice number on the paper
  delivered_on    date NOT NULL
  status          'draft' | 'received' | 'void' NOT NULL default 'draft'
  proof_file_id   uuid NULL -> stored_files   -- the photo gate, invariant 1
  received_at, received_by, voided_at, voided_by, void_reason
  created_by, created_at, updated_at
  unique (store_id, supplier_id, reference_no) where reference_no is not null and status <> 'void'

delivery_lines
  id, delivery_id -> deliveries (on delete cascade)
  line_no, item_id -> items
  ordered_quantity   numeric(14,3) NOT NULL
  received_quantity  numeric(14,3) NULL       -- set at receive
  purchase_unit      text NOT NULL
  conversion_factor  numeric(14,6) NOT NULL   -- SNAPSHOTTED (T-145's rule)
  unit_cost          numeric(14,4) NOT NULL   -- per purchase unit, as typed
  location_id        uuid NULL -> stock_locations   -- NULL = park in Receiving
  shortage_reason    text NULL
  over_receipt_ok    boolean NOT NULL default false
  unique (delivery_id, line_no)
```

**Shortage reasons** — a separate, smaller enum from wastage (§16.6, and phase plan §7):
`not_received` *(auto-set, excluded from the manual picker)* · `supplier_short` ·
`damaged_in_transit` · `damaged_on_arrival` · `quality_reject` · `count_correction` · `other`.

```ts
saveDraft(input) / addLine / removeLine
receive(deliveryId, { lines, allowOverReceipt }): Promise<ReceiveResult>
voidDelivery(deliveryId, reason): Promise<void>
duplicateRisk(draft): Warning[]          // pure, advisory
```

## 5. Invariants

1. **A delivery cannot be created without proof.** `kind='purchase'` needs `proof_file_id`;
   `kind='supplier'` needs it or a linked invoice that has one; `kind='commissary'` is exempt and
   may only be created by T-173. ⚠️ Enforced **server-side**, and the file must exist in
   `stored_files` — not merely be a non-empty string (the regression DEF-077's audit already caught
   once, in `verifyInvoice`).
2. **Receiving is the only door for inbound stock.** No other path creates a `receipt` movement.
3. **A line received above ordered is refused** unless `allowOverReceipt` **and** the caller is
   manager/admin. A cashier passing the flag is refused — asserted.
4. **A line received below ordered requires a shortage reason**, except a wholly-unreceived line,
   which auto-sets `not_received`.
5. ⭐ **A line with no `location_id` goes to Receiving; if the store has none, to the default room.
   It is never dropped and never guessed.** The ordering is exact.
6. **Receive posts, in ONE transaction:** the movements (T-161), the layers (T-162), the
   `Dr 1310/1320/1330 · Cr 2120` entry (T-163). Any failure rolls back all three.
7. **Duplicate-risk warnings never block.** Three heuristics kept verbatim: same supplier + same
   reference already recorded · same item already recorded on this date · this delivery at least
   **doubles** current on-hand.
8. ⭐ **Void is one transaction and cascades in the direction of causation** — reverse the entry
   (`reverseEntry`), the layers, the movements, and unlink the invoice. ⛔ **Refused if any layer
   has been consumed** (T-163 invariant 8). v1's OC-14 non-atomic cascade is **not** ported; the
   constraint that forced it is gone.
9. **Period lock applies** to receive and to void (invariant 7).
10. **A received delivery is immutable.** Corrections are a void plus a new delivery, or an
    adjustment (T-168) — never an edit (invariant 5).

## 6. Tests

1. Creating a purchase with no `proof_file_id` is refused; with a `stored_files` id that does not
   exist, also refused.
2. Receiving 10 of 10 posts one entry, one layer, one movement, and `2120` rises by the line total.
3. Receiving 12 of 10 as a cashier is refused; as a manager **without** the flag, refused; as a
   manager **with** the flag, accepted.
4. Receiving 8 of 10 with no reason is refused; with `supplier_short`, accepted. A line marked
   not-received auto-sets `not_received` and does not require a picker choice.
5. A line with no location lands in Receiving. With the Receiving location deleted from the
   fixture, it lands in the default room. **Neither case loses the quantity.**
6. Duplicate risk fires all three warnings and **the receive still succeeds** — asserted, because
   the whole design decision is that it is advisory.
7. Void reverses entry, layers and movements; `2120`, `1310` and on-hand all return to their prior
   values; the trial balance ties.
8. Void of a partly-consumed delivery is refused, naming the consumed quantity.
9. Receiving into a closed period is refused.
10. Editing a received delivery is refused.
11. RLS: a manager of store A cannot receive store B's delivery. ⚠️ *Recurring `hasStoreAccess`
    omissions — 5+ instances in two months — are §16.7 defect #9.*
12. ⭐ Live route on 9008: create → attach photo → receive → see the stock, the layer and the
    journal entry from the UI.

## 7. ⚠️ Built 2026-08-29 — the seam, and the bug the seam exposed

**Landed:** `packages/db/schema/deliveries.ts` · migration `0066` (applied to dev and test) ·
`packages/domain/src/deliveries/receive.ts` · `duplicate-risk.ts` · both registries ·
`packages/domain/tests/integration/receive-delivery.test.ts` (16 cases).

### 7.1 ⭐ Receiving is what made five tasks real

Until `receiveDelivery` existed, T-161's movements, T-162's layers and T-163's postings each had
tests and **no caller**. One call now does three things in one transaction:

```
1. a stock movement per line     quantity  (T-161)
2. a FIFO layer per line         cost      (T-162)
3. one journal entry             value     (T-163)   Dr 1310/1320/1330 · Cr 2120
```

### 7.2 ⛔ THE BUG: "all three or none" was false, and the test caught it

The first cut validated the item-kind mapping **inside the write loop**. So a line with an
unmapped kind wrote its movement and its layer, *then* the posting refused — and because
`postReceiptValue` **returns `ok:false` rather than throwing**, the transaction **committed the
stock without the value.**

⚠️ **That is v1's non-atomic cascade (OC-14), reproduced by accident, in the task written to
remove it.**

⭐ **Fixed by ordering:** every precondition is now checked before the first write, and a refusal
discovered *after* a write throws, so the transaction unwinds. The test asserted zero movements
and found one — it was written expecting the code to be right, and it was not.

> **A returned error and a thrown one are not interchangeable inside a transaction.** A function
> that returns a refusal is safe only while it has written nothing.

### 7.3 The controls that live in the database

| Control | Where |
|---|---|
| **The photo gate** | CHECK — a delivery or purchase without proof cannot be stored at all. ⚠️ `commissary` exempt: system-generated by T-173, and the dispatch IS the evidence |
| Supplier required for a supplier delivery | CHECK |
| **A short line must explain itself** | Trigger, at `received` only — a shortage is a supplier-relationship fact, and an unexplained one is a fact nobody can act on |
| ⭐ **Over-receipt needs explicit approval** | Trigger. *Suppliers legitimately send extra*, so it is allowed — but deliberately, never as a silent tolerance a cashier can trip past |
| Same supplier + same paper reference | Unique index. ⚠️ The hard duplicate is refused; the soft ones only warn (§10.4) |

### 7.4 ⭐ Duplicate risk warns and never blocks

Three heuristics, kept verbatim, including the **self-scaling** overstock multiplier — a delivery
that at least *doubles* current stock, which is why it is a multiplier and not an absolute
quantity: *"50 units" would scream on chopsticks and stay silent on beef.*

⛔ Blocking would be wrong: a supplier splitting a load across two vans is normal, and only the
person holding the paper can tell a re-key from a real second drop. **A system that refuses the
real one teaches people to work around it.**

### 7.5 One implementation of "quantity × rate → money"

⚠️ The first cut called `money(unitCost)` — but `unitCost` is a **rate** at `numeric(14,4)` and
`money()` rejects anything past 2dp. ⭐ Rather than write a second conversion, `lineCost` was
**exported from `layers.ts`** and shared with the FIFO planner: two implementations of "quantity
times a rate" is how two halves of one system come to disagree about what a delivery cost.

### 7.6 Not built

| Piece | Why |
|---|---|
| `/inventory/deliveries` route | ⛔ Port 9008 held all day. See `docs/PENDING-VERIFICATION.md` |
| Void with its cascade | Needs the route to be useful, and its refusal condition (any layer consumed) needs T-168's usage path to be testable against |
| The expense/invoice link | T-163's `linkInvoiceToReceipt` exists and is tested; wiring it to a delivery is the AP screen's job |

## 8. Out of scope

⛔ **Auto-matching an invoice to a delivery.** Built and removed in v1. Manual link only (T-163).
⛔ **The direct receive-into-a-room door.** Retired by policy in v1; not ported.
⛔ **Supplier returns.** T-170.
⛔ **Commissary deliveries' creation path.** T-173 creates them; this task only honours the exempt
`kind`.
⛔ **Batch codes / expiry capture.** Phase plan §8.
⛔ **Purchase orders.** Discovery 20: *"staff-entered on the spot, not requisition-and-approve."*

## 9. Done when

- [x] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
      — Already true from the 2026-08-29 pass (`0066`). This pass needed no schema change; the
      document layer is built entirely on the existing tables.
- [x] `classification.ts` **PURGE** (operational); `rls/registry.ts` NULLIF-guarded (DEF-077).
      — Already true from 2026-08-29; verified still present (`deliveries`/`delivery_lines` rows
      in both files), not re-touched.
- [x] `CAPABILITY-MATRIX.md`: `receive_delivery`, `allow_over_receipt` (manager+) — each with a
      test proving the ✗ fires (both new, in `deliveries.test.ts`: staff refused even with the
      flag; manager refused without it). `void_delivery` — **deliberately NOT declared.** Void is
      not in this pass; see §10.5.
- [x] `typecheck` green · [x] `npm test` (unit) green, 942/943 (1 pre-existing skip, unrelated) ·
      [x] integration tests green — **31/31**, run against the private `shareat_test_t166`
      database via `it.mjs`, never the shared `shareat_test` (`npm run test:integration` itself was
      not run, per the concurrency rule — four lanes share one tree and one shared test DB right
      now). · [x] `npm run build` — run by the coordinator 2026-09-03 with the dev server stopped,
      after all four lanes and the review fixes: clean.
- [x] ⭐ Test 12 performed in the browser, not asserted from a server action. Scripted headless
      Chromium on 9008, Lipa (LIP), **2026-09-03** — §10.4 for the full narrative and DB evidence.
- [x] `docs/ROADMAP.html` updated — by the coordinator 2026-09-03: T-166's line names the
      zero-caller gap, the Lipa run, and the unbuilt void.

## 10. Built 2026-09-03 — the document and the screen

**Landed:** `packages/db/src/repo/deliveries.ts` extended — `insertDelivery`, `insertDeliveryLines`,
`getDeliveryDocument`, `listDeliveries`, `updateLineReceipt`, `markReceived`, `listLocationsLike`,
`recentDeliveriesForRisk` (`getDelivery`/`getDeliveryLine`/`createCommissaryDelivery` untouched — T-170/
T-173's own callers) · `packages/domain/src/deliveries/documents.ts` (the stub overwritten) —
`createDeliveryDocument`, `receiveDeliveryDocument` · `packages/domain/src/deliveries/receive.ts`'s
`toBaseUnits` made `export` (no behaviour change, reused by the duplicate-risk check) ·
`apps/erp/src/app/inventory/deliveries/{page.tsx,lib.ts,actions.ts,NewDeliveryForm.tsx,[id]/page.tsx}` ·
`packages/domain/tests/integration/deliveries.test.ts` (15 cases).

### 10.1 What a person can now do that they could not yesterday

Sign in as a cashier, draft a supplier delivery or a cash purchase — kind, supplier, reference,
date, a required photo, dynamic item lines (item, quantity, purchase unit, conversion factor, unit
cost, an optional room) — and receive it: a per-line received quantity defaulting to what was
ordered, a shortage-reason picker, a room override, and one "allow over-receipt" checkbox that
does nothing for a cashier except get refused. This closes the T-166 slice of **DEF-135**: the
engine has been green and unreachable since 2026-08-29; today it has a door.

### 10.2 The role gate and the DB trigger stay two separate jobs

`receiveDeliveryDocument` computes what to WRITE (auto `not_received` on a zero-received line;
pass the picked reason through unchanged on a short line) and calls `authorize(tx, actor,
'allow_over_receipt', …)` **only when a line asks for it** — that is the one check the trigger
structurally cannot make, because `over_receipt_allowed` is just a boolean column with no memory
of who is allowed to set it true. Everything else — "a short line needs a reason", "an over line
needs the flag" — is left to `delivery_lines_shortage_explained_trg` to refuse and to `actions.ts`
to translate, per the instruction not to re-implement a rule the database already enforces.

⚠️ **Ordering matters and is easy to get backwards**: `markReceived` runs BEFORE the per-line
receipt-field writes, not after. The trigger reads the delivery's CURRENT status; writing the
lines first would have it check against `draft` and validate nothing at all. Both writes are
inside one call to `receiveDelivery` in the same transaction, so a refusal anywhere unwinds all
of it — the header included.

### 10.3 A spec defect found and fixed: `recentDeliveriesForRisk`'s "(non-void)" made a warning dead code

The Build section's literal text asked for `recentDeliveriesForRisk(tx, storeId, days)` to return
**non-void** deliveries. Tracing `duplicateRisk`'s own `same_reference` branch shows why that
can't be right: it fires only when an EXISTING entry matches the new draft's (supplier,
reference) exactly — but `deliveries_supplier_reference_key` (the hard unique index) already
refuses any two NON-void deliveries sharing those two values, org-wide, with no day window. A
non-void match in the "recent" list would always hit the index and throw before the warning is
ever computed; the branch would be unreachable in real use. `duplicate-risk.ts`'s own header names
the one case where it is NOT dead — *"a voided prior document that the unique index deliberately
excludes."* `recentDeliveriesForRisk` now includes void rows for exactly that reason (comment left
in place at the call site). Per bible §3.4a this is reported rather than silently kept as written;
closing test in `deliveries.test.ts` constructs a voided prior on purpose and asserts all three
warnings fire together, and the receive still succeeds.

### 10.4 ⭐ Test 12, live on 9008 — Lipa, store LIP, 2026-09-03

Scripted headless Chromium (Playwright from the npx cache), signed in as **Dev Cashier**:

1. Created a supplier delivery from **Batangas Meat Supply** — PORK-SMOKE 10 kg @ ₱300, a MILKIS
   24 pcs @ ₱25, a real small PNG as the proof photo. Landed on the detail page as a draft; an
   amber duplicate-risk banner correctly fired (leftover same-day items from earlier smoketest
   runs) and did **not** block the save.
2. Received it: 10 of 10 pork, 20 of 24 milkis with `supplier_short`. Screen showed **"Received.
   Posted at ₱3,500.00"**. Lipa has no Receiving-purpose room, so both lines parked in the
   store's one and only room (Stockroom A, its default) — invariant 5's fallback, exercised live,
   not just in a fixture.
3. `/inventory?store=LIP` — **"Inventory ties to the ledger": FIFO layers ₱8,700.00 = 1310+1320+1330
   ₱8,700.00, Difference ₱0.00**, right after a real receipt through the real screen. Pork Belly
   27 kg (17 seeded + 10 received), Milkis 20 pcs.
4. A second delivery, 5 kg pork ordered. As the **cashier**, tried to receive 8 with "allow
   over-receipt" ticked — refused **on screen**: *"Only a manager or admin can approve receiving
   more than what was ordered — untick 'allow over-receipt', or ask a manager to receive it."*
   Nothing was written; the redisplayed form showed the pristine 5.000 default, unchecked box.
5. Signed in as **Dev Manager**, same delivery, same 8-of-5 with the flag ticked — accepted:
   **"Received. Posted at ₱2,400.00"**, the line showing `8.000 kg` against `5.000 kg` ordered with
   an amber **"(over-receipt approved)"** note.

**DB evidence**, both deliveries: two `receipt` movements (10 kg, 8 kg, both PORK-SMOKE) and one
more (20 pcs MILKIS) · three `stock_layers` rows at ₱300.0000 / ₱300.0000 / ₱25.0000 · two journal
entries — `Dr 1310 ₱3,000 + Dr 1310 ₱500 / Cr 2120 ₱3,500` and `Dr 1310 ₱2,400 / Cr 2120 ₱2,400` ·
two `stored_files` rows, `purpose='receipt_photo'`, `content_type='image/png'` · both deliveries
`status='received'`, the second carrying `over_receipt_allowed=true` on its one line. Final on-hand
at Lipa: PORK-SMOKE 35 kg (17 + 10 + 8), MILKIS-014313 20 pcs. Ten screenshots captured, one per
meaningful state (register, filled form, draft, filled receive form, received, stock-on-hand,
over-receipt attempt, refusal, manager attempt, acceptance).

⚠️ **The run before this one hit a dev-server fault, not a code fault** — Turbopack's dynamic-route
compile worker had wedged (`"Jest worker encountered 2 child process exceptions, exceeding retry
limit"` on every `/inventory/deliveries/[id]` request, confirmed NOT specific to this route by the
same failure briefly appearing on unrelated existing routes under the same load, and confirmed
NOT a code defect by the domain layer's own 31 green integration tests against real Postgres).
The coordinator restarted the dev server; the run above is the clean one taken after confirming it
answered again. Recorded here because it cost real time diagnosing and is exactly the kind of
"looked like my bug, wasn't" trap the next session should not re-walk.

### 10.5 Same-day review fixes (coordinator)

- **The over-receipt approval flag is stamped only on lines that ARE over-received.** The screen
  sends one document-wide checkbox, and `receiveDeliveryDocument` wrote `over_receipt_allowed =
  true` on every line — so a cashier ticking it on an in-full delivery recorded a manager-only
  approval nobody was asked for (no stock effect; the trigger reads the flag only on an over
  line, and `allow_over_receipt` was still authorised whenever a line was actually over). Now
  `cmp > 0 && overReceiptOk`.
- **Warning 2's wording matched its data.** With §10.3's change, `existing` includes drafts and
  voided documents, so *"were already received on {date}"* could be false. It now reads *"were
  already recorded on a delivery dated {date} (drafts and voided ones included)"*.
- The store's active rooms are read through `stockLocationsRepo`, not a drizzle query in
  `lib.ts` (bible §4.3). `nav.tsx` and `/inventory` now link the route.

### 10.6 Not built

| Piece | Why |
|---|---|
| Void, with its cascade | Unchanged from §7.6's reasoning — needs a real usage/consumption path to test the "any layer consumed" refusal against. T-168 (usage) is being built in parallel this same session by another lane; picking this up is now unblocked, but was out of this lane's scope |
| `void_delivery` capability | Deliberately not declared — see above |
| The expense/invoice link | `linkInvoiceToReceipt` (T-163) exists and is tested; wiring a delivery to a supplier invoice is the AP screen's job, unchanged from §7.6 |
| Nav entry | `nav.tsx` is off-limits to this lane (shared file, four lanes editing concurrently). The route works at `/inventory/deliveries` but is not yet linked from anywhere — needs a one-line addition from whoever next touches `nav.tsx` |
