# T-172 — The branch order: draft → submit → accept → fulfil → dispatch

> **Status:** ✅ **BUILT, 2026-09-03 (DEF-136)** — the whole contract: `packages/domain/src/commissary/orders.ts` (the branch's side) and `fulfilment.ts` (the commissary's), migration `0121`, five capabilities, the two screens under `apps/erp/src/app/commissary/orders/`, and `packages/domain/tests/integration/branch-orders.test.ts` (30 tests, green). **§12 records what shipped and where the spec bent** — read it before trusting §6 literally. The ledger side was built 2026-08-29: migration `0070`, `transfer.ts`'s `dispatchOrder`, `commissary-transfer.test.ts` (20 tests). ⛔ DEF-095 (found 08-29): `schema/trade.ts` stated a constraint T-133 had already replaced, and acting on the stale text reverted its fix.
> **Depends on:** T-171 (catalogue and map), T-160/T-161 (both stores' locations and ledger),
> T-132/T-133 (`trade_orders` — ⭐ see §2), T-151 (price and outbound fee).
> ⭐ **v1 RE-READ AT SOURCE 2026-08-29**, at Ian's instruction — the first draft cited
> `docs/discovery/14` §O rather than the code. §9 records what the source added.
> **v1 read at source** — `branch-order.actions.ts` (640), `branch-order-fulfilment.actions.ts` (703),
> `order-helpers.ts`, `autobook.ts`.
> `docs/discovery/14` §O rows 8–12.

## 1. Goal

A branch asks its commissary for goods, the commissary says what it will actually send, and both
sides agree on the list **before** anything leaves the building — so the receipt (T-173) has nothing
left to negotiate except quantity.

## 2. ⭐ This is `trade_orders`, not a new table

T-133 already settled the shape and the reasoning is worth quoting because it decides this task:

> *"One ordering and fulfilment flow. Two accounting treatments, derived from the counterparty. …
> A mode is a fork; a derived treatment is a fact."*

`trade_orders` already carries `draft | confirmed | dispatched | received | void`, the derived
`internal | inter_entity | external` treatment, the four-leg internal posting, and T-151's
`delivery_fee` / `other_fees`.

⛔ **Do not add a `branch_orders` table.** ERPNext genuinely splits these (Material Request / Stock
Entry vs Sales Order / Delivery Note) and ADR-008 §8 gives the reason we do not: *that split encodes
an organisational boundary of separate teams and approval chains, which this business does not
have. The same commissary staff pack the same crates on the same morning.*

**What this task adds is the ordering conversation `trade_orders` has never had:** a branch-initiated
request, an acceptance, a fulfilment pass where quantities change, and a mid-fulfilment substitution
the branch approves.

## 3. What v1 gets right

| Capability | Keep |
|---|---|
| ⭐ **Pre-submit hardening** — every line must have qty > 0, a resolved branch item (or an explicit ledger-only decision), **and** a resolved expense category | ✅ **Closes "the receipt knows nothing to credit" and "auto-book can't categorise" BEFORE the order leaves the branch**, rather than discovering them at receive time |
| **One open order at a time per branch** | ✅ A dispatched order is goods in transit and blocks a new one until confirmed received |
| **Accept seeds fulfilment fields from the request** | ✅ The commissary starts from what was asked, then adjusts |
| **Fulfilment adjusts quantity, price and source room per line** | ✅ |
| ⭐ **Authoritative stock gate at dispatch — unknown counts as 0, fail closed** | ✅ Cannot dispatch more than the commissary actually holds |
| ⭐ **A commissary-added or substituted line lands `pending`** | ✅ It does **not** count toward the total and does **not** let the order reach "ready" until the branch approves or rejects. Approving a new line requires it be mapped first — the same rule as ordering |
| **Dispatch is a pure status flip; no books are touched** | ⚠️ **Changed** — see §5 |

## 4. Scope

**Create:** `packages/domain/src/commissary/orders.ts` ·
`packages/domain/src/commissary/fulfilment.ts` ·
`packages/db/migrations/<next>_t172_branch_orders.sql` (columns on `trade_orders`, one child table)
· `apps/erp/src/app/commissary/orders/page.tsx` + `[id]/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/branch-orders.test.ts`

**Modify:** `packages/db/schema/trade.ts` · `packages/domain/src/trade/index.ts` ·
`packages/db/src/repo/trade.ts` · `classification.ts` · `rls/registry.ts` ·
`CAPABILITY-MATRIX.md` · `_journal.json` · `docs/ROADMAP.html`

## 5. ⚠️ Where dispatch posts, and it is not here

v1 defers **all** postings to confirm-receipt. **v2 keeps that for the internal transfer** —
T-173's whole design rests on it — with one addition Wave 0 forces:

> ⭐ **Dispatch moves the goods out of the commissary's stock and into `1340 Inventory in transit`.**

| Account | Store | Dr | Cr |
|---|---:|---:|---:|
| `1340` Inventory in transit | commissary | 18,000.00 | |
| `1310`/`1330` Inventory | commissary | | 18,000.00 |

**Why this is not a contradiction of "everything posts at receipt".** Under v1's *periodic* shape
there was nothing to move at dispatch — cost had already been expensed. Under the perpetual shape
the goods are a real asset that has physically left the commissary's shelf and has not arrived
anywhere. `1340` **exists precisely for this** (`chart-of-accounts.ts:151`, *"Inventory in transit
(branch orders)"*), it is seeded and unused, and without it the goods are invisible between the two
stores — the same gap T-167's in-transit reservation closes within one store.

⚠️ **`1340` is a same-store, same-org movement.** Nothing crosses to the branch, no receivable, no
`1250`/`2150`. **T-173 is still the only place the two stores' books touch.**

## 6. Contract

```
trade_orders  -- new columns
  requested_by_store_id  uuid NULL -> stores     -- set when the BRANCH initiated it
  accepted_at, accepted_by
  ready_at, ready_by
  rejected_at, rejected_by, reject_reason

trade_order_lines  -- new columns
  requested_quantity  numeric(14,3) NULL         -- what the branch asked for
  fulfilled_quantity  numeric(14,3) NULL         -- what the commissary will send
  source_location_id  uuid NULL -> stock_locations
  origin       'requested' | 'commissary_added' NOT NULL default 'requested'
  approval     'not_required' | 'pending' | 'approved' | 'rejected' NOT NULL default 'not_required'
  is_ledger_only boolean NOT NULL default false  -- T-171 invariant 2's explicit column
  check (origin <> 'commissary_added' or approval <> 'not_required')
```

```ts
saveBranchOrderDraft / addLine / removeLine
submitOrder(id)                     // pre-submit hardening, invariant 2
acceptOrder(id) / rejectOrder(id, reason)
fulfilLine(orderId, lineNo, { quantity, rate, sourceLocationId })
proposeLine(orderId, input)         // commissary_added, lands pending
decideProposedLine(orderId, lineNo, 'approved' | 'rejected')
markReady(id)
dispatchOrder(id)                   // stock out -> 1340, §5
```

## 7. Invariants

1. **A branch order's counterparty resolves to `internal`** via `customers.counterparty_store_id`
   (T-133 §5). The treatment is derived, never stored, never a mode flag.
2. ⭐ **Submit is refused unless every line has:** `requested_quantity > 0`, a `branch_item_id` **or**
   `is_ledger_only = true`, and a resolved expense category. **All three, at submit** — not at
   receive.
3. **One open order per (branch, commissary) at a time.** Draft through dispatched blocks a new one;
   `received` and `void` do not. Enforced by a partial unique index.
4. **Accept seeds `fulfilled_quantity` from `requested_quantity`.**
5. ⭐ **A `commissary_added` line counts toward nothing until approved**: not the total, not the
   dispatch stock gate, and `markReady` is refused while any line is `pending`.
6. **Approving a `commissary_added` line requires a mapped `branch_item_id`** — the same rule as
   ordering, applied at the point the line becomes real.
7. ⭐ **Dispatch is refused if `fulfilled_quantity` exceeds the source location's on-hand.**
   Unknown or untracked counts as **zero** — fail closed.
   ⚠️ **The same predicate fails OPEN at receipt** (T-173), and the asymmetry is deliberate: an
   untracked item is the commissary's data problem, so refusing to DISPATCH makes them fix it,
   while refusing to RECEIVE punishes the branch for someone else's gap and leaves goods
   physically on their floor that the system will not admit exist (§9.1).
8. **Dispatch posts the `1340` movement in the same transaction as the status flip** (§5), and is
   period-locked.
9. **Void before dispatch posts nothing. Void after dispatch reverses the `1340` movement.**
   ⛔ **Void after receipt is refused** — T-173 owns that, and it is a discrepancy, not a void.
10. **The branch may edit only its own lines; the commissary only fulfilment fields.** Two roles,
    one document, and each field has exactly one owner.
11. **A stated rate on a line wins over the branch price** (T-151 invariant 6), and is **captured**
    on the line so a later price change never rewrites a dispatched order.
12. ⭐ **The category that lets an order be SUBMITTED is the same one the receipt POSTS with — one
    definition, never two.** v1 carries `hasFullCategory` for exactly this, shared by the
    submit block and the auto-book test; had they drifted, an order could pass submit while its
    lines were invisible to booking — the ₱12,184.71 failure by a second route (§9.2).

## 8. Tests

1. Submitting with a line whose `branch_item_id` is null and `is_ledger_only` false is refused,
   naming the line. The same order with `is_ledger_only = true` submits.
2. Submitting with no expense category is refused.
3. A second open order for the same pair is refused **by the database**.
4. Accept copies requested → fulfilled for every line.
5. ⭐ A `commissary_added` line: the order total is unchanged while `pending`, `markReady` is
   refused, and both become true only after approval.
6. Approving a proposed line with no branch map is refused.
7. Dispatching 20 with 18 on hand is refused; with an untracked item, also refused (fail closed).
8. Dispatch moves on-hand out of the source room and posts `Dr 1340 / Cr 1310` at FIFO cost —
   **and touches no `1250`, `2150` or branch account at all**, asserted explicitly.
9. Void after dispatch reverses the `1340` entry and returns stock to its own layers.
10. Void after receipt is refused, naming T-173.
11. A branch user editing `fulfilled_quantity` is refused; a commissary user editing
    `requested_quantity` is refused.
12. A line with a stated rate keeps it after `item_pricing` changes.
13. Dispatch into a closed period is refused.
14. Live route on 9008: place, accept, fulfil, propose a substitution, approve it, dispatch.
15. ⭐ **The fail-direction asymmetry, both halves in one test:** an item with NO tracked balance
    is refused at dispatch and ACCEPTED at receipt. A test of only the dispatch half would pass
    against an implementation that had copied the function and forgotten the flag.
16. An order whose line lost its expense category cannot be submitted — and the same predicate is
    what the receipt reads, asserted by using one helper in both.

## 9. ⭐ Read at source 2026-08-29 — two rules the summary did not carry

### 9.1 ⭐ The stock gate is fail-CLOSED at dispatch and fail-OPEN at receipt

`insufficientStockLines(lines, onHand, { treatUnknownAsZero })`, and v1 states the asymmetry in
its own comment:

> *"`treatUnknownAsZero` blocks items with no tracked balance (used at dispatch — the commissary
> must set inventory first); **leave it false at receipt so the branch isn't stranded by the
> commissary's untracked items**."*

⭐ **That is exactly right and the first draft had only half of it.** An untracked item is the
*commissary's* data problem: refusing to dispatch makes them fix it, refusing to *receive* punishes
the branch for someone else's gap and leaves goods physically on the branch floor that the system
will not admit exist.

⚠️ **Two different fail directions for one predicate, chosen per call site.** Copy the parameter,
not just the function.

### 9.2 ⭐ `hasFullCategory` — a SECOND pair of gates that must share one definition

The ₱12,184.71 incident (T-173) is about the *authority* gates drifting. There is a second shared
predicate right beside it, and it exists for the same reason:

```ts
hasFullCategory(m) = expenseEntryId && expenseCategory && expenseSubCategory
```

Used by **both** the order-submit block and the auto-book inclusion test. ⭐ If they drifted, an
order could pass submit while its lines were invisible to auto-book — silently unbooked AP again,
by a different route.

⚠️ In v2 the equivalent is T-172 invariant 2's pre-submit hardening: **the same resolved category
that lets an order be submitted is the one the receipt posts with.** One definition, or the bug
returns wearing different clothes.

### 9.3 The one-open-order statuses, exactly

`draft → submitted → accepted → fulfilling → ready → dispatched` all block. **Only `received`,
`cancelled` and `rejected` free the branch.** v1's reason for `dispatched` blocking: *"a dispatched
order is goods-in-transit not yet received, so it BLOCKS — the branch must confirm receipt first."*

⚠️ And it guards the **low-stock auto-order** too, which routes through the same create path
(T-175). A branch cannot accumulate auto-drafted orders it never submits.

## 10. Out of scope

⛔ **Confirm receipt and everything it posts.** T-173.
⛔ **Discrepancy resolution, settle, defer.** T-174.
⛔ **The order message thread.** T-175.
⛔ **A `branch_orders` table.** §2.
⛔ **Franchise (`inter_entity`) orders.** Still refused, naming T-133 §4 — no second org exists.

## 11. Done when

- [x] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
      `0070` (2026-08-29) carried the columns, the index and the submit trigger; **`0121`
      (2026-09-03) carried what building the functions found missing — §12.2.** ⚠️ The new columns
      are on an existing table: `trade_orders`' RLS policy is on `org_id`, which every new column
      shares a row with, so it carries; the one-open-order partial index was re-read against the
      derived stages (§12.1) and needs no change.
- [x] `classification.ts` already covers `trade_orders` (**PURGE**); the child rows follow it. No
      new table.
- [x] `typecheck` · `npm test` (904) · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first) — real numbers in the 2026-09-03 commit message.
- [x] `CAPABILITY-MATRIX.md`: `place_branch_order`, `fulfil_branch_order`, `dispatch_branch_order` —
      each with its ✗ test (`authorize.test.ts` sweeps every false cell; `branch-orders.test.ts`
      *"dispatch is manager+"* and *"invariant 10"* exercise them through the real functions).
      `dispatch` and `confirm_receipt` are separate; the receipt now authorises `confirm_receipt`
      at EITHER store on the order (§12.4).
