# Industry ERP patterns — what mature systems know that we haven't decided yet

**Date:** 2026-08-23
**Method:** Source code read directly (git clone / GitHub API), not vendor docs, per Ian's explicit
steer mid-task. Five systems' core accounting engines were read at the DDL/controller level:
**ERPNext** (`frappe/erpnext`, pinned `6ba623e`, branch `develop`), **Odoo Community**
(`odoo/odoo`, pinned `037c4dc`, branch `18.0`), **Tryton** (`tryton/account`, pinned `fd54e0a`,
branch `develop`), **LedgerSMB** (`ledgersmb/LedgerSMB`, pinned `91cee95`, branch `master`),
**GnuCash** (`Gnucash/gnucash`, pinned `80c442d`, branch `stable`) — plus **TigerBeetle**
(`tigerbeetle/tigerbeetle`), **Beancount** (`beancount/beancount`), **hledger**
(`simonmichael/hledger`), and **iDempiere** (`idempiere/idempiere`) for the ledger-model and
dimension questions. Docs/forum sources are used only for process knowledge (cutover practice,
restaurant-industry benchmarks) and are marked as such.

**Read first, honored throughout:** PROJECT_BIBLE.md §1.1, §4.2, §13 (95 rows), §16 (ten
invariants); ADR-001 through ADR-005; `docs/CAPABILITY-GAPS.md`; `docs/decisions/OPEN-DECISIONS.md`;
`docs/decisions/COA-ALIGNMENT.md`. Settled questions are not re-opened — where research touches
one, the row is cited and the reasoning is argued with, not silently ignored.

---

## 1. Period close and year-end

