# 25 — Depreciation policy: what the standard actually says, and what it leaves to you

**Date:** 2026-08-25 · **Prompted by Ian:** *"Research on policy — what is industry standard?"*
**Answers:** T-124 §9's two open questions · **Feeds:** T-134's December walk-round

**The short version: there is no standard to comply with here.** Both numbers are judgement calls
the business is expected to make and document. So the useful question is not *"what is correct?"*
but *"what does each choice cost us?"* — and one of them has a cost nobody has counted yet.

---

## 1. Useful lives — ⭐ the Philippines prescribes NOTHING

> *"There is no prescribed periods for useful lives in the Philippines, so taxpayers are given
> freedom to reasonably estimate the same. Reasonableness is a matter of professional judgement
> based on the nature of the property and the extent of use."*
> ([Tax and Accounting Center](https://taxacctgcenter.ph/deductible-depreciation-expense-for-income-tax-in-philippines/))

**Commonly used in practice:** vehicles **5 years**, buildings **20 years**, and PPE generally on
straight line with lives **5–10 years**
([Grant Thornton PH](https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/property-plant-and-equipment-vital-to-business-operations/) ·
[Accountable PH](https://www.accountable.ph/property-plant-and-equipment-valuation-and-depreciation)).

### ⚠️ So v1's flat 5 years is defensible — and crude

**Five years is the low end of the common range applied to everything.** A building on five years
is wrong by fifteen; a smallware on five years is wrong the other way. The category enum already
exists (`Building · Equipment · Machinery · Furniture & Fixture · Vehicles · Smallwares ·
Appliances`), so **per-category lives cost a lookup table and buy depreciation that is not
obviously wrong.**

**VERDICT: ADOPT per-category lives**, defaulting to 5 where nothing better is known. It is
already how the field does it, and the data model is ready for it.

### ⭐⭐ The finding that vindicates v1's single method

> *"Should there be any change in the depreciation method used in the business, **approval from
> the BIR is needed**."*

**So `depreciationMethod: 'straight_line'` is not merely simplicity — the alternative carries
regulatory friction.** Offering declining-balance in a dropdown would let someone create a filing
obligation with a click. **Keep one method. Do not re-propose this.**

---

## 2. The capitalisation threshold — ⛔ ₱5,000 may be a borrowed number

> *"No standard prescribes a threshold; GAAP and IFRS rely on **materiality**, making it a
> documented policy decision."*
> ([AssetCues](https://www.assetcues.com/blog/fixed-asset-capitalization-threshold/) ·
> [CPDbox](https://www.cpdbox.com/030-capex-threshold-ppe-ifrs/))

US practice anchors on the **IRS de minimis safe harbor — $2,500, or $5,000 with an applicable
financial statement** ([AccountingTools](https://www.accountingtools.com/articles/capitalization-policy) ·
[Wipfli](https://www.wipfli.com/insights/articles/aa-the-three-ds-of-fixed-asset-accounting-dos-donts-and-details)).
**That is a US tax rule and does not apply here.**

### ⚠️ The observation worth raising

**v1's threshold is ₱5,000 — and the most-cited convention anywhere is $5,000.** The same digits.

> ⭐ **₱5,000 is roughly $85.** If the figure was reached by borrowing a familiar number rather
> than by asking *"what is material to this business?"*, it is **about sixty times lower** than
> the convention it resembles. **I cannot prove that is what happened, and it may simply be a
> deliberate, sensible choice** — but the coincidence is worth one look, because nothing else in
> v1 explains where 5,000 came from.

### ⭐ The cost nobody has counted — and it lands in December

The guidance frames the trade-off as **recordkeeping burden versus expense smoothing**: a small
business may accept a low threshold, *"whereas a larger business that may be overwhelmed by the
recordation requirements of fixed assets may prefer a very high limit."*

**For this business the burden is not abstract. It is physical:**

| At ₱5,000 | |
|---|---|
| A rice cooker, a set of pans, a decent chair | **All become depreciating assets** |
| Four stores' worth of them | **Hundreds of asset rows**, each with a schedule |
| ⛔ **T-134 step B2** | **Every one of them must be physically found and confirmed in the December walk-round** |

> **The capitalisation threshold silently sets the length of the asset walk-round.** Raising it to
> ₱20,000 could remove a large fraction of the rows a person has to stand in front of and tick —
> at the cost of expensing those purchases immediately, which is a timing difference, not a
> permanent one.

**VERDICT: DO NOT change it unilaterally. Put the number and its December consequence to Ian and
his accountant**, with the walk-round cost stated, because that is the half nobody has priced.

### One consistency point to carry

US practice requires the **same threshold for tax and for books**
([AccountingTools](https://www.accountingtools.com/articles/capitalization-policy)). The principle
travels even where the rule does not: **one threshold, applied both ways.** ⚠️ A system that let
them differ would need two depreciation schedules per asset — explicitly out of scope in T-124 §6,
and worth keeping out.

---

## 3. Salvage value

Nothing in the sources treats a **zero** default as wrong, and it is the conservative choice: it
depreciates the full cost, which never overstates the asset. **Keep zero as the default**, with
the field editable for the cases where a resale value is genuinely known (a vehicle, most
obviously).

---

## What this changes in T-124

| | |
|---|---|
| **Useful lives** | ✅ Per-category, defaulting to 5. Adopted — it is standard practice and the enum exists |
| **One method** | ✅ Confirmed, and now with a REASON beyond simplicity: changing method needs BIR approval |
| **Threshold** | ✅ **₱10,000** — Ian decided on 2026-08-26, doubling v1's figure. See below |
| **Salvage** | ✅ Zero default, editable |

## ✅ Decided 2026-08-26 (bible row 139)

**Threshold: ₱10,000**, doubling v1's ₱5,000 — Ian, without needing the coincidence resolved. The
December walk-round shortens accordingly, and the cheap end of the register is expensed on
purchase instead: **a timing difference, not a permanent one.**

**Per-category lives adopted**, with T-124 §10 carrying the reasoning and a proposed table. The
durable part is the question a life answers — *"when would we realistically replace it?"*, never
*"how long could it last?"* — and the restaurant-specific driver most businesses forget: **aesthetic
life**, because a dining room is refreshed long before its chairs break.

### Still open

- **The lives themselves want the accountant's nod once.** Changing a life does not need BIR
  approval the way changing the *method* does — but an estimate that keeps moving is one nobody
  trusts, so agree them and leave them.
