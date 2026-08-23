# ADR-006 — Period close: month is a lock, year posts one entry

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
| Every `requires_party` control account's subledger sums to its control balance | **Hard**, year close — one `GROUP BY` per account, thanks to T-118 |
| No earlier period in the org still open | **Hard** |
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

> This is why §7.2's 31-day window matters and why the two decisions belong together: a window
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

### 2. The close date is **31 January**, not 31 December

December gets a **31-day correction window**: the holidays are the busiest and messiest trading
period, and the books need time to settle. December stays `open` through January and closes on
the 31st, alongside the year close.

> **This is standard practice, not an indulgence.** No real operation closes a period on the day
> it ends — invoices arrive late, statements clear the following month, counts reconcile after
> the fact. The gap between *period end* and *period close* is the close calendar, and a month
> usually gets 5–10 business days.
>
> **It is also what makes never-reopen fair.** The two are complements: never-reopen with a
> same-day close would be brutal; never-reopen with a real window is discipline. The schema
> already supports it — multiple periods may be `open` at once, so Dec 2027 and Jan 2028 coexist
> until the 31st.

**Three obligations this creates:**

| | |
|---|---|
| **The date must be hard** | A window's value is that it *closes*. Slip 31 Jan once and it slips every year. The routine treats it as a deadline it reports against |
| **December figures are provisional for a month** | Anyone pulling a December P&L on 20 January reads a number that can still change. **Reports must say "provisional — period still open."** A requirement, not a nicety |
| **The window must be used, not consumed** | 31 days spent entirely in the last three is a rushed close with extra steps. The gates in this ADR are the checklist |

### 3. Month close is NOT enforced — but analytics is monthly

No hard gate at month end. Postings into an earlier month stay legal all year.

> **Stated once, because it is a real consequence:** if months never close, **a monthly figure
> can change until year-end.** An error found in November and dated March posts to March — so
> "March revenue" is not stable for eight months, and comparing March to April compares two
> numbers that can both still move.
>
> For internal management analysis this may be entirely acceptable; Ian has run the business this
> way for years. **Not being re-litigated.** If a month should ever stop moving *without* a hard
> gate, the cheap version is a **soft "reviewed" marker** the database still permits posting
> through, so analytics can distinguish provisional from settled. Offered, not built.

### 4. Who may close: **admin and manager**

Enforced server-side (§7 rule 1). Since reopening is never permitted, the grant covers closing
and the year-close posting only.

### 5. `closed` → `locked`

Automatic once the following year's close posts successfully. With never-reopen, `closed` is
already terminal in practice; `locked` records that a later year now depends on it.
