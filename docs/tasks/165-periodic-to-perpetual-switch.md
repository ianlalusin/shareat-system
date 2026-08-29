# T-165 — ⭐ The switch: six shipped modules move to the perpetual shape

> **Status:** ✅ **UNBLOCKED 2026-08-29 — ADR-011 accepted, bible row 165.** Ian: *"let's build it
> right for v2 … so when we test the app we are testing its final deliverable shape and won't need
> to adjust later."* **Retro-fit, one shape, no dated split and no boundary constant.**
> **Depends on:** T-160 – T-164, all of them, and **all shipped together with this one**.
> **This is the last task of Wave 0 and it is the point of Wave 0.**

## 1. Goal

The system stops being periodic. One posting shape exists in the codebase, Phase 3's exit gate —
**inventory control account = sum of on-hand valuations** — becomes checkable, and §16.7 defect #5
closes.

## 2. ⚠️ This task cannot be split, and that is the single most important line in it

Retro-fitting T-122 alone would debit `1310` for food with no stock ledger to relieve it. **The
P&L would show no food cost at all** — worse than the periodic shape it replaces.

> **T-160 – T-165 ship as one deploy, or none of them do.** ADR-011 §4 states this as the reason
> Wave 0 is atomic; it is restated here because this is the task a well-meaning agent would try to
> land incrementally.

## 3. ⭐ Why this costs no data migration, and why that is temporary

`packages/db/src/cutover/classification.ts`, read this session:

| Table | Class |
|---|---|
| `journal_entries`, `journal_lines`, `expenses`, `expense_payments`, `sales_days`, `trade_orders` | **PURGE** |
| `items`, `item_pricing`, `store_item_sellability`, `supplier_items`, `expense_categories` | **KEEP** |

**Every peso posted under the periodic shape during the Oct–Dec pilot is deleted on 1 January**
(ADR-007; bible row 106: *"v2 may ALWAYS assume a zero starting point"*). This is a **code** change
against **zero** production rows.

⚠️ **That will not be true again.** After 1 January the same change is a restatement.

## 4. What moves — the six modules, verified at source

| Module | Today | After |
|---|---|---|
| **T-122** expenses | `expense_categories.account_code` → `5110`/`5120`/… on approval (`packages/domain/src/expenses/routing.ts`) | A COGS-group expense **carrying stock lines** routes through T-163: `Dr 1310/1320/1330 · Cr` funding or `2110`. ⭐ **A COGS expense with NO stock lines still debits `5xxx`** — there is nothing to capitalise, and the seed's own "COGS without a delivery" case survives untouched |
| **T-130** AP | Credits `2110`; debit is the expense's | Unchanged on the credit side. Gains the `2120` → `2110` true-up path (T-163 §3) |
| **T-145** invoice lines | Price history only | Also the layer's source — quantity received × landed unit cost |
| **T-151** landed cost | Feeds `item_pricing` | Also feeds `stock_layers.unit_cost`. ⭐ **The derivation does not change**; it gains a second consumer |
| **T-132** trade orders | Sale: `4xxx` revenue + `1210` | **Plus** `Dr 5xxx COGS · Cr 1310/1330` at dispatch — the goods leave, and until now nothing said so |
| **T-133** internal transfer | `5175` seller-credit / `5170` buyer-debit + `1250`/`2150` | **`1330` seller-credit / `1330` buyer-debit** + `1250`/`2150`. ⭐ Already written in `POSTING-PATTERNS.md` as *"⛔ The Phase 3 target — inventory movement, NOT live"* |

### ⭐ UPDATE 2026-08-29 — the perpetual side is already BUILT, so this task is a rewiring

T-172/T-173 shipped `dispatchOrder` and `confirmReceipt` (`packages/domain/src/commissary/
transfer.ts`) with 20 green integration tests. They post the target shape below **and nothing
calls them**. So this task's commissary row is no longer *"write the perpetual transfer"* — it is:

1. point `dispatchTradeOrder`'s `treatment === 'internal'` branch at `dispatchOrder`;
2. give the receipt path a caller for `confirmReceipt` (today `receiveTradeOrder` records who
   signed and posts nothing — under perpetual that is where **both stores** move);
