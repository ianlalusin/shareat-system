# T-212 — Commissary and inventory KPIs

> **Status:** ✅ **SHIPPED 2026-09-05** (`f6350bd`, not pushed — Ian's call). Query layer, tests and
> the three dashboard tiles are all in. **Depends on:** T-211 (the dashboard
> route itself — shipped by `ianla-15` as `3e0089f`), Phase 3 Wave 2 (T-172/T-173/T-174,
> shipped). Named in `docs/plans/phase-6-reporting-and-dashboards.md` Wave 2, and inherited
> explicitly from `docs/plans/phase-3-inventory.md` §5.3 row 27 and §8, both of which defer
> *"commissary dashboard KPIs"* to Phase 6.

## Why this exists

Three figures a commissary manager needs and this app cannot currently show: **what is on the floor
right now**, **how much value is stranded in disputes and for how long**, and **how much actually
arrived this month**. v1 has all three in one card. Phase 3 deliberately deferred them here rather
than building a reporting surface mid-inventory-phase.

`docs/plans/phase-6-reporting-and-dashboards.md` §9 item 9 makes one of the three an explicit **exit
criterion for the phase**: *"A commissary dispute's AGE is on a screen — the thing whose absence let
4 of 9 pass 15 days unnoticed."* T-212 is the task that satisfies it.

## Discovery — the four-step method (bible §1.2d), in order

### 1. v1 at source

`ERP-rebuild/src/lib/actions/commissary-dashboard.actions.ts` (115 lines) →
`src/components/dashboard/CommissaryKpiCard.tsx`. Three parallel, filtered Firestore queries against
`branchOrders`:

| Query | Shape | Figure |
|---|---|---|
| In-flight | `status in ['submitted','preparing','ready','dispatched']` | count per status |
| Open disputes | `hasDiscrepancy == true` | count + `Σ discrepancyTotalAmount` |
| Month received | `status == 'received' && receivedAt >= monthStart` | count + **`Σ totalAmount`** |

It is a genuinely good file, and its own header says why: it replaced an unbounded full-collection
scan, and it argues correctly that *"each of the three things this widget shows is naturally
self-bounding… so there's no need for a write-side projection here."* ⭐ **That reasoning is right
and v2 keeps it** — this is not a counter to be dismantled, it is one of the few v1 dashboard
surfaces that already obeys Phase 6's own invariant.

### 2. The GOAL, written down (an unwritten goal can only be copied)

1. **In-flight** — *"what is in my inbox / on the floor"* for a commissary; *"what is outstanding
   upstream from me"* for a branch. v1's own words. The goal is **workload visibility by stage**,
   not a total.
2. **Open disputes** — *"how much value is stranded, and whose desk is it on."* The money is real:
   it sits in `1340 Inventory in transit` on the commissary's books until someone disposes of it.
3. **Month received** — *"how much value actually arrived this month."*

### 3. Count the live data

From `docs/discovery/26-reporting-dashboards-and-insights.md` §B.2/§B.4 and the phase-6 plan §6 Q3
(live-probed 2026-09-04 — **not re-derived here**, per the handoff):

- **9 open receiving disputes fleet-wide** — 5 at Lipa, 4 at Malvar. **4 of the 9 (44%) already
  exceed 15 days.**
- In-flight and month-received are self-bounding by lifecycle; no volume concern at any store.
- v1 ships **no age on a dispute anywhere** — not on the card, not on the list.

⭐ **The count is what makes goal 2 the important one.** A code comment in v1 argues a receiving
dispute needs no forced-resolution backstop because *"disputes get resolved."* That assumption is
~44% false today, and the reason nobody noticed is precisely that **the age was never on a screen.**
Goals 1 and 3 are maintenance; goal 2 has measured harm behind it.

### 4. Design v2 against the goal — the bar is more correct / more effective, not merely not-flawed

Four differences, each with its reason:

| # | v1 | v2 | Why |
|---|---|---|---|
| 1 | `monthReceivedTotal = Σ order.totalAmount` | `Σ (line.received_quantity × line.rate)` | ⭐ **The quirk this task was written to fix.** §B.4: a received order with a shortfall still holds its *dispatched* amount, so the figure overstates on any month with a discrepancy. **v2 never reads the order header for this figure at all** — reading lines is what makes the overstatement structurally unavailable, not a subtraction somebody can forget |
| 2 | Overstatement is silent | Dispatched, received and short-received are shown as **three numbers that add up** | Not merely correcting the figure — making the gap *legible*. A manager who sees "₱48,200 dispatched, ₱46,900 received, ₱1,300 short" learns something the single corrected number hides |
| 3 | Disputes have an amount, no age | Every open dispute carries **age in days**, bucketed `0–6 / 7–15 / >15`, oldest first | §9 item 9, the phase exit criterion. The 15-day boundary is not invented here — it is the same threshold v1's *wastage* backstop already uses, applied to the dispute type that never got one (plan §6 Q3) |
| 4 | Disputes found via a hand-set `hasDiscrepancy` flag on the order | The `trade_discrepancies` rows themselves, `status <> 'resolved'` | v2 has no flag to set or forget. The T-174 schema header states the property this relies on: the row is written by `confirmReceipt` in the same transaction as the posting, so *"a shortfall cannot exist in `1340` without a row naming it"* |

⛔ **Not adopted from v1:** the `byStatus` record pre-seeded with all eight statuses and zeros
(`STATUS_ZERO`). v2 has five statuses plus derived stages; a permanently-zero row in a KPI is the
defect class bible §16.9 names — *"report noise is a real control weakness, not a cosmetic one"* —
and the phase plan §5.1 already refused the same shape once for the scorecard's third term. **Stages
with no orders are absent, not zero.**

## Goal

Three commissary KPI figures, each a live SQL query over fact rows, each stating its basis, none
reading a stored total — available to the dashboard T-211 is building, and correct in the one place
v1 is not.

## Scope — files this task may create or modify

**New:**
- `packages/db/src/repo/commissary-kpis.ts` — the three query functions. New file, not an extension
  of `commissary.ts` (catalogue/mapping) or `trade.ts` (order lifecycle): these are reads with no
  writer, and `reports.ts`'s precedent is that reporting SQL lives apart from the lifecycle repo
  that writes the same tables.
- `tests/integration/commissary-kpis.test.ts`

**Modify:**
- `packages/db/src/repo/index.ts` (or the barrel this repo actually uses) — export the new module.
- `packages/db/schema/trade-discrepancies.ts` — **doc comment only, on `value`.** See "Found in
  passing" below. No column change, no migration.
- `docs/DEFECTS-REGISTER.md` — one section-E row for the same finding.

⚠️ **Explicitly NOT in this task's file list, and why:** `apps/erp/src/app/page.tsx`,
`apps/erp/src/components/dashboard/*`, `apps/erp/src/components/nav.tsx`. **`ianla-15` holds all
three uncommitted for T-211** (coordinated 2026-09-05). The tiles are §"Wiring" below — a separate,
last step taken **after** T-211 commits, on top of it, never merged over it.

**Do not touch:** `packages/domain/src/commissary/*` or `packages/db/src/repo/trade*.ts`. Every
figure here is a read over tables those already own. This task adds no writer and changes no
posting.

## Contract

All three take an `Executor` (a `Database` or an open `Tx`), never require a transaction of their
own — `reports.ts`'s established read-path convention.

```ts
export interface CommissaryKpiFilter {
  orgId: string;
  /** Omit or pass null for "every store the caller can see". */
  storeId?: string | null;
}
```

### 1. `inFlightOrders(ex, filter): Promise<InFlightStageRow[]>`

An order is in flight when `status in ('confirmed','dispatched')`. ⚠️ **`draft` is not in flight** —
nobody is waiting on it — and `received`/`void` are terminal.

⭐ **The stage is DERIVED from the timestamps, exactly as the order screens derive it — never a
sixth status.** Migration `0121`'s header is explicit that v2 has *"deliberately no new status
values"*, and `trade_orders_branch_stage_check` is the constraint that makes the derivation total:

| Stage | Predicate | v1's equivalent |
|---|---|---|
| `submitted` | `status='confirmed'` and `accepted_at is null` | submitted |
| `accepted` | `status='confirmed'` and `accepted_at is not null` and `ready_at is null` | preparing |
| `ready` | `status='confirmed'` and `ready_at is not null` | ready |
| `dispatched` | `status='dispatched'` | dispatched |

Returns one row per **non-empty** stage: `{ stage, orderCount, totalValue }`. `totalValue` is
`Σ order.total_amount` — correct here, because an in-flight order has not been received and its
header total *is* what is currently committed.

### 2. `openDisputes(ex, filter): Promise<OpenDisputeSummary>`

```ts
{ count, deferredCount, totalValue, oldestAgeDays, buckets: { fresh, ageing, overdue }, rows }
```

- **The set is `status <> 'resolved'`** — the identical predicate `tradeDiscrepanciesRepo.unresolved`
  and `blocking` use. ⭐ That file's own header states the invariant this must not break: *"`blocking`
  and `open` are the SAME query… One source, two consumers."* This KPI is a **third consumer of the
  same predicate**, not a third definition. A dispute that blocks a sales day and a dispute this tile
  counts must never be able to differ.
- **`deferredCount` is broken out, and a deferred dispute still ages.** A deferral is *"a promise to
  decide by a date, not an exemption"* (T-174 schema header). Its clock does not reset — hiding
  deferred rows from the count is how the 15-day breach becomes invisible a second time.
- ⛔ **Age is `((now() at time zone 'Asia/Manila')::date - created_at::date)`, never bare
  `current_date`.** DEF-172, migration `0112`'s own comment, and the trap list in
  `docs/HANDOFF-TODAY.md`: `current_date` follows the session timezone, so on a UTC server it is a
  full day wrong through Manila's early-morning hours. T-213's three date-comparing detectors use the
  Manila form; four older ones do not, which is DEF-172's open follow-up. **This task adds no new
  instance of the wrong form.**
- Buckets: `fresh` 0–6 days, `ageing` 7–15, `overdue` >15. `rows` oldest first, capped at 20 for the
  tile — ⚠️ **and `count`/`totalValue` are computed over the whole set, never over the capped rows.**
  A truncated total that looks total is the §2.2 failure this phase names by name.
- `totalValue` is **at cost**, and the caller must label it so. See "Found in passing".

### 3. `receivedInRange(ex, filter & { fromDate, toDate }): Promise<ReceivedSummary>`

```ts
{ orderCount, goodsReceivedValue, goodsDispatchedValue, shortReceivedValue, feesValue }
```

Over orders with `status='received'` and `received_at` inside the range (Manila-converted), joined to
their lines:

| Field | Derivation |
|---|---|
| `goodsReceivedValue` | ⭐ `Σ (l.received_quantity × l.rate)` — **the figure. Lines only; the order header is never read for it** |
| `goodsDispatchedValue` | `Σ l.line_total` — at dispatch `line_total` is re-derived to `fulfilled_quantity × rate` (`fulfilment.ts:132`), so this is genuinely what left |
| `shortReceivedValue` | `goodsDispatchedValue − goodsReceivedValue` |
| `feesValue` | `Σ (o.delivery_fee + o.other_fees)` — **stated separately, never blended in.** `trade_orders.delivery_fee`'s own comment: freight is *"ON TOP, never into the item's cost"*. v1's `Σ totalAmount` silently included it |

⚠️ **`goodsDispatchedValue + feesValue` is what v1 would have reported.** Keeping both on the return
is what lets the test below assert the two differ in the presence of a shortfall — which is how the
fix stays fixed.

## Invariants

1. **No figure on this surface reads a stored total for goods received.** `grep` for `total_amount`
   in `receivedInRange` must return nothing.
2. **The dispute set is `tradeDiscrepanciesRepo`'s predicate, not a copy.** If the two ever need to
   differ, that is a spec defect to report, not to implement (§3.4a).
3. **No bare `current_date` anywhere in this file.**
4. **No stage, bucket or row is emitted with a zero count** (bible §16.9).
5. Every count/total is over the full set; only display rows are capped, and the cap is not applied
   to any money figure (§2.2).
6. `numeric` in, decimal strings out — no float ever touches a money figure (bible §6).

## Tests — `tests/integration/commissary-kpis.test.ts`, real Postgres

⭐ **The load-bearing one, which is a regression test for the fix and not merely a coverage test:**

> Build one order, dispatch 100 units at ₱310, receive 90. `confirmReceipt` raises the discrepancy
> row itself, in its own transaction — the fixture must not hand-write one.
> - `goodsReceivedValue` === ₱27,900 (90 × 310)
> - `goodsDispatchedValue` === ₱31,000 (100 × 310)
> - `shortReceivedValue` === ₱3,100
> - ⛔ **and `goodsReceivedValue !== order.total_amount`** — the assertion that fails the moment
>   somebody "simplifies" the query back to the header total. That is the whole v1 quirk, pinned.

Plus:

1. **Two independent derivations agree.** `Σ(received × rate)` === `Σ line_total − Σ(discrepancy.quantity × line.rate)`. ⚠️ Assert this on an **above-tolerance** shortfall only: `RECEIPT_DISCREPANCY_TOLERANCE` means a tiny shortfall raises no row, and an *over*-receipt raises none either (`quantity > 0` check) — so equality is a property of the material case, not of every case. State that in the test name; do not assert it universally and do not "fix" the tolerance to make it universal.
2. **Fees stay out.** An order with a ₱500 delivery fee moves `feesValue`, not `goodsReceivedValue`.
3. **Stage derivation.** One order at each of the four stages → four rows; a `draft` and a `void`
   order appear in none of them; a stage with no orders is **absent, not zero**.
4. **Dispute ageing.** Rows created 3 / 10 / 20 days ago land in `fresh` / `ageing` / `overdue`, and
   `oldestAgeDays` === 20. ⚠️ **Pin the clock or the date arithmetic** — `reference_server_side_time_formatting_utc`: a test that formats or compares dates without a fixed TZ passes in Manila and fails in CI.
5. **A deferred dispute is still counted and still ages** — `deferredCount` 1, and it is in `count`.
6. **Store scoping.** `storeId` set returns that store's rows only; a second store's dispute never
   leaks. ⚠️ The dispute's `store_id` is the **COMMISSARY's**, not the branch's (T-174 invariant 11) —
   the test must assert the side it actually filters on, or it will pass for the wrong reason.
7. **The cap does not truncate a total** — 25 open disputes → `rows.length === 20`, `count === 25`,
   `totalValue` over all 25.

⚠️ **Do not run `npm run test:integration` on the shared `shareat_test` DB while a peer is busy**
(RULES §3.4 / row 94). Use a per-lane DB — `make-test-dbs.mjs` + `it.mjs`
(`reference_parallel_lanes_isolated_test_dbs`).

## Wiring — the last step, and it is deliberately last

Three tiles on T-211's dashboard: **In flight** (count, linking to the orders list), **Open disputes**
(count + oldest age in days — the age goes *on the tile*, not one click in), **Received this month**
(`goodsReceivedValue`, with `shortReceivedValue` as the basis caption when non-zero).

⛔ **Not started until `ianla-15` commits T-211.** Rebase onto that commit; never merge over an
uncommitted peer's `page.tsx`. If `ianla-15` would rather own the tiles inside T-211's grid, this task
ships the queries and tests only and hands over the call signatures — that hand-off is agreed and
costs T-212 nothing.

## ⚠️ Two corrections this spec needed, both found by running it (§3.4a)

Recorded rather than silently folded in, because both are cases where the spec above was a
**hypothesis that the data falsified** — and in both the first draft was wrong in the *same*
direction: it invented a shortfall that had not happened.

### C1 — INTERNAL orders only, and v1 gives no warning about this

v1 reads a `branchOrders` collection holding **nothing but** commissary→branch transfers; a franchisee
sale lives elsewhere entirely. **v2 keeps both in `trade_orders`**, told apart only by
`customers.counterparty_store_id`. And `receiveTradeOrder` sets `received_quantity` **only** on the
internal branch (`packages/domain/src/trade/index.ts:745`) — an external sale is marked `received`
with every line's `received_quantity` still NULL, because no branch takes those goods into stock.

⛔ **So the un-scoped query reports every external wholesale sale as 100% short-received.** Measured
on dev data 2026-09-05: **₱720 of a ₱1,420 apparent shortfall was two external sales that arrived
perfectly fine** — half the headline number was fiction. All three functions now carry the internal
scope; `openDisputes` deliberately does not (a discrepancy can only be written by `confirmReceipt`,
which is internal-only already, and adding the condition would break invariant 2).

⭐ This is bible §1.2b — *read v1 as requirements, never as design* — with a price tag. The query
**shape** ported cleanly and was still wrong, because v2 merged two collections v1 kept apart.

### C2 — `unrecordedValue`, a third bucket, because two were not honest

A NULL `received_quantity` is **not a zero receipt**. Besides external sales (now excluded), a
**ledger-only** line legitimately has one: `receiveTradeOrder` skips it on purpose (*"this line moves
no branch stock"*, `trade/index.ts:775,787`), so its value moved on the books with no stock receipt.

Folding that into `shortReceivedValue` invents a shortfall; folding it into `goodsReceivedValue`
claims a receipt nobody signed. **Both were tried; both are wrong.** `receivedInRange` therefore
returns four figures satisfying `dispatched = received + short + unrecorded`, which is also the
cleanest thing to assert in a test. Phase §2.2 — a figure whose basis is incomplete says so.

## Found in passing — logged, per bible §13 row 164

⭐ **`packages/db/schema/trade-discrepancies.ts:53` documents `value` as *"Quantity × the line's
transfer rate"*. The code writes it at COST**, and says so emphatically:
`packages/domain/src/commissary/transfer.ts:423-429` — *"AT COST, because that is what is actually
stranded in `1340`. ⚠️ Valuing the dispute at the transfer rate would make every disposal relieve
`1340` by more than the goods put into it."*

The comment's second sentence (*"What is stranded in `1340`"*) is right; its first is the opposite of
what the code does, and it is the sentence a reader uses to write arithmetic. **This spec's first
draft of `receivedInRange` used it and was wrong** — the corrected cross-check in test 1 multiplies
`discrepancy.quantity` by the *line's* rate rather than using `value`, precisely because `value` is
in the other measure.

This is the hazard `trade.ts:115-125` already names for this very table — *"a constraint changed in
SQL and not mirrored back into this file is invisible until someone trusts the file"* (DEF-095).
**Doc-comment fix + a section-E register row are in scope; the column and its arithmetic are correct
and are not touched.**

⚠️ **Also noted, not fixed:** the phase-6 plan §6 Q3 says Phase 6's contribution to receiving-dispute
ageing is a **`receivingDisputeOverdue` detector, attributed to T-213**. T-213 shipped eight
detectors and **that is not one of them** — `grep` over `findings.ts` confirms it is absent. This KPI
puts the age on a screen, which is the exit criterion; it does **not** put the dispute in `/findings`.
Whoever picks up T-214 or a T-213 follow-up should close it, and it needs one row in the register
rather than a silent gap between two shipped tasks.

## Out of scope — with reasons

- **A receiving-dispute forced-resolution backstop** — plan §6 Q3: the *control* is T-174's, not
  Phase 6's. This task makes the ageing visible; it does not force anything.
- **Low-stock and inventory-valuation tiles** — `lowStockRepo.lowStock` is already T-211's tile
  (its spec, line 84). Not duplicated here.
- **Anything reading POS receipt-grain data** — plan §6 Q1, unchanged.
- **`monthReceivedCount` as a headline figure** — kept as `orderCount`, but the money is the KPI; v1
  shows both and the count is the less useful half.

## Done when

- [x] `typecheck` clean.
- [x] `npm test` clean, no regressions.
- [x] Integration tests pass **on an isolated lane DB** — 15/15 on `shareat_test_lane25` (created
      2026-09-05), **not** the shared `shareat_test`, which `ianla-15` was running T-211/T-217
      against at the time.
- [x] Verified against **real dev data** by a read-only probe of all three functions before the tests
      existed — which is what caught C1. ⚠️ Not yet seen **on a screen**: the tiles are held for
      T-211's commit, so the on-9008 smoketest belongs to the wiring step, not to this one.
- [x] Self-reviewed line by line.
- [x] DEF-175 filed for the stale `value` comment; the comment fixed.
- [x] DEF-176 filed for the missing `receivingDisputeOverdue` detector.
- [x] Tiles wired onto T-211's dashboard, rebased on `ianla-15`'s commit `3e0089f` as agreed —
      three tiles, live-smoketested on 9008 (see above).
- [x] `docs/ROADMAP.html` T-212 row marked done and the Phase 6 chips refreshed, once the file was
      clear of the other session's in-flight edit.
- [x] This file's status line updated.
