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

## 1. ~~Blocks the January books cutover — 5 items~~ ✅ **ALL FIVE SHIPPED — CLOSED 2026-09-16**

> ⛔⛔ **THIS SECTION SAID "BLOCKS THE JANUARY BOOKS" FOR ROUGHLY THREE WEEKS AFTER THE LAST OF THE
> FIVE SHIPPED, AND IT IS THE FIRST THING ANYONE OPENING THIS DOCUMENT READ.** Nobody edited it;
> the project moved underneath it. ⭐ **Found 2026-09-14 while building a completion census for Ian,
> then independently re-derived by a second reader before this correction was written** — the five
> rows carry no task numbers, so closing them required mapping each description to its task and
> checking that task's state, which is exactly the work nobody had reason to do.
>
> ⚠️ **It had already misled a reader:** the census reported these five as outstanding to Ian before
> the check was run. **That is this register's own DEF-347 / bible §13 row 204 pattern** — a document
> that is not maintained must not carry a fact that moves — landing on the document whose whole
> purpose is to say what is missing.

| Gap | v1 builder | Closed by | State |
|---|---|---|---|
| Fixed assets + **depreciation** | `depreciation.builder.ts` | **T-124** | ✅ shipped |
| Prepaid + **amortisation** | `amortization.builder.ts` | **T-125** | ✅ shipped |
| **Loans** | `loan.builder.ts` | **T-126** | ✅ shipped |
| **Owner equity movements** | `equity-movement.builder.ts` | **T-127** | ✅ shipped |
| Generic **liability accounts** | `liability-charge/payment` | **T-128** | ✅ shipped |

> ⭐ **THE FINDING THAT PRODUCED THIS SECTION IS KEPT, BECAUSE IT IS THE HALF THAT DOES NOT ROT.**
> These five were absent from the phase plan **and** absent from the bible's list of *deliberate*
> omissions — **so their absence was an oversight, not a decision**, recorded in ADR-005. That is why
> the capability-gap pass exists at all: a phase plan can be complete against itself and still miss
> five ledger-posting modules, because nothing in it was asked *"what does the business do that no
> phase owns?"* ⛔ **The status above rots; that sentence does not. Do not delete it when this
> section is eventually archived.**

## 2. Blocks day-one operations, but NOT the January books — ~30 items

> ⚠️⚠️ **THIS SECTION IS DATED 2026-08-23 AND HAS NOT BEEN AUDITED SINCE. SEVERAL OF ITS ITEMS HAVE
> SHIPPED. DO NOT READ IT AS A LIST OF WHAT IS MISSING TODAY.** Checked 2026-09-16 while closing §1,
> and **three were confirmed shipped without looking for more**:
> **the commissary ↔ branch order pipeline** — the ~24-capability item this section calls *"very
> large"* — closed in Phase 3; **POS item mapping and the daily usage pull**, closed by **T-177**;
> and **staff master record + position taxonomy**, closed by **T-154**. **Store provisioning /
> readiness** is closed by **T-222**, which makes four.
>
> ⛔ **The remaining rows are UNVERIFIED in both directions** — some are certainly still open, and
> nobody has checked which. ⭐ **This banner is deliberately not a corrected list**, because writing
> one without doing the audit would reset the same clock §1 just proved this document cannot be
> trusted to keep: the fix for a stale list is either an audit or an honest warning, never a fresher
> guess. **Whoever next needs this section audits it against `docs/ROADMAP.html` first.**

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
| Slicer per-piece pay | 5 — ⭐ **live-probed 2026-09-05 (DEF-173) and re-scoped by it: 237 of 241 production records are SharEat Lipa ALONE**, every other operating store at zero, and `slicerPayments` totals **3** (2 paid, 1 draft) across ~5 months. Real and current, but **single-site and low-volume**. ⛔ **Sequence AFTER T-189**, which serves 126 staff who have never been paid through the system at all. **Header-level `performed_by_person_id` + the existing kind-agnostic `labour_cost`, NOT per-line pay attribution** — `isPaid:false` occurs on 1 output line in 102 |
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

## Added 2026-09-05 — found auditing v2's current build state for a completion plan (`docs/plans/v2-completion-blueprint-2026-09-05.md`)

