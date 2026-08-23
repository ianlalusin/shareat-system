# Capability gaps — what the business does that the plan does not cover

> **Source:** the four capability inventories, `docs/discovery/13`–`16`, run 2026-08-23.
> Each read the legacy system as a **requirements document** (bible §1.2b) and asked *"what
> problem was this solving?"* rather than *"how does this work?"*
>
> **34 capabilities had no home in the eight-phase plan. Three are now resolved by Ian
> (2026-08-23); 33 remain** — one dropped, one deferred, two confirmed as builds.

## Why this document exists

The phase plan was written by comparing the plan against itself. These gaps only appeared when
it was compared against **what the business actually does every day**. That is the whole value
of the pass, and it is the reason "add what's missing" (§1.2) can now be a checklist rather
than an aspiration.

**None of these are feature requests.** Every one is something the legacy system does today,
in production, that no phase of the rebuild currently owns.

---

## 1. Blocks the January books cutover — 5 items

**These post to the ledger today.** ADR-005's Phase 2 list — *expenses, AP, AR, payments, cash
requests, sales day, settlements* — omits all five, and v1 has a journal builder for each.

| Gap | v1 builder | If omitted |
|---|---|---|
| Fixed assets + **depreciation** | `depreciation.builder.ts` | Expenses understated every month |
| Prepaid + **amortisation** | `amortization.builder.ts` | Same |
| **Loans** | `loan.builder.ts` | No interest expense, no principal tracking |
| **Owner equity movements** | `equity-movement.builder.ts` | Capital and drawings never post |
| Generic **liability accounts** | `liability-charge/payment` | Statutory and other payables missing |

> They are absent from the phase plan **and** absent from the bible's list of *deliberate*
> omissions — so this is an oversight, not a decision. Recorded in ADR-005.

## 2. Blocks day-one operations, but NOT the January books — ~30 items

January is books-only, so these do not threaten the cutover date. **They threaten the
"everything else follows in Q1" half of ADR-005**, and one of them is very large.

### The commissary ↔ branch order pipeline — ~24 capabilities on its own

Order → fulfil → dispatch → confirm-receipt (which posts **both** stores' books at once) →
discrepancy resolution → settle/defer → repair/backfill.

**This is not a peripheral module. For a branch store, it is how inventory gets replenished at
all** — and per the data model, most of the seven-store fleet operates as branches of a
commissary. It sits between Phase 2 (AR/settlements) and Phase 3 (inventory) and is named by
neither.

### The rest

| Gap | Why it matters |
|---|---|
| **POS item mapping + usage pull** | The mechanism keeping on-hand stock honest against sales. Without it every sale fails to decrement stock unless someone hand-enters usage daily |
| **Meat production / slicing + slicer payroll** | Stock conversion *and* a separate compensation stream tangled with salaries payable |
| **Order/channel wastage disposition** | Channel-order losses stop being tracked or recovered; the 15-day auto-charge backstop has no replacement |
| **Branch low-stock auto-order** | The low-stock signal never becomes a replenishment action |
| **Staff master record + position taxonomy** | Load-bearing dependencies of Phases 4 and 5 with no phase of their own |
| **Infractions / discipline** | Used *by* Phase 7's performance scoring; itself unowned |
| **Absentee / leave tracking** | Independent monthly and yearly caps, no phase |
| **AI insights / briefing layer** | Entire narrative + comparison surface |
| **OIL lapse-detection engine** | Deterministic daily lapse detection + manager responsiveness scorecard |
| **Store provisioning / readiness** | How a new store gets set up at all |
| **Admin danger-zone tooling** | Selective reset, projection rebuild, integrity audit |
| **Cross-store staff-identity linking** | A person working at two stores has no single identity — *note: T-101's `person_identities` already solves this* |
| **Kiosk shell UI mode** | Distinct from the Phase 4 offline hot lane |
| **In-app notifications** | The 8-event bell |
| Expense budgets · recurring-expense automation · books-tie-out audit · depreciation watchdog | Financial, but non-posting — safely after January |

## 3. Surprises worth their own line

**~~A whole client surface nobody mentioned.~~ ✅ RESOLVED — DROPPED.**
Ian, 2026-08-23: *"no, I dropped it."* The Flutter handheld app is not in use. Its eight
routes — `/api/inventory/{count,thresholds,transfer}`, `/api/meat/adjust`,
`/api/production/{cook,void-record}`, `/api/deliveries/{receive,void}` — are **dead code in
v1 and are NOT ported.** This is a DELETE under the four verbs, and it is Ian's call to make
because it removes a user-facing capability (§1.2). **Gap count drops from 34 to 33.**

**A regression, not a gap.** `archive/TODO-smart-reorder.md` is stamped DONE, `firestore.rules`
still carries live rule blocks naming a **deleted** `reorder.actions.ts`, and the item master
still exposes `reorderPoint` / `reorderQuantity` fields that fed it. Real functionality —
14-day projection, seasonality, AI recommendations, an alerts dashboard — existed and was
removed, leaving debris. **✅ RESOLVED — revive, but later.** Ian, 2026-08-23: *"revive, but later — addition to what
we will build. We'll just build the foundation first; the need-to-have then nice-to-have will
follow."* Classified **ADD, deferred past cutover.** Not a Phase 1 or 2 concern.

**Three overlapping day-accountability surfaces.** Manager Daily Review, Manager Daily Report,
and Task Inbox. Flagged for **consolidation, not triple-porting**.

**Two things missing from v1 as well — ✅ CONFIRMED as builds.** Ian, 2026-08-23: *"yes, we
need to build it."* **13th-month pay** and a **separation / final-pay / clearance workflow**.
Neither exists in the legacy system, so these are not porting gaps — they are **genuine ADDs**,
the first confirmed entries under the fourth verb.

Note **6140 13th month pay already exists in the approved chart of accounts** — the account was
provisioned, the workflow that posts to it never was. Both belong to Phase 5 (payroll), which
is post-January under ADR-005.

---

## Triage rule — Ian, 2026-08-23

> *"Build the foundation first; the need-to-have then nice-to-have will follow."*

Every one of the remaining 33 is classified against this, in order:

1. **Foundation** — the ledger and the things that post to it. Nothing works correctly without
   these, and they cannot be retrofitted cheaply once data exists.
2. **Need-to-have** — the business cannot operate day to day without it. The commissary→branch
   pipeline is the clearest example: a branch store has no other way to restock.
3. **Nice-to-have** — real value, deferrable. Smart-reorder, AI insights, the OIL engine.

**A gap being deferred is a decision. A gap being unclassified is not.** The point of assigning
all 33 is that "later" becomes a place on the plan rather than an absence from it.

## What this means for the timeline

**January is intact.** It is books-only, and only §1's five items affect it. They are real work
but bounded, and they are now recorded in ADR-005.

**The eight-phase plan is not a complete description of the business.** The commissary pipeline
alone is a phase-sized domain sitting in the gap between two phases. Any judgement about
"Phase 2 feature-complete" at the **15 November go/no-go** must be made against the corrected
scope, not the original.

**Recommended next step:** a phase-plan revision that assigns every one of these 33 an owner —
even if the owner is "explicitly deferred past cutover." An unowned capability is not a
decision; it is a thing nobody has looked at. The four verbs require a verdict on each, and
right now 33 have none.
