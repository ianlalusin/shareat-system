# Phase 3 — Inventory, valuation, and the commissary ↔ branch pipeline

| | |
|---|---|
| **Status** | Planned 2026-08-29 (Opus planner). ✅ **UNBLOCKED the same day — ADR-011 accepted, bible rows 165–166** (§1.1) |
| **Governed by** | `PROJECT_BIBLE.md` §10 (Phase 3), §16.1 invariants 4/6/7, §16.11, and rows 106, 109, 110, 111 |
| **Research — §3.6 satisfied, and NOT repeated** | `docs/discovery/14-capabilities-inventory.md` (the capability inventory this plan is the answer to) · `docs/discovery/20-expense-delivery-inventory-shape.md` (four reference systems read at source) · `ADR-009` (cost is the spine) |
| **Decides against** | **ADR-011** (perpetual, retro-fit, no dated split — ✅ accepted) · ADR-009 · ADR-008 §8 (one order flow, two treatments) · ADR-005 (amended: the valuation core is in January's scope) |
| **Prerequisite** | Phase 2 Waves 0–3. ⚠️ **T-121 is decided-but-unbuilt (DEF-053)** and T-130 is spec-ready. Phase 3 must not start by repeating that mistake |

---

## 1. Objective

Give the business back the half of its operation that Phase 2 does not touch — **what is on the
shelf, what it cost, and how a branch gets more of it** — and in doing so close the last of the
ten invariants that has never been checkable.

Phase 3 is where **operational truth and financial truth meet.** Everything before it moved money.
This moves goods, and makes the money follow them.

### The two things this phase exists to fix

| | |
|---|---|
| **§16.7 defect #5** | *"No inventory valuation at all — COGS is purchase-basis rather than consumption-basis; count adjustments have no GL effect. **Gross margin is wrong**; stock is not an asset on the balance sheet"* |
| **`CAPABILITY-GAPS.md` §2** | The commissary ↔ branch pipeline — **~24 capabilities that straddled Phases 2 and 3 and were owned by neither.** For a branch store, this *is* how inventory gets replenished. It got lost precisely because it was half AR and half stock |

### 1.1 ✅ Answered 2026-08-29 — perpetual, one shape, and the reason is the pilot

**ADR-011 asked one question**: do the six shipped modules retro-fit to perpetual, or does a dated
cutover split periodic-before from perpetual-after? **Ian:**

> *"For inventory let's build it right for v2 — everything in v1 plus the inventory being asset and
> used. That's the model of v1, it just was not realized… Everything is anchored in inventory: the
> expense, delivery, usage, wastage etc. So when we test the app we are testing its final
> deliverable shape and won't need to adjust later."*

**Retro-fit. One posting shape. No dated split, no boundary constant, no two-era
`POSTING-PATTERNS.md`.** Bible row 165; §16.11 rewritten; ADR-005's January scope amended.

⭐ **The justification is testability, and it moves the deadline.** My recommendation argued the
boundary from period-close mechanics; Ian's argument is simpler and better — *a pilot that
exercises an interim shape has not rehearsed anything.* So the practical date is not 31 December,
it is **before the Oct–Dec pilot meaningfully exercises inventory.**

⭐ **And the framing settles the four verbs for the whole phase.** *"That's the model of v1, it just
was not realized"* — read as §1.2b requires, **v1 has always been a perpetual system that could not
perform**: it records quantities, it links a cost through an expense, it simply never posted the
asset. **This phase is CORRECT, not ADD.**

> **Wave 0 is the only part of Phase 3 that has a date.** Waves 1–3 are Q1 work behind feature
> flags, and they need no adjustment when they land because each posts into the spine Wave 0
> establishes.

### 1.2 ⭐ A second decision arrived with the answer — returns are credits

Bible **row 166**, and it was not a question this plan asked:

> *"Supplier returns must be recognized as store credit for us that we can use for next purchase —
> that's for external suppliers. Us being the supplier to other customers, return to us must be
> treated the same I guess: store credit customer may use, or we refund."*

**It closes `CAPABILITY-GAPS.md`'s standing *"Needs Ian"* on supplier returns** (T-170 respecified:
`1240 Advances to suppliers` when the receipt was invoiced, `2120` when it was not) **and opens a
capability nothing had ever owned** — the customer side, now **T-179**: `2140 Customer store credits
payable`, or a refund.

