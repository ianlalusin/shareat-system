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
standard name — **undeposited funds**. v1 has no account for it.

⚠️ **CORRECTED 2026-08-25 (discovery 24 §1): I originally wrote "cash in transit / undeposited
funds" as if interchangeable. They are not.** *Undeposited funds* is our books versus the money's
physical location; *deposit in transit* is our books versus **the bank's** books — a bank-
reconciliation timing item with nothing to do with a till. **Undeposited funds is the right one**,
and vendors describe batched deposits ("only going to the bank once or twice a week") as its
ordinary case — which is exactly Ian's request.

```
1110 Cash on hand — cashier      (the live till)
  ↓  daily count + handover, variance recorded here
[NEW] Undeposited funds          (counted, accepted, not yet moved)
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

⚠️ **CORRECTED 2026-08-25 — I said "v1 has nothing" and that was wrong.** A search for
`pettyCash` / `revolving` returns zero matches, and I stopped there. Reading `SalesDayPlain`
properly (T-123 §2.4) shows **the till float is already in v1 and already flows through the
arithmetic**: `openingBudget` sits in the sales day's `plus` block and is part of the expected-
remittance computation.

**So the correct statement is narrower and more useful:** v1 has **no petty-cash MODULE** — no
fund entity, no replenishment cycle, no receipts-gated top-up — but it does have the **daily till
float**, and any design here must fit what that already does rather than replace it.

*The general lesson, recorded because it has now cost twice: a grep proves a NAME is absent, never
that a CONCEPT is.*

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

---

## 6. 🆕 The service-charge float, and its distribution cadence (bible rows 135, 136)

Service charge collected on a sales day credits **2160, a float** — neither revenue nor AP
(T-123, row 135). **It has to be cleared, and clearing it is a cash movement, which puts it here
rather than with revenue recognition.**

Ian, 2026-08-25: distribute *"per day, per week or per month."*

### ⛔ Monthly is not lawful, and the option list must say so

**RA 11360 requires distribution at least twice a month, at intervals not exceeding sixteen days.**

| Cadence | |
|---|---|
| **Daily** | ✅ |
| **Weekly** | ✅ |
| ~~Twice monthly~~ | Lawful, but **Ian, 2026-08-25: "daily or weekly only"** — not offered |
| **Monthly** | ⛔ **Not compliant** (RA 11360's 16-day interval) |

⭐ **Only two options, and that is stronger than three.** The statutory floor is twice a month, so
Ian has chosen to sit comfortably inside it rather than at its edge — **the closed list cannot
express a breach at all**, which means nobody has to remember the sixteen days when configuring a
store.

> **This is a case where the configuration must not be able to express the wrong answer.** Same
> instinct as `is_remitted_daily` being NOT NULL: if a setting can be set to something unlawful,
> eventually it will be — and nobody will notice, because a float that keeps growing looks like a
> healthy balance rather than an overdue obligation.

### ⭐ An ageing float is a FINDING, not a balance

**2160 growing is the symptom of a missed distribution**, and it is invisible if you only read the
balance sheet. It belongs in the OIL feed (T-135) as a derived finding: *"service charge float
older than 16 days."* Same shape as every other finding there — derived from the condition, so it
cannot be resolved while it is still true.

### It shares its shape with remittance, and deliberately not its cadence

Both are per-store cash movements on a configurable rhythm (§4). ⚠️ **But they are not the same
setting and must not be collapsed into one**: remittance is bounded by how much cash you are
willing to hold, and this is bounded by *statute*. A store that remits weekly may still have to
distribute twice a month.

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

---

## 7. ✅ How a pooled remittance SETTLES the days it covers (Ian, 2026-08-26)

> **Ian:** *"So we preserve the daily cashier remittance locking — each sales day locks on
> verified, so all remittable cash and online is recorded. But remittance may happen by batch. For
> example Lipa has 5 sitting sales reports for January 1 to 5, all verified, money in cashier not
> remitted yet — it can be remitted all at once, so remittance-01 can cover 5 dates. If the
> remittance is short, cover the oldest sales report first, and record shortage/overage on the
> last date."*

**This is the allocation rule §1 left unstated, and it is consistent with everything already
decided.** The daily lock is §1's COUNT; the batch is §1's TRANSFER. Row 129's ceiling still
governs — a cadence with no ceiling is the failure that row names.

### 7.1 The rule, and why the residual naturally lands last

Oldest-first is **FIFO**, and FIFO does the placement on its own — no separate rule is needed for
where the variance goes:

```
Jan 1–5 verified, ₱10,000 remittable each        expected  ₱50,000
Cashier hands over                                actual    ₱46,000

  Jan 1  ₱10,000  settled in full
  Jan 2  ₱10,000  settled in full
  Jan 3  ₱10,000  settled in full
  Jan 4  ₱10,000  settled in full
  Jan 5  ₱ 6,000  partially settled  →  ₱4,000 SHORT
