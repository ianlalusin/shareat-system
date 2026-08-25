# T-136 — Cash custody: pooled remittance and the store revolving fund

> **Status:** ⚠️ **REQUIREMENTS ONLY, 2026-08-25.** Ian's brief, captured with the structural
> findings that constrain it. **Not a design** — §5 names what must be researched first (bible
> §3.6). Recorded now so it is not lost, and because it changes T-123's shape.
> **Related:** bible rows 122 (period close), 126 (sales day), 127 (the owner split)

## Ian's brief

> *"Is it logical to pattern it to the lock of ERP, which is monthly with a 15-day grace period, so
> POS sales can be locked monthly instead of daily? So instead of daily remittance as required,
> remittance can now be pooled — for example 3 days' sales in one remittance, weekly remittance, or
> monthly remittance will be possible. And it is common for us to allot a store budget, a petty
> cash the store can use as a revolving fund for operations — it must also be taken into
> consideration."*

---

## 1. Pooled remittance — **yes, and it is safer than it sounds**, with one correction

### Why it is accounting-safe

**Revenue recognition does not depend on remittance.** A sale is revenue when it happens,
regardless of whose hands the cash is in. Remittance moves money between two asset accounts
(cashier → office); it touches no revenue account and no P&L line.

> **So pooling remittance cannot make the books wrong.** It changes only *when* cash moves between
> two asset accounts. This is a real and often-missed separation, and it is why the answer is yes.

### ⚠️ The correction: do NOT pattern the cadence on the monthly lock

The monthly lock plus 15-day grace solves **late-arriving invoices** — an August electricity bill
that reaches you on 10 September (ADR-006 §7.2). **Cash custody is a different risk with a
different clock:**

| | Period close | Cash in a till |
|---|---|---|
| What is at risk | A figure being wrong | **Money being gone** |
| What the delay costs | Rework | An unattributable shortage |
| Who can still be asked | Anyone | **The cashier who worked that shift — if it is still recent** |

**Month + 15 days' grace means up to 45 days of cash sitting in a drawer**, and a shortage found
then cannot be attributed to a shift or a person. *The lock cadence and the remittance cadence
should not be the same number just because both are "monthly".*

### ⭐ The resolution: separate the COUNT from the TRANSFER

This gives Ian everything he asked for and loses no control:

| | Cadence | Purpose |
|---|---|---|
| **Count / handover the till** | **Daily, always** | The custody control. A variance is attributable to one shift and one person |
| **Physically remit to the office** | **3 days · weekly · whatever suits** | Logistics. Somebody has to carry money to a bank or an office |

**POS already does the daily half** — `cashHandovers` records `startingCash`, `cashSales`,
`deductions[]`, `expectedCash`, `countedCash` and `variance` (discovery 09 §1). *The control Ian
would be giving up by pooling is one he is not actually giving up, because it lives in a different
document that keeps running daily.*

### ⭐ And it requires exactly the account row 127 said was missing

Cash that has been **counted and accepted but not yet physically moved** is a real state with a
standard name — **cash in transit / undeposited funds**. v1 has no account for it.

```
1110 Cash on hand — cashier      (the live till)
  ↓  daily count + handover, variance recorded here
[NEW] Cash held for remittance   (counted, accepted, not yet moved)
  ↓  the pooled remittance — one movement covering N days
1130 Cash on hand — office       (arrived)
```

> **Row 127 flagged this account as missing from an entirely different direction — the online
> owner split — and Ian's pooling request independently requires it. Two unrelated needs pointing
> at the same missing account is a strong signal it is real.**

### ⛔ The structural blocker: v1 cannot express a pooled remittance

**Remittance in v1 is a set of FIELDS ON THE SALES DAY** — `actualRemittanceCash`,
`actualRemittanceOnline`, `remittanceRefNo`, `remittanceDiscrepancyCash`/`Online`, plus the day's
own `partially_remitted` / `remitted` statuses (`src/types/index.ts:1173-1195`).

**A remittance therefore cannot span days by construction.** `partially_remitted` handles *part of
one day*; nothing handles *one payment covering three days*.

**So pooling is not a settings change — it is a modelling change.** Remittance must become its own
document that **references** the days it covers:

- One remittance → many sales days (and a day may be covered by more than one remittance).
- The day's remittance status becomes **derived** from what covers it, not stored on it. *Same
  lesson as T-135: derived, not maintained.*