| Gap | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **Per-store, per-month expense budgets with auto-reissue** | ✅ `manager/budgets/page.tsx` + `budget-editor.tsx` — budget/consumed/remaining per flagged expense sub-category, month-navigable, with an `autoReissue`/`reissueInterval` option that carries the amount forward and resets consumed to zero. **Confirmed live and working**, not dead code: a daily Cloud Scheduler job (`budget-reissue`, `30 0 * * *`) runs `processAutoReissueBudgets`, verified end-to-end (idempotent, correct no-op in the current month, real next-month budget created when forced against a target month) | 🟡 **Correction — this row was wrong on first write.** `ROADMAP.html` already names it: **T-215 "Expense budgets,"** filed under Phase 6 with its own caveat *"may move to Phase 7 without argument."* Not an unowned gap — the real news is the depth of v1's version (auto-reissue on a live cron) versus T-215's one-line scope ("budget vs. actual as a query over `journal_lines`") | Not a new gap — an enrichment of an already-named task. **Ian, 2026-09-05: confirmed in scope.** T-215's implementer should read v1's `budget-editor.tsx` before scoping — the reissue behaviour is real, tested, running in production, and worth carrying forward, not just the read-only budget-vs-actual query T-215's current one-liner describes |
| **Staff onboarding as content + a comprehension check** | ✅ A real, separate system (not the account-creation gate it was initially assumed to be) — `onboardingDocs`/`onboardingExams`/`onboardingProgress`: handbook/rules/training/menu documents with versioned acknowledgment (a content edit forces re-acknowledgment), exams with auto-graded multiple-choice and manually-graded open-ended questions, staff-proposed content routed through an admin approve/reject queue, and per-item and per-staff completion tracking | ⛔ **No phase owns it**, and Ian's own assessment of v1's version is that it has more moving parts than its purpose needs | Not a straight port. **Ian, 2026-09-05: "even I who designed it don't fully understand it — streamline it, clear beginning and end, a progress, so no staff can jump to end without steps start and middle."** Redesigned scope: one ordered, strictly-gated track (`current_step_index` + `completed_at` per staff member) replacing the five-kind library, versioning, proposal pipeline and open-ended grading. Full redesign in the completion blueprint's §6. **Confirmed in scope (Add), starting with one universal track** — per-position tracks deferred |

⭐ **Verified by reading the actual v1 source this session**, not inferred from the route list alone — the STORE-ROSTER.md lesson (*"never derive a list from a capped query"*) applies here too: a route existing is not evidence of what it does. **Only onboarding is a genuinely new, unowned gap — budgets turned out to already be T-215 (Phase 6), corrected above rather than double-counted. Gap count: 39.**

---

## Added 2026-09-06 — found auditing the tree against `ROADMAP.html` and the completion blueprint

⭐ **One gap, and it is a whole tree of screens that no phase, plan or register has ever named.**
v1 carries **13 screens under `/manager/settings/*`** plus `/admin/configurations/*`. v2 has
**one** (`/settings/attendance`, T-201). Several of the thirteen are genuinely covered elsewhere in
v2 and are not gaps; the ones below are not covered anywhere, and the reason they were missed is
structural — the completion blueprint's §6 catalog was built from v1's **top-level route groups**,
and this whole tree sits one level down inside `manager/`.