This is our single biggest blank: `fiscal_periods` has `open|closed|locked` and no close routine
at all. Five systems, two genuinely different philosophies, and one important course-correction
mid-research.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 1.1 | **Close *generates* a real reversing journal entry** that zeros every P&L account for the period and nets the total into a named equity account (textbook "closing entries") | **ERPNext** — `PeriodClosingVoucher.get_pcv_gl_entries()`, `erpnext/accounts/doctype/period_closing_voucher/period_closing_voucher.py:255-283`. **LedgerSMB** — `eoy_zero_accounts()`, `sql/modules/EndOfYear.sql`, pure PL/pgSQL. **GnuCash** — optional, user-triggered, `dialog-book-close.c` `gnc_book_close_response_cb()` | Common among systems that treat "closed" as a real accounting event, not universal — see 1.2 | Directly answers our blank: this is one of two live options for what "close a period" means mechanically | NEEDS IAN — pick 1.1 or 1.2 |
| 1.2 | **Close never posts anything.** P&L is always a **live query** filtered by date range; the boundary is enforced only by a lock date preventing edits before it | **Odoo** (pre-v19) — `account_account.py:80`, `include_initial_balance` flag: P&L account types are excluded from carrying balance across a fiscal-year boundary; "Current Year Earnings" is a live `SUM` at report time, not a posted balance. Corroborated by [Odoo 18.0 year-end docs](https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/year_end.html) | One vendor's choice — and that vendor partially reversed it (see 1.3) | Matches our own invariant 2/3 philosophy ("the income statement is a query over `journal_lines`") more closely than ERPNext's — but see 1.3 before assuming this settles it | NEEDS IAN — this is the philosophy we're structurally closest to, but not risk-free |
| 1.3 | **Odoo v19 partially reversed 1.2** — retained earnings now requires an explicit manual entry to book results, because pure live-computation caused reporting-history instability once anything in a prior period could be touched | Odoo, [19.0 year-end docs](https://www.odoo.com/documentation/19.0/applications/finance/accounting/reporting/year_end.html): *"upgrading users should revisit past fiscal years and explicitly book the results"* | One vendor's own course-correction — but it's real, documented, and from the system whose philosophy we're closest to | **This is the most important single finding in this section.** We are architecturally closer to Odoo's pre-19 model (live P&L query) than to ERPNext's (explicit closing entries) — and Odoo itself moved away from pure live-computation for a documented reason. Our invariant 5 (posted entries truly immutable, not just lock-dated) may avoid Odoo's specific failure mode — but that's an untested assumption, not a proven mitigation | NEEDS IAN before Phase 1 close-routine design |
| 1.4 | **Close is a refusal, not a generator** — `FiscalYear.close()` throws `FiscalYearCloseError` if any non-deferral (P&L) account has a nonzero balance; zeroing P&L is a **separate, explicit wizard** (`BalanceNonDeferral`) run beforehand by a human | **Tryton** — `fiscalyear.py:282-323`, `get_deferral()`, `361-450` | One vendor's choice, but notable: it's the only one of the five that **separates "generate the closing entry" from "close the period"** into two distinct acts | Interesting middle ground: gives you an explicit, auditable "did someone actually zero P&L" moment without conflating it with the close-status flip | ADAPT — worth considering as a shape, not necessarily the mechanism |
| 1.5 | **Tryton's exact status vocabulary is `open / close / locked`** — identical three words to our own `fiscal_periods.status` | Tryton — `fiscalyear.py:39-43`, `period.py:31-35` | One vendor's naming, but a strong independent confirmation that our chosen vocabulary is a real, previously-arrived-at shape, not an invention | Low-risk validation of an already-made naming choice | ADOPT (already done) |
| 1.6 | **A period cannot close unless every subledger reconciles to its control account first** — ERPNext hard-blocks close if the GL balance of Stock-type accounts doesn't match the independently-computed Stock Ledger value: `"Resolve the difference using the Stock Ledger Variance report before closing the period."` | ERPNext — `validate_stock_accounts_balance()`, `period_closing_voucher.py:174` | Common practice among systems with a real close gate (also present in Tryton's and LedgerSMB's "no drafts left behind" checks, see 1.8) | **We have invariant 6 ("checked continuously") but nothing that makes reconciliation a hard precondition of closing a period.** This is a concrete, low-risk, directly portable addition | ADOPT |
| 1.7 | **Enforcement of the closed-period rule lives in application/ORM code in ERPNext, Odoo, and Tryton — not the database.** `validate_against_pcv()` runs inside the one Python function everything is supposed to route through (`make_gl_entries`), with no role exemption — but a raw SQL insert bypasses it entirely | ERPNext `gl_validator.py:145-158`; Odoo `_check_fiscal_lock_dates()` `account_move.py:2540-2556` (with a `BYPASS_LOCK_CHECK` sentinel — deliberately hard to spoof externally, but still ORM-layer); Tryton `Move.check_modify()` `move.py:248-254` | **Genuinely the dominant pattern** — application-layer enforcement, not a DB constraint | Our invariant 7 ("no posting into a closed period by ANY code path, including crons/migrations/admin tools") is **stricter than the industry default** across three major systems | ADOPT — validates going further than the reference systems, not less far |
| 1.8 | **LedgerSMB enforces the closed-period rule as a real `BEFORE INSERT` database trigger** on `acc_trans`/`ap`/`ar`/`gl` — the one system of five where this is actually unbypassable by any client, ORM, cron, or admin script | LedgerSMB — `prevent_closed_transactions()`, `sql/modules/triggers.sql:55-64`; attached via `sql/Pg-database.sql:2098-2105` | **One vendor's choice, but the correct one for our stated invariant** — LedgerSMB is the outlier, not the norm, and it's the outlier doing exactly what we already committed to | This is the concrete proof that a real DB-level closed-period guard is buildable in Postgres, not just aspirational | ADOPT — implement invariant 7 as an actual trigger, matching LedgerSMB's mechanism, not ERPNext/Odoo/Tryton's ORM-layer convention |
| 1.9 | **Unposted/draft documents block period close** — universal wherever a real close gate exists | ERPNext (fresh Stock Closing Entry required); Tryton (`Period.close()` refuses if any move in the period isn't `state='posted'`, `period.py:346-355`); LedgerSMB (`eoy_create_checkpoint` raises `'Unapproved transactions in closed period'` if any unapproved row exists, `EndOfYear.sql`) | Universal among the three systems with a real close gate | We have no equivalent check named anywhere against `fiscal_periods` today | ADOPT |
| 1.10 | **Reopen is always sequential and asymmetric — never arbitrary, and always a reversing act, never a status flip** | ERPNext blocks reopening if a *later* Period Closing Voucher is submitted; Tryton blocks reopening a year if a later one is open; LedgerSMB's `eoy_reopen_books` only allows reopening the *most recent* checkpoint, via a reversing transaction, never a delete | Universal across the three | Directly answers our blank on prior-period adjustment mechanics: closes chain forward, reopens unwind backward one at a time, and a reopen is itself a posting, never silent | ADOPT |
| 1.11 | **Per-journal or per-document-type period locks, finer-grained than a single global period status** | Tryton's `account.journal.period` — a period can be closed for Sales while a Miscellaneous/adjustments journal stays open (`move.py:1207-1224`). iDempiere's `C_PeriodControl` — one row per (period, document base type): GL can close while Material Management stays open (doc-sourced, **not independently verified from source this session** — WebFetch was blocked; flag for re-confirmation before citing exact column names to Ian) | Real but less common — a deliberate refinement over a single period-status column | **Directly relevant to ADR-005's monthly summary bridges** (payroll, inventory) that must keep posting into an otherwise-closed month during the Q1 strangler period. A single global lock can't express "this month is closed to everything except the v1 summary bridge" | ADAPT — worth a lighter version: an explicit allow-list of source_types permitted to post into a closed period, rather than a full per-journal lock framework |
| 1.12 | **Prior-period restatement is materiality-driven**, not mechanism-driven: a *material* error requires retrospective restatement of prior statements; an *immaterial* one is corrected as a current-period "out-of-period adjustment" | Accounting standard, not vendor-specific — IAS 8 / ASC 250. [PwC Viewpoint 30.7](https://viewpoint.pwc.com/dt/us/en/pwc/accounting_guides/financial_statement_/financial_statement___18_US/chapter_30_accountin_US/307_correction_of_an_US.html); [Uniqus ASC 250](https://uniqus.com/accounting-standards-codification-250/) | **Genuinely universal — an accounting-law requirement, not a system's design choice** | We have invariant 5 (immutable, corrections are reversals) and invariant 7 (closed periods reject postings) but **no stated rule for which period a correcting reversal lands in** when the original error is in an already-closed period | NEEDS IAN / Opus — write this rule down before it's needed under pressure |

---

## 2. Inventory valuation and COGS posting

Weighted average is already decided (bible §13 row 50, OPEN-DECISIONS.md item 4) — not
re-litigated. What follows is how the mechanics actually work at scale, which is still open.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 2.1 | **Weighted-average recompute formula** — `new_rate = ((prev_qty × prev_rate) + (in_qty × in_rate)) / new_qty`, run on every receipt | ERPNext — `erpnext/stock/stock_ledger.py:1257-1266`; Odoo AVCO — `addons/stock_account/models/product.py:263-306` | **Genuinely universal arithmetic** — not a vendor choice at all | Confirms §16.11's chosen method has one, unambiguous, well-known formula | ADOPT (already decided) |
| 2.2 | **Weighted-average recomputation must be serialized per item+location**, because the formula is inherently sequential (each movement depends on the previous one's resulting balance) | ERPNext — `sle_processing_gate(item_code, warehouse)`, `stock_ledger.py:643`, a lock taken before recompute | Structurally forced by the math, not a style choice — genuinely universal constraint | **We have no stated locking design for concurrent receipts at the commissary.** Two simultaneous receipts of the same item at the same location will corrupt the running average without an explicit `SELECT ... FOR UPDATE` or advisory lock | ADOPT — design this into the Phase 3 posting service now |
| 2.3 | **A backdated correction to already-posted, already-averaged history is never done synchronously in the same transaction** — even ERPNext, our stated reference, queues it as an async background job (`Repost Item Valuation`, `frappe.enqueue(..., queue="long", timeout=1800)`) because the blast radius (every downstream movement's valuation and GL effect) is unbounded | ERPNext — `stock_ledger.py:334-380`, `repost_item_valuation.py:828-834` | Common — the same shape (bounded synchronous forward path, async backward-repost path) recurs anywhere real weighted-average history exists | **§16.11's "posts to the GL in the same transaction, no overnight job" needs to be scoped explicitly to the *original* movement, not silently extended to *corrections to history*.** No comparable system attempts synchronous, same-transaction reposting of a backdated correction at scale | NEEDS IAN — clarify §16.11's scope; this is presently ambiguous, not contradicted |
| 2.4 | **Negative stock — two legitimate, differently-costed answers**, not one standard: (a) reject the transaction outright, with an opt-in escape hatch; (b) allow it, value provisionally at last-known cost, correct retroactively once real supply arrives | (a) ERPNext — `validate_negative_stock()`, `stock_ledger.py:1397-1415`, default-on. (b) Odoo — `_run_fifo_vacuum`, `stock_move.py:381`, comment at `product.py:411-413`: *"we chose to value the out move at the price of the last out and a correction entry will be made once fifo_vacuum is called"* | **One vendor's choice each — genuinely a real fork, not a universal answer either way** | Given POS cannot block a sale on an inventory validation failure operationally, **Odoo's model (allow, provisionally value, vacuum-correct later) fits our reality better than ERPNext's (block by default)** — but this generates a second correcting journal entry after the fact either way; it doesn't avoid async correction, just moves it later | NEEDS IAN — this needs its own worked example and probably its own ADR, the same way voiding got one |
| 2.5 | **Perpetual inventory (COGS posts synchronously with each movement) is a real, named, company-level toggle** even in ERPNext — not a degraded mode, a fully supported alternative to periodic/purchase-basis costing | ERPNext — `is_perpetual_inventory_enabled(company)` gate in `make_gl_entries()`, `erpnext/controllers/stock_controller.py:187-214` | Common — the distinction is well-established under the terms **"Anglo-Saxon" (perpetual, COGS at delivery) vs "Continental" (periodic, purchase hits P&L, period-end stock-variation correction)** — Odoo names this explicitly (`company_id.anglo_saxon_accounting`, `stock_move.py:748`) | **Confirms our chosen model (§16.11) is the named industry-standard "Anglo-Saxon perpetual" pattern for a business needing day-to-day gross margin** — Continental exists because French statutory law requires it, not because it's a better costing method | ADOPT (already decided; now confirmed as the correctly-named standard, not an invented approach) |
| 2.6 | **Count-variance posts to a single account, signed both ways** — no split by direction | ERPNext — one `stock_adjustment_account` (a P&L account by validation), `difference_amount` signed either way, `stock_reconciliation.py:610-707, 1098-1105` | **Genuinely standard** — same shape as our own 7350 Cash over/short | Confirms COA-ALIGNMENT.md's 5400 Inventory adjustment design | ADOPT (already decided) |
| 2.7 | **No system found gives waste, spoilage, and theft separate GL accounts.** Restaurant-industry practice treats theoretical-vs-actual food cost variance as a **reporting layer** on top of a single inventory-adjustment posting — theoretical usage from POS sales × recipe cost, actual from the perpetual ledger, and the *gap* is decomposed into waste/over-portioning/theft/spoilage as a diagnostic, not as different journal entries | Restaurant industry material, not vendor code — [Restaurant365](https://www.restaurant365.com/blog/closing-the-gap-between-actual-and-theoretical-food-costs), corroborated independently by Toast and getmeez.com around a **≤2% variance benchmark** | Common in the restaurant-tech space specifically (not general ERP) | Our COA is already correctly shaped (5300 Wastage, 5400 count variance). What's missing for theoretical-vs-actual as a real management signal — which the bible itself flags as "the single most important margin signal" for the unli product — is a **recipe/BOM costing engine and a variance report**, not more accounts | ADD, deferred — a Phase 3/6 reporting feature, not a chart change; not currently named in CAPABILITY-GAPS.md |
| 2.8 | **Invariant 5 (inventory control account = Σ on-hand valuations) was not found enforced as a real-time database constraint in any system studied.** It is eventual-consistency-by-construction (one code path writes both sides) verified by **periodic reconciliation reports**, not a live constraint — and ERPNext's own issue history shows this genuinely drifts when reposts/cancellations lag | ERPNext, Odoo — architecture inferred from `make_gl_entries` coupling + existence of separate "Stock Balance vs Stock Ledger vs GL" reconciliation reports | Common — this appears to be a real, structural limit, not a gap in the systems studied | **Our bible's "checked continuously" language for invariant 5 is stricter than what any reference system actually achieves.** The honest target is a fast, frequently-run reconciliation query (materialized-view-backed, minutes-scale interval), not a synchronous cross-domain DB constraint — attempting the latter risks serializing every stock movement against every GL read | NEEDS IAN — recalibrate "continuously" to mean "on a short, automated interval" rather than "as a live constraint," and say so explicitly so nobody tries to build the stricter (and probably undoable) version |
| 2.9 | **Inter-location transfer within one entity moves through an explicit in-transit account, at existing cost, with no markup** | ERPNext — Material Transfer with "Add to Transit" (transit warehouse pattern) | Common for same-entity multi-location transfers specifically (see §3 for the separate-entity case, which behaves very differently) | **Matches our own 1340 "Inventory in transit (branch orders)" account, already provisioned in COA-ALIGNMENT.md** — we arrived at the same shape independently | ADOPT (already decided, now corroborated) |

---

## 3. Inter-store / inter-company

We are single-entity, multi-store (OPEN-DECISIONS.md item 5, `organizations` table reserved but
not activated). This framing matters more than it looks — most "inter-company" tooling solves a
different problem than ours.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 3.1 | **"Inter-company" tooling in the two flagship open-source ERPs assumes SEPARATE LEGAL ENTITIES, not locations of one entity**, and solves it with full mirrored documents | ERPNext requires each branch modeled as a full separate `Company`, plus internal-customer/supplier master records; a Sales Invoice on one auto-generates a linked Purchase Invoice on the other (`make_inter_company_sales_invoice`). Odoo Community's equivalent (`account_inter_company_rules`) is an **Enterprise-only module** — the Community repo contains only a settings toggle pointing at code that isn't shipped | Common for the problem they're actually solving (distinct legal entities), but **that is not our problem** | **Reading either as "how to do commissary↔branch" would import generality this business does not have — exactly what §1.1 warns against.** This is not a system we should follow for this specific question | DELIBERATELY SKIP — validates OPEN-DECISIONS.md item 5's rejection of true multi-company tenancy |
| 3.2 | **The one real structural analog to "one legal entity, internal transfer between locations"**: a second "performing organization" dimension column on the GL fact row itself, separate from the "posting organization" | iDempiere — `Fact_Acct.AD_Org_ID` (posting org) paired with `Fact_Acct.AD_OrgTrx_ID` (performing/initiating org), from `org.adempiere.base/src/org/compiere/model/I_Fact_Acct.java` — plus `C_LocFrom_ID`/`C_LocTo_ID` for the separate physical-movement dimension | One vendor's choice, but structurally closest to our actual problem shape of the systems studied | Solves the same problem as our `due_from`/`due_to` reciprocal pair, but at the **fact-row level** (one extra column) rather than the **balance-sheet level** (two accounts eliminating to zero) | ADAPT (informational) — our reciprocal-account approach is a legitimate, lighter alternative for a company that has not yet built a dimension framework; see §5 for why we're not building one |
| 3.3 | **Our reciprocal due-from/due-to pair, eliminating to zero (invariant 6), is a genuine, standard-shaped balance-sheet solution — lighter than either alternative above** | Ours — COA-ALIGNMENT.md 1250/2150, bible §16.1 invariant 6 | N/A — this is our design, being checked against the field, not copied from it | Confirmed as neither over-built (vs. ERPNext/Odoo's mirrored-invoice machinery) nor under-built (vs. doing nothing) — a real middle position | ADOPT (already decided) — worth one sentence in `POSTING-PATTERNS.md` explicitly recording that the mirrored-invoice pattern was considered and rejected as over-fit, so a future reader doesn't wonder why it wasn't copied |

---

## 4. Subledger ↔ control account reconciliation

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 4.1 | **The counterparty is a plain column on the GL row itself** (`party_type`/`party` on ERPNext's `GL Entry`; `C_BPartner_ID` directly on iDempiere's `Fact_Acct`), so "the subledger" is a *filtered view* of the same table the control account total comes from — not a second, physically separate table that can drift from it | ERPNext — `erpnext/accounts/doctype/gl_entry/gl_entry.json` field list; `get_balance_on()` in `erpnext/accounts/utils.py` computes a per-party balance as `SUM(debit-credit) WHERE account='Debtors' AND party='X'`. iDempiere — same shape on `Fact_Acct` | Common between the two systems studied on this point | **This makes "does the subledger tie to the control account" true by construction, not a periodic check that can fail** — the same principle our own bible §4.2 rule 7 already applies to derived summaries ("a view, not a hand-maintained row"), just not yet applied to AP/AR | NEEDS IAN / Opus — genuine open design question, see below |
| 4.2 | **COA-ALIGNMENT.md's "control account + subledger" language does not yet specify the subledger's physical shape** — a genuinely separate table (heavier, needs continuous reconciliation, matches invariant 6's reciprocal-elimination language) vs. a `party_id`/`counterparty_id` column directly on `journal_lines` (lighter, makes reconciliation structurally moot, matches 4.1 and our own §4.2 rule 7 philosophy) | N/A — this is a gap in our own design exposed by comparison | N/A | **This is a real Phase 1 schema decision, not yet made.** Retrofitting from a separate-table subledger to a party-column model after AP/AR data exists would be exactly the kind of expensive-after-the-fact change §4.2 warns about. Note: this does **not** apply to the due-from/due-to inter-store case (§3.3) — that is a genuinely different mechanism (two accounts eliminating to zero across stores, not a per-counterparty column) | **NEEDS IAN before Phase 1 AP/AR table DDL is cut** |
| 4.3 | **Payments must name the specific open item(s) they settle** — no floating/unallocated cash; the linkage is a real FK-shaped reference (`against_voucher_type`/`against_voucher` on ERPNext's `GL Entry`), not a memo string | ERPNext | Common, and already independently adopted into our own POSTING-PATTERNS rules (bible §13 row 60, from the `accounting-systems` skill pass) | Confirms an already-made decision from a second, independent source | ADOPT (already decided) |
| 4.4 | **Reconciliation as a hard close-time gate**, not merely a continuously-run report — see §1.6 above (ERPNext blocks period close on stock-to-GL mismatch) | ERPNext | Common wherever a real close gate exists | The concrete mechanism for turning invariant 6 from "checked continuously" into something that actually stops a bad close | ADOPT |

---

## 5. Dimensions

Bible §16.4 rejects "cost centres, projects, arbitrary accounting dimensions" in favor of exactly
two hardcoded nullable columns (`store_id`, `channel_id`). This is not re-litigated as a question —
it is checked against the field, and the result is a stronger endorsement than the bible itself claims.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 5.1 | **Two hardcoded FK columns directly on the GL line (`cost_center`, `project`), identical in kind to our own `store_id`/`channel_id`** — the *default* shape, not a stripped-down or legacy one | ERPNext — `erpnext/accounts/doctype/gl_entry/gl_entry.json` | This is our stated reference system's own default | **Direct, strong validation of §16.4/row 44.** We are doing the ERPNext-default thing, not a naive simplification of it | DELIBERATELY SKIP (a dimension framework) — confirmed correct, citing §16.4 and bible row 44 |
| 5.2 | **A dynamic, schema-mutating dimension framework exists ONLY for dimensions beyond the two defaults**, and it's expensive when used — literally calls `ALTER TABLE` at runtime via `create_custom_field()` on every transactional doctype when an admin defines a new dimension | ERPNext — `erpnext/accounts/doctype/accounting_dimension/accounting_dimension.py`, `before_insert` → `set_fieldname_and_label` | One vendor's escape hatch, not the default path | Reinforces that a framework is the *expensive* option even in the system that has one — further evidence against building one preemptively | DELIBERATELY SKIP — §16.4 |
| 5.3 | **A full ~30-column dimension fact table** (org, performing-org, business partner, activity, cost center, department, project/phase/task, campaign, sales region, product, locator, warehouse, from/to location, two free "user element" columns, asset, posting type) | iDempiere — `I_Fact_Acct.java` | One vendor's choice — genuinely thorough, but solving for problems we don't have (multi-warehouse locators, sales campaigns, project phases, budget postings across a much larger org) | Useful as an upper bound, not a target. Confirms two columns is a real, deliberate point on a spectrum, not an oversight of a "correct" larger design | DELIBERATELY SKIP — §16.4; the generality genuinely does not exist in this business |
| 5.4 | **A JSONB percentage-split "analytic distribution"** letting one GL line allocate fractionally across multiple analytic accounts/plans simultaneously, as a parallel management overlay separate from the statutory GL | Odoo — `addons/analytic/models/analytic_mixin.py:16-37`, `analytic_distribution` field + GIN index | One vendor's choice, and a materially larger feature than a nullable FK column | Useful contrast: shows what "arbitrary, N-dimensional, fractional-split dimensions" actually costs to build (a parallel data model, not a column) — reinforces that our simpler approach is a real simplification against a real, much bigger alternative | DELIBERATELY SKIP — §16.4 |

---

## 6. Chart of accounts design

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 6.1 | **~120 leaf (postable) accounts, ~56 group/rollup accounts, 4 levels of depth, for a real Philippines-localized small-business template** — Expense-dominated (58 leaf), then Asset (30), Liability (20), Income (7), Equity (5) | ERPNext's own PH chart-of-accounts seed, `erpnext/accounts/doctype/account/chart_of_accounts/verified/philippines.json` (176 total named accounts, 924 lines, read in full) | One vendor's generic template, but a real, deployed one — and it's meant to cover many industries at once, wider than a single-concept restaurant needs | **Corroborates §16.9's "60–120 active accounts is normal for a single-entity F&B business" at the upper bound.** Our own trimmed COA (~85–90 accounts after the withdrawn 4200/4410/4420 splits) sits comfortably inside this band | ADOPT — the 60-120 heuristic is now evidence-backed, not just asserted |
| 6.2 | **Even a generic small-business template carries a dedicated "due from affiliate/company" receivable line** (`1310 Accounts Receivable - Affiliates` → `1311 Due from Company`) | Same ERPNext PH template | One vendor's template, but independently arrived at | Independent corroboration that our `1250 Due from related store` is a standard-shaped concept, not a bespoke invention for our situation | ADOPT (already decided) |
| 6.3 | **Deliberate numbering gaps left for future accounts** — round-number group boundaries (e.g. a `1100` group leaves `1101`/`1110`/`1111` for leaves, next group starts `1200`) | Same ERPNext template; general bookkeeping convention | **Genuinely universal** — seen identically in the template and in general practice | Directly validates COA-ALIGNMENT.md's deliberate 1520/1530 gap ("don't need names, keep the gap") as standard practice, not laziness | ADOPT (already decided) |
| 6.4 | Could not locate a usable generic Odoo Community chart-of-accounts template in the current repo — Odoo has moved to country-only localization modules, no default template found in `addons/account/data` | — | — | No claim made here; flagged as a gap in this research, not a finding | N/A |

---

## 7. Migration and cutover

ADR-005 already commits to a single opening-balance journal entry, balance-sheet only, netting
`3900 Opening Balance Equity` to zero, with a staged 30 Sep / 31 Oct / 15 Nov honesty-checkpoint
calendar. This section checks that plan against documented industry practice, not against a
technical alternative.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 7.1 | **One consolidated opening-balance journal entry, which must net to exactly zero, with the residual moved into Retained Earnings/Owner's Equity only once verified — is stated as the recommended practice, not one option among several** | [beancount.io opening-balance guide](https://beancount.io/blog/2026/05/17/opening-balance-equity-account-set-up-new-books-mid-year-clear-zero-out-retained-earnings-owner-equity-guide); [Deskera](https://www.deskera.com/blog/opening-balance-equity/); [FreshBooks](https://www.freshbooks.com/hub/accounting/opening-balance-equity) | Common across small-business accounting guidance broadly, not tied to one vendor | **ADR-005's approach matches the specifically-named correct pattern**, not merely a defensible one | ADOPT (already decided) — confirmed, not just plausible |
| 7.2 | **A lingering or force-zeroed residual in the opening-balance-equity account is explicitly flagged as a sign of an incomplete/incorrect load — never a formality to clear with a plug** | Same sources as 7.1 | Common | ADR-005 already says 3900 "must net to zero... a residual balance means the migration did not balance." Worth stating explicitly in the T-11x opening-balance-loader task spec that a non-zero residual **halts and requires investigation**, never an auto-plug | ADOPT — make explicit in the task spec, not just the ADR |
| 7.3 | **Only ~32% of ERP implementations finish on schedule; ~49% report post-go-live operational disruption**, and root causes trace to scope decisions made under pressure and go/no-go recommendations overridden by leadership | [Panorama Consulting, ERP implementation lessons learned](https://www.panorama-consulting.com/erp-implementation-lessons-learned-from-famous-failures/); [Panorama, expert-witness practice lessons](https://www.panorama-consulting.com/lessons-learned-from-our-erp-failure-expert-witness-practice/) | Industry-wide statistic, not tied to open-source or any one vendor | **A direct, cited endorsement of ADR-005's own honesty-checkpoint structure** — the failure literature specifically names "leadership overrides the recommendation" as a cause, and ADR-005 already commits to moving the date rather than shipping under a no-go. The only actionable item is discipline: don't relax that structure under pressure in November | ADOPT (already decided) — this is validation, not a new requirement |
| 7.4 | **Prior-period restatement discipline is materiality-driven** — see §1.12 above; repeated here because it's as much a cutover-adjacent concern (2026 close, then 2027 opening balance) as a period-close concern | IAS 8 / ASC 250 | Universal | Same gap as §1.12 — no documented rule yet for where a post-cutover correction to a 2026 balance lands | NEEDS IAN / Opus |

---

## 8. The ledger data model itself — what we did not ask about, but should have

This is the category the task explicitly calls out as highest-value. Two forks converged on the
same underlying question independently: **where does "the books balance" actually get enforced?**

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 8.1 | **Of five systems read at the code level — including the one built specifically to be PostgreSQL-native and philosophically committed to database enforcement — NONE has a real, multi-row, database-level constraint or trigger that blocks an unbalanced commit.** LedgerSMB (the PostgreSQL-native one) only *detects* imbalance via a standalone after-the-fact audit query (`sql/consistency/00001-balanced-transactions.sql`); GnuCash actively *repairs* imbalance by force-posting the residual into an auto-created `"Imbalance-<currency>"` account (`Scrub.cpp:448-634`) rather than rejecting it; Beancount/hledger tolerate small residuals by design (`interpolate.py:28-231`, tolerance-bounded, silently absorbed into a rounding account) | LedgerSMB, GnuCash, Beancount, hledger — all confirmed from source | **This is close to universal in the negative: essentially nobody enforces exact balance as a real DB-level constraint**, TigerBeetle being the sole exception, and it isn't a general-purpose relational database — the invariant is baked into a purpose-built state machine, not a portable SQL construct | **Our `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` (bible §13 row 65) appears to be a genuinely novel-for-Postgres-ERPs implementation of a principle every one of these systems claims to hold but almost none actually enforce mechanically at the database layer.** This is not a risk to reconsider — it's a real differentiator | ADOPT (already decided) — do not weaken this under any future "but nobody else does it this way" pressure; nobody else doing it this way is the finding, not a warning sign |
| 8.2 | **TigerBeetle's `Account`/`Transfer` model is the one true engine-level enforcement**, via `debits_must_not_exceed_credits`/`credits_must_not_exceed_debits` flags checked in the state machine itself | TigerBeetle — `src/tigerbeetle.zig:10-116`; `docs/reference/account.md` | One system's purpose-built design, not a general pattern — but instructive | Confirms the *idea* (balance as a hard invariant) is sound engineering, even though the *mechanism* (a bespoke financial-transactions database) isn't something we'd adopt wholesale, consistent with the task's instruction not to import another system's architecture | ADOPT the principle (already have it via 8.1's trigger); DELIBERATELY SKIP the engine |
| 8.3 | **TigerBeetle's idempotency mechanism — client-generated 128-bit id, primary-key uniqueness, retry-with-same-id returns `exists` rather than erroring — is the exact pattern our own bible §4.2 rule 10 already specifies** (UNIQUE constraint as the idempotency key) | TigerBeetle — `docs/coding/reliable-transaction-submission.md:9-38` | Common wherever idempotent retry matters, described unusually explicitly here | Independent, external validation of an already-made decision | ADOPT (already decided) |
| 8.4 | **Our unsigned debit/unsigned-credit column pair (mutually exclusive via CHECK) is the commercial-ERP convention (matches ERPNext's `debit`/`credit` fields on `GL Entry`, and SAP/NetSuite generally) — NOT what Beancount, hledger, LedgerSMB, or GnuCash do.** All four of those store **one signed amount per posting line**; direction is implicit in the sign plus the account's normal balance | Beancount `core/data.py:206-269`; hledger `Types.hs:519-573`; LedgerSMB `acc_trans.amount`, `sql/Pg-database.sql:1123-1148`; GnuCash `Split` | **A genuine fork in the field between two legitimate conventions** — commercial-ERP style (unsigned pair) vs. plain-text/PostgreSQL-hobbyist style (signed single amount) — not a case of one being right and one being naive | Not a defect — the unsigned pair makes "which side is this line on" a directly checkable column rather than something requiring knowledge of the account's normal balance to interpret, which matters more in a system many people query directly (reports, ETL, audits) than in a single-maintainer plain-text ledger | ADOPT (already decided) — worth one line in `POSTING-PATTERNS.md` noting this was a considered choice against a real alternative, not an accident |
| 8.5 | **hledger supports first-class "virtual" (unbalanced) postings**, explicitly exempt from the balance check, as a documented convenience feature | hledger — `PostingRealness`, `Types.hs:526` | One vendor's deliberate escape hatch | **We have no equivalent and should not build one** — this is exactly the shape of hole that broke our legacy system (§16.0's "trivially balanced single-leg" bug). Worth naming as a negative example: a real, shipped feature in a respected system, that we are correctly not copying | DELIBERATELY SKIP — cite bible §16.1 invariant 1 ("no bypass for convenience... for 'simple' transactions") |
| 8.6 | **TigerBeetle's actual shape (an immutable, append-only `Transfer` log with `Account` balances as continuously and *eagerly* maintained aggregates over that log) resembles event sourcing's "events are truth, state is derived" — but updates aggregates synchronously on write, not via CQRS's typical deferred/eventually-consistent read-model rebuild** | TigerBeetle | One system's design, informative rather than standard | **This is close to, and arguably validates, our own append-only-ledger-plus-materialized-summary-refreshed-in-the-same-transaction model (§4.2 rule 7, §15.10) — not a counter-argument to it.** Nothing found in this research challenges the event-sourcing/CQRS rejection (bible §13 row 22) | DELIBERATELY SKIP (event sourcing/CQRS) — row 22 stands; if anything, this strengthens it rather than weakening it |

---

## What we have not thought about

Ranked by how expensive it gets to fix later, per §4.2's own logic (schema changes before data
exists are cheap; after, expensive).

1. **We have no period-close routine, and the two systems closest to our own design philosophy
   flatly disagree about what one should be** (§1.1–1.3). ERPNext posts real reversing entries
   that zero P&L into retained earnings before a period can be marked closed. Odoo, historically,
   posts nothing and treats "retained earnings" as a live query — until v19, which **partially
   reversed that** because pure live-computation caused reporting-history instability once prior
   periods could be touched at all, even under a lock-date regime. Our own invariants 2/3 (P&L is
   always a `GROUP BY` over `journal_lines`) put us architecturally on Odoo's side of this split —
   but we have not verified whether our stricter invariant 5 (posted entries are *truly*
   immutable, not merely lock-dated) actually avoids the specific failure mode Odoo hit. This is
   an assumption standing in for a decision, and it needs to become the latter before Phase 1's
   close routine is designed.

2. **Nothing makes subledger-to-control-account reconciliation a hard precondition of closing a
   period.** Invariant 6 says "checked continuously," but ERPNext hard-blocks its period close on
   exactly this kind of mismatch (§1.6, §4.4). This is a small, concrete, low-risk addition that
   is currently missing.

3. **There is no rule for where a correcting entry lands when the original error was in an
   already-closed period.** We have "posted is immutable, corrections are reversals" and "closed
   periods reject postings" — but nothing connecting the two once a period *has* closed and an
   error is found in it later. This will happen within weeks of go-live, not in some hypothetical
   future, and the materiality-based IAS 8 / ASC 250 distinction (§1.12, §7.4) is the standard
   framework to adapt, not invent from scratch.

4. **The AP/AR "subledger" has not been decided as a physical shape.** COA-ALIGNMENT.md commits
   to "control account + subledger" without saying whether the subledger is a genuinely separate
   table (implying continuous reconciliation against invariant 6, the heavier and more traditional
   design) or a `party_id`/`counterparty_id` column directly on `journal_lines` (making
   reconciliation structurally unnecessary, matching both ERPNext's and iDempiere's actual
   implementation, and matching our own §4.2 rule 7 philosophy). This is a real Phase 1 schema
   fork, currently undecided, and retrofitting it after AP/AR data exists is exactly the kind of
   change §4.2 warns is expensive after the fact (§4.1–4.2).

5. **§16.11's "same transaction, no overnight job" doesn't distinguish an original stock movement
   from a correction to already-posted valuation history.** No system studied — including
   ERPNext — attempts synchronous same-transaction reposting of a backdated correction; the
   downstream blast radius is unbounded by nature. As written, the bible line could be read as
   demanding something no comparable system does at scale. This needs a scope clarification, not
   a reversal (§2.3).

6. **Negative-stock policy for Phase 3 has not been decided**, and it's a real fork with two
   legitimate, differently-costed answers (reject vs. allow-and-provisionally-value-then-correct),
   not a default either way. Given POS cannot block a sale on an inventory check, this deserves
   its own worked example and probably its own ADR (§2.4).

7. **Concurrent-receipt locking for the weighted-average recompute has no stated design.** Every
   system studied serializes this per item+location because the math is sequential by nature —
   two simultaneous commissary receipts of the same item will silently corrupt the running average
   without an explicit lock (§2.2).

8. **Invariant 5's "checked continuously" language is stricter than anything any reference system
   actually achieves for the inventory-control-to-valuation tie-out**, and probably stricter than
   is buildable without serializing stock movements against GL reads. The honest target is a fast,
   frequent, automated reconciliation query — not a live cross-domain constraint (§2.8). Worth
   recalibrating the language so nobody spends effort trying to build the stricter version.

9. **Theoretical-vs-actual food cost variance — the bible's own stated "single most important
   margin signal" for the unli product — currently has no owner in any phase.** It doesn't need
   new GL accounts (5300/5400 are already correctly shaped, §2.7); it needs a recipe/BOM costing
   engine and a variance report. Not currently named in `CAPABILITY-GAPS.md`; worth adding as a
   nice-to-have alongside the already-deferred smart-reorder item.

---

## Where we diverge, and whether that is deliberate

| Divergence from common practice | Recorded decision? | Assessment after this research |
|---|---|---|
| Exact-to-the-cent balance enforced by a real Postgres `CONSTRAINT TRIGGER DEFERRABLE`, no tolerance, no absorption account, no bypass | **Yes** — §16.1 invariant 1, §13 row 65 | **Stronger than every comparable system studied, including the one PostgreSQL-native peer (LedgerSMB), which only audits for imbalance after the fact.** This research is a point in favor, not a reason to reconsider (§8.1) |
| Header + N lines, not a strict two-account-per-transfer model (TigerBeetle) or a single line table shared across GL/AR/AP (LedgerSMB) | **Yes** — §16.3, row 27 | Correct to keep. TigerBeetle's constraint is a database-engine property we don't share; LedgerSMB's shared table is a decades-old legacy-migration artifact of theirs, not a pattern worth emulating (§8.4 for the related unsigned-pair note) |
| Two fixed dimensions (`store_id`, `channel_id`), explicitly no dimension framework | **Yes** — §16.4, row 44 | **More strongly validated than the bible itself claims** — our stated reference system (ERPNext) ships exactly this shape by default and only goes dynamic, at real schema-mutation cost, beyond it (§5.1–5.2) |
| Single company, `organizations` table reserved but inactive; no true multi-company tenancy | **Yes** — OPEN-DECISIONS.md item 5 | Validated by §3.1: the "inter-company" tooling in both flagship open-source ERPs assumes separate legal entities and is genuinely the wrong reference for a same-entity, multi-store business. Building toward it would be importing generality this business does not have |
| Event sourcing / CQRS rejected in favor of plain append-only ledgers with compensating entries | **Yes** — §13 row 22, §15.10 | Nothing found challenges this. TigerBeetle's actual shape — the closest thing to a counter-example — turns out to resemble our own already-chosen model (eager, same-transaction aggregate maintenance) more than it resembles CQRS's deferred read-model rebuild (§8.6) |
| No period-close routine of any kind | **Not decided — a genuine gap**, not a recorded omission | This is the one item on this list that isn't a documented divergence at all. It needs to become one — see "What we have not thought about" §1–2 |
| No rule for prior-period restatement after close | **Not decided — a genuine gap** | Same status as above — see §3 |
| AP/AR subledger's physical shape (separate table vs. column-on-journal_lines) | **Not decided — genuinely open**, COA-ALIGNMENT.md deliberately leaves it unspecified rather than silently assuming one | Needs a decision before Phase 1 DDL, not after |
| §16.11's same-transaction posting rule doesn't distinguish forward postings from backdated corrections | Ambiguous reading of an existing decision, not a new one | Needs a scope clarification, likely a one-line bible amendment, not a reversal |
| Negative-stock handling for Phase 3 | **Not decided** — Phase 3 detail design hasn't started | Real fork identified by this research (§2.4), needs its own ADR before Phase 3 posting patterns are written |

**Not re-raised, and why:** VAT-engine rejection (row 75) and the no-dimension-framework decision
(row 44, revisited above only to confirm it, not to challenge it) were both explicitly checked
against this research and found *more* supported by it, not less. No finding in any of the four
research passes suggested either should be reconsidered.

---

## The three things for the planner

1. **Pick a period-close philosophy before Phase 1's close routine is designed — this is not
   optional detail, it's an open fork with two live, contradictory precedents from the systems
   closest to our own shape.** Either closing posts a real entry zeroing P&L into 3300 Retained
   Earnings (ERPNext's model), or Retained Earnings stays a live query forever (Odoo's model,
   which Odoo itself partially retreated from in v19 for reporting-history reasons we haven't
   independently ruled out for ourselves). Whichever is chosen, steal ERPNext's "period cannot
   close unless every subledger reconciles to its control account first" gate regardless — that
   part is a clean, low-risk win either way, and we don't currently have it.

2. **The `CONSTRAINT TRIGGER DEFERRABLE` balance enforcement (row 65) is not merely adequate — it
   is stricter than every comparable open-source system studied, including the one built
   specifically to be database-enforced.** Do not let a future "but nobody else does it this way"
   argument weaken it; nobody else doing it this way is the finding, not a warning sign.

3. **Two genuinely open schema questions need an answer before Phase 1 DDL is cut, not after**:
   whether the AP/AR subledger is a separate table or a counterparty column on `journal_lines`
   (both ERPNext and iDempiere use the latter, making reconciliation structurally unnecessary
   rather than continuously checked), and how weighted-average recomputation gets locked per
   item+location for Phase 3 (every system studied treats this as a hard concurrency requirement,
   not an implementation detail). Both are cheap to decide now and expensive to change once data
   exists.