```

⭐ Ian's *"record shortage on the last date"* is not an extra convention — **it is what FIFO
produces**. A rule that falls out of the allocation cannot drift from it.

An overage settles every day in full and leaves a positive residual on the same last date,
symmetrically.

### 7.2 ⚠️ The evaluation: this is a CUSTODY variance, not a COUNT variance

**They are two different events and must not become one number**, or the daily count that §1 fought
to keep stops meaning anything.

| | When it is found | What it means | Who it belongs to |
|---|---|---|---|
| **Count variance** | At the daily close, per day | The till did not match what the day says it should | The cashier who worked **that day** |
| **Custody variance** (this section) | At the batch handover | Money that was counted and signed for did not arrive | Whoever **held the pool** between count and handover |

⭐ **Once the till is counted daily and signed, a batch shortage cannot be a counting error** — the
counts already reconciled. It is a loss *in custody*, after the fact. That is a different question,
asked of a possibly different person.

⚠️ **So dating it on the last date is right; ATTRIBUTING it to the last date's cashier is not.**
The last date is where the arithmetic puts the residual; it says nothing about who was holding the
money. v1 already refuses to guess here — its remittance builder **throws** if a shortage is posted
without an explicit `chargeToStaffId` rather than inferring one — and that refusal should be
ported, because inferring the person from the date is exactly the wrong inference.

⛔ This is row 128's warning arriving in a concrete form: *"a shortage found then is attributable to
nobody."* Pooling does not remove attribution — but it moves the question from *"which day?"* to
*"who was holding it?"*, and only the second one has an answer.

### 7.3 Cash and online settle separately, in one document

A batch covers N days, and each day carries **two** remittable figures. They are not the same act:

- **Cash** is physically handed over. It can be short because notes are missing.
- **Online** is a wallet-to-wallet transfer — cashier-custodian account to office-custodian account
  (ADR-010 §8). It cannot be "short" in the same way; a mismatch there is a failed or partial
  transfer, not a missing note.

⚠️ So the remittance document holds **two settlement tracks**, allocated FIFO independently, with
their own variances. v1 keeps separate cash and online remittance builders for this reason.
Collapsing them into one figure would let an online surplus silently paper over a cash shortage —
and the cash shortage is the one somebody has to answer for.

### 7.4 ⭐ FIFO is a DOCUMENT concern, not a journal concern

The ledger does not care which day a peso came from: `1110` is `1110`, and the days were already
recognised as revenue when they happened (§1). So:

- **One remittance = one journal entry**, moving the total actually handed over from the
  cashier-custodian account to the office-custodian one, plus the variance leg.
- **Which days it settles, and by how much, is subledger detail** on the remittance document — not
  five journal entries, and not a leg per day.

⚠️ **Resist the symmetry.** Posting per-day legs would look tidier and would immediately create the
thing ADR-010 §1 exists to prevent: a second place the same pesos are recorded, drifting from the
first. The allocation is an *answer about* the movement, not the movement.

### 7.5 ✅ A partially-settled day shows as PARTIALLY REMITTED — and batch is ADDITIVE

> **Ian, 2026-08-26:** *"The unsettled sales day displays as partially remitted, just like v1. We
> do not take out the daily remittance functionality — batch remittance is additive."*

#### ⛔ Correcting this spec: v1 *does* have a name for it, and I said it did not

An earlier draft of this section claimed *"a partially-settled day is a state v1 has no name for,
because v1 cannot pool at all."* **That was wrong, and checking took one grep.** v1's sales-day
status enum is:

```ts
// ERP-rebuild/src/types/index.ts:1173
status: 'open' | 'submitted' | 'verified' | 'partially_remitted' | 'remitted' | 'voided'
```

⭐ **The error was conflating two different things.** v1 cannot have ONE remittance covering FIVE
days — that part of the blocker stands. But v1 has always been able to remit *less than a day's
expected*, so the **display state** was there all along. Pooling is the new capability; the status
is not.

#### What v1 already gets right here, and should be ported

1. ⭐ **The status is DERIVED, not set.** `applyRemittanceStatusFromTransfers` computes it from the
   posted transfers rather than a caller stamping it — the same principle as everything else in
   this design.
2. ⭐ **Revenue does not wait for remittance.** `verified`, `partially_remitted` and `remitted` are
   all recognised statuses for the income statement and the integrity check
   (`income-statement.actions.ts:98`, `integrity-check.actions.ts:43`). This is row 128's *"revenue
   recognition does not depend on remittance"* already true in v1's code.

#### ⚠️ And one failure mode to design out, which v1 documents against itself

v1 ships an **admin repair action** whose comment explains why it exists
(`admin-record-ops.actions.ts:880-887`):

> *"Use when a sales day is stuck on `partially_remitted` even though all transfers are posted
> (e.g. due to businessDate mismatch on an older transfer, or a zero-expected account blocking the
> status flip)."*

⛔ **A derived status that needs a manual recompute button is a derived status that is being
cached somewhere.** Both named causes are the same bug in different clothes: the status was
computed once and stored, so a later-arriving or mis-dated transfer never re-triggered it.

**v2 must not need that button.** If the status is genuinely derived — read from the legs at the
moment it is displayed, the way §8 derives expected remittance — it cannot go stale, and a
mis-dated transfer shows up as the wrong number rather than a stuck state. ⚠️ The
*zero-expected* case is the sharper warning: a day expecting ₱0 online must not be waiting forever
for an online transfer that will never come. **Settled must be defined as "nothing outstanding",
never as "a transfer arrived".**

#### Batch is ADDITIVE — daily remittance is not replaced

Daily remittance stays exactly as it is; pooling is a **capability a store may use**, not a new
mandatory shape. This is consistent with §4's *default to daily* — a store that changes nothing
keeps working the way it works today, and the store an hour from the office opts into a cadence.

⚠️ **Which means one remittance-settles-many-days is the general case, and one-settles-one is
simply N=1.** There is no separate "daily" code path to maintain — building two would guarantee
they eventually disagree about a shortage.

### 7.6 ✅ It does NOT block — it gets its own table, so it cannot hide (Ian, 2026-08-26)

> **Ian:** *"No, it won't block. But it must be flagged, and dedicate a separate table so it won't
> hide from sight like v1 does."*

**Not blocking is right**: a shortage on Jan 5 is not a reason to strand Jan 6–10's cash in a
drawer, which would make the control cause the risk it exists to reduce.

⭐ **And "like v1 does" is not a hunch — v1 proves it against itself.** §7.5 records the admin
button v1 had to build for days *"stuck on `partially_remitted` even though all transfers are
posted."* **A stuck status that needed a repair tool is a status nobody was watching.** It sat in a
column, in a list, among days that all looked broadly similar — visible in the sense that it was
rendered, invisible in the sense that no one acted on it. Ian's instruction is the fix for the
thing that actually went wrong.

#### The table holds the CASE. The amount stays derived.

⚠️ A dedicated table is exactly right for the flag and exactly wrong for the figure, and the
distinction is the whole design:

| | Where it lives | Why |
|---|---|---|
| **How much is outstanding** | ⭐ **Derived** — expected (§8) less what remittances have settled | A stored balance is a second place the same pesos live. Rows 143 and 145 both refuse this |
| **That there IS a case, and its life** | ⭐ **The table** | Who owns it, when it was raised, what was decided, whether it is closed. **None of this is derivable — it is a human process, and a process needs a record** |

So the row is *"Lipa, 2026-01-05, outstanding, raised 2026-01-06, owner: —, unresolved"* and the
peso figure on the screen is read from the ledger every time it renders. **The table can never
disagree with the books, because it does not hold a number that could.**

#### ⚠️ Three states, and conflating them is the trap

The residual is not always the same thing, and the table must say which:

| State | What happened | Is anyone answerable? |
|---|---|---|
| **Outstanding** | Counted, signed, simply not handed over yet | No — this is normal, and the ceiling (§4) governs it |
| **Custody variance** | Counted and signed, but the money did not arrive | ⛔ Yes — §7.2, and the person must be named, never inferred from the date |
| **Resolved** | Recovered, charged, or written off with a reason | Closed, and kept for the audit trail |

⛔ **Collapsing "not yet handed over" into "short" would accuse a cashier of losing money they are
holding perfectly properly** — and it is the easy mistake, because both look identical as a number.

#### Flagged means counted, not coloured

Same standard as T-125 §11.2, and for the same reason: **a status is a property of a row, and a row
in a list is exactly what hid in v1.**

- A **persistent count** on the module — *"3 days unsettled, ₱12,400"* — that reads zero when there
  is nothing outstanding. ⚠️ A badge that is always present is a badge people stop seeing.
- **Nothing expires or auto-closes it.** It stays until a human resolves it. An item ageing out
  quietly is precisely v1's stuck status with a timer attached.
- ⭐ **Age is the signal, not just amount.** ₱200 outstanding for 40 days is a worse finding than
  ₱9,000 outstanding since yesterday. The count should surface the oldest, because that is the one
  nobody is thinking about.

#### Where it sits

This is **T-136's table**, not T-135's. T-135 is the general findings layer and can read this like
any other source once it exists — but this flag must not wait for T-135, because T-135 is on
ADR-005's *can wait past January* list and cash sitting unremitted is not.

## 8. ✅ What "expected remittance" actually equals (Ian, 2026-08-26)

> **Ian:** *"Today's remittance = all money in less all money out touched by cashier. Money in:
> sales, collections, returns, refunds from vendors. Out: expense with payment from cashier
> (cashier's part only, not necessarily the whole expense amount), cash request released by
> cashier, salary advance released by cashier, payment to payables by cashier, other out to be
> determined."*

This completes bible row 143's mixed pot with the actual inventory. **And evaluating it, the
formula collapses into something much smaller than the list.**

### 8.1 ⭐ Every item on that list already posts to the cashier's accounts

Checked against the worked examples rather than assumed — all eight, no exceptions:

| Ian's item | Pattern | Leg |
|---|---|---|
| Sales | `sale.unli.simple` | **DR** 1110 |
| Collections | `ar_collection.no-fee` | **DR** 1110 |
| Returns (staff float) | `cash_request.return` | **DR** 1110 |
| Expense from cashier | `expense.cash.simple` | **CR** 1110 |
| Expense, cashier's share of a split | `expense.split.cash-online` | **CR** 1110 |
| Cash request released | `cash_request.release` | **CR** 1110 |
| Salary advance released | `salary_advance.disbursement` | **CR** 1110 |
| Payment to payables | `ap_payment.simple` | **CR** 1110 |

Money in is a **debit** to a cashier-custodian account. Money out is a **credit**. Without
exception.

> ### So the formula is not a sum over documents. It is the account's net movement.
>
> ```
> expected remittance  =  Σ debits − Σ credits
>                         on every money account WHERE custodian = 'cashier'
>                         over the period being remitted
> ```

⭐ **This is bible row 143's "derived, not maintained" applied one level up.** Ian's list stops
being the *computation* and becomes the *documentation* — a description of what a reader should
expect to find there, not a checklist the code walks.

### 8.2 ⛔ Which is why the list must NOT be implemented as a list

*"Other out to be determined"* is the tell. Implemented literally — sum the sales, add the
collections, subtract the expenses, subtract the advances — that phrase is a **live hole**: any
transaction type that touches the till and is not in the enumeration silently breaks the
reconciliation, and it breaks it in the direction that looks like a cashier is short.

⚠️ **That is DEF-044's shape again**: a figure maintained alongside the ledger instead of read from
it, drifting the moment something new is added and blaming a person for the difference.

Derived from the account, *"other out"* needs no determining. **Anything that credits the cashier's
account is already counted, including the transaction types nobody has thought of yet.** A future
module cannot forget to register itself, because posting IS registering.

### 8.3 ⭐ "Cashier's part only" is free, and it is the split-payment model paying off

Ian's parenthesis — *"cashier's part only, not necessarily the whole expense amount"* — is the
subtle one, and it needs no special handling at all.

A ₱3,500 expense split ₱2,000 cashier cash / ₱1,500 office online posts **two** legs: `CR 1110
₱2,000` and `CR 1140 ₱1,500`. Summing the cashier's account picks up ₱2,000 and ignores the rest,
**because the leg is already the cashier's share.**

⚠️ Computed from documents instead, this is a real trap: reading the expense's `total_amount`
would subtract ₱3,500 from an expected remittance the cashier only ever paid ₱2,000 of — and
report a ₱1,500 shortage that does not exist. **The split is only innocent if the arithmetic runs
on legs.**

### 8.4 What is still open

⚠️ **Is there a RETAINED FLOAT?** Ian's formula is *in minus out*, which is a **net movement** and
therefore assumes the drawer keeps whatever it started with. If a store instead remits the drawer
down to zero, expected remittance is the account **balance**, not the movement — a different
number whenever an opening float exists. v1's "envelope" mode (a release drawing on prior days'
unremitted cash) implies cash does sit across days, so this needs answering per store, and it is
one line either way:

```
retained float   →  expected = net movement over the period
remit to zero    →  expected = closing balance
```

⛔ Not guessed here. It interacts with the per-store cadence (§4) and belongs with it.