⚠️ **T-179 could not have been found by any capability inventory**, because v1 cannot do it. It is
the fourth verb — **ADD** — and the first one this phase has.

---

## 2. Why this order, and the top of it is not negotiable

| | What | Why it comes first |
|---|---|---|
| **0** | **The valuation core** — locations, stock ledger, FIFO layers, the postings, the switch | It is the **posting shape**. Every module below writes into it, and a module built against the wrong shape is rework, not progress. It is also the only part with a deadline (§1.1) |
| **1** | **The operational surface for a single store** — receiving, transfers, usage, counts, returns both ways | The stock ledger with no way to move stock is a table. These are the six doors, and every one of them is a prerequisite of Wave 2 |
| **2** | **The commissary ↔ branch pipeline** | The largest deliverable, and it depends on Wave 1 existing at **both ends** — a branch receives into its own locations, a commissary dispatches out of its own. It cannot come earlier |
| **3** | **Production, POS usage pull, channel wastage** | Real, named, and none of them blocks another. They are the tail, not the spine |

> ⭐ **The one sequencing rule worth stating on its own:** the valuation core ships as **one
> switch**, never module by module. Retro-fitting expenses to debit `1310` before a stock ledger
> exists to relieve it would show **no food cost at all** in the P&L — worse than the periodic
> shape it replaces. ADR-011 §4 states this as the reason Wave 0 is atomic.

---

## 3. Decisions taken from the research

All four were reached in `docs/discovery/20` and `ADR-009`, and all four are adopted. They are
restated here because a plan that only cites its research makes the next reader go and get it.
⭐ **A fifth, §3.5, did not come from the research at all** — it came from Ian, after this plan was
first written.

### 3.1 A receipt posts value immediately — through a clearing liability, not AP

`Dr 1310/1320/1330 · Cr 2120 Goods received not invoiced`, at the typed unit cost. The supplier
invoice, arriving later, **corrects** `2120` into real AP. This is ERPNext's GR/IR shape
(`stock_received_but_not_billed`) riding on one document instead of two.

⭐ **`2120` already exists**, seeded `reserved` (`chart-of-accounts.ts:183`). ADR-009's amendment
asked for exactly this account and it was provisioned and never activated.

**What this closes:** ADR-009 measured expensing at 91% → 86% → 89% → **76%** of deliveries, worst
in the most recent month, because *"expensing LAGS delivery."* A receipt that posts its own value
makes the lag an accuracy question instead of a completeness one. **The books are never blind.**

### 3.2 ⛔ NOT a two-document Purchase Receipt / Purchase Invoice chain

Discovery 20 named this the thing to skip, and ADR-009 said why: ~30 deliveries a month, one
supplier line each, no formal PO matching. **One document, two postings.** Three of four reference
systems split it; this business does not have the problem the split solves.

Also deliberately skipped, each with its reason in discovery 20's *"What NOT to adopt"*: ERPNext's
**Landed Cost Voucher** doctype (T-151 allocates by value in a query instead) · a full **N-UOM
conversion table** (one purchase unit per item is how this business buys) · **three-way PO→PR→PI
matching** (staff-entered on the spot, no counterparty to match against) · Odoo's
**multi-warehouse reposting engine** (bible row 110 adopts the layer concept, not the engine).

### 3.3 Cost-confirmation is DERIVED, never a stored boolean pair

v1's `isExpensed` / `partiallyExpensed` are hand-set at **three independent call sites**. ERPNext's
`per_billed` and Odoo's `invoice_status` are re-derived and never written.

**This is DEF-075's pattern for the seventh time** — a stored balance beside the ledger. It is
also the exact shape that let v1's AP tile drift for months while looking live. A delivery line's
cost-confirmation state is a **query** over provisional-cost-posted vs linked-invoice-amount.

### 3.4 One transaction, in the direction of causation

v1's void cascade is **explicitly non-atomic, accepted risk OC-14**, by its own code comments.
Discovery 20 §4: no reference system chose that shape; it is a Firestore constraint, and the
constraint is gone.