| Gap | v1 has it | v2 state | Why it is a gap, not a defect |
|---|---|---|---|
| **A place to administer reference data at all** | ✅ `/manager/settings/*` (13 screens) + `/admin/configurations/*` | 🟡 `/settings/attendance` only — **and `/settings` itself is a nav entry with no page behind it (DEF-192)** | The *container* is the gap. Each item below is small; what is missing is the shelf they stand on |
| **Expense categories** | ✅ `/admin/configurations/expense-entries` **and** `/manager/settings/expense-entries` — two screens, so it is real, daily reference data | ⛔ **Seed-only.** 39 rows from `packages/db/seed/expense-categories.ts`, no `createCategory`/`updateCategory` anywhere in `domain` or `repo` | ⚠️ Filed as **DEF-193** as well, because it has a second edge: T-213's `expenseCategoryUnpostable` detector fires on a category with no mapped account and **no screen exists on which to map one** |
| **Positions** | ✅ `/manager/settings/positions` | ⛔ **Seed-only.** Two functions in a stack write this table and **neither has a caller under `apps/`**: `seedCanonicalPositions` (`packages/domain/src/people/index.ts:256`) wraps `employmentRepo.seedCanonical` (`packages/db/src/repo/employment.ts:56`), which holds the actual `insert into positions`. The domain one appears only in five attendance integration tests; `apps/` imports `employmentRepo` for `listActiveRoster`/`getEmployment` and never `seedCanonical`. `positions` is a real FK-referenced table and a store cannot add one | ⭐ v1's own history proves the need: `project_add_griller_feature` was a whole task about adding **one position**. In v2 that is a migration, not a form. ⚠️ **Same grep signature as DEF-190, opposite blast radius** — an org with no positions fails *loudly* at the first hire, where an uncleared `1210` fails *silently* forever. That is why this is a gap and DEF-190 is a defect |
| **Wastage reasons** | ✅ `/manager/settings/wastages` | ⛔ A code constant (`WASTAGE_REASONS`), not a table — config by deploy | Small, and the right answer may well be *keep it a constant*: a reason list that anyone can extend stops being analysable. **Needs a verdict, not necessarily a screen** |
| **Salary-advance policy** | ✅ `/manager/settings/salary-advance` | ⛔ No v2 equivalent found | Ties to T-189's advance recovery off `1230`. Phase 5 built the mechanism and not the policy surface |
| **Organization details** | ✅ `/manager/settings/organization` | ⛔ No v2 equivalent — and **worse than this row first claimed.** It said organization rows "are created by migration/seed"; **corrected 2026-09-06 — nothing creates them at all**, not a migration, not a seed, not the app. See **DEF-195** and **T-228** | Low volume — an org is edited once a year — but there is currently no way to correct a business name or TIN, and TIN is a statutory field |

**Already covered in v2, deliberately not counted as gaps** (verified at source, not inferred):
`locations` → `/inventory/locations` (T-160) · `stocks` → `/inventory` · `meat` → `/items` +
`/inventory/pos-map` · `payment-settings` → the destination-money-account picker on
`/channel-settlements` (T-150/DEF-147) · `attendance` → `/settings/attendance` (T-201) ·
`departments` → the usage-department field already on stock usage.

**Deliberately NOT ported** — recorded so nobody re-adds them looking at a gap: `local-users`
(superseded by the hire flow + PIN issuance; Ian, 2026-09-05: no self-service accounts, ever) ·
`printer` (a POS device concern, not an ERP one) · `insights` (the AI briefing layer, deferred
with its own reasoning in ROADMAP.html) · `ui-ux-sample` (a dev scaffold).

⚠️ **Read this beside the phase status, not instead of it.** None of these blocks the January
books — none posts to the ledger, which is exactly why the original capability inventory's triage
rule filed nothing like them. They block *day-two operations*: the day somebody needs a fortieth
expense category, a new position, or a corrected TIN, and the answer is "an engineer writes a
migration." **Probable home: Phase 7**, as one *Reference data* screen group rather than six
separate tasks.

**Gap count: 44.**

### The sweep that found these — reproducible, so it does not have to be re-invented

⭐ Recorded here rather than left in a session log, because a method that produced four defects
and lives only in a transcript is exactly `DEF-185`'s expired-deferral shape.

1. **Every domain export, checked for a caller.** Collect every `^export (async )?function` under
   `packages/domain/src` (excluding `*.test.ts`), then word-boundary match each name against every
   `.ts`/`.tsx` under `apps/` — ⚠️ **excluding `apps/erp/.next`**, whose turbopack cache contains
   compiled copies of the barrel and will match everything. 401 exports, **157 with no `apps/`
   caller** on 2026-09-06.
   ⛔ **The raw count is not the finding and must not be reported as one.** Most of the 157 are
   correct: pure helpers called by other domain functions (`computeDay` via the adjudicator,
   `planConsumption` via `postUsage`), and several action-shaped ones are reached through a
   differently-named app wrapper — `commitCountSession` looks uncalled and is not, because
   `/inventory/counts` calls `commitCount`. **The signal is action-shaped functions that move
   money or state and have no wrapper either.** Read each candidate before filing it; this pass
   discarded far more than it kept.