- [x] `docs/ROADMAP.html` updated.
- [x] Live on 9008, 2026-09-03: draft → submit → accept → fulfil → propose → approve → ready →
      dispatch → receive through the real screens, stock moving at both stores — §12.6.

## 12. ⭐ Built 2026-09-03 — what shipped, and where the spec bent

Read this before §6. The contract was written on 2026-08-29 against a schema that then shipped
with three decisions the contract did not know about; building the functions on 2026-09-03 found
four more. Each is recorded here rather than silently absorbed (bible §3.4a).

### 12.1 The stages are DERIVED, not stored — no new status values

§9.3 lists `draft → submitted → accepted → fulfilling → ready → dispatched`. Migration `0070`
deliberately kept `status` at `draft | confirmed | dispatched | received | void` and added
`accepted_at`, `ready_at`, `rejected_at` instead — *"a status that changes nothing about the books
is a label, not a state."* So `branchOrderStage()` (`orders.ts`) is a function of the row:
`confirmed` is **submitted** until `accepted_at`, **accepted** until `ready_at`, **ready** after;
`void` with `rejected_at` is **rejected**, without it **cancelled**. "Fulfilling" is not a separate
stage — it is *accepted*, and the commissary packs in it. ⚠️ The one-open-order index blocks on
`status`, so every derived stage except received / rejected / cancelled blocks a second order,
exactly as §9.3 requires.