⭐ **The cascade's *shape* is right and is kept** — voiding the root event auto-voids what it
caused, so a human never has to unwind four documents in the right order. Only the mechanism
changes: one Postgres transaction, `reverseEntry` for the postings, committed together or not at
all.

### 3.5 ⭐ A return is a credit, in both directions — bible row 166

Not from the research. Ian's answer, and it changed one spec and created another.

| | Goods **we** return to a supplier | Goods **a customer** returns to us |
|---|---|---|
| **Receipt/sale not yet invoiced or paid** | `Dr 2120` — they will simply bill us less. **No credit arises** | `Dr 4950 · Cr 1210` — reduce what they owe |
| **Already invoiced or paid** | `Dr 1240 Advances to suppliers` *(party)* — ⭐ **a credit we can spend on the next purchase** | `Cr 2140 Customer store credits payable` *(party)* — ⭐ **or a cash refund, their choice** |
| **Inventory** | Relieved oldest-first at the cost actually on hand | ⭐ **Re-enters at the cost the sale relieved**, read from `stock_layer_consumptions` |
| **Task** | T-170 | T-179 |

⛔ **Neither is a negative balance in the control account.** A supplier credit netted into `2110`
puts a debit in a liability control and hides the credit inside *"what we owe"*; a customer credit
netted into `1210` does the mirror image. **Both accounts already exist, both are party-required,
and a credit you cannot see is a credit nobody spends.**

⭐ **And an INTERNAL return is not a credit at all** — a branch returning to its own commissary posts
T-173's transfer backwards (`1250`/`2150`), because a branch has no credit relationship with its own
commissary. Same derived-treatment rule as a dispatch (ADR-008 §8), applied to the return.

---

## 4. The task sequence

**T-153 – T-159 are reserved for the attendance lane** and are not used here. Phase 3 starts at
**T-160**.

### Wave 0 — the valuation core ⏳ *blocked on ADR-011; targets 31 December*

| # | Task | One line |
|---|---|---|
| **T-160** | Stock locations and the room model | Types, storage-vs-operating roles, the Receiving parking spot, single-room branches |
| **T-161** | The stock ledger and derived balances | Append-only signed movements. **On-hand is a query, never a column** |
| **T-162** | FIFO cost layers | A layer per receipt; consumption oldest-first; partial consumption; reversal |
| **T-163** | The receipt posts value | `Dr 1310/1320/1330 · Cr 2120`, trued up when the invoice links. Derived confirmation status |
| **T-164** | Consumption, wastage and variance post | `Dr 5xxx · Cr` inventory · `5300` wastage · `5400` variance. **Period lock on every inventory path** |
| **T-165** | ⭐ **The switch** | The six shipped modules move to the perpetual shape. Invariant 6's inventory arm becomes checkable |

### Wave 1 — the operational surface, one store at a time *(Q1, behind flags)*

| # | Task | One line |
|---|---|---|
| **T-166** | Deliveries: draft → receive → allocate | The receiving document. Photo gate, over-receipt guard, shortage reasons, duplicate-risk warnings |
| **T-167** | Stock transfers within a store | Draft/dispatch/receive/void, one-step "transfer now", in-transit reservation, stuck-transfer report |
| **T-168** | Usage, wastage, adjustment, opening stock | The busiest door in the domain. Reserved-`transfer` block, operating-location gate, wastage → staff charge |
| **T-169** | Count sessions, freeze, and commit | The freeze that gates every other writer, and the variance that finally posts |
| **T-170** | Supplier returns | ✅ **Answered (row 166)** — the goods go back and we hold a spendable credit in `1240` |
| **T-179** | ⭐ **Customer returns and store credit** | The other direction, and **nothing owned it before**: revenue reverses to `4950`, goods re-enter at the cost they left at, the customer holds `2140` or takes a refund |

### Wave 2 — the commissary ↔ branch pipeline *(the ~24 capabilities)*

