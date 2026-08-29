# T-136 — Cash custody: pooled remittance and the store revolving fund

> **Status:** ⚠️ **REQUIREMENTS, PARTLY BUILT — see §9 (2026-08-29).** This is a requirements
> umbrella, not a task. **Two thirds of it has shipped** under other numbers: §1 · §7 · §8 as
> **T-143** (built 2026-08-27) and §5b's prerequisite as **T-144** (built — its own doc still says
> *SPEC*, which is wrong). What remains is §2, §4 and §6, and they are three different sizes of
> problem. ⛔ **Do not read this doc as "T-136 is unstarted."**
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

## 5. ✅ RESEARCH DONE, 2026-08-27 — and the source was better than the one asked for

§5 (below, kept for the record) asked for ERPNext and Odoo petty-cash implementations. **A better
source existed:** `webapps/MIGRATION` is a prior attempt to move *this business* onto ERPNext, with
its own design docs and a decision log. That is not a generic reference — it is this company's own
money modelled by someone reading the same Firebase data.

### 5a. Question 1 — cash-in-transit / undeposited funds ✅ **already answered**

ADR-010 and bible row 143 settled it: undeposited funds is **derived**, not an account, because
nobody reconciles it against an external document — they reconcile the till. No further research
needed.

### 5b. Question 2 — the imprest / petty-cash model ⭐ **answered, and it splits in two**

`06_financial_bridge_schema.md` §2.6 records the decision (2026-07-07) and the postings:

```
Release   Dr Petty Cash Float   Cr Cash on Hand
Spend     Dr Expense            Cr Petty Cash Float     (per expense)
Return    Dr Cash on Hand       Cr Petty Cash Float
Shortage  Dr Staff Advance      Cr Petty Cash Float
                     → the float nets to ZERO when the request closes
```

⭐ **The finding that matters: what this business runs today is NOT an imprest fund.** It is a
**per-request advance to a person** that nets to zero on liquidation. An imprest fund holds a
*fixed standing balance* and is replenished; this holds **zero** between requests. They are
different instruments and §2 above was describing the one the business does not yet have.

⭐ **And v2 already owns the account.** `cash__staff` is v2's **`1120` Cash on hand — staff
custodian**, which T-142 made one of the five every store is born with. The float has a home; what
is missing is the document that moves through it.

⚠️ **So §2's "genuine ADD" verdict stands, and is now sharper:**

| | Exists in v1 | Exists in v2 | What it is |
|---|---|---|---|
| **Cash request / staff float** | ✅ workflow + postings | ⛔ **nothing** | An advance to a PERSON, nets to zero |
| **Daily till float** (`openingBudget`) | ✅ in the sales day's `plus` | partly (T-123) | The drawer's starting cash |
| **Store revolving fund** | ⛔ | ⛔ | A standing imprest at the STORE |

⛔ **Therefore §2 has a prerequisite it did not know about: cash requests.** Building a store
revolving fund before the per-request float would mean designing replenishment against a document
that does not exist — and rows 152–153 already lean on cash requests for the cross-store case
(*"office cash of Malvar can be used to cash request for Lipa"*). **Cash requests come first.**

### 5c. Question 3 — is a remittance document the norm ✅ **answered by building it**

`06` §2.8 maps v1's remittance onto an ERPNext **Internal-Transfer Payment Entry plus a Journal
Entry for the variance** — i.e. the movement and the variance are separate documents, and the
variance needs a **Cash Over/Short** account, which that doc lists as a gap. T-143 arrived at the
same split independently: a transfer for the money, a `remittance_variances` row for the case.

### 5d. ⭐ A bonus finding, for T-126

`06` §2.12 maps loans onto ERPNext's Loan Management: *"Loan (disbursement → cash/bank + loan
liability), Loan Repayment (principal + `expense__interest`), auto-deduct schedule."* And
`00_PROGRESS.md` carries **live loan data with a warning**: two Grab loans on Lipa, and *"NEITHER
figure is usable"* — one because every settlement routes its deduction through a single
`channelCfg.loanId` so the second loan has **zero references** (*"a wiring artifact, not a fact"*),
the other because Lipa's settlements stop 14 days short. ⚠️ **T-126 must not import either
balance.** Read that section before designing it.