### 12.2 Migration `0121` — the three things `0070` did not enforce

1. **A fulfilled quantity of ZERO is a real answer.** v1's `markOrderReadyAction`: *"zero is the
   commissary's way of saying 'we couldn't fulfill this line'"*, and a rejected substitution is
   zero-fulfilled too. `0053`'s `line_total > 0` made both unrepresentable — the only way to send
   none of a line was to delete the branch's line, which invariant 10 forbids the commissary from
   doing. Relaxed for exactly that case: a line may total zero **only** when its fulfilled quantity
   is zero. A sale line still cannot bill nothing. `requested_quantity > 0` and
   `fulfilled_quantity >= 0` are now CHECKs as well.
2. **The submit-hardening trigger now guards DISPATCH too**: a branch order flips to `dispatched`
   only with `ready_at` set and no `pending` line — invariant 5's second half at the database.
3. **Stage shapes**: ready ⇒ accepted; accepted ⇒ a branch order; each timestamp travels with its
   person; a rejection carries who and why and is a `void`.

### 12.3 Names — one collision, three abbreviations

`transfer.ts` already exports **`dispatchOrder`** (the posting primitive, T-172/173) from the same
barrel, so the contract's `dispatchOrder(id)` is **`dispatchBranchOrder`** — it checks the stage is
*ready* and delegates every posting decision to `dispatchTradeOrder` (T-165). The contract's
`addLine / removeLine` are `addBranchOrderLine / updateBranchOrderLine / removeBranchOrderLine`.
Everything else is named exactly as §6: `saveBranchOrderDraft`, `submitOrder`, `acceptOrder`,
`rejectOrder`, `fulfilLine`, `proposeLine`, `decideProposedLine`, `markReady`.