| # | Task | One line |
|---|---|---|
| **T-171** | Commissary catalogue, branch pricing, item map | What a branch may order, at what price, mapped to what it calls the thing |
| **T-172** | The branch order: draft → submit → accept → fulfil → dispatch | Pre-submit hardening, one-open-order rule, mid-fulfilment line changes the branch approves |
| **T-173** | ⭐ **Confirm receipt — the cross-store posting event** | **Everything posts here, at RECEIVED quantity, on both stores, in one transaction** |
| **T-174** | Discrepancy, settle, defer, and the day-open block | Audit / loss / charge; the floated variance; the block that stops a sales day opening over it |
| **T-175** | Branch low-stock auto-order and the order thread | The low-stock signal becomes a draft order line; the per-order message trail |

### Wave 3 — the remaining Phase 3 gaps *(independent of each other)*

| # | Task | One line |
|---|---|---|
| **T-176** | Production and prep conversion | Slab → slice, recipes, hard/soft validation tiers, edit-a-posted-record, the slicer-payment lock |
| **T-177** | POS item mapping and the daily usage pull | The mechanism that keeps on-hand honest against sales |
| **T-178** | Order/channel wastage disposition | Dispute → resolve → charge, the 15-day backstop, settlement match. ⚠️ **A different "wastage" (§6.3)** |

---

## 5. The commissary ↔ branch pipeline — the deliverable that was owned by nobody

**Bible row 91 named this explicitly** and it is worth restating why it went missing: it is half
Phase 2 (AR, settlement, a receivable between two parties) and half Phase 3 (stock leaving one
store and arriving at another). Each phase looked at it and saw the other phase's problem.

**Per `01-data-model.md`'s production numbers, most of the seven-store fleet operates as a branch
of a commissary. Without this, a branch store cannot restock through the new system at all.**

### 5.1 The one rule that makes the whole thing work

⭐ **Everything posts at CONFIRM RECEIPT, keyed to what the branch actually RECEIVED — never to
what was fulfilled or dispatched.** (`branch-order-receive.actions.ts:56-80`)

v1 arrived at this after the alternative failed: *"this avoids the previous mismatch where
dispatched-fulfilled qty differed from received qty and the AR had to be retroactively credited."*

**It is what makes the two stores' books agree by construction instead of by correction**, and it
is also exactly Phase 2 §3.3's already-adopted rule — *"the buyer's side posts at `received`, not
at `dispatched`"* — arrived at independently from the sell side. Two roads, one destination; that
is a strong signal it is right.

### 5.2 What survives the platform change, and what dies with it

v1's pipeline is shaped around one constraint that **no longer exists**: Firestore cannot span two
stores in one transaction.

| v1 mechanism | v2 |
|---|---|
| `pending_variance` → atomic flip to `recognized` | ⛔ **Deleted.** A two-phase-commit workaround for a limitation that is gone |
| Settle a floated variance (`branch-sales-settle.actions.ts`) | ⚠️ **Kept, but for a different reason** — see below |
| Admin repair: orphaned branch-sale revenue | ⛔ **Deleted.** Repairs a hard-delete path v2 does not have |
| Admin backfill: sale never mirrored into the sales-day report | ⛔ **Deleted.** v2's report is a query over the ledger; there is no mirror to miss |
| Admin repair: branch-payment → commissary-AR mirror | ⛔ **Deleted.** One transaction, no mirror |

⭐ **`03-business-logic.md` §8 calls this "likely the single largest simplification available
anywhere in this codebase," and it is.** Four repair tools and a two-phase commit collapse into
one `BEGIN … COMMIT`.

⚠️ **But `settle` survives, and the reason matters.** v1's settle exists because a *transaction*
could fail halfway. v2's exists because a **quantity dispute** is a real business event: the
branch says 18 kg arrived, the commissary says it sent 20. That needs a human decision and a
posting, and it does not go away because the database got better. **Keep the capability; delete
the plumbing it was bolted to.**

### 5.3 The ~24 capabilities, mapped to a task

Every row from `docs/discovery/14` §O. Nothing is dropped silently; a dropped row says why.