---

## 5 (original). ⚠️ Research required before designing this (bible §3.6)

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

---

## ⭐ Cross-store cash requests — the rule, recorded before the feature exists

> **Ian, 2026-08-26:** *"for cash request later, document that cross store money movement will
> only be possible for manager initiated transactions, with manager having access like
> hasStoreAccess to both stores."*

**Bible row 153.** Written here because this is the document whoever builds cash requests will
read, and the rule has to reach them rather than being rediscovered.

### The scenario it governs

> *"Office cash of Malvar can be used to cash request for Lipa. Then when this cash request is
> liquidated the expense still belongs to Lipa, and the return, if there is, may be returned to
> Lipa."*

⭐ **Note what is NOT symmetric here:** the money comes from Malvar, the **expense belongs to
Lipa**, and any unspent return goes back to **Lipa** — not to the store that funded it. So the
funding leaves a standing position between the two stores that a later settlement clears. That is
the `1250` / `2150` due-from/due-to pair, exactly as T-139's cross-store transfer already posts
it, and it must eliminate on consolidation (bible invariant 6).

### What is already enforced, and what is not

| | State |
|---|---|
| Money moves between stores **office to office only** | ✅ Built (row 152, `createMoneyTransfer`) |
| Actor needs store access to **both** stores | ✅ Built for transfers, and for an expense funded from another store's account (row 153) |
| No overdrawing the funding account | ✅ Built for transfers and expenses |
| **Cash requests themselves** | ⛔ **Do not exist in v2 yet** |
| Liquidation attributing the expense to the *other* store | ⛔ Not built |
| Returning the unspent balance to the *requesting* store | ⛔ Not built |

⚠️ **A cash request must apply the same both-stores check**, and for the same reason: it is money
movement between stores, whatever screen it is reached through. Gating the transfer screen alone
would leave the identical act reachable one menu across — which is exactly the mistake T-139
made first and row 153 corrects.

---

# 9. ✅ ASSESSMENT, 2026-08-29 — what is actually left, and what to build

> Run under `/research-evaluate-propose` (bible row 163) because §2 had never been weighed —
> only designed. **The verdict changed what to build next.**

## 9.1 ⛔ First: this task is two-thirds built, and the handoff said it was unstarted

`docs/HANDOFF-TODAY.md` names *"T-136 cash custody"* as one of three *"designed and unstarted"*
tasks. **Verified at source, that is wrong**, and it matters because it would have sent this
session to design something that already exists:

| T-136 section | Real state | Evidence |
|---|---|---|
| §1 · §7 · §8 — pooled remittance | ✅ **BUILT** as **T-143**, 2026-08-27 | `0030`, `0031`, `packages/domain/src/remittance/`, 8 integration + 8 unit tests |
| §5b — cash requests, named as §2's **prerequisite** | ✅ **BUILT** as **T-144** | `0034`, `0035`, `packages/domain/src/cash-requests/`, `/cash-requests` route |
| **§2 — the store revolving fund** | ⛔ **Not built** — and see 9.3 | Only comments *saying* it is owed |
| **§4 — cadence + un-remitted ceiling** | ⛔ **Not built** | No config column exists on `stores` |
| **§6 — service-charge distribution** | ⛔ **Not built, and see 9.4** | — |

⭐ **T-144's own doc still says `Status: SPEC` although it shipped** — the same stale-status defect
the 2026-08-28 session fixed for five other task docs. One more slipped through.

## 9.2 ⭐ The verdict

**Build §4 (T-152). Argue against §2 as designed. Escalate §6, which may outrank both.**

## 9.3 §2, the store revolving fund — recommended AGAINST as designed, and the reason is the till

### The stated reason does not hold in the way §2 assumed

Ian: *"it is common for us to allot a store budget, a petty cash the store can use as a revolving
fund for operations."* §2 read that as a missing **instrument** and designed an imprest fund.