3. delete the `5170`/`5175` legs from `trade/index.ts`, keeping the accounts (§4).

⛔ **Until then both shapes exist in the tree and must not both run for one order** — the transfer
would be counted twice, once through the P&L and once through the balance sheet, and **the trial
balance would still tie**, so nothing would announce it. The warning is carried in both modules'
headers and in `POSTING-PATTERNS.md` §`commissary_dispatch.transfer`.

⚠️ **`1340` is the piece the periodic shape had no room for.** The old pattern posts once, at
dispatch, because there was no asset to track in between. Perpetual has one — goods on a truck are
still the commissary's inventory — so the switch also turns one event into two.
### ⚠️ T-133's `5175` does not get deleted

`5175 Cost transferred to branches` is the contra-COGS the chart demanded since T-102b, and under
the perpetual shape an **internal** transfer stops using it — inventory moves instead of cost.

⛔ **Do not delete or archive the account.** ADR-008 §4 / bible row 111: a dispatch to a
**franchise** crosses a legal-entity boundary and recognises revenue and COGS. That pattern is not
built (no second org exists) and `5175`'s elimination role is still the right shape when it is.
**Leave it active with its comment intact.**

## 5. ⭐ There is no boundary — decided, and the absence is the design

**One shape, from v2's first posting.** ⛔ **No `PERPETUAL_FROM` constant, no date branch, no second
posting path, and no era labels in `POSTING-PATTERNS.md`.**

Three facts make the absence correct rather than lazy:

| | |
|---|---|
| **The purge** | Every pre-2027 v2 entry is deleted (§3). There is no periodic era in the books for a branch to serve |
| **The close rule** | Row 103 — once January closes on 15 February, nothing may be dated before it |
| ⭐ **The pilot** | Ian's own reason: *"when we test the app we are testing its final deliverable shape."* A branch would mean the pilot exercises a shape that will not exist |

> ⛔ **Do not add a date branch "just in case."** A dead branch nobody can test against data that
> does not exist is worse than no branch — it looks like a supported path, and the next reader
> cannot tell that it is not.

⚠️ **What this does change is the deadline.** ADR-011 §3.1: the practical date is not 31 December,
it is **before the Oct–Dec pilot meaningfully exercises inventory** — because a pilot on the wrong
shape produces findings about a system that will not ship.

## 6. Scope