| # | Capability | Task |
|---|---|---|
| 1 | Branch discovers its linked commissary(s) | T-171 |
| 2 | Commissary's orderable catalogue with pricing | T-171 |
| 3 | Commissary item pricing: fixed / fixed-markup / percent-markup | T-171 — ✅ **already built by T-151** (`item_pricing`) |
| 4 | "Max of last two receives" basis | T-171 — ✅ **already built by T-151**, derived not stored |
| 5 | Margin-alert threshold (fixed mode only) | T-171 — ✅ **already built by T-151** |
| 6 | Commissary item ↔ branch item map | T-171 |
| 7 | Commissary catalogue bulk-import into a branch | T-171 |
| 8 | Branch order draft → submit, with pre-submit hardening | T-172 |
| 9 | One-open-order-at-a-time per branch | T-172 |
| 10 | Commissary accept / reject / fulfil / mark-ready / dispatch | T-172 |
| 11 | Authoritative stock gate at dispatch | T-172 |
| 12 | Commissary adds/replaces a line mid-fulfilment; branch approves | T-172 |
| 13 | ⭐ Confirm receipt posts BOTH stores at received quantity | **T-173** |
| 14 | Provisional recognition (`pending_variance`) + atomic flip | ⛔ **Deleted** — §5.2 |
| 15 | Unit-mismatch guard on receive | T-173 |
| 16 | Two-sided access check for branch-delivery expense booking | T-173 |
| 17 | ⭐ Auto-book AP authority = receipt-confirm authority, ONE definition | **T-173** — the ₱12,184.71 incident (§5.4) |
| 18 | Discrepancy handling: audit / loss / charge | T-174 |
| 19 | Settle a floated variance | T-174 — **re-motivated**, §5.2 |
| 20 | Defer a floated variance, once only | T-174 |
| 21 | Blocking-variance list gates day-open | T-174 |
| 22 | Admin repair: orphaned branch-sale revenue | ⛔ **Deleted** — §5.2 |
| 23 | Admin backfill: sale never mirrored to the sales-day report | ⛔ **Deleted** — §5.2 |
| 24 | Admin repair: branch-payment → commissary-AR mirror | ⛔ **Deleted** — §5.2 |
| 25 | Branch↔commissary order chat | T-175 |
| 26 | Branch low-stock auto-order (+ buyer-stores-only scope) | T-175 |
| 27 | Commissary dashboard KPIs | ⏸️ **Deferred to Phase 6** — reporting, and self-bounding queries over tables Phase 6 already reads |

**Net: 26 capabilities, 5 tasks. Four deleted with a stated reason, one deferred, three already
shipped inside T-151.**

### 5.4 ⭐ The incident this pipeline must be built around

**₱12,184.71 of AP silently never booked**, traced to Banay-Banay order BO-BNY-2607-0011 on
2026-07-23. The auto-book wrapper was tightened to manager/admin in a cross-store sweep while the
receipt-confirm gate still admitted cashiers — so **every cashier-received delivery from then on
booked no AP at all**, with no error anywhere.

v1's fix was to make both gates share one definition (`canBookBranchDeliveryExpense`).

> **The ERPv2 rule, stated once and enforced structurally: receipt-confirm authority and the
> AP-booking authority it implies are ONE capability, never two.** In v2 they are not even two
> gates — the posting happens *inside* the confirm transaction (T-173), so there is no second
> authority to drift from the first. `docs/decisions/CAPABILITY-MATRIX.md` gets one row, not two,
> and the ✗ test proves it.

---

## 6. Three things that will bite, named before they do

### 6.1 ⚠️ "Wastage" is two unrelated systems sharing one word

- **Raw-stock wastage** — spoiled ingredients. Decrements stock, posts `5300`. Lives in the usage
  path (T-168).
- **Order wastage** — a cooked menu item lost to Foodpanda/Grab/dine-in. **Moves no stock at all.**
  An accountability and settlement workflow (T-178).

v1's `wastages/{id}` collection holds *only* the second, and its own type comment names the first
as *"Phase 2"* — a second system v1 planned and never built. **Do not let "wastage" in a
requirement default to the wrong one.** (`src/types/wastage.ts:1-16`)

### 6.2 ✅ Supplier returns — answered, and the answer was better than my recommendation

v1's supplier return is **stock-out and audit trail only**, deliberately not touching AP or the
journal, with an operator-checked `apAlreadyHandled` box as a UI nudge. It called this *"a
documentation gap, not data corruption."*

**Under §16.11's stock↔GL coupling that compromise stops being available**: if stock moves and the
books do not, invariant 6 breaks. I recommended posting a debit note against `2110`.

