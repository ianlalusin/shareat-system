# Migration wizards — what accounting-system conversions actually do, checked against T-134

**Date:** 2026-08-25
**Method:** Source read directly for the two open-source systems: **frappe/frappe** (the onboarding-
checklist framework itself, `develop` branch) and **frappe/erpnext** (`develop` branch) — reused and
extended from the pins already established in discovery 17/19; **odoo/odoo** (`18.0` branch, `account`
and `onboarding` addons), fetched fresh this session via `gh api .../contents/<path>?ref=<branch> -H
"Accept: application/vnd.github.raw"` and `gh search code`, exact paths and line numbers cited below.
**Xero, QuickBooks Online, Wave, and FreeAgent are closed-source** — cited by URL to vendor
documentation and, where the vendor's own Salesforce-rendered help center blocked fetching, to
independent step-by-step guides that quote the vendor flow directly (noted per citation). Practitioner
and failure-literature sources (Panorama, Ramp, TinyTax, Definian, Moxo) are cited by URL and used only
for the "what goes wrong" and "rehearsal practice" questions, never for how a specific product's UI
behaves.

**Read first, honored throughout:** `docs/RULES.md` §3.6 (research informs, never decides);
`PROJECT_BIBLE.md` §1.1 (the midpoint — v1's laxity, ERPNext's rigour, neither's generality);
`docs/discovery/17-industry-erp-patterns.md` and `19-b2b-order-to-cash.md` (the format and citation
standard this document matches, not re-litigated); `docs/tasks/134-cutover-wizard.md` (the provisional
draft this document corrects — **written before this research, which was a process error**, per its
own status line); `docs/decisions/ADR-005-books-first-cutover.md` (both the original and the
2026-08-24 balance-forward amendment); `ADR-007-pilot-then-purge.md`; `ADR-009-cost-is-the-spine.md`;
`docs/DEFECTS-REGISTER.md` (DEF-044, DEF-051, DEF-052 — cited where they inform the verify-vs-tick
question); `docs/reviews/v1-audit-2026-08-24.md` and `docs/reviews/cutover-purge-2026-08-24.md` (the
artifacts the wizard would actually be pointed at).

**The framing correction this research exists to make, stated once up front:** T-134's own language —
"wizard," "progress bar," "guide" — reads like a SaaS onboarding checklist. Its actual step table
(clear the backlog, run depreciation, count stock, purge, post one opening entry, check 3900, tie the
trial balance) is not that at all. It is an accounting **conversion**, in the specific, named sense
Xero and Odoo both use that word for. That distinction matters because the two things behave
differently in every system studied: an onboarding checklist is a permissive, skippable, mostly
self-attested tour; a conversion is a small, tightly-scoped, largely single-screen data-entry act with
one real correctness gate (does the trial balance tie) at the end. **The draft's substance is already
shaped like the second thing. Its vocabulary should catch up, and a few of its mechanics should be
pared back to match — not made more elaborate.**

---

## 1. Opening-balance entry — one screen or many, per-account or per-party, how the tie-out is surfaced

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 1.1 | **One opening journal entry per company** (`account_opening_move_id`, a single `account.move`), edited through **one screen**: a list view of every account with `opening_debit`/`opening_credit`/`opening_balance` as editable columns directly on the account row | Odoo — `addons/account/models/company.py:165-166` (the field); `addons/account/models/account_account.py:131-134` (the three computed/inverse fields), `:575-602` (`_compute_opening_debit_credit`, reads straight off `account_move_line` for `company.account_opening_move_id`), `:681-710` (`_set_opening_debit`/`_set_opening_credit`/`_set_opening_debit_credit`) | Odoo's own shipped, default mechanism — one vendor, but a real, working implementation, not a doc description | **A second real system independently arrived at ADR-005's exact shape**: one journal entry, one screen, per-account, dated at the cutover boundary | ADOPT (already decided) — now corroborated by source, not only by first-principles accounting guidance |
| 1.2 | **Xero's "Conversion Balances" is likewise one screen** (Accounting → Advanced → Conversion Balances), per-account, entered from the prior system's trial balance — but **AR/AP is explicitly carved OUT of that screen** and must be entered as individual outstanding invoices/bills in a separate step: *"Entering just a total for your debtors or creditors is not sufficient... enter each outstanding invoice and bill individually so that Xero can match them against future payments and receipts"* | [Xero conversion-balances guide, via fastlane-global.com](https://fastlane-global.com/hk/blog/how-to-enter-conversion-balances-in-xero/) ("Step 3: Enter Historical Invoices or Bills"); independently, QuickBooks Online: *"the recommended practice is to enter individual unpaid invoices and bills rather than a lump sum"* (search synthesis of [Intuit's own opening-balance help articles](https://quickbooks.intuit.com/learn-support/en-us/help-article/journal-entries/enter-opening-balance-quickbooks-online/L4l3NZSMR_US_en_US)) | **Genuinely the norm across the two largest cloud accounting platforms** — not one vendor's idiosyncrasy | **Directly conflicts with ADR-005's 2026-08-24 amendment** (lump balance per party, dated 1 Jan, allocation left to Ian's spreadsheet) | **DO NOT RECONSIDER** — Ian's amendment already weighs this exact tradeoff by name ("we can always use the simplest cleanest approach... leave it to me — I'll handle it manually in the spreadsheet"). Recorded here so the divergence from the two market leaders reads as a considered, documented choice, not an oversight — see §"Where we diverge" |
| 1.3 | **An unbalanced conversion is auto-plugged into a suspense/equity account, not blocked** — three independent implementations: Xero posts the difference to an account literally called **"Ask My Accountant"**; Odoo auto-generates an **"Automatic Balancing Line"** against `get_unaffected_earnings_account()` inside `_update_opening_move` (`company.py:785-870`, the `balancing_account` block at `:846-847`); GnuCash force-posts into an auto-created `Imbalance-<currency>` account (already found, discovery 17 §8.1) | [Xero conversion-balances FAQ, via outbooks.co.uk](https://outbooks.co.uk/training-and-support/bookkeeping-vat-return/conversion-balance-in-xero/): *"If your total debits do not equal total credits, Xero will automatically post the difference to an account called 'Ask My Accountant'"*; Odoo — company.py above; GnuCash — discovery 17 §8.1 | **Three independent systems, genuinely the majority commercial-software behavior** — auto-plug-on-save is closer to the norm than the halt ADR-005 already chose | ADR-005 and research §7.2 already explicitly reject auto-plugging: *"a residual balance means the migration did not balance... never a formality to clear... halts and is investigated."* This finding sharpens WHY the divergence is safe, not just asserts that it is | **DELIBERATELY SKIP the auto-plug, ADOPT the halt** — but the reasoning is **scale, not diligence**: auto-plugging exists because Xero/Odoo/GnuCash serve millions of self-serve tenants who cannot get a human's attention for every mismatch. A single, once-only, four-store cutover with Ian personally available to investigate has none of that constraint. This is the most consequential single finding in this document — see the report's lead |
| 1.4 | **The opening entry is a mutable draft, not immutable-on-save, until an explicit later lock**: Xero *"posts a new conversion journal every time you click Save. Any previous conversion journal is automatically reversed and replaced with the new one"* (fastlane-global.com, "Note"); Odoo refuses to touch `account_opening_move_id` once `state != 'draft'` — *"You cannot import the 'opening_balance' if the opening move... is already posted. If you are absolutely sure you want to modify... reset the move to draft"* (`company.py:797-800`) | Same two sources | Consistent across both dedicated conversion tools studied | **Conflicts with our invariant 5 (posted = truly immutable, corrections are reversals) if applied naively to C3.** Both vendors instead treat the opening entry specifically as a special still-draft document during the whole entry window, distinct from their own normal steady-state immutability | ADAPT — C3 (enter opening balances) should be an unposted `journal_entries` draft, editable in place across the whole entry window; only the final POST, gated by C4/C5 passing, makes it immutable under invariant 5. This scopes invariant 5's start point rather than weakening it — the same distinction discovery 17 §2.3 already drew between an original movement and a correction to history. **This is one of the three decisions for the planner, below** |
| 1.5 | **ERPNext has no dedicated opening-balance screen for the general ledger at all.** AR/AP goes through the "Opening Invoice Creation Tool" — bulk-creates real Sales/Purchase Invoices flagged `is_opening="Yes"`, one row per **invoice** (per party, at invoice level, never lump), posting to a `Temporary` typed account (`erpnext/accounts/doctype/opening_invoice_creation_tool/opening_invoice_creation_tool.py:256-259` `make_invoices`, `:337` `get_temporary_opening_account`). Every other balance-sheet account's opening figure is an ordinary multi-line **Journal Entry** with `voucher_type="Opening Entry"` (`erpnext/accounts/doctype/journal_entry/journal_entry.py:123-124,147-154`), gated only against landing in an already-closed period via `validate_opening_entry_against_pcv` (`:31`, `:154`) — no per-account list, no dedicated UI | ERPNext, both files above | ERPNext is the outlier among the three systems read at source level — the two purpose-built cloud products (Xero, Odoo) both ship a dedicated screen; ERPNext reuses its fully generic Journal Entry document, true to discovery 17's finding that it is "enterprise-general" | Reinforces that the dedicated single-screen shape (Odoo's, Xero's, and ADR-005's own) is the leaner, better-fit design at our scale. ERPNext's genericism here is not something to emulate | DELIBERATELY SKIP ERPNext's generic-journal-entry approach to the GL side; ADOPT the dedicated-screen shape already decided |
| 1.6 | **Both dedicated tools compute and display a live summary of what has already been entered, next to the entry form** — Odoo recomputes `opening_debit`/`opening_credit` straight from `account_move_line` on every read (1.1's `_compute_opening_debit_credit`); ERPNext's tool computes a per-company, per-doctype outstanding summary the same way (`opening_invoice_creation_tool.py:45` `get_opening_invoice_summary`, grouping live `frappe.get_all(doctype, filters=dict(is_opening="Yes", docstatus=1)...)` results, never a hand-maintained tally) | Both, cited above | Independent in both systems studied | **This is exactly the mechanism T-134 already specifies for "show the user what is needed"** — a derived gap list, not a static checklist — and it is real, working prior art, not an invented pattern | ADOPT (already decided in the draft) — now corroborated, not merely argued |

---

## 2. "What is still missing" — derived from data, or a maintained list?

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 2.1 | **One step in Odoo's accounting onboarding is marked done by reading real ledger state, never by a click**: `action_open_step_chart_of_accounts` calls `company.opening_move_posted()` before deciding what to show, and that function is a plain boolean read of the move's actual state — `bool(self.account_opening_move_id) and self.account_opening_move_id.state == 'posted'` (`addons/account/models/company.py:749-751`), invoked from `addons/account/models/onboarding_onboarding_step.py:80,86` | Odoo | One example, but the one self-contained, fully derived completion check found across both frameworks read this session | This is the concrete precedent for T-134's "3900 nets to zero" style ✅-verified step: read the actual ledger state, never a flag. Same shape, smaller scope (does a posted move exist) than ours (does 3900 net to zero) | ADOPT — cite as the working precedent for the design principle, not an invented one |
| 2.2 | **Everywhere else in the SAME framework, completion is a plain click**, recorded by client JS as a Check field with no data read behind it at all: `is_complete`/`is_skipped` on ERPNext's generic `Onboarding Step` doctype (`frappe/desk/doctype/onboarding_step/onboarding_step.py`, auto-generated type stub lines 30, 32) are set directly by `mark_complete()` (`frappe/public/js/frappe/widgets/onboarding_widget.js:450-461`) for five of its six action types (Watch Video, Show Form Tour, Go to Page, View Report, and — critically — **Create Entry**, whose completion fires on doc save/submit succeeding, not on any later re-check that the entry still exists or is correct). The lone exception, "Update Settings," re-reads one field after save and string/percent-matches it against `value_to_validate` (`onboarding_widget.js:298-301`) before allowing completion | ERPNext / frappe framework | This is ERPNext's own general-purpose onboarding-checklist engine, used product-wide, not accounting-specific | Directly calibrates how far "derived, not ticked" goes in the field: **one narrow field-match, out of six action types, in the one system that has any check at all.** Feeds the central-claims verdict below | Informational — see §"The draft's two central claims" |
| 2.3 | **Practitioner literature treats the trial-balance comparison as a manual, cross-system act a person must run** — *"Compare trial balance totals, aged receivables and payables reports, and bank reconciliation summaries between the old and new systems... Investigate and resolve any discrepancies before the final cutover. Even small variances can signal mapping errors that affect multiple records"* | [Ramp, Accounting Data Migration: Steps, Strategies & Tools](https://ramp.com/blog/accounting-data-migration) | Common guidance, not tied to a vendor | `docs/reviews/v1-audit-2026-08-24.md` **already is this comparison**, computed mechanically ahead of time (per-supplier AP, per-account cash, all four stores) rather than reconciled by hand after entry | ADOPT (already built) — worth stating plainly that the audit report already exceeds documented common practice, which still assumes a human runs two reports side by side |

---

## 3. Verify vs. self-attest — the draft's first central claim, checked against the field

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 3.1 | Restated from 2.2: **real, data-checked verification exists for one of six step-action types**, and even that check is a single-field string/percent match after one save — not a query over a dataset | ERPNext/frappe, `onboarding_widget.js:298-301` | ERPNext's own general framework, the most "checklist-like" tool studied | Verification is real prior art. It is also, even in the system with the most machinery for it, the rare exception rather than the rule | Feeds the verdict below |
| 3.2 | **Odoo's default completion path requires no check at all** — `action_set_just_done()` is the generic, always-available "mark as done," called directly by a button click (`addons/onboarding/models/onboarding_onboarding_step.py`). Of the eight accounting-onboarding steps read in `addons/account/models/onboarding_onboarding_step.py`, only **two** override this with a real precondition before calling `action_validate_step`: chart-of-accounts/opening-move (`:80-89`, gated on `opening_move_posted()`) and document layout (`:37-44`, gated on `self.env.company.external_report_layout_id`). The other six — company data, bank account, create-first-invoice, fiscal year, sales tax, base document layout's own button — mark done because a wizard closed or a button was clicked, not because anything was checked | Odoo | Odoo's own shipped accounting onboarding | Two of eight, in the system that tries hardest. Confirms verification is deployed at a small number of deliberately chosen high-value points, never as a blanket policy | Feeds the verdict below |
| 3.3 | **Where systems genuinely DO hard-verify without exception is the close/cutover gate itself, never the setup checklist that precedes it** — already established: ERPNext blocks period close on stock-to-GL mismatch (discovery 17 §1.6); all three systems with a real close gate block on any unposted/draft document in the period (17 §1.9) | ERPNext, Tryton, LedgerSMB — discovery 17, not re-fetched this session | Common wherever a real close gate exists | **This is the distinction the draft doesn't quite draw.** "Verify" belongs at the few gates that actually decide whether the cutover may proceed — matching exactly where every mature system studied puts its real enforcement — not spread thinly across every checklist row | ADAPT the draft's claim — narrow it, see verdict |
| 3.4 | **Physical, human events cannot be verified by any system studied either.** ERPNext's own `Stock Reconciliation` with `purpose = "Opening Stock"` (`erpnext/stock/doctype/stock_reconciliation/stock_reconciliation.py:57`) still requires a human-typed quantity per item; nothing confirms anyone walked the floor. A variance is only computable once **both** a system-expected figure and a human count exist (`calculate_difference_amount`, `:694-707`) | ERPNext | Universal absence — not one system studied claims otherwise | Confirms the draft's own "Attested" category is the correct, and the only available, treatment for B1/B2. Building toward "verifying" a physical count would invent a control that exists nowhere in the field | ADOPT (already decided) — the draft's three-kind-of-step split already matches the field's real limit; it does not exceed it |

---

## 4. Ordering and prerequisites — the draft's second central claim, checked against the field

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 4.1 | Xero's only encountered example of enforced sequence is **four numbered steps during initial setup** (Set conversion date → Enter conversion balances → Enter historical invoices/bills → Post balances) — presented in order, but the identical screen is reachable and freely re-editable "at any time" after setup finishes, with no dependency check found | [fastlane-global.com](https://fastlane-global.com/hk/blog/how-to-enter-conversion-balances-in-xero/), "Entering Conversion Balances: The Four Key Steps" and "How to Manually Enter Conversion Balances... at any time" | One vendor's onboarding-flow UI convention | Order is a first-run suggestion, not a system-enforced gate, even in the system most explicitly structured around sequential steps | Feeds the verdict below |
| 4.2 | ERPNext's onboarding UI opens on the **first incomplete step** (`onboarding_widget.js:36-42`, `findIndex` over `!is_skipped && !is_complete`) as a default starting point — every other step stays independently clickable and completable out of order, and a **Skip** affordance exists on every incomplete step | ERPNext/frappe | Its own default | Same conclusion as 4.1 from a second system | Feeds the verdict below |
| 4.3 | Odoo has **no ordering check located anywhere** in `onboarding.onboarding.step`/`onboarding.onboarding` — `action_validate_step` is called per-step, independently, with no read of any other step's state in either file examined this session | Odoo — `addons/onboarding/models/onboarding_onboarding_step.py`, `addons/account/models/onboarding_onboarding_step.py`, both read in full | Its own default | Third system, same conclusion | Feeds the verdict below |
| 4.4 | Hard sequence enforcement in the systems studied lives in the **close/reopen chain**, never the setup checklist — discovery 17 §1.10 ("reopen is always sequential and asymmetric") and §1.6 (close blocked on subledger mismatch). The pattern across every system that gates anything hard: gate the transition where getting it wrong silently corrupts a downstream number; leave everything else open | ERPNext, Tryton, LedgerSMB — discovery 17 | Common wherever a real gate exists at all | **This exactly parallels ADR-009's own finding**: counting stock before clearing the December expensing backlog silently prices the newest — and only — stock at no cost, a mistake ADR-009 itself says *"nobody would have found... by reasoning about it"* | Directly informs the verdict below — the shape of gate to keep is named, not generic |

---

## 5. The physical-world problem — a count that happens outside the software

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 5.1 | **An opening stock count's residual posts to an Asset/Liability account, never P&L** — enforced specifically for `purpose = "Opening Stock"` via a dedicated exception class: *"Difference Account must be an Asset/Liability type account, since this Stock Reconciliation is an Opening Entry"* (`stock_reconciliation.py:1104-1111`, `OpeningEntryAccountError` at `:27-28`). An ordinary (non-opening) reconciliation's variance posts to a P&L stock-adjustment account instead — already ADOPTed in discovery 17 §2.6 | ERPNext | A real, coded distinction in our own stated reference system between "variance against nothing" (opening) and "variance against known history" (ongoing) | **Directly answers ADR-009's own open question 3** about whether opening-count variance is a P&L item: by this precedent, it should not be — it belongs against equity/opening-balance-equity, matching ADR-009 §3's own framing ("the count's job... verify a computed value") | ADD — one explicit line in whichever spec replaces T-134 for B3/C3: opening-count variance posts against 3900 (or a dedicated opening-inventory suspense line under it), never against 5400 |
| 5.2 | No system studied has any mechanism confirming a physical count actually happened, beyond a human typing a number | All systems studied | Universal absence | Same conclusion as 3.4 | Nothing to add — the draft's Attested treatment is already correct and sufficient |

---

## 6. Resumability and multi-user

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 6.1 | **Onboarding progress is a plain, server-persisted row keyed by (procedure, company)**, not session or browser state — `onboarding.progress` has `company_id`, a unique index on `(onboarding_id, COALESCE(company_id, 0))` (`addons/onboarding/models/onboarding_progress.py`, `init()`), and survives logins/devices by construction because it is just a database row | Odoo | Odoo's default architecture, not a bolt-on | **Directly matches T-134's per-store attestation model** (four stores ≈ four "companies" in this narrow sense) and its "resumable across weeks" requirement. The mechanism needed is an ordinary row per (step, store), nothing more | ADOPT the shape (persisted per-store status rows); DELIBERATELY SKIP any real-time/multi-user-presence layer — nothing in either reference system has one, and four stores and a handful of managers don't need one either |
| 6.2 | Practitioner guidance names **documentation, not tooling, as what carries a multi-week migration across handoffs** — *"thorough records covering your migration plan, any challenges encountered, and how they were resolved"* — and describes no checkpoint/resume mechanism beyond keeping good notes | [Ramp, Accounting Data Migration](https://ramp.com/blog/accounting-data-migration) | Common guidance | Reinforces that "resumable" is satisfied by ordinary persistence (a step's state and who recorded it survive between sessions); no additional resumability engineering is implied anywhere in the field | ADOPT the minimal reading — a persisted status row per step is sufficient |

---

## 7. Rehearsal / dry run

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 7.1 | **A "mock cutover"/"dress rehearsal" run, with the same data, tools, people, and timing as the real cutover, ideally more than once**, timed to the literal clock the real event will use — *"If a go-live cutover task is expected to happen at 3 AM on a Saturday, that same activity needs to have resources at-the-ready to execute the plan at 3 AM on dress rehearsal Saturday."* One cited case: three mock runs reduced go-live downtime 30% | [Definian, Why a Dress Rehearsal Matters for Data Migration](https://www.definian.com/articles/dress-rehearsal); corroborating roundup at [Moxo, ERP go-live checklist](https://www.moxo.com/blog/erp-go-live-planning) | Named, standard ERP-implementation practice, not one vendor's opinion | Directly validates **ADR-007's November rehearsal**, run against a restored copy, as matching documented best practice rather than an invented precaution | ADOPT (already decided, ADR-007) — now corroborated by named industry practice, not only argued from first principles |
| 7.2 | A **smaller, earlier dry run** — *"test the process with a small subset of your data first... compare the results to the source system"* — distinct from, and preceding, the full rehearsal | [Ramp, Accounting Data Migration](https://ramp.com/blog/accounting-data-migration) | Common guidance | ADR-005's own **30 Sep "Full backup + ETL Stage 1 dry run"** already IS this lighter, earlier step, ahead of the November full rehearsal — a genuine two-stage shape, not a redundant extra one | ADOPT (already decided, ADR-005) — corroborated as the correct two-stage shape |
| 7.3 | **No system studied — ERPNext, Odoo, or any of the closed vendors documented — ships a "rehearsal mode" toggle inside the live product.** Every rehearsal/dry-run practice found is achieved by running the real software against an **isolated copy** of the data (a sandbox company, a restored database, a test tenant), never by a flag inside a shared system marking some actions as "not real" | Absence, checked across all sources read this session | Universal absence | **Directly validates, and extends, ADR-007 §1's own decision** ("the table is the mark, there is no per-row flag") one level up: the rehearsal itself should be isolation-by-database, exactly as ADR-007 already specifies, not a mode flag inside the wizard | DELIBERATELY SKIP the REHEARSAL flag on attestation rows T-134 currently proposes — see decision 2 below |

---

## 8. What actually goes wrong in real conversions

| # | The finding | Evidence | Relevance to us |
|---|---|---|---|
| 8.1 | **~83% of data migration plans fail or run over budget**, root causes tracing to "inaccurate transfers, system mismatches, or limited testing" | [Ramp, Accounting Data Migration](https://ramp.com/blog/accounting-data-migration) | A second, independent figure alongside discovery 17 §7.3's Panorama statistic (~32% of ERP implementations finish on schedule). Different methodology, same magnitude, same message: schedule and scope discipline predicts outcome more than tooling sophistication. ADOPT (already decided via ADR-005's honesty checkpoints) — a second citation, not a new requirement |
| 8.2 | **An unreconciled opening balance is invisible, not merely wrong** — if it doesn't tie to the prior system's close, "every financial report produced in the new system will be wrong — and the discrepancy will be invisible until a bookkeeper specifically looks for it" | [TinyTax, Opening Balance When Switching Bookkeeping Software](https://tinytax.co.uk/guides/opening-balance-new-bookkeeping) | The single strongest argument, from outside this project, for treating C5 (trial balance ties) as a hard, machine-checked gate specifically — not a general argument for verifying everything, a specific one for verifying this |
| 8.3 | **Named, common failure mode: double-counting AR/AP** when a lump opening figure and individually-entered post-cutover documents both restate the same pre-cutover money movement — *"if you have entered an amount for AR in Opening Balance and you also need to import/create invoices for the amount... you will end up in double counting"* | Search synthesis of QuickBooks/Zoho community threads on non-zero Opening Balance Equity, [Zoho Books opening-balance FAQ](https://www.zoho.com/uk/books/kb/opening-balance/difference-in-ob.html) family | A concrete, named risk against ADR-005's own lump-sum-per-party design — not a reason to reverse it, but a specific thing worth naming explicitly in whichever spec implements C3, so it is guarded by naming rather than avoided by luck |
| 8.4 | **Partial transfers are among the most common migration mistakes found in financial audits**, specifically calling out ensuring "every bank account is fully reconciled up to the migration date" as a distinct, easily-skipped step | Search synthesis of migration-checklist guidance (Ramp, receipt-bot.com) | Cash/bank reconciliation-to-date is not named as its own gate anywhere in T-134's Phase A/B table — it is implicit inside A3 (export, Attested) but not called out. Cheap to add explicitly, same shape as A1 |

---

## What NOT to adopt

A pass that recommends everything it read has not done its job. Five things read this session are
real, working, and wrong for this project:

1. **The generic onboarding-step *framework*** — a reusable step-type registry (Create Entry / Update
   Settings / Show Form Tour / View Report / Go to Page), video/tour content, and Odoo's
   `is_per_company` progress-merge machinery. This is infrastructure built for a product used by
   thousands of self-configuring tenants, run continuously. T-134 runs, at most, twice, for one
   company. **Hardcode the ~15 steps as a plain table.** Building a step-type engine for a two-run
   procedure is importing generality bible §1.1 already says this project has none of.

2. **Auto-plug-to-suspense on imbalance** (Xero's "Ask My Accountant," Odoo's automatic balancing
   line, GnuCash's `Imbalance-<currency>`) — see §1.3. Real, majority, and a scale-driven convenience
   this project should not copy.

3. **CSV bulk-import of the opening chart of accounts.** Xero, Odoo, and (by inference) ERPNext's
   Chart of Accounts Importer all ship one, because their users are creating an unknown chart from
   scratch, often hundreds of accounts. Our chart of accounts is a fixed ~90-account set, already
   seeded and classified **KEEP** by ADR-007 §3 — nothing to import. Building an importer for a
   one-time, ~90-row, mostly-empty opening entry solves a scale problem this project does not have.

4. **Xero's "Comparative Balances" feature** (multi-year prior-period display alongside current-year
   figures). ADR-005 already explicitly declines to load 2026 comparatives as if they were real —
   *"legacy basis, unaudited"*, a spreadsheet artifact. A comparative-balances screen would invite
   exactly the mistake ADR-005 is trying to prevent: someone treating a hand-scanned 2026 figure as
   equivalent to an audited one because it now sits in the same UI as real numbers.

5. **A per-tenant progress-visibility engine.** T-134's own Open Q1 asks who sees what; the field only
   shows this need at real multi-tenant scale (Odoo's `is_per_company` merge logic exists because
   companies are added and removed from a live system continuously). For four stores and effectively
   one admin plus a handful of managers, the draft's own suggested answer — whole wizard read-only,
   own store's attestations editable — is already right-sized. It does not need Odoo's machinery to
   get there; it needs four rows.

---

## The draft's two central claims — verdict

### (a) "A step is complete when the system can see it, not when someone ticked a box"

**Mostly right, as already scoped in the draft — provided it stays scoped that narrowly.** It is not
disproportionate for the handful of true invariants (3900 nets to zero, trial balance ties, purge
post-conditions, restore-tested, every active item has a quantity or an explicit zero): every mature
system studied puts its one real, hard, unbypassable check at exactly this kind of close/cutover gate
(§3.3, discovery 17 §1.6/§1.9), and practitioner literature independently names an unreconciled opening
balance as a silently compounding failure a person has to go looking for (§8.2).

Where the claim would go wrong is if "verify" quietly expanded past that short list. No system studied
verifies more than a small minority of its steps — ERPNext's own general framework verifies 1 of 6
action types (§3.1), Odoo verifies 2 of 8 accounting onboarding steps (§3.2); everything else in both
systems is a click. **Recommendation: keep the three-kind-of-step split exactly as drafted, and hold
the ✅-verified list to the five or six checks it currently names — not fifteen.** Do not add
verification to A3 (export) or attempt to verify B1/B2 (the physical count, the asset walk-round)
themselves; they are correctly Attested, and no reference system does better there (§3.4, §5.2).

### (b) "A step is not startable until its prerequisites verify"

**Too strong as a blanket rule; right for a short, named list.** No system studied hard-blocks a later
checklist step until an earlier one verifies — Xero's four-step flow is presented in order but freely
re-editable afterward (§4.1), ERPNext defaults to the first incomplete step but never locks the others
(§4.2), Odoo has no ordering check at all (§4.3). Applied uniformly across the whole table, "not
startable until prerequisites verify" is stricter than every reference system's setup checklist.

But this project already has a proven, evidenced case where skipping ahead silently produces a wrong
number nobody would catch by reasoning about it: ADR-009's finding that counting stock before clearing
the December expensing backlog prices the newest — and only — stock at no cost. That is exactly the
shape of transition every system studied DOES hard-gate, just never inside a setup wizard — inside
close/reopen chains and period locks (§4.4, discovery 17 §1.10).

**Recommendation: replace the blanket rule with four named hard gates**, each one already argued for
by an existing ADR or defect, not invented for this document:

| Gate | Why it must be hard |
|---|---|
| A1 (backlog cleared) before B1 (count) | ADR-009 — the cost basis is weakest for exactly the stock being valued; the inversion "took counting," nobody would find it by reasoning |
| C2 (purge) before C3 (opening entry) | Entering opening balances into a database still holding pilot data is meaningless, not merely risky |
| C3 (opening entries) before C4 (3900 check) | The check has nothing to check against otherwise |
| C4 (3900 = 0) before C5 (trial balance ties) | Same reason as ADR-005's own stated order |

Everything else in the table — A2/A3 relative to each other, B1/B2 relative to each other, the four
stores' B1/B2/B3 relative to one another — should be free-orderable, matching what every system studied
actually does.

---

## Needed for a four-store single cutover vs. needed if this were a product

| Needed now (four stores, one company, one cutover, done at most twice) | Needed only if this were a product (many tenants, self-serve, continuous) |
|---|---|
| The ~15-item step table itself (the draft's, plus the 5.1 posting-account line and the 8.4 cash-reconciliation line) | A generic, declarative step-type registry (Create Entry / Update Settings / …) |
| A persisted per-step status row — who, when, verified/attested/performed (§6.1) | CSV bulk import of chart of accounts / opening balances (§"What NOT to adopt" #3) |
| The four named hard-ordering gates above — not a general ordering engine | Per-tenant progress isolation and merge-on-config-change logic (Odoo's `is_per_company`) |
| One mutable-until-locked `journal_entries` draft for the opening entry (§1.4) | Guided video/tour content, gamified completion states |
| Per-store attestation as four rows, not a framework (§6.1) | An auto-suspense ("Ask My Accountant") account — only needed when volume exceeds what a human can individually investigate |
| Rehearsal = the same wizard run against ADR-007's restored copy; **no in-wizard flag** (§7.3) | Comparative-balances / multi-year reporting screens |
| The derived gap list sourced from `docs/reviews/v1-audit-*.md` (§1.6, §2.1, §2.3 — already specified, now corroborated) | Configurable, admin-authored step definitions instead of a hardcoded list |

---

## Where we diverge, and whether that is deliberate

| Divergence from common practice | Recorded decision? | Assessment after this research |
|---|---|---|
| Lump-sum-per-party AR/AP opening, vs. Xero/QuickBooks' recommended individual-invoice entry | **Yes** — ADR-005's 2026-08-24 amendment, Ian's explicit call | Checked against the field and found to be the deliberate minority position — both major cloud platforms recommend the opposite. Not an oversight; worth one added caution in the eventual task spec: name the double-counting failure mode from §8.3 explicitly so it's guarded, not merely avoided by luck |
| Halt-and-investigate on a 3900 residual, vs. three real systems' auto-plug-to-suspense | **Yes** — ADR-005 + research §7.2 | This research adds a sharper reason than "we're more careful": the divergence is **scale-driven**. Auto-plugging is a self-serve-vendor convenience this project's actual situation (one company, one cutover, Ian personally available) has no need for |
| Hard prerequisite ordering across the whole step table | **Not yet decided as a scoped rule** — T-134's current draft states it as a blanket policy | This research proposes narrowing it to the four named gates above, not abandoning it — see central claim (b) |
| No REHEARSAL flag on attestation rows; isolation by restored database instead | **Not yet stated in T-134**, though ADR-007 §1 already established the identical principle one level up (no per-row pilot-data flag) | Should be made explicit — see decision 2 below |

---

## The three things the planner most needs to decide

1. **Should the four named ordering gates (A1→B1, C2→C3, C3→C4, C4→C5) be the *only* enforced sequence,
   with everything else in the table free-orderable?** **Recommendation: yes.** A blanket ordering rule
   is stricter than every reference system's setup checklist studied (§4), and the evidence for hard
   gates specifically supports these four transitions, not the whole table.

2. **Does the wizard need a `REHEARSAL` flag on attestation rows, given ADR-007 already isolates the
   November rehearsal inside a restored database?** **Recommendation: no — drop it.** A flag repeats
   the exact anti-pattern ADR-007 §1 already rejected for pilot-data rows, for the identical reason: a
   code path that forgets to set it produces a rehearsal attestation indistinguishable from a real one.
   No system studied uses an in-product mode flag for this (§7.3); every one uses an isolated copy,
   which ADR-007 already provides.

3. **Should the opening-balance entry (C3) be a mutable draft, locked only once C4/C5 verify — matching
   how both Xero and Odoo treat their opening entry as editable until an explicit final lock — or must
   it obey invariant 5's normal posted-immutable-forever rule from the first figure typed?**
   **Recommendation: draft until locked.** This matches §1.4's finding, and matches the project's own
   existing draft-first posting discipline (`postEntry`, DEF-031/T-105). Treating every keystroke as a
   permanent posting would force a formal reversal for correcting an ordinary typo in a document that
   was never actually final — ceremony the entry window doesn't need and no reference system imposes.