### 12.4 Capabilities — five, not three, and the receipt's gate corrected

`place_branch_order` (branch side, **staff-open**), `fulfil_branch_order` (commissary side,
**staff-open**), `dispatch_branch_order` (**manager+**, the posting event). v1 gates none of the
order flow by role (only discrepancy resolution checks `isManager`); v2 keeps that for the
conversation and holds the one act that posts to `1340` to `dispatch_wholesale_order`'s bar.
⭐ **Invariant 10 is enforced by WHICH STORE a capability resolves at** — `place_` against
`requested_by_store_id`, `fulfil_`/`dispatch_` against `store_id` — not by a column rule. T-171's
`manage_commissary_offerings` and `manage_commissary_map` shipped alongside (DEF-129);
`import_commissary_catalogue` deliberately did not, because the import is unbuilt.

⚠️ **Found and fixed in `trade/index.ts`**: `receiveTradeOrder` authorised `approve_buyer` at the
*selling* store — so the branch cook T-173 invariant 8 exists for could never sign for a delivery,
and `confirm_receipt` had no caller at all. A branch order's receipt now authorises
`confirm_receipt` at either store on the order. `voidTradeOrder` likewise: before dispatch either
side may withdraw; after it, only `dispatch_branch_order` (a posting is being reversed).

