# Period close and year-end close — mechanics, preconditions, and a recommendation

**Date:** 2026-08-23
**Method:** `docs/discovery/17-industry-erp-patterns.md` §1 already did a source-level pass on ERPNext,
Odoo, Tryton, LedgerSMB and GnuCash and produced twelve numbered findings (1.1–1.12) plus three
top-line conclusions for the planner. **This document does not repeat that pass** — it is cited by
row number throughout. This pass goes deeper on exactly the questions doc 17 left open, adds three
systems doc 17 did not examine at all (Xero, QuickBooks, hledger/Beancount beyond the single data-
model note in 8.4), and — where doc 17 speculated — replaces the speculation with a sourced answer
(most importantly §2.4 below, on *why* Odoo actually changed in v19). Sources are docs/blog posts
for Xero and QuickBooks per the task's own instruction that this is acceptable for closed-source
SMB tools; everything else is read from the vendor's own documentation or, where doc 17 already
read source code, cited back to doc 17.

**Read first:** `PROJECT_BIBLE.md` §16.1 (ten invariants, esp. 1/2/4/5/6/7/10), §16.4 (deliberately
simpler than ERPNext), §13 row 22 (event sourcing rejected) and row 75 (management ledger, no VAT
engine, never statutory-filing-basis) · `docs/decisions/ADR-005-books-first-cutover.md` (the 2027
cutover, the opening-balance-entry convention this document's year-close recommendation mirrors) ·
`docs/DEFECTS-REGISTER.md` DEF-038 (this exact gap, logged, disposition `verified`) and **DEF-037**
(fixed 2026-08-23 — `party_type`/`party_id` now live directly on `journal_lines`, which changes the
answer to "how expensive is a reconciliation gate" from doc 17's own §4.2 "genuinely open" framing
to "already cheap," argued in §3 below) · `packages/db/schema/fiscal-periods.ts` (confirmed: a flat
table of date ranges with `status: open|closed|locked` and no `period_type`/year marker of any
kind — there is no schema-level distinction today between a month row and a year row; this matters
for §6) · `packages/domain/src/ledger/reverse-entry.ts` (the only correction mechanism that exists
today — refuses to backdate into a closed period, posts to an open one with `[prior period]`
prefixed onto the memo; §4 below assesses this against IAS 8/ASC 250 and finds it deliberately, not
accidentally, narrower).

---

## 1. What does "close" actually do — post entries, set a flag, or both?

Doc 17 §1.1–1.4 already established the two live philosophies (ERPNext posts a real reversing
entry; Odoo pre-19 posts nothing and computes live; Odoo v19 partially reversed that; Tryton
separates "generate the closing entry" from "flip to closed" into two acts). What follows is new
material from three systems doc 17 did not examine, each of which is a *third or fourth* real
answer to the same question, not a restatement of the first two.

| # | The pattern | Source | How standard | Relevance to us |
|---|---|---|---|---|
| 1.1 | **QuickBooks never posts a real journal entry to Retained Earnings, ever.** The "Closing Entry" line shown on a Retained Earnings report is calculated at the moment the report runs — QuickBooks Desktop "doesn't post an actual journal entry to Retained Earnings at year-end. Instead, it computes the Closing Entry whenever you run the Retained Earnings report," and the line cannot be opened, edited, or "QuickZoomed" into because no transaction exists behind it. On the first day of the new fiscal year QuickBooks simply increases the Retained Earnings *balance shown in reports* by last year's net income and treats net income as reset to zero for the new year | [Intuit QuickBooks Community — multiple corroborating threads](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/retained-earnings-closing-entry-is-wrong/00/1605240); [Close your books in QuickBooks Desktop](https://quickbooks.intuit.com/learn-support/en-us/help-article/close-books/close-books-quickbooks-desktop/L8T1Cgfhk_US_en_US) (page fetch was blocked by the host; content corroborated via search-indexed excerpts and independent community threads, so treated as reliable but secondary) | One vendor's SMB-scale choice, but it is a **real, shipped, third implementation** of "close = nothing is posted" (alongside pre-19 Odoo and GnuCash's default) | Reinforces that the "live query, nothing posted" camp is common at SMB scale specifically, not just a design taste of two open-source projects — but see 1.2 for the failure mode this specific implementation produces |
| 1.2 | **A virtual-only closing line breaks the moment a human tries to treat it as a real balance.** Multiple QuickBooks Community threads exist specifically because users manually posted a correcting entry against Retained Earnings (e.g. reclassifying an Owner Investments/Draws balance) *alongside* QuickBooks's own invisible virtual calculation, producing an apparent double-count on the balance sheet that confused the reporting user until support explained the calculated line isn't a transaction at all | [QuickBooks Community — "Reclass of Owner Investments to Retained Earnings at year end is double counting"](https://quickbooks.intuit.com/learn-support/en-us/reports-and-accounting/reclass-of-owner-investments-to-retained-earnings-at-year-end-is/00/1384500) | One vendor's failure mode, but the underlying lesson — a computed-not-posted balance and a posted balance in the *same account* are not composable, and mixing them produces exactly the kind of confusion that looks like a double-count — is general | Directly rules out "virtual-only" as our year-boundary answer, argued fully in the Recommendation. It is fine for month-range P&L (nothing to zero, nothing to compose against); it is not fine for the one account (3300) that is meant to hold a permanent, addable, auditable balance |
| 1.3 | **GnuCash's Close Book posts two real transactions** (one per currency for income accounts, one per currency for expense accounts, each with a split per account), moving every income/expense balance to a chosen equity account on a user-selected date — but its own documentation states plainly that "closing the books in GnuCash is unnecessary" and warns that doing so **breaks its own standard reports**, because those reports "don't currently understand closing transactions" — from their point of view, net income for any period spanning a close simply reads as zero | [GnuCash 5.x manual — "Close Book" tool](https://www.gnucash.org/docs/v5/C/gnucash-manual/tool-close-book.html) | One vendor's implementation, but the **warning itself is a general lesson, not a GnuCash-specific defect**: any reporting layer that isn't explicitly aware of a closing transaction's special status will misread date-ranged queries that span it | **The single most concrete, actionable finding in this section.** Our own invariant 2/3 commits P&L to a live `GROUP BY` query over `journal_lines`. If a year-close entry is ever posted (§2 argues it should be, once a year), any "P&L for calendar year 2027" query run afterward must **exclude** that entry by construction (a distinct `source_type`, e.g. `year_close`, filtered out of period-range P&L queries and included only in balance-sheet-as-of queries) — or we reproduce GnuCash's own documented bug on day one of using our own feature |
| 1.4 | **hledger's `close` command posts a linked pair** — a closing transaction in the old period zeroing the named accounts into `equity:retained earnings` (or wherever `--close-acct` points), and an opening transaction in the new period re-seeding them — with an optional `--assert` flag that generates balance assertions verifying both halves actually landed at zero/the expected opening balance | [hledger 1.52 manual](https://hledger.org/1.52/hledger.html); [hledger `close` reference](https://hackage-content.haskell.org/package/hledger-1.51/src/Hledger/Cli/Commands/Close.txt) | One tool's design (plain-text-ledger community), not enterprise-common, but notable for pairing the act with a machine-checked assertion rather than trusting it | We already do exactly this shape once, for the 2027-01-01 opening balance (ADR-005: one entry, must net to zero, a residual "means the migration did not balance"). hledger's `--assert` is the same idea applied *every* year, not just at cutover — worth carrying the discipline forward, not the tool |
| 1.5 | **Beancount's own docs recommend a defensive balance assertion immediately before closing an account** ("insert a balance assertion for 0 units just before closing an account, just to make sure its contents are empty"), even though the `close` directive itself does not insert one automatically | [Balance Assertions in Beancount](https://beancount.github.io/docs/balance_assertions_in_beancount.html) | Common practice in the plain-text-ledger community specifically | Independent confirmation of the same pattern ADR-005 §7.1–7.2 already commits us to ("a residual balance... halts and requires investigation, never an auto-plug"). Nothing new to decide — cited as corroborating evidence, not a new decision |
| 1.6 | **Tryton posts a real entry (via the Balance Non-Deferral wizard) *and* separately persists a per-account "Account Deferral" record** that caches the carried-forward balance for the next fiscal year — two representations of the same fact, one a journal entry, one a maintained cache row | [Tryton `account` module — Fiscal Year design](https://docs.tryton.org/7.0/modules-account/design/fiscal-year.html); [Closing a period](https://docs.tryton.org/7.0/modules-account/usage/close.html) | One vendor's choice | **Split verdict.** The *real-entry* half (Balance Non-Deferral) is the same pattern as ERPNext's PCV and hledger's `--retain` — common, and the one we should take. The *cached-deferral-row* half is exactly the shape our own bible §4.2 rule 7 forbids ("derived data is a view or materialised view, not a hand-maintained summary row"). DELIBERATELY SKIP the cache; ADOPT the posted-entry half |

---

## 2. Retained-earnings roll-forward — mechanically

**What entry, on what date, against which accounts.** No system studied disagrees on the *shape*:
zero every income and expense account's year-to-date balance, net the difference into one equity
account. What differs is *whether* an entry exists at all (§1) and, among those that do post one,
the exact date convention — which turns out **not** to be uniform:

- ERPNext's Period Closing Voucher posts as of its own submission/posting date, typically the
  fiscal year-end date itself (doc 17 §1.1).
- Tryton's documentation explicitly recommends creating a dedicated **adjustment period whose
  start and end are both the fiscal year's last day** for the closing entries — i.e. dated *inside*
  the closing year, not the first day of the next one ([Tryton fiscal-year design](https://docs.tryton.org/7.0/modules-account/design/fiscal-year.html)).
- hledger's paired closing/opening transactions are dated either side of the boundary by
  convention (closing in the old period, opening in the new one), and this is a user choice, not
  an enforced rule ([hledger manual](https://hledger.org/1.52/hledger.html)).

**Finding, stated plainly: there is no universal date convention.** What every system agrees on is
narrower and more useful — the entry must land unambiguously inside the correct fiscal boundary and
the convention chosen must be applied consistently. This is genuinely a free choice, not a gap in
this research.

**Is it reversed at the start of next year, or permanent?** Permanent, universally, among every
system that posts a real entry. Nothing studied auto-reverses a roll-forward entry at any point;
what exists instead is the ordinary correction mechanism (ERPNext's PCV can be cancelled like any
submittable document; Tryton's moves can be reopened via the same period/fiscal-year reopen path) —
i.e. a *correction*, not a scheduled unwind. This directly matches our own invariant 5 (posted
entries immutable; corrections are reversals, never edits) and needs no new mechanism — see the
Recommendation.

**What happens to the P&L accounts.** Universally: their balance for the closed year reads zero
going forward (either because a real entry zeroed them, per ERPNext/Tryton/hledger/GnuCash-if-used,
or because the report is date-filtered and a new year's query never sees the old year's postings in
the first place, per Odoo pre-19/QuickBooks-virtual/Beancount-default).

### 2.4 The Odoo v19 change — the actual reason, sourced (this corrects doc 17's own hedge)

Doc 17 §1.3 flagged this as "the most important single finding in this section" but could only
report *that* Odoo changed, describing the cause as "reporting-history instability once anything in
a prior period could be touched" — explicitly labelled there as inferred, not confirmed. Fetching
Odoo's own explanatory blog post (linked from the v19 docs page itself) gives the real, stated
reason, and it is narrower and more specific than doc 17's hedge:

> In pre-19 versions, year-end profits automatically rolled into the Current Year Earnings account.
> This meant "**automatic entries** that rolled up income and expenses into the current year
> earnings account" were commingled with "**manual entries** involving the same account" — making
> it impossible to tell, from the account's history, which lines were system-generated and which
> were a bookkeeper's deliberate adjustment.
>
> — [Odoo — "How to Manage Current Year's Earnings in Odoo 19 Compared to Previous Versions"](https://www.odoo.com/blog/business-hacks-1/how-to-manage-current-year-s-earnings-in-odoo-19-compared-to-previous-versions-2107)

The actual driver was **audit-trail clarity**, not live-computation instability per se. And Odoo
v19's fix is more specific than "post a real entry now": it removed the automatic rollup
*entirely* and requires a human to post an **explicit, manual** entry, while a live "Result Brought
Forward" line continues to display the un-booked amount until someone does. Upgrading users are
told to "revisit past fiscal years and explicitly book the results that were previously handled
implicitly by the system" ([Odoo 19.0 year-end docs](https://www.odoo.com/documentation/19.0/applications/finance/accounting/reporting/year_end.html)).

This is a **third position**, distinct from both camps doc 17 named: not ERPNext's "the system
posts it for you," and not old-Odoo/GnuCash's "never post, always query" — but "the system will
show you the number continuously, and will never silently write history on your behalf; a human
must post the real entry." That third position is, not coincidentally, close to what §2's
Recommendation below proposes for us — and it directly narrows the open question doc 17 left
standing ("we have not verified whether our stricter invariant 5... actually avoids the specific
failure mode Odoo hit"). **We can now verify it, argued precisely:** Odoo's failure mode was two
different *kinds of writer* (automatic system code, and a human bookkeeper) both being able to
write into the same account's history with no way to tell which wrote what. Under invariant 5, only
one writer class exists for any posted line — a deliberate, explicit call to `postEntry`, always by
a named actor, always immutable, always reversible-not-editable. There is no code path in our
design that writes a journal line silently in the way Odoo's old automatic rollup did. The specific
mechanism of Odoo's bug — silent automatic writes commingled with manual ones in one account — does
not exist for us by construction, independent of whether the roll-forward is automatic or manual.
What *does* still need deciding is §1.3's separate warning (the reporting-query one) — those are two
different risks that doc 17's hedge had conflated.

---

## 3. Preconditions — hard gates vs warnings

Doc 17 §1.6 and §1.9 already established that ERPNext hard-blocks close on a stock-to-GL mismatch
and that draft documents block close (universal across the three systems with a real gate). New
material from general SMB close-process literature and from checking our own current architecture:

| # | Finding | Source | Hard or warning, and why |
|---|---|---|---|
| 3.1 | **Subledger-to-control-account tie-out is treated as an effective hard gate in SMB close practice generally**, independent of software: "AP subledger-to-GL reconciliation is the single most important control in the AP close... any unexplained variance between the two is an audit finding," and the standard close sequence is explicitly ordered — cut off, reconcile cash, then subledgers, resolve variances, only then report | General month-end-close operations literature (Ramp, Trullion, dokka — vendor-neutral finance-ops content, not tied to one accounting package) | **Now cheap for us to make a real hard gate**, and this is new information not available when doc 17 was written: `DEF-037`/T-118 (fixed 2026-08-23, `docs/DEFECTS-REGISTER.md`) put `party_type`/`party_id` directly on `journal_lines` for every control account, so "does the subledger tie to the control account" is a single `GROUP BY party_id` query, not a separate reconciliation system doc 17's own §4.2 flagged as "genuinely open." Doc 17's §4.4 already said ADOPT the *gate*; this closes the *cost* objection that made it a real open question |
| 3.2 | **No system studied — ERPNext, Tryton, QuickBooks, or Xero — enforces "bank reconciliation complete" as a machine-checked precondition of closing.** In every source read this pass, it appears only as a procedural recommendation ("you should complete bank reconciliations... before creating the voucher"), never as a validation the software runs | [Period Closing Voucher docs](https://docs.frappe.io/erpnext/period-closing-voucher); [Tryton closing a period](https://docs.tryton.org/7.0/modules-account/usage/close.html); general SMB checklist sources above | **Warning, universally — never a hard gate, and for a structural reason**: bank statement availability is an external dependency outside the software's or the business's control, and no vendor studied has chosen to block a close on it. Worth stating explicitly so this is never proposed as a hard constraint later |
| 3.3 | **"No draft/unposted documents in the period" may already be structurally impossible to violate in our own architecture**, not merely a rule we enforce. `DEF-031`'s fix (`docs/DEFECTS-REGISTER.md`) made `postEntry` insert an entry as `draft`, insert its lines, and flip to `posted` as the *last statement of one transaction* — there is no code path today that leaves a `journal_entries` row sitting in `draft` status across transactions the way ERPNext's or Tryton's UI-driven draft documents genuinely can | Internal — `packages/domain/src/ledger/post-entry.ts` per `docs/DEFECTS-REGISTER.md` DEF-031 | Universal-and-hard everywhere it's checked (doc 17 §1.9) — but for us this precondition may cost nothing to enforce because there may be nothing to find. Worth verifying with one query rather than assuming, but this is a genuine "free win" the stricter posting design already bought |
| 3.4 | **Sequential ordering — a period cannot close while an earlier one in the same org is still open** — is not stated anywhere in the sources read this pass as an explicit precondition of *closing* (only of *reopening*, per doc 17 §1.10). It is, however, the natural mirror of that rule, and none of the systems studied appear to allow closing out of order | Inferred from the reopen-sequencing pattern (doc 17 §1.10), not directly sourced for the close direction | Recommend as a hard gate by symmetry with the well-sourced reopen rule, flagged here as an inference rather than a directly observed universal, per the task's instruction not to fill gaps with plausible text |

---

## 4. Prior-period adjustments

Doc 17 §1.12 already established the universal accounting-law framework (IAS 8 / ASC 250):
material errors get retrospective restatement of prior comparatives; immaterial ones get a
current-period catch-up adjustment. That citation is confirmed again this pass by independent
professional sources ([ACCA technical factsheet](https://www.accaglobal.com/content/dam/ACCA_Global/Technical/Guides/tf-prior-period-errors-adjustments.pdf),
[Moore Global](https://www.moore-global.com/services/ifrs/ias-8-accounting-policies-changes-in-accounting-estimates-and-errors/)) —
genuinely universal, statutory in origin, not a vendor's design choice.

**Is our approach standard?** Assessed directly against what we already have (`reverseEntry`,
tagging `[prior period]` and posting into an open period when the original's period is closed):

- We implement exactly the **immaterial / current-period-adjustment half** of IAS 8's framework.
  We implement **none** of the material/retrospective-restatement half — there is no mechanism to
  restate a closed period's *own* reported figures.
- **This is deliberately correct for us, not an oversight**, and the argument is bible §13 row 75:
  Shareat System is "a management ledger, not a statutory filing basis," with no regulator or
  external auditor demanding restated comparatives. Retrospective restatement exists in the
  standard specifically to protect *someone reading a previously-filed statement* — a party we do
  not have. Building the dual-track material/immaterial machinery here would be exactly the kind of
  generality §1.1 says to leave out: real cost, no real need behind it.
- **One genuine, concrete gap worth naming, not previously stated anywhere in this project's
  docs**: `[prior period]` is a memo-string prefix, not a structured, queryable flag. Nothing
  today lets a report ask "show every correction posted against an already-closed period this
  year" except a text search over `memo`. This is a small hardening of an existing mechanism, not
  a new capability — flagged in the Recommendation, not urgent (see §Ian's decision 5).

---

## 5. Reopening

Doc 17 §1.10 already established the universal pattern from the three systems with a real close
gate: reopening is sequential (most-recent-closed-period only), asymmetric, and itself a reversing
act, never a silent status flip. Two new, concrete pieces of evidence this pass, one illustrating
*why* the capability must exist, one illustrating what happens when it is built weakly:

- **Why it must exist — a documented real scenario.** Zuora's own reopening documentation
  describes exactly the shape of event that motivates this feature: an invoice from January is
  incorrectly written off as bad debt in February; both January and February close; a payment for
  the *original* January invoice then arrives in March. February must be reopened purely to unwind
  the incorrect write-off and apply the payment correctly ([Zuora — Reopen accounting periods](https://knowledgecenter.zuora.com/Zuora_Finance/Accounting_Periods/H_Reopen_accounting_periods)).
  This is not a hypothetical for us — a late channel-settlement adjustment or a delayed AP credit
  memo landing weeks after a month closes is the same shape of event, and it will happen.
- **What happens when it's built weakly.** At Xero's SMB scale, reopening is not a distinct,
  logged act at all: "anyone with access to a client's settings in Xero can change the lock
  dates, and there is nothing preventing users from changing the locked period to a date in the
  past" (search-indexed community/product-forum consensus, corroborated across multiple threads
  including [Xero Product Ideas](https://productideas.xero.com/forums/967136-banking-chart-of-accounts/suggestions/45687991-settings-ability-to-lock-bank-reconciliation-per)).
  Reopening is indistinguishable, in the audit trail, from any other settings change.

**Relevance:** the Xero gap is a clean negative example of the thing our own invariant 5 and the
DB-level closed-period trigger already prevent structurally — even if `fiscal_periods.status` flips
back to `open`, no journal line becomes editable as a result; reopening can only ever re-enable *new*
postings into a period, never silently rewrite what is already there. That said, the *act* of
flipping status deserves the same discipline `reverseEntry` already requires (mandatory reason,
attributed actor, logged) rather than being a bare `UPDATE` — Xero's failure is precisely that its
lock-date field has no such ceremony around changing it.

---

## 6. Month close vs year close — one mechanism or two?

- **At SMB scale (Xero): one mechanism, two cadences.** A single lock-date mechanism is applied
  twice — a "Reporting Period" lock moved monthly by whoever does the books, and an "End of Year"
  lock moved once, after filing, and then left alone
  ([Xero lock dates overview, secondary-sourced](https://www.bookkeepingtutor.com.au/blog/lock-dates-in-xero/)).
  Odoo similarly layers several lock-date *fields* (a general journal-entries lock, a tax lock, and
  per-journal-type sales/purchase locks — [Cybrosys Odoo 15 lock dates](https://www.cybrosys.com/odoo/odoo-books/odoo-book-v15/accounting/lock-dates/)) — but every one of them is the *same kind* of
  mechanism (a date beyond which posting is blocked), just scoped differently. No separate
  "closing artifact" is created for any of them.
- **At the more rigorous end (ERPNext, Tryton — doc 17 §1.1, §1.4): two mechanisms.** A cheap,
  frequent period-level lock, plus a distinct, rarer year-level *artifact* that performs a real
  posting (Period Closing Voucher; Balance Non-Deferral wizard). The correlation is not
  coincidental: **a vendor needs a second mechanism only where the year boundary requires an actual
  posting** that an ordinary month never does. Where nothing is ever posted (Xero-style lock-only),
  one mechanism suffices for every cadence, because a lock is a lock regardless of period length.
- **What this means for us, argued from our own already-made choices**: invariant 2/3 already
  commits ordinary month-range P&L to a live query — nothing to post, ever, at month-end. §2 above
  argues the year boundary *should* post a real entry (for the reasons GnuCash and Odoo v19 both
  independently arrived at). That combination puts us in the ERPNext/Tryton shape by necessity, not
  by choice — **one shared lock/gate mechanism** (the existing `fiscal_periods.status` flip and the
  existing DB trigger) used at every cadence, **plus one extra, rare, deliberate posting action**
  that only applies at a year boundary and reuses `postEntry`/`reverseEntry` entirely. This is not a
  new invention; it is the field's own two-mechanism shape, with the enterprise plumbing (separate
  doctype, submit/cancel/amend workflow, wizard UI) explicitly not carried over — see the
  Recommendation's "deliberately left out" list.

---

## 7. Soft close vs hard close — is the distinction real?

**Yes, and it is standard, vendor-neutral operations terminology, not a marketing term from one
tool.** Multiple independent sources ([AccountingTools — soft close](https://www.accountingtools.com/articles/what-is-a-soft-close.html);
[Docyt](https://www.docyt.com/article/closing-books-with-ai-hard-close-vs-soft-close/); [Innovative
CPA Group](https://www.innovativecpagroup.com/resources/newsarticles/month-end-closing-procedures-hard-close-vs-soft-close/))
converge on the same definitions: a **hard close** is the full procedure — every account
reconciled, every accrual booked, no shortcuts, typically reserved for year-end or audit-facing
output. A **soft close** is an abbreviated pass — the significant accounts only, accruals estimated
or skipped — used for speed at interim/monthly cadence, with the explicit acknowledgment that
"results reported through a soft close can be materially inaccurate." One source frames it cleanly:
*"the soft close is a draft; the hard close is the published version."*

**Relevance:** this maps directly onto §6's month/year split and licenses it. Month-close for us can
legitimately be lighter — the existing lock/gate, no roll-forward posting, no requirement that every
discretionary accrual be perfect — without inventing a new concept or weakening a real one; that is
textbook soft-close practice, not a compromise specific to our scale. Year-close is where the full
gate list from §3 (draft-free, subledger-tied, sequential) and the roll-forward posting from §2
belong.

---

## 8. What goes wrong — documented failure modes

Collected from this pass, each a real, sourced instance rather than a hypothetical:

1. **Automatic + manual writers commingled in one account, destroying the audit trail** — Odoo's
   own stated reason for the v19 change (§2.4). Directly informs the Recommendation's insistence
   that the year-close entry is posted by one deliberate, attributed call to `postEntry`, never a
   silent background job.
2. **A closing transaction silently zeroing date-ranged reports that don't know about it** —
   GnuCash's own documentation admits this about its own optional feature (§1.3). The single most
   actionable failure mode in this whole document — see the Recommendation and the planner note.
3. **A late-arriving fact forcing a reopen of an already-closed period** — Zuora's documented
   invoice/write-off/payment scenario (§5). Argues reopening must exist, not that it's risk-free.
4. **Reopening after later periods have posted material transactions corrupting history** — general
   caution surfaced in SAP community discussion during this pass ("it is only safe to reopen... when
   no material postings have been done after the period shift... reverting can cause database
   inconsistencies in the history tables"). Independently corroborates doc 17 §1.10's
   most-recent-only sequencing rule from a different, non-open-source angle.
5. **A computed-not-posted balance and a manually-posted entry colliding in the same account,
   reading as a double-count** — the QuickBooks Retained Earnings community threads (§1.2). Directly
   rules out "compute it forever, never post" as our permanent year-boundary answer.
6. **A lock date that does not lock something** — literally the task's own framing, and a real,
   documented gap: Xero's bank-feed "Reconcile period" lock is a *separate* mechanism from the
   accounting lock date and does not talk to it, and the accounting lock date itself is changeable
   by "anyone with access to a client's settings," with nothing stopping it being moved backward
   into the past (§5). Worth citing plainly as the concrete version of a risk that is easy to wave
   away as theoretical.

---

## Recommendation for Shareat System

**For a seven-store single-entity restaurant business with a management ledger and no statutory
filing obligation (bible §13 row 75).** Concrete, buildable, deliberately smaller than every
reference system studied.

### What close does

- **Month close is a pure lock. Nothing is posted, ever, at month-end.** `fiscal_periods.status`
  flips `open → closed` for the period; the existing DB trigger (already blocking postings into any
  non-open period, on every path — invariant 7, doc 17 §1.8's ADOPT) does the rest. This needs no
  new posting logic at all, because invariant 2/3 already makes month-range P&L a live query. This
  is the "soft close" of §7, applied monthly.
- **Year close does everything month close does, plus one real journal entry**: every income and
  expense account's balance for the fiscal year zeroes into **3300 Retained earnings**, posted by
  calling the existing `postEntry`, dated the first day of the following year (mirroring ADR-005's
  own convention of dating the opening balance 2027-01-01 as one clean, dated artifact — chosen over
  Tryton's "last day of the closing year" convention for consistency with that precedent, not
  because either is objectively more correct; §2 found no universal rule here). This is the "hard
  close" of §7, applied once a year.
- **The year-close entry is an ordinary posted entry, subject to every existing invariant** —
  balanced (1), a real nominal-ledger posting (2), traceable to a source document (4: the trial
  balance snapshot for the year, archived, exactly as ADR-005 already treats the monthly
  payroll/inventory summary entries as acceptable "source documents"), immutable (5). A mistake in
  it is corrected by calling the **existing** `reverseEntry` — never edited, never a bespoke
  "cancel voucher" workflow. This is the whole reason ERPNext's and Tryton's separate
  voucher/wizard lifecycles are not needed here: we already built the one thing they exist to
  provide.

### What it checks — hard gates vs warnings, explicitly

| Precondition | Hard or warning | Why |
|---|---|---|
| No draft/unposted journal entries dated inside the period | **Hard** | Universal wherever any real gate exists (doc 17 §1.9); likely already structurally unviolable given DEF-031's fix (§3.3) — verify, don't build |
| Trial balance ties (invariant 10) | **Hard** | Already a continuous CI check; re-run as the literal close-time gate, costing nothing new |
| Every `requires_party = true` control account's subledger sum equals its control balance | **Hard, for year close** | Doc 17 §1.6/§4.4 ADOPT, and now cheap: DEF-037/T-118 already put `party_id` on `journal_lines`, so this is one `GROUP BY` query per control account, not a system. Recommend soft/advisory only for the *first* year (Ian's decision 1) given low early transaction volume |
| Sequential — no closing a period while an earlier one in the org is still open | **Hard** | Mirrors the well-sourced reopen-sequencing rule (§3.4); not directly sourced for the close direction, flagged as an inference |
| Bank reconciliation complete | **Warning only, never a gate** | No system studied enforces this in software (§3.2) — it depends on an external party (the bank) outside anyone's control. Stated explicitly so this is not proposed as a hard constraint later |

### What it refuses

Posting of any kind into a closed or locked period, from any code path — inventory, production,
crons, admin tools included. This is invariant 7 and the existing trigger; the close routine adds
nothing here, it only confirms the gate it already relies on is doing its job.

### Reopening

Permitted, admin-only, **most-recent-closed-period-of-the-org only** (mirrors doc 17 §1.10's
universal sequencing; cannot reopen a period while a later one in the same org is `closed` or
`locked`), requires a **mandatory reason string** and is logged with actor and timestamp — the
exact same ceremony `reverseEntry` already requires, applied to the status flip itself rather than
left as a bare `UPDATE` (the direct lesson from Xero's weak version, §5/§8.6). Reopening a period
that already has a year-close entry posted against it does **not** auto-reverse that entry — it
stands, immutable, until someone explicitly reverses it. No second correction mechanism is invented.

### `locked` — giving the third status a real job

The schema already has three states (`open | closed | locked`), matching Tryton's exact vocabulary
(doc 17 §1.5), but nothing today distinguishes `closed` from `locked` in behaviour or decides what
moves a period from one to the other. Recommend: a period auto-advances `closed → locked` once the
**following year's own year-close entry posts successfully** against it — the same sequential
principle as reopening, applied one level up (you cannot reopen 2027 once 2028 has rolled forward
on top of it). `locked` periods cannot be reopened at all, by anyone, through any path. This gives
the existing third state a genuine function instead of sitting unused — but whether the trigger
should be automatic or a deliberate later human action is a real judgment call, not a technical one
(Ian's decision 6).

### Deliberately left out, and why

- **No separate "closing voucher" entity with its own submit/cancel/amend lifecycle** (ERPNext's
  PCV, Tryton's wizard). We have one closing event a year across seven stores — nowhere near enough
  volume to justify a dedicated workflow object, and `postEntry`/`reverseEntry` already do
  everything such an object would provide. Carrying it over would be exactly the generality §1.1
  says to leave out.
- **No per-journal/per-document-type granular period locks** (Tryton's `account.journal.period`,
  iDempiere's `C_PeriodControl`, doc 17 §1.11). Doc 17 already verdicted this ADAPT-not-ADOPT for
  ADR-005's named monthly summary bridges specifically; this document does not reopen that — a full
  framework remains overkill, and a bridge that genuinely needs an exception gets a named,
  explicit allow-list entry, not new machinery.
- **No tax lock date** (Odoo's third lock date, `tax_lock_date`, which exists to protect a filed
  statutory return). Rejected directly against bible §13 row 75: no VAT engine, no output-VAT
  liability accounts, no filed BIR return exists to protect. The entire reason this lock date
  exists elsewhere is absent here.
- **No materiality-driven dual-track restatement** (IAS 8/ASC 250's full machinery — restate prior
  comparatives for material errors, catch up immaterial ones). Rejected against the same row 75:
  no external auditor or regulator is reading a previously-filed statement of ours. The existing
  `reverseEntry` `[prior period]`-tagged current-period correction is the entire mechanism,
  deliberately, per §4.
- **No hard, database-enforced bank-reconciliation-complete gate.** Rejected because no system
  studied does this (§3.2), and it would block a close on a dependency nobody here controls.
- **No Tryton-style persisted "Account Deferral" cache row carrying a balance forward outside the
  ledger** (§1.6). Rejected against our own bible §4.2 rule 7 — derived data is a view, never a
  hand-maintained summary row. The year-close journal entry is the only place a carried-forward
  balance should live.

### The alternative rejected: never post anything, ever (pure live P&L, permanently)

This is architecturally where we start, per invariants 2/3, and it is a real, common, respectable
position — Odoo pre-19, GnuCash by default, Beancount, hledger without `close` all live here
happily. It is rejected as the **permanent** answer for three sourced reasons, not asserted: (a)
GnuCash's own documentation concedes this only works because *its* reports are never
closing-entry-aware — we don't get a report layer that's exempt from ever needing a persisted
number; a multi-year balance sheet legitimately needs Retained Earnings to be a real, fast,
addable balance rather than an ever-growing aggregation query over all history since 2027; (b) Odoo
itself — the system we are architecturally closest to on this question — walked this back in v19
specifically because pure live-computation caused real problems over time (§2.4); (c) it would
leave 3300, seeded and clearly intended for use, permanently at zero forever. **Live query remains
correct and unchanged for every month-range or ad hoc date-range P&L query** — that part of the
architecture is not being revisited — it is simply not sufficient as the *only* mechanism at the
year boundary.

---

## What needs Ian's decision

Business judgements, not technical ones:

1. **How strict should the subledger-tie-out gate be in year one?** Technically cheap and
   recommended as hard (§3.1), but Phase 1/2 will have very little transaction volume and few
   counterparties in the first year — starting it as a warning and graduating to hard once there's
   a track record trades early friction against early discipline. Ian's call.
2. **Is reopening permitted in production at all?** Doc 17's own literature and the Zuora scenario
   (§5, §8.3) argue it is the standard, necessary escape hatch — but Ian may reasonably decide
   "never reopen, always correct forward via `reverseEntry` regardless of how old the error is" is
   simpler and carries zero reopen-related risk for a business with no external audit. That
   simplicity has a real cost: it means every late correction, however old, shows up in whatever
   period is open *today*, never in the period it actually happened.
3. **Is month-close a real, enforced event here at all** — or does only year-close matter,
   softening month-close to an internal habit rather than a system-enforced gate? Per ADR-005 the
   business has run for years with **no** monthly close discipline; introducing one from Feb 2027
   is an operational and habit change for whoever runs the books each month, not merely a schema
   feature. Ian should decide whether to enforce it from month one or phase it in.
4. **Who holds the server-side permission to close or reopen a period** — admin-only, or does an
   owner/manager role get it too? A role-scope question, not a technical one (bible §7's
   server-side-only rule governs *that* it must be enforced server-side, not *who* it is granted to).
5. **Is the `[prior period]` memo-tag worth hardening into a structured, queryable flag now**, or
   fine to defer until the first genuine post-close correction actually happens (§4)? A sequencing
   question, not a correctness one — nothing is wrong with the current mechanism, only its
   queryability.
6. **When does `closed` become `locked`?** §Recommendation proposes an automatic trigger (next
   year's close posts successfully) by analogy with the reopen-sequencing rule. Ian may instead
   prefer this to be a deliberate, later, manual "seal it" action — a business-process choice with
   no technical right answer surfaced by this research.

---

## Three things for the planner

1. **Exactly one new posting action is needed, and it is small.** Year close zeroes every
   income/expense account into 3300 Retained earnings by calling the *existing* `postEntry`,
   correctable via the *existing* `reverseEntry` — no new posting primitive, no separate voucher
   entity. Month close needs nothing beyond the lock flip and trigger that already exist. This
   document's entire technical ask is one admin-triggered, once-a-year call into machinery already
   built.
2. **The costliest-to-retrofit gap this research found — the physical shape of the AP/AR subledger
   — is already closed**, not still open. `DEF-037`/T-118 (2026-08-23) put `party_id` directly on
   `journal_lines`, which is exactly the shape doc 17 §4.1 found ERPNext and iDempiere use and
   recommended, and it makes the standard "subledger ties to control before you can close"
   precondition a single cheap query instead of a project of its own.
3. **Whatever posts the year-close entry must be tagged distinctly enough that a live P&L query for
   a date range can and does exclude it, while a balance-sheet-as-of query includes it.** GnuCash's
   own documentation admits its identical feature breaks its own reports for exactly this reason.
   It is a five-minute design note to get right now and the literal, sourced, self-admitted bug in
   a shipped product to reproduce if it's missed.
