# T-153 — The standing till float

> **Status:** ✅ **NO BUILD REQUIRED, 2026-08-29 — and that is the finding.** The float rides on
> primitives that already exist; two integration tests in `remittance.test.ts` prove it.
> **Requirements:** Ian, 2026-08-29. Closes T-136 §8.4's open *"is there a retained float?"*
> question and supersedes T-136 §2's imprest design. **Evidence:** DEF-085.

## 1. What Ian asked for

> *"The revolving fund admin or manager give to cashier at the start of the day for change for
> expenses. So we design the cashier till that way that it has fund per cashier."*

and, decisively, how it works today:

> *"Actually in practice that budget is agreed upon and **never recorded** — the admin, manager and
> cashier just know that there is an extra 20k in till, and it **has to be counted daily and
> maintained**."*

⭐ **The second quote changes the shape of the answer.** This is not a fund released each morning
and returned each night. It is a **standing balance** that lives in the drawer, is counted daily,
and is topped back up to its agreed amount. That is the imprest pattern T-136 §2 described — with
the entire record missing.

## 2. ⛔ What is actually wrong today: the books do not know the money exists

If ₱20,000 sits in a till and nothing recorded it moving there, then `1110 Cash on hand — cashier`
is **understated by the float, permanently, for every store that has one** — and office cash is
overstated by the same amount. The company total is right; the split is wrong, in the two accounts
a cash count is checked against.

⚠️ **This is why the daily count currently needs a human to remember a number.** *"Counted daily
and maintained"* against **what**? Today the expected figure lives in three people's heads. The
count cannot be checked against the books, because the books are missing the float.

⭐ **So the gap is not a feature. It is one unrecorded transfer.**

## 3. ✅ The float needs NO new code — proved, not argued

The primitives already treat it correctly, and two tests in
`packages/domain/tests/integration/remittance.test.ts` demonstrate it end to end:

| Proved | Result |
|---|---|
| A ₱20,000 office→till transfer, then read what the day owes | Till balance **₱28,000**; the day still owes exactly **₱8,000** |
| Remit that ₱8,000, then read the till | Till holds exactly **₱20,000** — the float survives |

**Why it works without being designed for:** `endDayReports` (and T-152's `storePositions`) exclude
`source_type = 'transfer'` in both directions, because a transfer is *custody, not a transaction of
the day*. So a float delivered by transfer is:

- **excluded** from what the cashier must hand over — it is not takings, and
- **included** in the account balance — so a count has something true to check against.

⭐ **v1 proves the same rule from the other side.** Its shift-mode arithmetic is
`expectedEndingCash = openingFloat + cashPayments + netCashFlows`, while
`computedRemittanceCash = cashPayments + netCashFlows`. **The float is in the COUNT and absent from
the REMITTANCE** (`derive-totals.ts:176-201`). That is exactly the separation T-136 §1 argued for —
*count the till daily, transfer on whatever cadence suits* — and v2 inherited it by building the
transfer exclusion for an unrelated reason.

## 4. ✅ This answers T-136 §8.4, which was left open

§8.4 asked whether a **retained float** exists, because *"in minus out"* assumes the drawer keeps
what it started with:

```
retained float   →  expected = net movement over the period      ← ✅ THIS ONE
remit to zero    →  expected = closing balance
```

**Ian's answer is retained**, and the code already implements it. No per-store setting is needed
for this after all — the question §8.4 wanted configurable turns out to have one answer.

## 5. ⛔ Why it belongs in the ERP, not only in POS

> **Ian:** *"So I guess we can just put it in POS rather than in ERP since it's not remitted daily,
> it is just kept in till."*

**The instinct is right about the workflow and wrong about the record**, and the two can be split:

| | Where it belongs |
|---|---|
| **The counting, at the till, every day** | ⭐ **POS.** It already does this — `cashHandovers` records `startingCash`, `countedCash`, `variance` (discovery 09 §1) |
| **The fact that the business's cash is ₱20,000 in a drawer rather than in the safe** | ⛔ **The ledger. There is nowhere else it can live** |

Three reasons the record cannot be POS-only:

1. **It is real company cash.** A balance sheet that cannot say where its own money is has a hole
   the size of the float times the number of stores.
2. **Bible §2.3: Postgres is the sole system of record**, and POS is Firestore. A float held only
   in POS is an authoritative balance outside the system of record.
3. ⚠️ **It would defeat its own purpose.** Ian's requirement is that the float be *maintained* —
   which needs an expected figure to maintain it against. If the amount lives in POS and the cash
   lives in the ERP's ledger, the two can disagree and **nothing would ever notice**.

⛔ **And a hard constraint worth stating plainly: this project cannot write to POS at all.** All
four reference repos are READ-ONLY (`docs/RULES.md` rule 1). POS v2 does not exist yet.

⭐ **The cost of doing it in the ERP is one transfer, once, per store.** Not a module, not a daily
workflow, not a screen — the money-transfer screen already built does it today. When POS v2 arrives
it reads the till balance from the ledger rather than keeping a second copy.

## 6. What is deliberately NOT built

| Out | Why |
|---|---|
| A `float_amount` column, a float entity, a release/return document | ⭐ The float is a **balance**, not a document. Recording an intended amount beside the real one creates the second source of truth rows 143/145/147 each refuse — and the imprest self-check needs only the balance |
| A per-cashier split of the till | v2 has one cashier-cash account per store, matching one drawer. **If a store runs two tills, that is two money accounts**, which the model already allows — `(store, instrument, custodian)` is unique, so a second cashier drawer needs a decision from Ian before it is invented |
| An automatic "float is short" finding | ⭐ Deferred on purpose: the check is `counted = float + movement since last remittance`, and **nothing captures `counted` in the ERP yet** — the count lives in POS's `cashHandovers`. Building the alarm before the input exists would be a detector that can never fire |
| Porting `plus.openingBudget` | **DEF-085** — dead in v1's arithmetic and null in all production data (Ian, 2026-08-29) |

## 7. What Ian still has to decide

1. ⚠️ **The float amount per store**, and whether both branches carry one. Business policy, same as
   T-152's ceiling.
2. **Whether to record the existing floats now or at cutover.** Recording one is a single
   office→till transfer on the money-transfers screen. ⭐ **At cutover is the natural moment** — the
   opening count will physically find the cash in the drawer, and T-134's count sheet is where it
   should be entered rather than as a correction afterwards.
3. **Whether any store runs more than one till** (§6).