### 12.5 What the build found, beyond the spec

- **`dispatchTradeOrder` could never say "untracked".** It filled the on-hand map for every line,
  so `dispatchOrder`'s absent-means-untracked branch never fired from the one path a real order
  takes; an item the commissary had never counted was refused as a plain shortage.
  `onHandByItemInStore` now returns `null` for an item with no movement at all, and the caller
  leaves it absent — §9.1's message is back. Test 15 caught it.
- **`lineCounts`** (`repo/trade.ts`) is ONE predicate — a line counts when `not_required` or
  `approved` — read by the total refresh (SQL), the dispatch and the receipt. A test asserts the
  SQL and the TypeScript agree.
- **"Ready" is un-said by any change.** A fulfilment edit or a new proposal after `markReady`
  clears `ready_at`; the commissary re-declares it. v1 had no such rule; the alternative is a
  truck loaded from a list that changed after it was declared final.
- **The category IS captured — but the perpetual receipt does not post with it.** Invariant 12
  holds at submit (the line's copy is what the receipt reads, and a map edited while the goods are
  on the truck does not reach it — tested). Under the perpetual shape, though, `confirmReceipt`
  debits the branch's inventory account by item KIND and never reads `expense_category_id`; the
  category becomes relevant when consumption posts COGS (T-164's `cogsCategory`, which has no
  per-item source of truth yet — DEF-125's own note). Logged here, not fixed: it is a cross-module
  question about what classifies COGS, not a T-172 gate.
- **The order may need an internal customer that does not exist.** `trade_orders.customer_id` is
  NOT NULL and names the branch through `customers.counterparty_store_id` (T-133). A branch with
  no such row cannot be ordered for; `saveBranchOrderDraft` refuses with a message, and the link
  screen (T-171 / DEF-129) creates the row when the link is saved, so a branch that may order
  always has one.

### 12.6 The live loop on 9008

Scripted headless Chromium through the real screens, signed in as the dev manager. Link → two
offerings (₱350, ₱200 manual costs) → two map rows through the catalogue screen; then, as Lipa,
draft 20 kg of pork from the Smoketest Commissary (priced ₱7,000 off the offering), add a second
line and remove it, submit, accept, fulfil 18 from a named room, propose 5 kg of a substitute,
**"Mark ready" refused on screen while the proposal was pending**, approve it, ready, dispatch,
receive. Two things the run found:

- ⛔ **The first dispatch was refused by the FIFO layers, not the gate**: the dev database's
  movement ledger held 29 kg of pork at the commissary while its `stock_layers` held one 15 kg
  delivery with 9 kg remaining — earlier smoketests left the two out of step, which is exactly what
  the `inventoryControlDoesNotMatchValuation` finding exists to show. Re-fulfilled to 8 kg and
  dispatched: commissary pork 29 → 21, substitute 11 → 6, `1340` up by ₱1,170 (13 kg at the ₱90
  layer cost).
- ⛔ **The first receipt threw** `stock_movements_source_pair_key` — DEF-140, fixed and re-run in
  the same session: Lipa's pork 4 → 17 kg, `1340` back to its prior balance, `1250`/`2150` each
  ₱3,800, Lipa `1310` +₱3,800 in two legs (₱2,800 + ₱1,000), `5175` credited the ₱2,630 margin,
  zero discrepancies, order `received` with total ₱3,800.

### 12.7 Still open, named not hidden

- **No `unmarkReady`** — a change un-says it (§12.5); there is no button to un-say it without one.
- **Fees.** `delivery_fee` / `other_fees` are not on the branch's form and post nowhere under the
  perpetual shape — DEF-127, unchanged.
- **The register's "New order" form takes three lines**; more are added on the order itself.
- **Phone-width rendering** is card-based (one `<form>` per line) by design, but was verified at
  desktop width only.
