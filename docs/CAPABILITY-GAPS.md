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

## Phase assignment — every gap now has an owner

*Revised 2026-08-23 against Ian's triage rule (bible §13 row 87). Phase numbers are bible §10's.
Nothing here is unassigned; "deferred" is a placement, not an omission.*

### Foundation → **Phase 2**, and therefore in the January cutover

| Gap | Why it cannot wait |
|---|---|
| Fixed assets + depreciation | Posts to the ledger monthly |
| Prepaid + amortisation | Posts to the ledger monthly |
| Loans | Interest expense and principal |
| Owner equity movements | Capital and drawings |
| Generic liability accounts | Statutory and other payables |

> **This expands ADR-005's January scope.** The 15 November go/no-go is judged against this
> corrected list.

### Need-to-have → **Phase 3**, and the largest single omission

| Gap | Phase | Note |
|---|---|---|
| **Commissary ↔ branch pipeline (~24 caps)** | **3** | **Named explicitly as its own deliverable.** It got lost precisely because it straddles Phase 2 (AR, settlement) and Phase 3 (stock movement) and was fully owned by neither. For a branch store this *is* replenishment |
| POS item mapping + usage pull | 3 | Without it stock never decrements from sales |
| Meat production / slicing conversion | 3 | Stock conversion half |
| Order / channel wastage disposition | 3 | Includes the 15-day auto-charge backstop |
| Branch low-stock auto-order | 3 | Turns the low-stock signal into an action |
| Supplier returns — scope decision | 3 | **Needs Ian**: v1 deliberately does *not* touch AP/journal. ERPv2's stricter stock↔GL coupling (§16.11) may change that. Porting the compromise silently would port a known gap |

### Need-to-have → **Phases 4–6**

| Gap | Phase |
|---|---|
| Staff master record + position taxonomy | **4** — load-bearing for 4 and 5; previously unowned |
| Absentee / leave tracking | 4 |
| Slicer per-piece pay | 5 |
| **13th-month pay** 🆕 | 5 — confirmed ADD. Account 6140 already seeded |
| **Separation / final-pay / clearance** 🆕 | 5 — confirmed ADD |
| Reimbursement payout as a distinct liability | 2 |
| Expense budgets · recurring-expense automation | 6 |
| Books-tie-out audit · depreciation-gap watchdog | 6 |
| Infractions / discipline | 7 — used *by* performance scoring |
| Store provisioning / readiness | 7 |
| Admin danger-zone tooling | 7 |
| Kiosk shell UI mode | 7 |

### Nice-to-have → **deferred past cutover**

AI insights / briefing layer · OIL lapse-detection engine · in-app notifications ·
smart-reorder (revive, row 89) · AI-assisted data entry · settlement→HR infraction filing ·
reconciliation certification · self-heal / drift-repair tooling.

**Consolidate, do not triple-port:** Manager Daily Review + Manager Daily Report + Task Inbox
are three overlapping day-accountability surfaces. One survives; Ian picks which.

### Already solved, no work needed

| Gap | Resolved by |
|---|---|
| Cross-store staff-identity linking | **T-101's `person_identities`** — one person, many identities, already shipped |
| Flutter handheld app | **Dropped** (row 88) — not ported |

---

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

---

## Added 2026-08-29 — found while assessing T-136 §2

| Capability | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **A store-administration screen** | ✅ ERP *and* POS both configure stores (`docs/discovery/23`) | ⛔ **No `stores` route exists** in `apps/erp/src/app/`. Stores arrive only through the seed and the cutover, and nothing in the app can edit one | Discovery 23 §6 decided *"one `stores` row, one editable copy"* — the **model** question. **Nobody owns the screen**, so every per-store setting added from here (T-152's remittance cadence and ceiling, T-136 §2's imprest amount, §6's distribution cadence) has no home and will each invent one. ⚠️ **The cost compounds silently**: the second such setting is where this becomes expensive, and T-152 is the first |

⭐ **Named rather than absorbed.** T-152 puts its two fields on the `/remittance` screen beside
the position they govern, which is right for those two and wrong as a pattern. **Gap count: 34.**

---

## Added 2026-08-29 — found while assessing T-137

| Capability | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **Capturing the SC/PWD holder's NAME and ID NUMBER at the till** | ⛔ **No — and this is the correction.** T-137 and bible rows 131/132 said the ID is captured today. Verified at source: `POS/src/lib/types.ts:813`'s `Discount` has `vatExempt?: boolean` and no identity fields at all; nothing in `ERP-rebuild`, `CUSTOMER` or `Shareat Website` captures one either (DEF-084) | ⚠️ **T-137 builds the RECORD, and no phase owns the CAPTURE.** `statutory_discount_records` holds all six statutory fields, but until POS v2 exists every row is typed by hand from the paper book (`source = 'transcribed'`) | **The two missing fields cannot be derived from anything.** POS already writes four of the six per transaction — `DiscountEvent` (`types.ts:1570`) carries receipt number, amount, date and the acting staffer — but a name and an ID number come off a physical card a cashier is looking at. ⛔ **v1 cannot be changed to capture them** (read-only reference repo; Ian, 2026-08-25: *"don't touch v1, let it be"*), so this is not deferred work — it is **impossible until POS v2**, a phase after January. ⚠️ **The obligation is live now.** RR 5-2017 §5.9 and RR 7-2010 both require the record per transaction, and the burden of proof in a BIR audit is on the seller |

⚠️ **This one is unusual: the gap is in a system this project is not allowed to touch**, and the
ERP half being built cannot close it alone. **What T-137 ships is the destination**, so that when
POS v2 lands it writes `source = 'pos'` rows into the same table with no migration — and so that a
store transcribing a paper book today is already recording it durably.

⛔ **Still unanswered since 2026-08-25** (discovery 24 Open 1): *is a paper logbook kept at the
store today?* If yes, T-137 is digitisation. If no, the obligation is being missed and a table will
not fix that by itself. **Gap count: 35.**