⭐ **Ian's answer is a credit, not a debit note** — `1240 Advances to suppliers`, a per-supplier
balance you can look at and spend. **The difference is operational, not cosmetic**: *"can we use the
credit on this week's order?"* is a question somebody asks, and a debit note buried in an AP balance
has no answer to it. See §3.5 and T-170.

### 6.3 ⚠️ Meat has no per-location model in v1, and that is why POS mapping refuses it

`meatUsageRecords` carries no `locationId`, so v1 **blocks** mapping any meat product to a POS
item — posting one would move the store balance while leaving the per-location balance untouched.

**v2 closes the gap instead of inheriting the exclusion**: T-160/T-161 give every item kind —
including `meat_slab` and `meat_sliced` — the same location dimension. T-177 therefore has no
meat carve-out. ⭐ **This is the "correct" verb, not the "duplicate" verb**, and it is called out
here because porting the exclusion would be the easy, invisible mistake.

---

## 7. Intent worth preserving — the rules a schema-only rebuild would lose

Every one is a real-incident fix or a stated business judgement from `docs/discovery/14`. They are
carried into individual task specs as invariants; collected here so the list can be checked against
the specs rather than trusted.

| Rule | Task | Why it exists |
|---|---|---|
| **Meat re-categorisation is BLOCKED, not warned** | T-160/T-176 | Lipa's `Beef Forequarter/regular`: 3 orphaned children, 7 corrupted production records |
| **Unit conversion refuses to guess** — g↔kg and ml↔ltr only | T-176 | *"Guessing one here would deduct the wrong quantity forever"* |
| **Receiving parks an undecided line in Receiving, never guesses a room** | T-160/T-166 | Falls back to the default room only if no Receiving location exists — stock is never lost |
| **Over-receipt allowed, but only by explicit flag AND manager** | T-166 | A trust boundary, deliberately not a silent cashier bypass |
| **Duplicate-delivery detection WARNS, never blocks** | T-166 | Legitimate double-drops and bulk buys are normal; only the person holding the paper can tell |
| **A usage record labelled "transfer" is REJECTED** | T-168 | Usage writes only an OUT leg — a mislabelled transfer destroys stock instead of moving it |
| **Count freeze fails CLOSED on malformed data** | T-169 | This predicate gates every other writer; the fail direction is a decision, not a default |
| **In-transit reservation is destination-side, and a void must not double-release it** | T-167 | Easy double-release bug if the reversal does not branch on prior status |
| **Balance reads happen INSIDE the transaction, never before it** | T-161 | Two named historical bugs: a negative meat drift and a −20 kg slab drift |
| **Void proceeds and REPORTS a missing ledger leg; never invents one, never gets stuck** | T-161/T-176 | The reversal is computed from the record, which is always correct |
| **A live slicer payment freezes the production records it covers** | T-176 | The payment total is frozen while the records stay editable |
| **⭐ Post at RECEIVED quantity, at receipt time, on both stores** | T-173 | §5.1 — the rule the whole pipeline rests on |
| **Purpose-tuned tolerances stay separate** — ₱0.99 invoice match, 1e-6 quantity | T-163/T-169 | §16.6: each fixed a real bug. Do not collapse them to one epsilon |
| **Wastage and shortage reason taxonomies are enums, and are DIFFERENT enums** | T-168/T-166 | A shortage is a supplier-relationship signal; wastage is a stock-loss classification |

---

## 8. What Phase 3 does NOT include

**Batch tracking and FEFO.** Fully built in v1 and **never wired** — `getItemBatchesAction` and
`getFEFOBatchesAction` are un-exported with comments saying *"no callers."* Only the expiry sweep
is live. ⏸️ **Not ported.** Reviving a half-built capability nobody has used is an ADD, and it goes
through `/research-evaluate-propose` (bible row 163), not through a phase plan.

**Smart reorder / AI reorder alerts.** ✅ Already classified: *"revive, but later"* (Ian,
2026-08-23, row 89). Deferred past cutover.

**The Flutter handheld API bridge.** ✅ Already **dropped** by Ian (row 88). The eight `/api/*`
routes are not ported.

