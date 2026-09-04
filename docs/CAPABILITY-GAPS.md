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
| Supplier returns — scope decision | 3 | ✅ **RESOLVED 2026-08-29 — bible row 166.** Ian: *"supplier returns must be recognized as store credit for us that we can use for next purchase."* Not v1's stock-only compromise, and **not the debit-note-against-`2110` I recommended either** — a spendable per-supplier balance in **`1240 Advances to suppliers`** when the receipt was invoiced, or **`2120`** when it was not, because an uninvoiced return just means they bill us less. **T-170** respecified |
| ⭐ **Customer returns and store credit** 🆕 | 3 | ✅ **A gap no inventory pass could have found, because v1 cannot do it.** Arrived with row 166's other half: *"us being the supplier to other customers, return to us must be treated the same I guess — store credit customer may use, or we refund."* Revenue reverses to `4950`, goods re-enter inventory **at the cost the sale actually relieved**, and the customer holds **`2140 Customer store credits payable`** or takes cash. ⚠️ An **internal** branch→commissary return is not a credit at all — it is T-173's transfer run backwards. **T-179**, and it is this phase's first genuine **ADD** |

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
| **Capturing the SC/PWD holder's NAME and ID NUMBER at the till** | ⛔ **No — and this is the correction.** T-137 and bible rows 131/132 said the ID is captured today. Verified at source: `POS/src/lib/types.ts:813`'s `Discount` has `vatExempt?: boolean` and no identity fields at all; nothing in `ERP-rebuild`, `CUSTOMER` or `Shareat Website` captures one either (DEF-101) | ⚠️ **T-137 builds the RECORD, and no phase owns the CAPTURE.** `statutory_discount_records` holds all six statutory fields, but until POS v2 exists every row is typed by hand from the paper book (`source = 'transcribed'`) | **The two missing fields cannot be derived from anything.** POS already writes four of the six per transaction — `DiscountEvent` (`types.ts:1570`) carries receipt number, amount, date and the acting staffer — but a name and an ID number come off a physical card a cashier is looking at. ⛔ **v1 cannot be changed to capture them** (read-only reference repo; Ian, 2026-08-25: *"don't touch v1, let it be"*), so this is not deferred work — it is **impossible until POS v2**, a phase after January. ⚠️ **The obligation is live now.** RR 5-2017 §5.9 and RR 7-2010 both require the record per transaction, and the burden of proof in a BIR audit is on the seller |

⚠️ **This one is unusual: the gap is in a system this project is not allowed to touch**, and the
ERP half being built cannot close it alone. **What T-137 ships is the destination**, so that when
POS v2 lands it writes `source = 'pos'` rows into the same table with no migration — and so that a
store transcribing a paper book today is already recording it durably.

### ⛔ ANSWERED 2026-08-29, and the answer is the worse one

Ian, closing discovery 24 Open 1: *"no they are not kept to avail the discount they just present id
and the pos picks the discount from the list of configured discount."*

**There is no paper logbook.** The customer shows a card, the cashier taps a configured discount,
and nothing records the name, the ID number or the invoice. So the record required by RR 5-2017
§5.9 and RR 7-2010 is **not being kept in any form today** — and the burden of proof in a BIR audit
is on the seller (bible row 164).

⚠️ **This is no longer only a capability gap; it is a live exposure with a running clock.** T-137
ships the register, but a register nobody writes to closes nothing, and **nothing can reconstruct a
sale that was not recorded at the counter.** The remaining decision is a *process* one and it is
Ian's: cashier enters it in the ERP at the till · a paper book is started and typed up later · or
the exposure is formally accepted until POS v2, the way DEF-070's was. **Gap count: 35.**
## Added 2026-08-29 — found while planning Phase 3, and it inverts this document's method

| Capability | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| ⭐ **Customer returns and store credit** | ⛔ **No.** v1 has no customer-return document at all — a wholesale return is handled by voiding the order or by a manual adjustment | Owned by **T-179** as of today (bible row 166) | ⚠️ **Every other row in this file was found by reading v1 and asking *"what does the business do that the plan misses?"* This one could never have been found that way, because the business cannot currently do it** — the capability is absent from the source as well as the target. It surfaced only because Ian answered a question about *supplier* returns and then extended it: *"us being the supplier to other customers, return to us must be treated the same I guess."* |

