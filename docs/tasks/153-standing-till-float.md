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

## 7. Answered by Ian, and the one thing still open

| | |
|---|---|
| **Which stores carry a float** | ✅ *"All stores, even franchisee."* — see §10 for what that means for a franchise |
| **How many tills per store** | ✅ *"1 store 1 till."* So one `1110` money account per store is the right model and §6's "if a store runs two tills" does not arise |
| **Shifts** | ✅ *"Most is 2 shifts, 1 morning 1 evening, same till."* — §9 |
| **The float AMOUNT per store** | ✅ *"Varying."* — each store carries its own figure. ⭐ **This changes nothing structurally**, and §11 explains why that is not a dodge |

### ⚠️ Correcting this doc's own earlier claim about where it gets recorded

An earlier draft of §7 said the float *"should be entered on T-134's count sheet."* **That is
wrong, and checking took one look:** `opening_counts` is keyed on `item_id` with a `quantity` and a
`unit_cost` — it is the **inventory** count sheet, and cash has no row in it.

⭐ Cash opening balances go through the **opening-balance entry** instead (`/cutover/opening`),
which posts each figure as a balanced pair against `3900` and halts on a residual. §8 states the
entry correctly.

---

## 8. ✅ The account structure — Ian's question, 2026-08-29

> *"OK well record it on ERP but what account will it belong? I just need to understand the
> structure."*

### It belongs to `1110 Cash on hand — cashier`. The same account as the day's takings.

⭐ **There is no separate float account, and that is the design rather than a shortcut.** An
account answers *"where is the money"*, and the answer is *"in the cashier's drawer"*. A dedicated
float account would answer a different question — *"why is it there"* — which a cash account is
not for. Worse, it would force every count to decide which account a given peso belongs to, and
**a peso in a drawer carries no label**. That is the mental arithmetic this exercise exists to
remove, reintroduced in the ledger.

### Establishing a float mid-life: a transfer between two asset accounts

```
Dr  1110  Cash on hand — cashier    20,000.00      the drawer gains
    Cr  1130  Cash on hand — office            20,000.00      the safe loses
```

⚠️ **Nothing touches profit.** Both legs are assets: the business is neither richer nor poorer, the
money changed rooms. This is exactly what `createMoneyTransfer` already posts — office → cashier,
the same path a float top-up or a change delivery uses.

### ⭐ At cutover it is simpler still — not a transfer at all

The money is **already in the drawer** on 31 December, so it needs no movement, only recording:

```
Dr  1110  Cash on hand — cashier    20,000.00
    Cr  3900  Opening balance equity          20,000.00
```

It is simply part of the counted opening cash for that till. ⛔ **Which is why the floats should be
recorded at cutover rather than as a correction now** — the opening count physically finds the cash,
and `3900` is the account that exists precisely to absorb *"this is what was there when we
started."*

### After that, the balance tells the whole story

```
till balance  =  float  +  takings since the last remittance  −  what has been paid out of it
```

A remittance sweeps the takings and leaves the float — proved by the second test in §3. **The
imprest self-check needs no extra machinery:** counted cash should equal the till balance, and any
other number is the discrepancy, visible without a reconciliation exercise.

## 9. ✅ Two shifts, one till — and the handover posts NOTHING

> **Ian:** *"1 store 1 till. Most is 2 shifts, 1 morning 1 evening, same till. They just count the
> 20k and hand it over after the 1st cashier reconciles his sales and hands over the remittance to
> the second cashier — see shift report."*

**v1 already models exactly this**, and its shape is worth porting (`types/index.ts:1443`,
`CashRemitShiftPlain`):

```ts
opening: {
  source: 'float' | 'manual' | 'handover',   // ⭐ three sources, and Ian named two of them
  floatAmount: number,
  prevShiftId?: string | null,               // ⭐ the chain between cashiers
  startedAt, startedByUid,
}
```

⭐ `'float'` is the standing ₱20,000 at the start of the day; `'handover'` is what the previous
shift passed on, linked by `prevShiftId`. Each shift carries its own `expectedCash` / `actualCash`
— the count, per cashier, attributable to one person.

