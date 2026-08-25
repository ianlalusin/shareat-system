# ADR-006 — Period close: every period closes on the 15th; only the year posts an entry

| | |
|---|---|
| **Status** | ✅ **Accepted 2026-08-23.** Ian answered all three open questions — §7 |
| **Evidence** | `docs/discovery/18-period-close.md` (source-level: ERPNext, Odoo, Tryton, LedgerSMB, GnuCash, Beancount/hledger, Xero, QuickBooks) |
| **Follows** | §3.6 — research before planning. This is that rule's first real use |

## Context

`fiscal_periods` has `open` / `closed` / `locked`, a no-overlap constraint, and a trigger
rejecting any posting into a non-open period on every path. **Nothing performs a close.**
Accounts **3300 Retained earnings** and **3900 Opening balance equity** are seeded and unused.

Per ADR-005 the old system closes 2026; our first month-close is ~Feb 2027 and our first
year-close is Dec 2027. **Not urgent — but a close mechanism is very hard to retrofit once the
ledger holds a year of data**, which is exactly why it is designed now.

## Decision

### Month close is a pure lock. Nothing is ever posted at month-end.

`status` flips `open → closed`. The existing trigger does the rest. **No new posting logic at
all**, because invariants 2 and 3 already make a month-range P&L a live query.

**Every period — month and year alike — closes on the 15th of the following month** (§7.3).
One rule, no exceptions: December's 15 January close is not a special case, it *is* the rule.

### Year close does that, plus exactly one journal entry.

Every income and expense balance for the year zeroes into **3300 Retained earnings**, posted by
calling the **existing `postEntry`**, dated the **first day of the following year** — matching
ADR-005's convention of dating the opening balance `2027-01-01` as one clean artifact. Research
found **no universal rule** on that date; this is consistency with our own precedent, not a
claim of correctness.

**The year-close entry is an ordinary posted entry**, subject to every invariant: balanced,
a real nominal posting, traceable to a source document (the archived year-end trial balance),
immutable. A mistake in it is corrected by the **existing `reverseEntry`**.

> **This is why no closing-voucher entity is needed.** ERPNext's PCV and Tryton's wizard exist
> to provide a submit/cancel/amend lifecycle around a closing entry. **We already built that,
> generally, for every entry.** Adding a bespoke object would be exactly the generality §1.1
> says to leave out.

### Gates — hard vs warning, stated explicitly

| Precondition | |
|---|---|
| No draft entries dated in the period | **Hard** |
| Trial balance ties (invariant 10) | **Hard** — already a continuous CI check; costs nothing new |
| Every `requires_party` control account's subledger sums to its control balance | **Hard, EVERY close** — one `GROUP BY` per account, thanks to T-118. Monthly closing is what makes this cheap: a subledger break is caught in the month it happens, not eleven months later |
| No earlier period in the org still open | **Hard.** With monthly close this is nearly always already satisfied — and on 15 January the order is fixed: **close December first, then run the year close** |
| Bank reconciliation complete | **Warning, never a gate** — no system studied enforces it, and it depends on a third party nobody here controls |

### ⚠️ The year-close entry must be distinguishable in queries

**A date-range P&L must be able to exclude it; a balance-sheet-as-of must include it.**

GnuCash's own documentation concedes its identical feature breaks its own reports for precisely
this reason. This is a five-minute design note now and a shipped, self-admitted bug if missed —
so it is a **requirement of this ADR**, not an implementation detail: the entry carries a
distinct `source_type` (e.g. `year_close`), and every reporting view is written knowing it.

### Reopening — NOT BUILT

The research recommended a guarded reopen path (admin-only, most-recent-only, mandatory reason).
**Ian decided against it entirely: a closed year is never reopened** (§7.1).

So no reopen path exists, and none can be abused. Every correction to a closed year is a
**prior-period adjustment carried into the following year**, using `reverseEntry`, which already
does exactly that.

> This is why §7.2's 15-day window matters and why the two decisions belong together: a window
> is what makes never-reopen fair rather than brutal.

## Decisions I am making, and why

**Subledger tie-out is a HARD gate from year one**, not a warning that graduates. The research
offered the softer option on the grounds that early volume is low. That argument runs backwards:
**low volume is what makes the gate cheap to satisfy, not burdensome.** A gate introduced once
volume is high is the one that gets bypassed under pressure, and a control that has been
bypassed once is not a control. Introduce it while it costs nothing.

**~~The `[prior period]` memo tag stays a memo~~ — REVISED 2026-08-23, same day.**

I decided that while reopening was still an open question. **Ian then chose never-reopen**,
which changes the weight entirely: a prior-period adjustment is no longer one of two correction
paths, it is **the only** path for an error found after a year closes.

That makes it the answer to *"what did we carry into 2028, and why?"* — a question someone will
ask — and a `LIKE '%[prior period]%'` scan over memo text is not an acceptable way to answer it.
**It becomes a structured, queryable field** on `journal_entries`, carrying the period the error
actually belongs to. Specced with the close routine, not deferred.