⭐ **The method has a blind spot, and it is worth writing down.** A capability inventory compares the
plan against **what v1 does**. It is structurally incapable of finding what **neither** system does
and the business needs — the fourth verb, **ADD**, which §1.2 lists and which this document has only
ever populated from Ian directly (13th-month pay, the separation workflow, and now this).

> **So a gap pass is necessary and not sufficient.** The three ADDs in this file all came from a
> conversation, never from a read. **Gap count: 35.**

## Added 2026-08-29 — the shift, found while answering a question about the till float

| Capability | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **The cashier SHIFT as a countable, attributable unit** | ✅ `CashRemitShiftPlain` (`types/index.ts:1443`) — `opening.source: 'float' \| 'manual' \| 'handover'`, `prevShiftId` chaining one cashier to the next, and `expectedCash`/`actualCash` per shift | ⛔ **Nothing.** T-123 models the sales **day**; the count lives in POS's `cashHandovers` (discovery 09 §1) and never reaches the ERP | Ian, 2026-08-29: *"most is 2 shifts, 1 morning 1 evening, same till… they count the 20k and hand it over after the 1st cashier reconciles his sales."* ⛔ **Without a shift record, a count variance on a shared till cannot be attributed to one of two cashiers** — which is the entire purpose of counting daily. Bible row 128 fought to keep that control; row 144 then insisted a variance names a person and is never inferred. **A shared till with no shift boundary makes both unenforceable** |

⭐ **Named rather than absorbed.** T-153 needed none of this — the float itself works today — but
answering *"what account does it belong to"* surfaced that the layer above it is missing. Discovery
23 §4 already folded the cash handover to the ERP *"(Ian, 2026-08-25)"*, so this gap has a decided
home and no builder. **Gap count: 35.**


### ⭐ Resolved in part, 2026-08-30 — the shift pass Ian asked for

The attendance lane's `attendance_days` was checked against what the cash count needs. **They are NOT the same object**: `attendance_days` is keyed `(employment_id, shift_day)` — one row per PERSON per 05:00 day — while the till needs one row per TILL per HANDOVER. A cashier who works a split shift produces one attendance row and two custody periods, so keying cash on it makes the second handover unrepresentable.

⭐ **But attendance already owns the person and the clock** (`first_in_punch_id` / `last_out_punch_id`, from append-only punches). So the remaining gap is narrower than it was: a `till_custody_shift` that **references** `attendance_days` rather than restating it. ⛔ Two tables asserting when a shift started will drift, and the first symptom is a variance charged to the wrong person. Full reasoning in `docs/tasks/153-standing-till-float.md`.

## Added 2026-09-03 — found while fixing the bible §4.3 layering findings over T-168's screen (DEF-135)

| Capability | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **A per-item COGS category** — the split COA-ALIGNMENT §4.1 wants between `5120` sides, `5130` condiments, `5140` sauces and `5200` beverages | ⛔ **No — v1 does the same coarse thing.** `meat-usage.actions.ts` never varied its posting account by item either; every non-meat/retail/supply kind lands on one line | ⛔ **`items` carries no costing taxonomy, only `kind`** (T-149 spent that column's budget on three sellability flags instead). `cogsCategoryForItemKind` (`packages/domain/src/stock/usage-records.ts:58-72`) maps every `raw_material`/`prepped` item — sides, condiments, sauces and beverages all included — to the `food` catch-all, `5100` | COA-ALIGNMENT §4.1 marks `5100` **"drive to zero,"** but nothing in the eight-phase plan owns adding the column that would let a consumption posting land anywhere finer. Not a defect: the mapping is intentional parity with v1, named where it was found rather than silently worked around (T-168 §12.2). It just means `5120`/`5130`/`5140`/`5200` will never receive a single consumption posting from this pathway until an item carries its own category |

⭐ **The fix and its cost, named so it is a placement rather than an absence.** A `cogs_category`
column on `items`, set from the item master screen and read by `usage-records.ts` in place of the
`kind` switch above, costs: a migration, a change to the items screen (one more field to set per
item), and a backfill — trivial for the seven dev-fixture items, real work for every live item at
cutover, since nobody has ever had to classify stock this way before. **Gap count: 36.**

## Added 2026-09-04 — found auditing the accounting foundation at Ian's request

| Capability | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **Creditable / expanded withholding tax on supplier payments** (BIR Form 1601-E — rent, professional fees, contractor payments above the statutory threshold) | ⛔ **No.** Grepped `ERP-rebuild`'s whole tree: its only withholding-tax code is platform-payout related (Foodpanda/Grab commission deductions), already carried forward via `channel_settlements` | ⛔ **Also absent.** `2240` exists and is scoped to *payroll* withholding only (bible §16.5's SSS/PhilHealth/Pag-IBIG/BIR table); nothing in `expenses`/`ap` splits a withheld portion out of a supplier payment or tracks the remittance obligation for it | Neither system does this and the business needs it the moment a branch pays rent or a professional fee above the EWT threshold — the same "neither system does it" blind spot row 242 already named for customer returns. Distinct from payroll withholding (2210–2240, built) and platform withholding (channel-settlements, built) |

