# ADR-006 — Period close: month is a lock, year posts one entry

| | |
|---|---|
| **Status** | Accepted 2026-08-23 by the planner. **Three questions remain Ian's** — §7 |
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

### Reopening

Admin-only · **most-recently-closed period of the org only** · mandatory reason string · logged
with actor and timestamp — the same ceremony `reverseEntry` already demands, applied to the
status flip rather than left as a bare `UPDATE`.

Reopening a period that already has a year-close entry against it does **not** auto-reverse it.
It stands until someone explicitly reverses it. **No second correction mechanism is invented.**

## Decisions I am making, and why

**Subledger tie-out is a HARD gate from year one**, not a warning that graduates. The research
offered the softer option on the grounds that early volume is low. That argument runs backwards:
**low volume is what makes the gate cheap to satisfy, not burdensome.** A gate introduced once
volume is high is the one that gets bypassed under pressure, and a control that has been
bypassed once is not a control. Introduce it while it costs nothing.

**The `[prior period]` memo tag stays a memo for now** — not hardened into a structured flag.
Nothing is wrong with the mechanism; only its queryability, and there is no data to query yet.
Revisit at the first genuine post-close correction.

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

## 7. What still needs Ian

1. **Is reopening permitted in production at all?** "Never reopen — always correct forward" is
   simpler and carries zero reopen risk for a business with no external audit. The cost is real:
   every late correction, however old, lands in whatever period is open *today*, never in the
   period it actually happened.
2. **Is month-close an enforced event, or only year-end?** The business has run for years with
   **no** monthly close discipline. Enforcing one from Feb 2027 is an operational habit change
   for whoever runs the books, not merely a schema feature. Enforce from month one, or phase in?
3. **Who may close or reopen a period** — admin only, or does an owner/manager role get it? §7
   governs *that* it is enforced server-side, not *who* holds it.

*(A fourth — when `closed` becomes `locked` — is proposed as automatic once the following year's
close posts. Low stakes; say if you would rather it were a deliberate manual "seal it".)*