## Deliberately left out

No closing-voucher entity · no per-journal period locks · **no tax lock date** (row 75 — no VAT
engine, no filed return to protect, so the entire reason it exists elsewhere is absent) · no
IAS 8 dual-track restatement (no external auditor reads our statements; `reverseEntry` with a
`[prior period]` tag is the whole mechanism) · no hard bank-rec gate · **no Tryton-style
persisted balance-carry-forward cache row** (bible §4.2 rule 7 — derived data is a view, never a
maintained summary row; the year-close entry is the only place a carried balance lives).

## The alternative rejected, and honestly

**Never post anything — pure live P&L, permanently.** This is where we already are, and it is a
respectable position: Odoo pre-19, GnuCash by default, and Beancount all live there happily.

Rejected as the *permanent* answer for three sourced reasons: GnuCash's own docs concede it only
works because its reports are never closing-entry-aware, and we do not get a report layer exempt
from ever needing a persisted number — a multi-year balance sheet needs Retained Earnings to be
a real, addable balance, not an ever-growing aggregation over all history since 2027; **Odoo,
the system we are architecturally closest to here, walked it back in v19** after real
audit-trail problems; and it leaves 3300 at zero forever.

**Live query remains correct and unchanged for every month-range and ad hoc P&L.** That is not
being revisited. It is simply not sufficient *alone* at the year boundary.

## 7. Ian's answers — 2026-08-23

### 1. Reopening: NEVER. A closed year stays closed.

An error found afterwards is **carried into the following year** as a prior-period adjustment —
the mechanism `reverseEntry` already implements. No reopen path is built, so none can be abused.

### 2. The close date is **15 January**, not 31 December

December gets a **15-day correction window**: the holidays are the busiest and messiest trading
period, and the books need time to settle. December stays `open` into January and closes on the
**15th**, alongside the year close.

> *Revised from 31 January the same day, at Ian's call.* **The shorter window is the better
> one.** Fifteen days is roughly ten working days after the New Year holiday — a normal
> *month-end* close window applied to a year-end, and this business has no external audit and no
> statutory filing to satisfy. A short hard window creates urgency; a long one invites drift.

> **This is standard practice, not an indulgence.** No real operation closes a period on the day
> it ends — invoices arrive late, statements clear the following month, counts reconcile after
> the fact. The gap between *period end* and *period close* is the close calendar, and a month
> usually gets 5–10 business days.
>
> **It is also what makes never-reopen fair.** The two are complements: never-reopen with a
> same-day close would be brutal; never-reopen with a real window is discipline. The schema
> already supports it — multiple periods may be `open` at once, so Dec 2027 and Jan 2028 coexist
> until the 15th.

**Three obligations this creates:**

| | |
|---|---|
| **The date must be hard** | A window's value is that it *closes*. Slip 15 Jan once and it slips every year. The routine treats it as a deadline it reports against |
| **December figures are provisional for a fortnight** | Anyone pulling a December P&L on 10 January reads a number that can still change. **Reports must say "provisional — period still open."** A requirement, not a nicety |
| **The window must be used, not consumed** | Fifteen days spent entirely in the last three is a rushed close with extra steps. The gates in this ADR are the checklist |
| **The binding constraint is the INPUTS, not the window** | If a supplier routinely bills December on 20 January, the 15th closes knowing that invoice carries into the next year. Not fatal — under never-reopen it carries either way — but **chosen knowingly rather than discovered**. If that turns out to be common, the date moves; it is not re-argued each January |

### 3. Months close too — on the 15th of the following month

**Revised the same day.** Ian's first answer was that month close would not be enforced; he then
decided months close as well. **That is the better decision, and my recommendation against it
was wrong for a reason worth naming rather than glossing.**

My argument was frequency-blind. The cost I emphasised — an error found in November dated March
landing in **November** rather than March — is a **rare** event: with daily POS reconciliation
most errors surface within days, comfortably inside a 15-day window. The benefit — monthly
figures that **stop moving** — is what Ian actually uses, **every month**. I weighed a rare cost
against a constant benefit and got the trade backwards.

It also serves the stated purpose better. §7 recorded *"analytics is always scoped monthly for
internal analysis and reporting."* **Monthly close is precisely what makes those numbers final.**
After 15 April, March is settled; every month-on-month comparison is between two numbers that
have stopped moving.

### The rule: one date, no exceptions

| | |
|---|---|
| **Every period closes on the 15th of the following month** | March closes 15 April. December closes 15 January |
| **December is not special** | Its 15 January close, decided in §7.2, is simply this rule applied. **An exception has been removed from the design, not added** |
| **15 days is the whole close calendar** | Roughly ten working days. Standard practice is 5–10 business days for a month-end; this is at the generous end, uniformly |