⭐ **But the function is already there, and the numbers say so loudly.** From the real v1 capture
(`POSTING-PATTERNS.md`): expense payment is **4,396 legs — 34% of all activity, #1 by volume** —
and the single most common shape in the entire dataset is an expense paid **straight out of the
cashier drawer**, `1110`, often split with an online wallet.

> **The till already IS the store's revolving fund.** It refills from sales, operations are paid
> out of it, and the net is remitted. That is not an accident — it is exactly what §8's
> *"in minus out"* expected-remittance formula encodes, and bible row 145 built on it.

**So an imprest fund would add control, not capability** — a ring-fenced pot with receipt-gated
replenishment. That is a real thing to want. It is not the thing the brief said was missing.

### ⚠️ And a second fund would compete with the till

Leave both paths open and the same ₱500 purchase has two possible sources, chosen by a cashier,
daily. That is a **new** reconciliation question, not a removed one. An imprest fund only repays
its cost if spending from it is *mandatory* for some category — which is a policy decision nobody
has made, and which §2 does not mention.

### ⛔ The finding that should decide this: *"allot a store budget"* may mean something v1 HAS

Bible row 128 states *"On the revolving fund: v1 has **NOTHING** — zero matches for
pettyCash/revolving."* §2 later corrected itself once, on finding the daily till float
`openingBudget`. **Both passes still missed a third thing**, and it is the closest match in any
system this business runs to the words *"allot a store budget… revolving"*:

```
ERP-rebuild/src/types/index.ts:2194  ExpenseBudgetPlain
  storeId · monthKey · category · budgetAmount · consumedAmount · remainingAmount
  autoReissue?: boolean
  reissueInterval?: 'daily'|'weekly'|'bi_weekly'|'monthly'|'quarterly'|'annually'
```

**A per-store, per-month spending allowance that literally revolves on an interval** — with a
manager screen (`/manager/budgets`), a cron (`/api/cron/budget-reissue`) and tests. Cash never
moves; it is a **cap**, not a pot.

⚠️ **A cap and a cash pot are different instruments, and only Ian can say which he meant** — or
whether he meant both. Building the wrong one is a wasted fortnight, and the two do not substitute
for each other. **v2 has neither:** `CAPABILITY-GAPS.md` logs expense budgets as *"Financial, but
non-posting — safely after January."*

⭐ **The general lesson, now costing a third time:** T-136 §2 already recorded *"a grep proves a
NAME is absent, never that a CONCEPT is."* It then re-committed the same error by grepping
`pettyCash`/`revolving` and `openingBudget` but never reading the expense module.

### What it would cost, honestly

A store fund needs a **fourth custodian**. `CUSTODIANS = ['cashier','office','staff']`
(`money-accounts.ts:60`) is switched on in **72 places across 20 files**, sits under a unique index
on `(store, instrument, custodian)`, and drives row 145's `WHERE custodian = 'cashier'`
remittance arithmetic. Plus a replenishment document, an expense-routing branch, and a pinned
foundation-account guard that will trip. **Call it T-144's size.**

Against that: ⭐ **zero legs of evidence in the v1 dataset**, because the instrument does not exist
there. The nearest comparable — cash requests — runs **82 releases / 52 returns**. An imprest
fund's volume is not knowable from data; it would be Ian's policy, not a demand signal.

### Open source: nothing adoptable, and this was checked twice

`docs/discovery/24` §5 (2026-08-27) concluded *"no ERPNext-specific imprest module surfaced — it is
bookkeeping practice over ordinary accounts rather than a feature."* **Re-run 2026-08-29 and it
holds.** Odoo has several third-party petty-cash addons (`dev_petty_cash`,
`petty_cash_management_app`, `ovnicraft/petty-cash`) — all Odoo/Python addons on an ORM we do not
use, several under Apps Store licensing. **Nothing to adopt; the mechanism is textbook
bookkeeping over ordinary accounts.**

## 9.4 ⛔ §6 — the finding that may outrank everything: NOTHING EVER DEBITS 2160

Every sales day with a service charge **credits** `2160 Service charge float — held for staff`.
Searching the whole tree for a debit returns **nothing** — not a document, not a script, not the
month-end runner:

```
packages/domain/src/sales-days/routing.ts:109   SERVICE_CHARGE_FLOAT: '2160'   ← credit only
```

**RA 11360 requires distribution at least twice a month, at intervals not exceeding sixteen days.**
So from the first month of go-live this is a statutory liability that can only ever grow, with no
path to clear it — and the real distribution, which surely happens, would be off-book.

⚠️ **The same shape as T-143 and the ceiling:** the accrual shipped, the clearing did not.

### ⛔ But it turns on one number I could not reach from here

Whether **any store actually configures a service charge**. POS has a generic per-store charges
system where *"Service Charge"* is only a placeholder example
(`POS/src/components/manager/collections/ChargesSettings.tsx`); v1's ERP sales day has **no
`serviceCharge` field at all**; v2's column defaults to `0`. Ian's own words to T-123 —
*"separated from service charge"* — imply it exists, but that is an inference, not a count.

**The number I need: do any live stores have a service charge configured, and what did it total
last month?** It lives in POS's store charges config and receipts. **If yes, §6 outranks T-152 and
probably everything else on the list. If no, §6 is theoretical and can wait.**

### ✅ ANSWERED — Ian, 2026-08-29: *"for now no we dont charge but im planning"*

⭐ **This is the most dangerous of the three possible answers, and it changes the shape of the
work rather than removing it.**

| If the answer had been | Then |
|---|---|
| *"yes, we charge it today"* | §6 is urgent — a live statutory breach from go-live |
| *"no, and we never will"* | §6 is dead. Delete `2160`, because an account that exists invites use (T-150's `1270` reasoning) |
| ⭐ **"not yet, but I'm planning to"** | **The books are correct today and become wrong the moment a switch is flipped — with nothing to announce it** |

⛔ **The trap is that nothing marks the transition.** `2160` reads zero, so it looks healthy;
the day a store first configures a service charge in POS it begins accruing, the sixteen-day clock
starts, and **the only symptom is a liability balance growing — which looks like a normal balance
sheet.** §6 warned about exactly this: *"an ageing float is a FINDING, not a balance… invisible if
you only read the balance sheet."* Nobody would connect a POS settings change to an unclearable
obligation in the ERP weeks later.

### ⭐ The resolution: build the ALARM now, not the distribution

**The distribution document stays unbuilt** — there is no demand for it, and building a document
for a thing nobody does yet is the failure this whole assessment exists to prevent.

**The detector is built now**, folded into T-152 because T-152 is already adding detectors to the
same file. It fires when `2160` is non-zero and its oldest un-cleared accrual is older than
sixteen days, and — since nothing can currently discharge it — **it will fire permanently once
service charge is switched on and stay firing until the distribution document exists.**

⭐ **That permanence is the feature, not a defect.** T-135's rule is that a finding cannot be
resolved while it is still true, and *"we are accruing an obligation we have no way to pay"* is
true until §6 is built. The alarm converts a silent trap into a demand.

⚠️ **So the ordering is now decided:** ⛔ **do not enable service charge in POS before the §6
distribution document exists.** The detector will say so loudly, but it is cheaper to read it here
first.

## 9.5 §4 — decided, unblocked, small. **Specced as T-152.**

T-143 §7 rule 5 shipped pooling and explicitly did not enforce the ceiling, so the risk shipped
without its guard. Row 129 settled the mechanism on 2026-08-25 and left only the peso numbers to
Ian. And since **T-135 shipped on 2026-08-28**, the flag T-136 §7.6 said *"must not wait for
T-135"* is now just **two detectors in an existing layer** — much cheaper than when it was written.

→ **`docs/tasks/152-remittance-cadence-and-ceiling.md`**

## 9.6 Amendments owed (reported, not made — RULES rule 14)

1. **Bible row 128** — *"On the revolving fund: v1 has NOTHING"* is wrong. v1 has `ExpenseBudget`
   with `autoReissue`/`reissueInterval`, a revolving per-store allowance (9.3).
2. **Row 128's imprest verdict** should record that the till already performs the function, so the
   fund's case is **control**, not capability.
3. **T-144's status** — says `SPEC`, shipped.