2. **Every nav entry, checked for a route, and the reverse.** Compare every `href:` in
   `apps/erp/src/components/nav.tsx` against every `page.tsx` under `apps/erp/src/app`. Both
   directions matter and they catch different failures: nav→route found **DEF-192**, route→nav is
   the check that would have caught **DEF-139** and **DEF-181**.
3. **Every table, checked for a writer.** For a schema file with no `insert` anywhere outside
   tests and seeds, ask whether that is deliberate. Found `audit_log` (**DEF-169**, zero writers *(2026-09-28: no longer zero — T-350 S3 made payout-account changes its first writer; see DEF-169.)*
   *and* zero readers), `expense_categories` (**DEF-193**) and `positions` (above).

⚠️ **Both checks in 1 and 2 are mechanical enough to be tests rather than a periodic audit**, and
`tests/unit/deferral-staleness.test.ts` (T-220) is the pattern to copy. Two lessons from building
that one apply directly: seed the guard with a **live** failure so its first run is red — a guard
whose first run is green has proved nothing — and assert non-vacuity, because a scan that silently
matches zero files looks identical to a clean tree (`DEF-179`).

✅ **Done 2026-09-06 (T-227). Checks 1 and 2 are now tests and run in `npm test`:**

| Check | Test | What it enforces |
|---|---|---|
| 2 | `tests/unit/nav-route-reachability.test.ts` | every `nav.tsx` `href:` resolves to a `page.tsx`, **and** every non-dynamic route is reachable from nav transitively. Exemptions live in `UNLINKED_BY_DESIGN` with a reason |
| 1 | `tests/unit/domain-actions-have-callers.test.ts` | every export shaped `(tx, …, actor: Actor, …)` has an `apps/` caller, or an `EXEMPT` entry opening with `INTERNAL` / `WRAPPER` / `JOB` / `UNWIRED` and naming the other half |

⭐ **Check 1's population is the thing worth carrying forward.** The raw *"401 exports, 157
uncalled"* above is unusable as a gate — a guard that fires 157 times fires zero times. Narrowing to
**exports that take an `actor`** — the ones that call `authorize()` and therefore presume a human —
gives **214 in the population and 30 uncalled**, which is a list a person reads. The judgement the
sweep note asks for ("read each candidate before filing it") is now made **once, in writing, in the
exemption map**, and a second assertion deletes an entry the moment its export gains a caller.

⛔ **Check 3 (every table, checked for a writer) is deliberately NOT a test.** *"Is this table
supposed to have no writer?"* needs a per-table judgement a scan cannot make — `audit_log` with no *(2026-09-28: no longer zero — T-350 S3 made payout-account changes its first writer; see DEF-169.)*
writer is DEF-169, a seeded reference table with no writer is correct. The method above stays the
record for it.

⚠️ **Both guards' first run was red, on purpose and on live defects** — DEF-192, DEF-197, and (with
the exemption map empty) the five AR functions of DEF-190.

---

## Added 2026-09-10 — fingerprint capture, named by Ian while deciding DEF-260

⭐ **The clock terminal is a downloaded Android APK (GitHub-compiled) with a fingerprint reader on an OTG dongle, and that dongle is the punch-in/punch-out method — the way v1 does it.** Ian, 2026-09-10, recorded as **bible §13 row 190**. One or two tablets per store.

**The gap: nothing in this project captures or verifies a fingerprint.**