### ⛔ The structural point: a shift handover is a DOCUMENT, not a journal entry

**No money moves.** Same drawer, same store, same `1110`, same custodian. What moves is
**responsibility**, and responsibility is not a ledger fact — the ledger records where cash *is*,
not whose turn it is to answer for it.

⚠️ **So the journal is involved exactly twice** in the whole cycle: when the float goes in, and
when the remittance comes out. Everything between is the shift report's job.

⭐ **This is T-136 §1's separation for the third time, and it keeps arriving from new directions:**

| | Unit | Purpose |
|---|---|---|
| **Count** | **the shift** | The custody control — a variance belongs to one cashier and one shift |
| **Transfer** | **the day** (or the pooled batch) | Logistics — the money physically going to the office |

Ian's description is precisely this: cashier 1 counts and reconciles, hands the drawer to cashier 2,
and the *remittance* happens once for the day.

⛔ **v2 does not have the shift report yet** — the count lives in POS's `cashHandovers` (discovery
09 §1), and T-123 models the sales day, not the shift. **That is the real gap this conversation
uncovered**, and it is bigger than the float: without a shift record, a count variance cannot be
attributed to one of two cashiers who shared a till. Not scoped here.

## 10. Franchise stores

> **Ian:** *"All stores, even franchisee."*

⭐ **v2 models a franchise as its OWN ORG**, not a branch — ADR-008 §7, correcting **DEF-050**
(*"v1 treats them as a branch but they are not actually"* — Ian, 2026-08-24). So a franchisee's
float is **its own money, out of its own safe**: the same entry, in that org's own books, with no
cross-entity due-from/due-to.

⚠️ **But Padre Garcia does not exist as an org in v2 yet** — DEF-050 records it as dormant because
it has posted nothing. Its float cannot be recorded until the org is.


## 11. ⭐ "Varying" per store changes nothing — and the reason is the good part

> **Ian, 2026-08-29**, asked whether ₱20,000 is every store's float: ***"varying."***

The instinct is that per-store amounts now need a per-store **setting** — a `float_amount` column,
an admin screen, a number to keep in step with reality. **They do not, and the reason is worth
stating because it is the whole shape of this feature.**

### The float is not money ADDED to the drawer. It is the amount NOT REMITTED.

That reframing is the key. *"Maintained at ₱20,000"* does not mean topping the drawer up each
morning; it means **leaving ₱20,000 behind when the takings go to the office**.

And that is already exactly what the system does, because **expected remittance is the period's
MOVEMENT, not the account's BALANCE** (bible row 145, T-152 §3):

```
till balance after remitting  =  float + movement − movement  =  float
```

⭐ **So the float maintains itself, at whatever number each store happens to hold**, with no
setting to configure and none to drift. The second test in §3 is this arithmetic: a till holding
₱28,000 remits the day's ₱8,000 and settles at ₱20,000, and nothing anywhere was told that
₱20,000 was the target.

⚠️ **This is why row 145's "movement, not balance" mattered more than it looked.** Had expected
remittance been the closing balance — the *remit to zero* branch of §4 — every float would be
swept to the office every night, and a per-store float amount would then be **compulsory** to know
how much to hand back each morning. The decision that looked like an accounting nicety is what
makes this feature free.

### ⛔ The one case a declared amount would buy something

**Telling an underfunded float apart from a shortage.** If Lipa's till settles at ₱15,000, is that
a ₱15,000 float or a ₱20,000 float missing ₱5,000?

The ledger can answer today — the float was funded by a recorded entry, and any later drop is a
posted outflow or a count variance — but answering takes reading history rather than reading one
number.

**Recommendation: still no column.** A declared amount would be a second place the float lives, and
rows 143/145/147 each refuse exactly that; it would also need its own screen, its own capability and
its own drift. ⭐ **If the question "what should this till hold?" ever needs a one-line answer, the
honest place for it is the shift record (CAPABILITY-GAPS, 2026-08-29) — beside the count that asks
it — not as a standing setting on the store.**