⚠️ **The exposure is live, not hypothetical, the moment a store starts paying rent or a contractor
through this system** — BIR 1601-E is a monthly filing obligation with its own penalties for
non-withholding, independent of whether the rebuild ever touches it. Needs a deliberate yes/no from
Ian, the same way the SC/PWD capture gap (row 216) and the statutory-remittance one did, rather than
staying silently absent. **Gap count: 37.**

## Added 2026-09-04 — from `docs/discovery/26-reporting-dashboards-and-insights.md`, while planning Phase 6

### ⭐ A correction to this file's own classification: **OIL is not an AI feature**

Line 168 files *"OIL lapse-detection engine"* under **nice-to-have → deferred past cutover**,
beside the AI insights/briefing layer. **Both halves of that placement are wrong**, and the
discovery pass flagged it rather than silently reclassifying it (bible §13 row 164):

| | |
|---|---|
| **It is not AI** | v1's own `src/types/integrity.ts:1-3`: *"Daily Insights — Open Items & Lapses (OIL). **Deterministic** integrity findings surfaced over existing operational/financial records. Pure observation layer — never touches the GL."* Zero LLM tokens. All 13 detectors are threshold/date logic over data Phases 2–5 already produce in Postgres |
| **It is not nice-to-have** | ⭐ **441 findings resolved by managers** at the two engaged stores (discovery 26 §C.2) — the strongest usage evidence anywhere in that pass, against **13 uses ever** for Ask ERP and **0 opens in 88 days** for the AI briefing at one enrolled store |
| **And it is mostly built** | **T-135 shipped the engine** — 22 detector kinds, the derived-not-stored model, acknowledgement with a 30-day expiry, and the `/findings` screen. What remains is the operational detectors whose data now exists, plus the scorecard: **~3–5 engineer-days, no new infrastructure** |

⭐ **Owner assigned: Phase 6** — `docs/plans/phase-6-reporting-and-dashboards.md` §4.4 (detectors,
T-213) and §5.1 (the manager responsiveness scorecard, T-214). The **AI narrative briefing layer**
and **Ask ERP** keep their deferral on line 168, with reasons restated in that plan's §4.5 and §4.6.
**No change to the gap count** — this row moves a capability from "deferred" to an owner.

### A new gap — receiving-dispute ageing has no backstop

| Capability | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **A forced-resolution backstop on commissary / branch-order RECEIVING disputes** | ⛔ **No — and the asymmetry is the finding.** v1 runs an automatic **15-day** forced-resolution cron for order/channel **wastage** disputes, and nothing equivalent for **receiving** disputes; a code comment argues one is unnecessary because *"disputes get resolved"* | ⛔ **Also absent.** T-178 carries the wastage backstop forward; **T-174** (discrepancy, settle, defer) has a *defer-once* rule but no ageing backstop, and no phase owns one | ⚠️ **The self-bounding assumption is measurably false today.** Live probe, discovery 26 §B.2: **2 of 5 open disputes at Lipa and 2 of 4 at Malvar already exceed 15 days** — the very threshold the *other* dispute path in the same codebase treats as serious enough to automate. Neither system does this, so it is a gap rather than a defect |

**Recommendation:** the control belongs to **T-174**, not to Phase 6. Phase 6 builds only the
`receivingDisputeOverdue` **detector** (plan §6 Q3), which makes the ageing visible either way and
is worth having even if Ian decides manual follow-up suffices at nine open disputes. **Needs a
yes/no from Ian on the backstop itself. Gap count: 38.**