| Piece | State |
|---|---|
| The offline clock page itself | ✅ **Built and already the right shape.** `apps/erp/src/app/clock/page.tsx` (T-184) is client-only and offline-capable by construction, signing in with `signInWithCustomToken` and using the Firestore client SDK — never a Server Action, enforced by a test that fails the build, not by a comment. An APK wrapping it inherits that unchanged |
| Enrolling a fingerprint | ⚠️ **Interim only.** T-203's enrolment accepts pasted/typed template text and is labelled on screen as NOT a working capture flow. DEF-133's disposition justifies that with *“no capture device exists in this stack”* — **the OTG dongle is that device**, so the justification has now expired |
| Capturing from the dongle | ⛔ **Does not exist.** No APK build, no OTG integration, no capture path anywhere in `apps/`, `packages/` or `docs/` — a sweep for *apk / fingerprint / biometric / otg* returns only ADR asides and enrolment code |
| Verifying a scan against a template | ⛔ **Does not exist as a working path.** DEF-224 already records that `person_credentials_shape_check` admits a `biometric` row *“whose verifier does not land until Phase 4”* and that **there is no writer today** |
| The APK build itself | ⛔ **Unowned.** Ian says GitHub compiles it; no workflow, no repo reference, and `docs/ops` does not ship (DEF-194) |

⚠️ **Why this belongs here and not in the defects register:** nothing is broken. Every piece that exists works. This is a capability the business relies on daily in v1 that **no phase currently owns** — which is exactly what this document is for (RULES §3, the three doors).

### ⭐ WHERE IT ALREADY EXISTS IN v1 — Ian, 2026-09-10: *“its here https://erp.shareat.net/operation/attendance/time-clock”*

Read at source in `webapps/ERP-rebuild` (READ-ONLY, RULES §1 rule 1) rather than by signing into production. **This is a large, proven subsystem, not a snippet** — v1 is authoritative about WHAT (row 84), so this is a port-and-improve, not a design problem.

**The delivery mechanism, which answers the question v2 could not:**

> `src/lib/biometric/fingerprint.ts:3-6` — *“JS binding for the custom Android Fingerprint **Capacitor** plugin (`FingerprintPlugin.java`), wrapping the **ZKTeco ZKFinger Android SDK**. Mirrors `src/lib/nfc/nfcCard.ts`. **APK-only** — on `Capacitor.isNativePlatform()` and never invoke these in a browser.”*

So the APK is a **Capacitor** wrapper around the Next.js app, and the OTG dongle is reached through a **custom native Android plugin over the ZKTeco SDK** — acquire/release the USB sensor, prompting for USB permission. ⭐ **That is the piece v2 has no equivalent of and cannot invent from the web side**: a browser cannot talk to a USB fingerprint sensor, which is precisely why T-203 concluded *“no capture device exists in this stack”* and shipped paste-only enrolment.

| v1 source | What it holds |
|---|---|
| `src/app/operation/attendance/time-clock/page.tsx` (**1,070 lines**) | The terminal screen itself — four punch methods side by side: passcode, NFC, QR, fingerprint, plus face |
| `src/lib/biometric/fingerprint.ts` | The Capacitor↔ZKTeco binding. USB acquire/release, `isFingerprintAvailable` |
| `src/lib/biometric/fingerprint-core.ts` (+ test) | `buildFingerprintDbEntries`, `resolveFingerprintMatchToken` — template → **match token** |
| `src/lib/biometric/fingerprint-arm.ts` (+ test) | `planFingerprintArm` — the re-arm state machine that skips a USB re-open and template re-marshal after each punch |
| `src/lib/biometric/fingerprint-pool.ts` (+ test) | Which credentials are loaded into the reader: `loggedOutPool`, `soloPool` |
| `src/lib/biometric/fingerprint-token.ts` (+ test) | Token derivation |
| `src/lib/offline/credential-cache.ts`, `bundle.ts`, `punch-queue.ts`, `sync-engine.ts`, `offline-clock-device.ts`, `db.ts` | The offline half — cached credential bundle, queued punches, sync |
| `src/components/attendance/FingerprintWaiting.tsx`, `QrScannerModal.tsx`, `FaceCaptureModal.tsx` | The waiting/capture UI |
| `clockByPasscodeAction` · `clockByNfcAction` · `clockByFingerprintAction` · `clockByFaceAction` | The four server entry points |

⭐ **A business rule embedded in that screen, worth carrying and easy to miss** (`page.tsx:148-150`): *“Staff (non-admin/manager) on a device with a reader attached clock in by fingerprint ONLY — passcode/NFC/QR are hidden and the reader auto-arms. Admins/managers keep every method.”* A reader hard-fault un-hides the other methods. That is a deliberate anti-buddy-punching control, not a UI preference.