- The discrepancy belongs to the **remittance**, not to a day, because a pooled count cannot
  attribute a shortage to one day anyway — which is precisely why the daily count above matters.

---

## 2. The store revolving fund — a genuine ADD, and the industry answer is settled

**v1 has nothing.** A search for `pettyCash` / `revolving` across `ERP-rebuild/src` returns
**zero matches.** This is the fourth verb (bible row: duplicate / correct / add / delete), not a
port.

### The standard model is an IMPREST fund, and it is self-checking

| | |
|---|---|
| The fund is **set at a fixed amount** | e.g. ₱10,000 per store |
| The store **spends from it**, keeping receipts | Cash goes down, receipts accumulate |
| **Replenishment restores it to exactly the fixed amount** | The top-up equals the receipts presented |
| **The fund's BOOK balance never changes** | Only its composition does |

> ⭐ **The self-check falls out for free: cash on hand + unreimbursed receipts must ALWAYS equal
> the imprest amount.** Any other number is a discrepancy, visible without a reconciliation
> exercise. This is why imprest is the standard rather than a floating cash account — *the control
> is arithmetic, not diligence.*

### ⚠️ The control point is replenishment, and it is the whole design

**A revolving fund whose top-up is not gated by receipts is an unlimited spending channel.** The
replenishment must be *the exact total of the receipts presented*, which is what forces the
receipts to exist at all.

**This is the same shape as T-122's receipt-photo gate** — the money is not the control, the
document is.

### It interacts with T-122

An expense paid from the store fund is a **third funding source** alongside cashier cash and office
cash. `packages/domain/src/expenses/routing.ts` currently resolves cash to office or cashier via
the `'office'` sentinel; a store fund is a new branch. ⚠️ **Per T-122 invariant 7's rule, an
unresolvable funding source must BLOCK, never default.**

---

## 3. What this changes about T-123

1. **Remittance leaves the sales day.** T-123 must not bake `actualRemittanceCash` onto the day
   the way v1 does, or pooling is blocked before it starts.
2. `accept_remittance` (already in the matrix, and **DEF-052** — a grant that enforced nothing in
   v1) gates the remittance document, not the day.
3. The sales day's remittance status is **derived**.

## 4. Cadence and ceiling — decided 2026-08-25

### ✅ The remittance cadence is PER STORE

Ian: *"yes per store."* A four-branch group does not have one answer — a branch two minutes from
the office and one an hour away have genuinely different logistics.

**Consequence: the cadence is a per-store configuration row, never a constant.** ⚠️ And a store
with **no** cadence configured must not silently fall back to "never" — an unset cadence is the
same defect class as an unmapped expense category. **Default to daily**, which is the safe end and
matches what every store does today.

### ✅ An un-remitted CEILING exists too — because the risk is the amount, not the days

> **Per-store cadence makes the ceiling MORE necessary, not less.** A store on a weekly cadence
> accumulates seven days of cash. Two hundred pesos a day and twenty thousand a day are the same
> number of days and a completely different amount of money sitting in a drawer.

**So a remittance is forced when the pooled un-remitted balance exceeds the store's ceiling,
regardless of where it is in the cycle** — normal retail cash-handling policy, and the same shape
as row 122's close checker: the condition is watched continuously, not only at the deadline.

⚠️ **"Forced" means the same thing it means everywhere else in this project — the pile becomes
visible and unignorable to the person who can clear it, not a blocked till.** A cashier is never
prevented from selling because a remittance is overdue (discovery 22 §4: a restaurant that cannot
sell is not a restaurant).

**The mechanism is settled; the NUMBER is Ian's, per store** — as is the imprest amount and who may
change either. Both are store configuration, and both belong to whoever carries the risk.

## 5. ⚠️ Research required before designing this (bible §3.6)

1. **How reference systems model a cash-in-transit / undeposited-funds account** — and whether
   they treat it as one account or per-custodian. This also settles row 127's online-owner
   question, since both turn on the same "whose hands" dimension.
2. **Imprest / petty-cash implementations** in ERPNext and Odoo — particularly how replenishment is
   gated and whether the fund is an account or an entity.
3. **Whether a remittance document is the norm** for multi-day pooling, or whether reference
   systems keep it per-day and simply allow a bank-deposit document to group them.

**Do not design any of the three from first principles.** Row 127's answer and this task's answer
are the same research pass, and it should be one pass.