### Three consequences, all of which land on work already done

**1. Prior-period adjustment goes from rare to routine — which settles the `[prior period]`
question for good.** With annual close only, correcting a closed period was an occasional event.
Now **every** correction to a month closed more than 15 days ago takes that path. The structured,
queryable field decided above is no longer a nicety; it is the field that answers *"what did we
book in April that actually belongs to March?"* — a question that will now be asked routinely. It
must carry the **target period**, and reports must be able to show a month **as booked** and **as
belonging**.

**2. `reverseEntry`'s "closed period" branch stops being the exception and becomes the norm —
and as specced it will error at the user.** T-106 §4 rejects a reversal whose original sits in a
closed period unless the caller supplies a `reversalDate`. That was written when closed periods
were rare. **Any correction to last month now hits it.** The *rule* is right and does not change;
the **UI must default** `reversalDate` to today's open period rather than surfacing a rejection.
Logged as a task note against T-106, not a change to it — the domain function is correct.

**3. A subledger break is now caught in the month it happens.** The tie-out gate above moves from
year-close-only to every close. Eleven months of drift in an AP control account is a forensic
exercise; one month of it is an afternoon.

### The soft "reviewed" marker — WITHDRAWN

It existed to give an *unclosed* month a stability signal. **Closing the month is that signal, and
a stronger one.** Keeping both would be two mechanisms for one job. Removed rather than left
standing as a stale recommendation.

### 4. Who may close: **admin and manager**

Enforced server-side (§7 rule 1). Since reopening is never permitted, the grant covers closing
and the year-close posting only.

### 5. `closed` → `locked`

Automatic once the following year's close posts successfully. With never-reopen, `closed` is
already terminal in practice; `locked` records that a later year now depends on it.

---

# 8. The close-readiness checker and the 16th escalation — Ian, 2026-08-25

## 8.1 ✅ The daily checker, 1st–15th — adopted as proposed

**The strongest idea in the close design**, and it explains the window better than §7.2 did:
**the fifteen days are not slack, they are the settlement period.** An August electricity bill
arriving on 10 September means August genuinely cannot close on 1 September.

Runs daily and reports what is outstanding for the closing month:

| | |
|---|---|
| **Recurring expenses with no instance** | Per template, per store — *“Electricity, Malvar: no August instance”* |
| **Depreciation / amortisation not booked** | **DEF-044 is the proof this is needed** — it stopped silently for two months |
| **Unposted drafts dated in the period** | Already a hard close gate; surfaced early rather than found on the 15th |
| **Unverified sales days** | Same |
| **Trial balance not tying** | Same |

### ⭐ A recurring-expense template generates a CHECKLIST ITEM, never a posting

They cannot be auto-posted — the amount varies every month. **But the obligation is knowable:**
rent recurs, electricity recurs. So the template produces a to-do.

**Better than either extreme:** auto-posting invents a figure nobody agreed; doing nothing means
the bill is either remembered or it is not.

## 8.2 The 16th escalation — scoped to back-office POSTING, never to operations

Ian's first phrasing read as blocking all transactions, and the objection to that was that it
stops the restaurant trading because the books are late. **He clarified, and the clarification is
the design:**

> *“When I say block, cashier can't create expense receipt, but all in-app biometrics will push
> through… don't block POS, but block submitting the daily sales report — make it pending,
> unverifiable unless last month is closed. For receipts, reject new entries, and expenses too.”*

**No revenue is blocked. The till runs, staff clock in.**

### The one remaining cost, and Ian's own answer to it

Blocking *entry* does not stop the expense happening — it stops it being **recorded when it
happens**. A cashier buys ice at 3pm on the 16th, enters it on the 20th from memory, or never.
**That trades this month's accuracy for pressure to close last month.**

**His sales-day answer solves it, generalised to all three:** *pending and unverifiable.*

| | |
|---|---|
| **Always allowed** | POS · biometrics · **recording** an expense or receipt as a draft, with its photo, while the memory is fresh |
| **Blocked until the prior month closes** | Sales-day **submission / verification** · **posting** an expense or receipt to the ledger |

**Nothing is lost, and the pressure improves.** A growing pile of unpostable drafts is a more
legible signal than a greyed-out button — and it is visible to the **admin**, who is the person who
can actually close the month.

### The daily-renewed unlock — kept, with one addition

Admin may release a day at a time, as Ian proposed. **It requires a typed reason, and the reason
is visible to others.**

> **Friction exercised daily stops being informative.** Unlock every day for a week and by the
> third day it is muscle memory. A reason someone must write, and others will read, stays
> informative; a button marked *Unlock* does not.

## 8.3 Open

1. **Does the checker notify, or only display?** A report nobody opens on the 12th is a report
   read on the 16th. Suggested: display daily, **notify from the 10th**.
2. **Do drafts blocked from posting expire?** Suggested no — they are the pressure. But somebody
   should own the pile.
