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
| **Disposal** | DR accumulated depreciation, DR loss on disposal (6xxx) for the remaining book value, CR 1510 |

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

## 9. Open

1. **Are 5 years / zero salvage / ₱5,000 still right?** Ian's call. They are v1's defaults, and
   defaults that have never been revisited are worth one look before they carry into a new ledger.
2. **Per-category useful lives instead of one number?** A vehicle and a smallware do not wear out
   at the same rate, and the category enum already exists. **Suggest yes, defaulting to 5** — the
   cost is a lookup table and the benefit is depreciation that is not obviously wrong.
3. ⭐ **Does depreciation post per asset or per category per period?** Per asset is more
   traceable; per category is far fewer lines. **Suggest per asset** — with a few hundred assets
   this is not a volume problem, and *"which asset is this ₱4,000 for?"* is a question somebody
   will ask.