⚠️ **Do NOT port the security holes with it.** A prior review of v1's biometric attendance found the offline bundle leaked templates and tokens, and that a punch trusted the token alone; the bundle-gating and token-rotation halves were fixed in v1, but **nonce binding, liveness and rate limiting were left open**. v2 must not inherit those — bible §1.3: where v1 and correct practice disagree, this is a finding, not a precedent.

⚠️ **Scope reality check before anyone estimates this:** four punch methods, a native plugin, an offline queue and a re-arm state machine is **multi-week**, and ADR-005 already lists *attendance/biometrics/offline* among the multi-week efforts. Face recognition is present in v1 too and is a separate question Ian has not been asked.

⛔ **The sequencing trap, stated so it is not discovered late:** attendance and payroll are already built and tested against *enrolled* credentials. They do not need the dongle to be correct. But **on cutover morning nobody can punch with a finger unless the capture path exists**, and the current enrolment screen cannot produce a real template — only pasted text. Phase assignment is Ian's; the honest reading is that this is a Phase 4 remainder that was closed on paper.

---

## Added 2026-09-11 — found by webapps-65 while specifying T-266 (MoneyLines)

### ⚠️ Nothing settles a reimbursable — staff pay out of pocket and no screen can pay them back

`payReimbursement` (`packages/domain/src/expenses/reimbursement.ts`) shipped with **T-208**, closing
DEF-157, and `reimbursablePayableAgeing` (`packages/db/src/repo/findings.ts`) watches `2130` and
ages what is owed per employee. Both are real, both are tested.

⛔ **No screen in `apps/erp` calls either.** Measured 2026-09-11: `grep -rln payReimbursement
apps/erp/src` returns nothing.

So the loop is open at the end: a staff member buys something with their own money, the expense is
recorded as a `reimbursable` split, `2130` correctly accrues a liability to that named person, a
detector correctly starts ageing it — **and there is no way to hand them the money back.** The
ageing finding grows and the only resolution is a manual journal entry, which is exactly the
"someone will just post a correcting entry" habit v2 exists to remove.

⭐ **This is a GAP, not a defect**, and the distinction is the one §13 row 164 draws: nothing is
wrong, and nothing is missing from the ledger. A capability the business needs simply has no owner
in any phase.

⚠️ **Cheaper than it looks, and it should be taken with T-266.** The domain function, the posting
pattern, the ageing detector and the capability all exist. What is missing is one screen listing
what is owed per person with a "pay this" action — and T-266 is already migrating ~20 money screens
onto the shared `MoneyLines` picker, which is the control that screen would need. Building it
inside that pass costs a fraction of building it alone.

⚠️ **Note for whoever picks it up:** `payReimbursement` draws from a real money account and already
calls `checkDraw`, so the screen inherits the overdraft rule for free — it does not need its own.

---

## Added 2026-09-12 — decided out of scope by Ian while approving position access defaults (bible row 198)

### Subtractive position defaults — a job that takes a `staff` capability AWAY

T-289 gives a position a *default grant set* on top of the role matrix (additive only, Ian's
decision 1). What it deliberately does not do: let a position switch OFF a capability the `staff`
column grants. Today every `staff` holder has `record_sale`, `record_wastage`, `transfer_stock` and
18 others (21 rows, grep-counted) — a Dishwasher included.

**Why it is a gap and not a defect:** nobody has asked for it, and v1 cannot do it either (v1
positions only filter the sidebar). It becomes real the first time someone says *"a Dishwasher
should not be able to record a sale"*.

**What it would cost, so the next reader does not underestimate it:** a deny concept in
`authorize()` consulted *before* the matrix column — a fourth axis where bible row 114 fixes three
— plus the ordering question of deny-by-position versus grant-by-hand, plus every denial test the
matrix already has re-run under the new precedence. That is a planner-level bible amendment, not a
task. ⛔ **Do not build it as a special case inside `reconcilePositionGrants`** — a revoke of a
matrix-held capability is unrepresentable in `person_grants` (the matrix column is `true` whatever
the rows say), so the only honest implementation is the deny axis or nothing.
