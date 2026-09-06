# T-220 — The expired deferrals, the silent unit mismatch, and a guard for the class

> **Status:** ✅ **SHIPPED 2026-09-06** (ianla-25). **Closes:** DEF-184, DEF-185.
> **Files:** DEF-186 (new). **Source:** `docs/discovery/27-coverage-claims-sweep.md`.
> **Parallel lane:** `ianla-e2` holds T-221 (DEF-183's RLS migration) and the migration journal.
> ⛔ **T-220 adds no migration**, so the journal is never touched from here.

## Why this exists

The coverage sweep found four detectors promised by shipped tasks and absent from code. Three were
deferred honestly with a stated blocker, and all three blockers have since been removed by later
tasks with nothing to re-trigger the work (DEF-185, "the expired deferral"). The fourth was never
deferred at all — it was specified, half-built, and dropped (DEF-184).

⭐ **Researching them changed the answer. Two should be built; two should NOT**, and one of the two
refusals uncovered something worse than the missing detector.

## What research established, before any code

### 1. `commissaryUnitMismatch` — BUILD (DEF-184)

⚠️ **My own sweep description was wrong and the correction improves the design.** The register row
says the movement is *"written flagged"*. It is not: `confirmReceipt`
(`packages/domain/src/commissary/transfer.ts:358-365`) `continue`s **before** pass 2's write loop, so
a unit-mismatched line gets **no `stock_movements` row and no layer at all**. Skipping is correct and
deliberate — *"adding commissary-denominated qty onto a branch balance the branch reads in its own
unit is exactly the corruption we're preventing"*, and debiting `1310` for goods the stock ledger
never received puts account and subledger permanently out of tie.

**The defect is the silence, not the skip.** The line pushes onto `unitMismatches`, which
`confirmReceipt` returns and **every production caller discards** — `receiveTradeOrder`
(`trade/index.ts:833-834`) reads `.ok` and `.entryId` and nothing else. `grep` finds `unitMismatches`
in 4 test assertions and no production code.

⭐ **So detect the CONSEQUENCE, not the cause.** The cause is transient and disappears the moment
someone fixes the item's base unit — while the goods stay missing from the balance forever. The
consequence is persisted and exact:

> A line on a `received` trade order, **not** `is_ledger_only`, with `received_quantity > 0`, that
> has **no `stock_movements` row** (`source_type = 'trade_order_receipt'`, `source_id` = the line id).

⚠️ Every other reason a line lacks a movement is excluded by construction: a ledger-only line by the
flag; a rejected substitution or zero-fulfilled line because `receiveTradeOrder` never reaches
`setLineReceivedQuantity` for it, leaving `received_quantity` NULL. ⭐ This also survives the base
unit being corrected later, which is the entire point.

### 2. `grniNotAtRest` — BUILD

T-163 deferred it because *"there is no receipt document yet to age"*. **T-166 shipped delivery
documents**, and `GRNI_ACCOUNT = '2120'` is live in
`packages/domain/src/stock/receipt-posting.ts:73`. Blocker expired.

⚠️ **This section originally said "by party, the same shape as `supplierCreditAgeing`", and the
database refused it.** `2120` is deliberately **not** a party-requiring account (T-118 set
`requires_party` on exactly nine control accounts; this is not one), and `postReceiptValue` writes
*"one credit to 2120 for the whole receipt — the per-item detail is the layers, which is the
subledger; splitting the credit would put detail in two places and tie neither."* The first draft's
`group by party_id` was rejected outright by `journal_lines_check_party_requirement`. ⭐ **Corrected
shape: a pooled PER-STORE balance, aged by a FIFO walk over its own credits** — the same shape
`serviceChargeFloatAgeing` uses for the same reason. Recorded rather than quietly amended: the spec
was wrong and the constraint caught it before it shipped.

### 3. `commissaryDiscrepancyOpen` — ⛔ DO NOT BUILD

**T-218 already ships `receivingDisputeOverdue`**, the same set (`status <> 'resolved'`) aged past 15
days. The T-174 variant is *all* open discrepancies at any age — which fires on **every ordinary
short receipt the day it happens**. A shortfall reported this morning is normal trade, not a lapse;
T-135's model is that a finding is something wrong, and bible §16.9 names report noise as a real
control weakness.

⭐ **T-174's own note already removed the reason to build it**: *"The day-open block does not depend
on the finding — it queries `tradeDiscrepanciesRepo.blocking` directly, which is the same query the
screen will list from."* So the block is covered, the screen is covered, and the ageing lapse is
covered by T-218. **Nothing is left for this detector to do.** Recorded as a decision, per T-213's
precedent of confirming non-duplication before adding.

### 4. `autoOrderFailed` — ⛔ DO NOT BUILD, and the reason is DEF-186

`replenishAfterUsage` returns `failed: string | null` and **persists nothing**, so there is no state
for a derived detector to read. That alone would make it unbuildable under T-135's derived-not-stored
model.

⛔ **But the real finding is bigger: `replenishAfterUsage` has ZERO production callers.** `grep`
across `packages/` and `apps/` finds it in exactly three places, all inside
`packages/domain/tests/integration/low-stock.test.ts`. **The low-stock auto-order never runs.**

Its own header explains the first half honestly — *"deliberately NOT called from `postUsageRecord`.
That function takes a `tx` it does not own, so it is structurally incapable of running anything after
the commit"* — and that reasoning is correct. It was simply never wired anywhere else afterwards.

⚠️ So a detector here would report on a code path that never executes: **exactly the vacuous
detector T-161 refused** (*"registering a detector that cannot fail is T-134's own vacuous-pass
lesson"*). Filed as **DEF-186**; wiring the caller is not this task's job and needs Ian's call on
where the seam belongs.

## Scope — files this task may touch

**Modify:** `packages/db/src/repo/findings.ts` · `packages/domain/src/findings/index.ts` ·
`packages/domain/tests/integration/findings.test.ts` · `docs/DEFECTS-REGISTER.md` (DEF-184/185
closed, DEF-186 filed) · `docs/ROADMAP.html`.

**New:** `tests/unit/deferral-staleness.test.ts` (§C).

⛔ **Do not touch:** any migration or `migrations/meta/_journal.json` (`ianla-e2` holds idx 129) ·
`packages/db/src/rls/registry.ts` · `packages/domain/src/commissary/*` · `trade/index.ts`. ⚠️ Fixing
the *cause* of DEF-184 — persisting the mismatch or wiring the caller — is deliberately **out of
scope**; this task makes it visible.

## Contract

### A. `commissaryUnitMismatch(tx, orgId)` → `DetectedFinding[]`

Per branch store. `severity: 'hard'` — ⚠️ **unlike the other ageing detectors, and deliberately.**
Goods are physically at the branch, paid for, and absent from its stock ledger; every valuation and
usage figure for that item is wrong until it is fixed, and the money is stranded in `1340`. That is a
books-do-not-reflect-reality fault, which is what `hard` means here.

`drillTo`: `/commissary/orders`. Detail names the branch, the item, the quantity signed for, and the
value still in transit.

### B. `grniNotAtRest(tx, orgId, thresholdDays = 30)` → `DetectedFinding[]`

A pooled **per-store** `2120` balance whose oldest uncleared credit is older than the threshold — a
receipt whose invoice never arrived. ⚠️ Per store, not per supplier — see §2. `severity: 'soft'` (an
ageing prompt). ⛔ Manila via `MANILA_TODAY` and `daysBetweenDates` from `./sql-time`, with
`manila_today` carried back as a column so gate and age share one clock; the T-218 guard fails the
build otherwise.

### C. The deferral-staleness guard (DEF-185) — the item that stops this recurring

⭐ **This is the deliverable that outlives the two detectors.** A deferral is a promise with a
precondition, and nothing in this project watches preconditions: T-166 shipped delivery documents
with no idea it owed T-163 a detector.

**The convention**, deliberately the smallest thing that can work: a task doc's deferral may name its
blocker on one line, in a form a machine can check —

```
<!-- STALE-IF-EXISTS: apps/erp/src/app/inventory/low-stock -->
```

`tests/unit/deferral-staleness.test.ts` scans `docs/tasks/*.md` for those markers and **fails when
the named path exists**, because the deferral claims it does not. ⚠️ The marker is
`STALE-IF-EXISTS`, not `STALE-IF` — the name says which direction fails.

⚠️ **Adopt-by-example, not by retrofit.** The three deferrals this task resolves get markers as
worked examples; ⛔ the other ~40 do **not** get back-filled. A convention proves itself on new
writing, and back-filling 40 markers is the same manufactured-assurance mistake the sweep warned
against.

⚠️ **The guard must be seeded with at least one real marker and confirmed failing**, or it is a
vacuous pass — the exact failure this whole line of work is about.

## Invariants

1. No detector fires on a state that is normal business (§3's reasoning).
2. No bare `current_date`, no `Date.now()` — T-218's guard covers `findings.ts`.
3. Every new detector is **registered** in `findingsFor` and proven reachable by a test that goes
   through `listFindings`, not by calling the repo function directly.
4. Both refusals (§3, §4) are recorded as decisions with reasons, not silently skipped.

## Tests

Each detector: fires when true, **does not** fire when absent (T-135 invariants 1–2), and is
reachable through `findingsFor`.

- `commissaryUnitMismatch`: a received line with `received_quantity` set and no movement fires; ⛔ a
  **ledger-only** line with no movement does **not**; a normally-received line with a movement does
  not.
- `grniNotAtRest`: a `2120` balance aged past the threshold fires; one inside it does not; one
  cleared by an invoice does not.
- The staleness guard: confirmed **failing first** against a real marker.

⚠️ Ages pinned to **Manila noon** (DEF-178's lesson). ⚠️ Integration on an isolated lane DB
(`shareat_test_lane25`), announced first — one heavy process at a time, and `ianla-e2` is on lane15.

## Done when

- [x] Two detectors ship, registered, both-direction tests — **44/44** on lane25. Verified by
      unregistering both: exactly the 2 positive tests fail.
- [x] Two refusals recorded with reasons (DEF-185's row, and §3/§4 above).
- [x] DEF-186 filed — `replenishAfterUsage` has zero production callers.
- [x] Staleness guard ships, **confirmed failing first** on two real markers, which surfaced that
      T-174 and T-175 both claimed built routes as unbuilt. Both docs corrected.
- [x] Markers: 2 stale (now resolved) + 1 live sentinel. ⚠️ The other ~40 deliberately unmarked.
- [x] ⚠️ **The database corrected the design**: `2120` is not a party-requiring account, so the
      first `grniNotAtRest` draft's `group by party_id` was refused by
      `journal_lines_check_party_requirement`. Rewritten as a pooled per-store FIFO.
- [ ] typecheck · unit · integration (lane DB, announced) · build (announced) · smoketest `/findings`.
- [ ] DEF-184, DEF-185 closed. Roadmap + this status line updated.
