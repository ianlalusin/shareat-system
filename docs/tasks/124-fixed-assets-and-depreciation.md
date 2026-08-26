# T-124 — Fixed assets and depreciation

> **Status:** spec 2026-08-25, **v1 read first.** Wave 2's first item.
> **Why it is next:** it is the only remaining task with a **physical December deadline** — the
> asset walk-round (T-134 B2) cannot capture the right fields until this model exists.
> **Depends on:** T-105 (`postEntry`) · T-121 · T-138 (a real actor)
> **Feeds:** T-134 (the cutover's opening asset balances) · T-135 (the missed-depreciation finding)

## 1. Why this one, now

**January is the deadline and depreciation is a monthly obligation.** If it does not post, the
books are understated from their first day — the phase plan's own words about Wave 2.

But the sharper reason is a date: **the December walk-round is a physical activity**. Someone
walks every store and writes down what exists and how much life it has left (bible row 109). **If
this model does not exist by then, they capture the wrong fields**, and no software fixes a
measurement nobody took.

---

## 2. What v1 has, and most of it is right

`ERP-rebuild/src/types/index.ts:2655-2699`

| | |
|---|---|
| `category` | Building · Equipment · Machinery · Furniture & Fixture · Vehicles · Smallwares · Appliances |
| `purchaseDate` · `purchaseCost` · `usefulLifeYears` · `salvageValue` | The inputs depreciation needs |
| **`depreciationMethod: 'straight_line'`** | ⭐ **One method, and that is a good decision.** Declining-balance and units-of-production exist and nobody here needs them; a method enum with one value is honest about that |
| `depreciationInterval: monthly \| quarterly \| annually` | Real flexibility that costs nothing |
| ⭐ **`needsReview`** | Auto-capitalised from an over-threshold CAPEX expense on default terms. **It depreciates immediately and a manager is asked to confirm the terms** — editing clears the flag |
| `sourceExpenseId` · `sourceDeliveryId` | Back-links to whatever capitalised it |
| Disposal: `disposalDate` · `disposalReason` · **`disposalLoss`** | The loss is the remaining book value at write-off |

### ⭐ `needsReview` is the best idea in this module

**It refuses the false choice between "block the expense until someone sets a useful life" and
"silently guess".** The asset starts depreciating on defaults so the books are never wrong by
omission, *and* it is visibly flagged until a human confirms the terms. **Port it exactly.**

### The T-122 seam is already built

`expense_categories` maps CAPEX to **1510**, and T-122 posts it there today. **v1 then
auto-capitalises an over-threshold CAPEX expense into an asset.** That is the join, and this task
is where 1510 stops being a bucket and becomes a register.

---

## 3. ⛔ The one thing v2 must not inherit

`depreciation.actions.ts:160`:

```
const newAccumulated = (asset.accumulatedDepreciation ?? 0) + depAmount;
```

**`accumulatedDepreciation` and `bookValue` are STORED on the asset and incremented in parallel
with the journal entry.** Two sources of truth for one number.

> ⚠️ **And DEF-044 proves they diverge in practice**: v1's depreciation stopped silently for two
> months. Every asset's stored `accumulatedDepreciation` then disagreed with the ledger by two
> months' worth, and **nothing anywhere compared them** — the asset register looked fine.

**v2: accumulated depreciation is DERIVED from the ledger.** Sum the depreciation postings for
that asset. Book value is `cost − derived accumulated`. Nothing is incremented, so nothing can
drift, and a missed run shows up as a smaller number rather than as a lie.

*Same lesson as T-123's revenue and T-135's findings: derived, not maintained.*

## 4. ⛔ The DEF-044 lesson, made structural

v1's scheduler stopping was **invisible**. A monthly obligation that silently does not happen is
the worst shape a control can take, because absence looks exactly like nothing-to-do.

**v2 answers it twice:**

1. **The run is idempotent per (asset, period)** — `idempotencyKey = asset:{id}:depreciation:{period}`,
   so re-running a month is safe and catching up is just running it again.
2. ⭐ **A missing run is an OIL FINDING** (T-135): *"an active asset with no depreciation posted
   for a closed period."* **Derived from the condition**, so it cannot be resolved while still
   true. That is exactly what would have surfaced DEF-044 in week one instead of at a capture.

## 5. Posting

| Event | |
|---|---|
| **Capitalisation** | DR 1510, CR the funding side — already what T-122 does for a CAPEX expense |
| **Depreciation** | DR depreciation expense, CR **accumulated depreciation (contra-asset)** |
| **Disposal** | DR accumulated depreciation (1590), DR **loss on disposal 7400** for the remaining book value, CR 1510 |

⚠️ **Accumulated depreciation is a CONTRA-ASSET account, not a reduction of 1510.** The asset's
cost stays visible at cost for its whole life; the contra account carries what has been consumed.
Netting them directly would destroy the one figure an auditor asks for first.

**Look the patterns up before implementing** — `docs/POSTING-PATTERNS.md` and
`docs/decisions/COA-ALIGNMENT.md` decide the account codes, not this document.

## 6. Scope

**In:** the `fixed_assets` table · capitalisation from a CAPEX expense (T-122's seam) ·
straight-line depreciation, monthly/quarterly/annual · the scheduled run · disposal with its loss ·
derived accumulated and book value · the screens.

**Out:** revaluation · impairment · component depreciation · declining-balance and
units-of-production (§2: one method is the decision, not an omission) · tax vs book depreciation
as separate schedules — ⚠️ **that last one is a real thing this business may eventually need, and
it is named here so nobody assumes it was considered and dismissed.**

## 7. Invariants

1. **Accumulated depreciation is never stored.** Provable: no column, and a test that the derived
   figure equals the ledger sum.
2. Depreciation is **idempotent per (asset, period)** — running twice posts once.
3. **An asset never depreciates below its salvage value**, and the final period takes the
   remainder rather than overshooting.
4. A **disposed** asset stops depreciating, and its disposal posts the remaining book value as a
   loss.
5. `needsReview` is set by auto-capitalisation and **cleared only by a human editing the terms**.
6. **A missed period surfaces as a finding**, not silence (§4).
7. Every capability has a denial test — `manage_fixed_assets` and `run_depreciation` are both
   admin-only in the matrix.

## 8. ⭐ v1's capitalisation policy — read, not invented

`expense.actions.ts:55`:

```
const CAPITALIZATION_DEFAULTS = { threshold: 5000, usefulLifeYears: 5, salvageValue: 0 };
```

**A CAPEX purchase over ₱5,000 is auto-capitalised on 5 years, zero salvage** — with the real
policy read from an `appConfig/capitalization` document and those figures as the fallback. Not
per-category, one policy.

### ⭐⭐ And the fail-closed here is the best code I have read in v1

If the policy document **cannot be read**, v1 refuses to record the expense at all:

> *"Could not read the capitalization policy, so this CAPEX purchase was not recorded — posting it
> now would capitalize the asset on default terms instead of yours."*

The comment above it says why: a silent fallback *"understates depreciation by ~60% on everything
capitalized."* **Somebody computed the cost of the wrong answer and then refused to let it
happen.**

> ⚠️ **The same codebase does the opposite in DEF-062**, where a missing HMAC secret falls back to
> a key printed in the source and merely logs. **Identical shape, opposite outcome** — and the
> difference is that here someone worked out what the silent path would cost. *That is the whole
> argument for asking "what does the fallback actually do?" every time one is written.*

**Port the refusal. Port the reasoning in the message.**

## 9. ✅ Researched — `docs/discovery/25-depreciation-policy.md`

**There is no standard to comply with.** Both numbers are judgement calls the business is expected
to make and document, so the useful question is what each choice costs.

| | Verdict |
|---|---|
| **Per-category useful lives** | ✅ **ADOPT**, defaulting to 5. PH prescribes nothing; common anchors are vehicles 5, buildings 20, PPE generally 5–10. A flat 5 applied to a building is wrong by fifteen years |
| **One method** | ✅ **CONFIRMED, with a better reason than simplicity: changing depreciation method requires BIR approval.** A dropdown offering declining-balance would let someone create a filing obligation with a click |
| **Zero salvage default** | ✅ Keep. Conservative, and editable where a resale value is genuinely known |
| **Threshold** | ✅ **₱5,000** — raised to ₱10,000 and returned to ₱5,000 the same day (bible row 141 supersedes 139). **One threshold, shared with prepaid items** |

### ✅ Threshold: ₱10,000, then back to ₱5,000 the same day (Ian, 2026-08-26)

> ⚠️ **Superseded within hours, and the reversal is the more instructive half.** Row 139 raised
> it; row 141 put it back. Ian: *"10k might be a bit high to absorb in one accounting period."*
> **A higher threshold does not spread more cost — it expenses more of it immediately**, because
> everything below the line is absorbed in one period. ₱10,000 was what let a ₱9,999 purchase
> land entirely in one month's P&L. The paragraph below records the original raise; it is kept
> because its materiality reasoning still holds, only its number does not.

Nothing prescribes a threshold; it is a **materiality** decision, and the trade-off is
recordkeeping burden against expense smoothing. **Here the burden is physical** — every
capitalised item is a row someone stands in front of during T-134's December walk-round.

**Doubling it removes the cheap end of the register**: a ₱6,000 chair or a ₱8,000 rice cooker is
now expensed on the day it is bought rather than tracked, depreciated and counted for five years.
⚠️ **That is a TIMING difference, not a permanent one** — the same money reaches the P&L either
way, just sooner.

**⭐ Where the number LIVES matters as much as the number.** v1 reads it from a config document
with a constant as fallback (§8), and refuses to post if it cannot read it. **Port that exactly**:
the threshold is configuration, and a threshold nobody can read must stop the posting rather than
silently substitute a default.

---

## 10. ⭐ Useful lives: the logic, then the table

> ⚠️ **Superseded in part by §11.1 (Ian, 2026-08-26).** The *reasoning* below stands and is still
> how a life should be chosen. The **unit and the default do not**: a life is a **month count**
> defaulting to **24**, set per asset, not a per-category table of years agreed once.

Ian asked what makes a building 20 and a vehicle 5. **The answer is one question, and it is not
"how long could this last?"**

> ### How long until we would realistically REPLACE it?
>
> Not its engineering life — the point at which this business actually buys another one. That is
> what makes depreciation match reality instead of a manufacturer's brochure.

**Three things drive it, and a restaurant is unusual in the third:**

| Driver | |
|---|---|
| **Physical wear** | How hard is it used? A commercial kitchen is brutal — heat, grease, water, twelve-hour days. The same fridge lasts far longer in an office |
| **Obsolescence** | Replaced because something better exists, not because it broke. Tablets and terminals go this way |
| ⭐ **Aesthetic life** | **Replaced because the place looks tired.** Furniture in a restaurant is retired long before it is broken — and this is the one most businesses forget to price |

**So a building is 20 because it is structural, sheltered and maintained; a vehicle is 5 because it
is used daily and wears mechanically.** Everything else sits between those two on the same scale.

### The proposed table — ⚠️ a starting point for Ian and his accountant, not a decision

| Category | Years | Why |
|---|---:|---|
| **Building** | **20** | Structural and maintained. The common PH anchor |
| **Machinery** | **10** | Heavy kitchen plant — ranges, chillers, exhaust. Built for it, and used hard |
| **Equipment** | **7** | General equipment. Lighter duty than machinery, heavier than an office's |
| **Furniture & Fixture** | **5** | ⭐ **Aesthetic life, not physical.** A dining room is refreshed long before the chairs break |
| **Appliances** | **5** | Aircon and refrigeration run continuously in this climate. Rarely reach seven |
| **Vehicles** | **5** | The common PH anchor, and it matches when a vehicle stops being reliable |
| **Smallwares** | **3** | Consumed, broken and replaced. Five years overstates every one of them |

### ⚠️ Raising the threshold partly hollows out Smallwares

⚠️ *Written when the threshold was ₱10,000; at ₱5,000 this bites less, but not none.* At ₱10,000, **almost nothing a kitchen calls a smallware clears the bar** — pans, utensils and
plates are expensed on purchase. **The category is not wrong, it is now rarely used**, and an item
expensive enough to be capitalised is probably not really a smallware.

> **Worth knowing rather than fixing.** A category that legitimately goes quiet is fine; a
> category quietly collecting things that do not belong in it is not. If Smallwares starts filling
> up, the threshold or the categorisation is being worked around.

## 11. Settled — Ian, 2026-08-26

All three questions this section used to hold are now answered. Nothing here is open.

### 11.1 Useful life is measured in MONTHS, and the default is 24

> **Ian:** *"default to 24 months, make configurable by months."*

**This supersedes §10's per-category table of YEARS and the accountant's-nod question with it.**
A life is now a **month count**, defaulted to **24**, and editable per asset.

Two consequences, and the first is the one that bites:

- **`usefulLifeYears` is the wrong column.** Years cannot express 30 months, and rounding to 2 or 3
  is exactly the silent imprecision §3 exists to refuse. It becomes **`usefulLifeMonths`**, and the
  interval maps to a month step rather than a per-year count.
- §10's reasoning is **kept, not deleted** — "how long until we would realistically REPLACE it" is
  still the right question and still the thing to think with. What changed is the unit it is
  answered in and who answers it: **per asset, at the point it is added**, rather than a table
  agreed once and applied by category.

`asset_category_lives` survives as the place a per-category default lives, now in months and
seeded to 24 across the board — so a category can be given its own default later without a
migration, and until then every category simply answers 24.

### 11.2 Depreciation posts PER ASSET, per period

> **Ian:** *"per asset per period."*

Confirms the suggestion. `source_type='depreciation'`, `source_id` = the asset,
`idempotencyKey = asset:{id}:depreciation:{period}` — so *"which asset is this ₱4,000 for?"*
is answerable from the entry alone, and catch-up stays a re-run.

### 11.3 The interval is chosen per asset, and SEMI-ANNUAL is added

> **Ian:** *"for period when asset is added user may configure monthly quarterly semi anual annual."*

The interval is set **when the asset is added**, per asset, from four choices:

| Interval | Periods / year | Month step |
|---|---|---|
| Monthly | 12 | 1 |
| Quarterly | 4 | 3 |
| **Semi-annual** — **new** | **2** | **6** |
| Annual | 1 | 12 |

⚠️ **`semiannual` does not exist yet** — not in the schema enum, not in the CHECK constraint, and
not in `schedule.ts`'s interval map. Migration `0019` is applied, so this is a **new** migration,
never an edit to that one (RULES.md rule 9).

---

## 12. What T-124 did NOT build, and what each one needs

Written 2026-08-26, at Ian's request, so these are buildable later without re-deriving them.
**All four are real gaps, not polish.** Everything else in this spec is shipped and green.

### 12.1 ⛔ The SCHEDULER — the one that is not optional

**What exists:** a Run button on `/fixed-assets`, and `runDepreciation(tx, actor, { through })`,
which is idempotent per `(asset, period)` and re-runnable.

**What does not:** anything that calls it without a human pressing a button.

> ⭐ **This is the whole of DEF-044.** v1's depreciation was also "a button" — its own seed data
> claims it is *"auto-generated by the depreciation cron"* and **no such cron has ever existed**
> (`ERP-rebuild/src/lib/seed-expense-entries.ts:207`; nothing anywhere calls
> `processMonthlyDepreciationAction` but two UI buttons). It stopped for two months, ₱35,483.98 a
> month went unbooked, and it was found by an audit rather than by anybody noticing.
> **We have now reproduced v1's exact shape.** The phase plan's own line for this task reads
> *"Fixed assets + **scheduled depreciation** — the thing v1's stopped scheduler proves matters"*,
> so the scheduled half is named in the plan and is not yet built.

**What it needs.** A monthly trigger, after month-end, calling `runDepreciation(null, systemActor,
{ through: lastMonth })` — `null` so each asset gets its own transaction and one failure cannot
roll back the rest. Two things make it different from a naive cron:

- **It needs an actor.** `run_depreciation` is admin-only and `authorize()` takes a real `Actor`;
  a scheduler has no session. Either a system principal (`app.principal_kind` already
  distinguishes one) or a designated service person. **This is the design decision, not the cron
  syntax.**
- **A failure must be visible.** The run already returns `failed[]` with a reason per asset —
  most likely *"no fiscal period covers 2026-06-30"*. If the scheduler discards that, we have
  rebuilt the silence, and a scheduler that fails quietly is worse than the button, because
  nobody is even expecting to press anything.

⚠️ Until this exists, **§12.3's drift report is the only thing standing between us and DEF-044
happening again in v2** — and it is not surfaced anywhere either.

### 12.2 The admin screen for policy and per-category lives

**What exists:** `asset_policy` (threshold, default salvage) and `asset_category_lives` (a life in
months per category), both with repo upserts and both read by the domain.

**What does not:** any way to edit them outside SQL. The register footer honestly says
*"₱5,000.00 (default — no policy set)"*, which is true and will stay true until someone inserts
a row.

**What it needs.** One small screen under `/fixed-assets/settings`, gated on
`manage_fixed_assets`: threshold, default salvage, and a seven-row table of category → months.
`fixedAssetsRepo.upsertPolicy` and `upsertCategoryLife` already exist and are idempotent.

⚠️ **The threshold is the number that decides how many rows exist in the December walk-round**
(bible row 139) — a materiality judgement with a physical cost. It should be visible and editable
before the cutover, not a value only an engineer can see.

⭐ **Do not add a per-asset life default here.** The life is copied onto the asset AT
capitalisation and never looked up again, deliberately — changing the org default must not
silently rewrite the schedule of every asset already on the books. The screen edits FUTURE
defaults only, and should say so on screen.

### 12.3 The OIL finding — surfacing the drift

**What exists:** `depreciationDrift(tx, actor, { through })` returns, per active asset, what the
ledger *should* show against what it *does* — with an integration test proving it detects a
missed month and goes quiet once caught up.

**What does not:** any caller. Nothing runs it, nothing displays it, nothing alerts on it.

> ⭐ **Why this comparison is possible at all is the point.** In v1 the "expected" and the
> "actual" were the same maintained column, so comparing them proved only that a number equals
> itself — which is precisely why a two-month outage was invisible. Here the expected figure comes
> from the pure schedule and the actual from the journal, so they are genuinely independent.

**What it needs.** T-135's findings layer, with this as one finding: *"an active asset with no
depreciation posted for a closed period."* Until T-135 exists, a banner on `/fixed-assets` when
`depreciationDrift` is non-empty would cost almost nothing and would catch the DEF-044 shape.

### 12.4 `pending_valuation` shells have no screen

**What exists:** the status, its CHECK constraints (a shell MUST have null cost and acquisition
date; anything else MUST have both), the `keep_shell` cutover classification with its
`clearColumns`, and `fixedAssetsRepo.valuateShell`.

**What does not:** the screen that walks someone through valuing them.

**This is T-134's, not a T-124 leftover** — ADR-007's cutover clears cost from surviving asset
rows on 1 January and they are re-entered from the December count. Listed here only so the next
reader does not mistake the missing screen for an oversight.