**`itemReorderPolicies` / `reorderAlerts`.** Dead schema — zero references anywhere in v1's
codebase. The real mechanism is one `lowStockThreshold` field. **Do not port the collections.**

**The dual-catalogue sync (`ip_{id}`) and `branch-stock-reconcile`.** Both are v1 migration repair
tools. ⭐ **The invariants they enforce become structural**: one item catalogue (T-145 already
shipped it, org-level), and a branch has exactly one room (T-160).

**Franchise dispatch (revenue + COGS, no elimination).** ADR-008 §4 and bible row 111 own it.
⚠️ It gets *more* urgent once inventory is real, and T-133 §4 already records why it is not built:
no second org exists to post the other half into.

**Commissary dashboard KPIs.** Phase 6.

---

## 9. Gates and checkpoints

### Wave 0's exit gate — bible §10, made checkable for the first time

> **Inventory control account = sum of on-hand valuations; stock ledger reconciles**

Three continuous checks, all through T-135's existing findings engine — **not** a report someone
remembers to run:

| Detector | Fires when |
|---|---|
| `inventoryControlDoesNotMatchValuation` | Σ `1310`+`1320`+`1330` ≠ Σ (open FIFO layer remaining qty × unit cost) |
| `stockLedgerDoesNotMatchBalance` | An item's summed signed movements ≠ its derived on-hand |
| `grniNotAtRest` | A `2120` balance older than N days — a receipt whose invoice never arrived |

⭐ **The third is the one v1 never had.** It is the "items whose cost basis is incomplete" report
ADR-009 asked for, expressed as a **finding on a real account balance** rather than a query over a
hand-maintained flag.

### Waves 1–3

Each task carries its own tests. The phase-level check is **parity in anger**, not a checklist: a
store receives, transfers, uses, counts and reorders for a full week without a manual correction.

### ⚠️ The check that must NOT be trusted — v1 taught this one twice

**A shipped server action is not a shipped feature.** Supplier returns sat permission-gated and
transactional with **zero UI callers for seven weeks**; the count-session freeze shipped and was
enforced from day one while nothing could open a session — a landmine where a session created by
any other route would have frozen a location permanently for non-admins.

> **Every Phase 3 task's "Done when" requires a live route, not an exported function.** Verified by
> opening it in the app on 9008, per §9.4 — *"a green build and green tests have already shipped an
> app that could not start."*

---

## 10. The risks worth naming now

| | |
|---|---|
| ⛔ **Phase 3 eating Phase 2** | T-121 is decided-but-unbuilt (DEF-053) and T-130 is spec-ready. **A January with correct inventory and incomplete AP is worse than the reverse.** If Wave 0 and Phase 2's remainder compete, Phase 2 wins — and ADR-011's §6 fallback exists for exactly that outcome |
| ⛔ **Wave 0 shipping in pieces** | The one failure mode that makes the books worse than they are today: `1310` debited with nothing relieving it means a P&L with no food cost. §2's rule is not a preference |
| ⚠️ **The 31 December valued count not being scheduled** | ADR-011 removed the *second* count a dated split would have needed, but **row 109's count still stands and is unchanged**: an operational commitment with a fixed date, in four stores. OPEN-DECISIONS item 9 already named the failure — *"the kind of thing discovered on 2 January, when it is unfixable"* |
| ⚠️ **The pilot running the old shape** | ⭐ **The deadline Ian's answer actually sets** (§1.1): a pilot that exercises the periodic shape produces findings about a system that will not ship. **Wave 0 lands before the pilot touches inventory, not merely before 31 December** |
| ⚠️ **The commissary pipeline being scoped by its screens** | It is 26 capabilities and five of them are the accounting. A plan judged by screens delivered will build the catalogue and the order form and discover T-173 in March |
| ⚠️ **"We'll add the location dimension later"** | Retrofitting a location onto a stock ledger that already has rows is the same class of expense as retrofitting RLS — cheap per table now, a week and a miss later. It is why T-160 precedes T-161 |
| 🔸 **Three sessions sharing this repo** | Wave 0 touches `packages/db/schema/`, the migration journal and the RLS registry — all shared state. `ListAgents` before starting, and never run `test:integration` beside a busy peer (§3.4) |