**Modify:** `packages/domain/src/expenses/routing.ts` · `packages/domain/src/expenses/approve.ts` ·
`packages/domain/src/ap/index.ts` · `packages/domain/src/trade/dispatch.ts` ·
`packages/db/seed/expense-categories.ts` (the comment that names this task) ·
`packages/etl/src/leg-mapping.ts` **only if** the mirror test demands it ·
`docs/POSTING-PATTERNS.md` (`commissary_dispatch.transfer` — the Phase 3 block becomes live) ·
`tests/worked-examples/fixtures.ts` · `packages/db/src/repo/findings.ts` ·
`packages/db/migrations/<next>_t165_switch.sql` (tighten T-161's `journal_entry_id` CHECK) ·
`docs/ROADMAP.html`

**Create:** `packages/domain/tests/integration/perpetual-switch.test.ts` ·
`packages/domain/src/stock/valuation-tie.ts`

⛔ **Not `PROJECT_BIBLE.md`** (§14). ✅ Its amendment is already applied — v3.0, rows 165–166,
recorded in ADR-011 §8. **Nothing further is owed to it by this task.**

## 7. Invariants

1. ⭐ **Σ (every inventory account, `1310`–`1340`) = Σ (open layer `remaining_quantity` ×
   `unit_cost`), per org, continuously.** Phase 3's exit gate; invariant 6's inventory arm; a
   finding, not a report. ⚠️ **Write the detector over the whole `1300` range, not the three
   accounts funded today** — `1340` is funded by T-172's dispatch in Wave 2, and a detector that
   enumerates today's accounts silently stops covering the range when the fourth arrives.
2. **Every stock movement whose kind posts value carries a `journal_entry_id`** — T-161 invariant 9
   tightened from nullable to a CHECK against the kind list.
3. **No path debits a `5xxx` COGS account for goods that entered inventory.** The `5xxx` debit
   happens at consumption and nowhere else. ⚠️ The exception is deliberate and narrow: a COGS-group
   expense with **no** stock lines (a caterer's invoice, a one-off ingredient bought and used the
   same hour). It debits `5xxx` directly, because there is no stock to capitalise.
4. **No path debits `1310`/`1320`/`1330` without creating a layer.** An inventory debit with no
   layer behind it breaks invariant 1 silently and is exactly the failure the gate exists to catch.
5. **`2120` nets to zero** once every receipt in a period is invoiced. A standing balance is a real
   fact (uninvoiced goods), not an error — but an **ageing** one is a finding (T-163).
6. **`1250` still equals `2150`** after the transfer pattern changes — invariant 6's reciprocal
   check must survive the shape change untouched.
7. **The trial balance ties, and the accounting equation holds**, before and after the switch, over
   the full worked-example corpus.
8. **`5175` stays active** — §4.

## 8. Tests

1. ⭐ **The gate:** a fixture of 4 stores, ~40 receipts, ~120 consumptions, wastage and a count.
   Assert `Σ 1310+1320+1330` equals `Σ` open-layer value **to the centavo**. This is the assertion
   Phase 3 exists to be able to make.
2. Every T-108 worked example still posts identically — nothing outside inventory moved.
3. A COGS expense **with** stock lines debits `1310`; the **same** expense without lines debits
   `5110`. Both in one test, so the distinction cannot be lost in a later refactor.
4. Ian's T-133 case under the new shape: 100 kg at ₱300, processed at ₱10/kg, transferred at ₱310.
   `1330` moves ₱31,000 seller→buyer, `1250`/`2150` are equal and opposite, **no `5170`/`5175`
   line**, and the buyer's COGS appears only when it consumes.
5. A trade-order dispatch to an **external** customer posts revenue, receivable **and** COGS +
   inventory relief — three things where T-132 posted two.
6. `2120` nets to zero across the fixture once every invoice is linked.
7. A stock movement of a value-posting kind with a NULL `journal_entry_id` is refused **by the
   database**.
8. An inventory debit with no matching layer is caught by the `inventoryControlDoesNotMatchValuation`
   detector — asserted by constructing one deliberately.
9. Trial balance ties and the accounting equation holds over the whole corpus.
10. ⛔ **The negative test that proves §2:** disabling the consumption posting while leaving the
    receipt posting enabled produces a P&L with **zero COGS**. Asserted, so the reason Wave 0 is
    atomic is in the test suite and not only in this document.

## 9. Out of scope

⛔ **Amending `PROJECT_BIBLE.md`.** ADR-011 §8 proposes it; only the Opus planner applies it, and
only once Ian has answered.
⛔ **The franchise dispatch pattern.** ADR-008 §4, row 111, and T-133 §4 all say why: no second org.
⛔ **Any Wave 1–3 module.** They are built against the shape this task establishes.
⛔ **A migration of pilot data.** §3 — there is none, by design.
⛔ **Changing the FIFO method, the opening-count decision, or the January cutover date.** Rows 110,
109 and ADR-005 respectively.

## 10. Done when

- [x] ~~ADR-011 answered and recorded in the bible's decision log.~~ ✅ **Done 2026-08-29 — rows 165
      and 166, bible v3.0.** Nothing further is owed here; ⛔ this task still does not amend the
      bible itself (§14).
- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `POSTING-PATTERNS.md`'s `commissary_dispatch.transfer`: the ⛔ *"Phase 3 target"* block becomes
      **the live pattern**, and the periodic block is relabelled as historical with its date.
      ⚠️ `npm run toc`.
- [ ] `inventoryControlDoesNotMatchValuation` registered in `repo/findings.ts` and **green on a
      populated fixture** — not vacuously on an empty one (T-134's own lesson).
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first — Wave 0 touches shared schema and the migration journal).
- [ ] ⭐ Smoketested on 9008: receive goods, consume them, and read a P&L where **gross margin is
      the margin on what was sold**.
- [ ] `docs/ROADMAP.html` updated, and `docs/DEFECTS-REGISTER.md` §16.7 #5 and #6 marked closed with
      the closing tests named.
