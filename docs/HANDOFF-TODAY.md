# Handoff — 2026-09-05

## Where things stand

Phase 6 (reporting & dashboards) is well underway: T-209a/b/c (balance sheet, AR/AP
aging, cash flow), T-210 (sales reporting over the ledger) and T-213 (OIL wave 2 — eight
new integrity detectors) are all shipped today. T-211 (manager/owner dashboard) and T-217
(shell hardening + PIN issuance) are in active, uncommitted progress in this same shared
tree as this handoff is written. T-157's golden-master attendance test was diagnosed and
mostly closed (55 of 57 divergences explained as corpus config-drift, not an engine bug;
3 residual items remain, none known to affect pay). A bible amendment (§3.6) extended the
no-hand-maintained-counter rule to dashboard tiles, directly relevant to T-211.

## Gates at `b5c2f9d`

- **typecheck**: clean
- **unit**: 1012/1014 (1 pre-existing skip, 1 pre-existing known-red — DEF-170's 3
  residual golden-master divergences, tracked, not a regression)
- **integration**: 2309/2309, 91/91 files, real Postgres — up from 2293 (T-213's 16 new
  tests)
- **build**: exit 0, dev server stopped first, smoketested live on 9008 (T-213's
  `/findings` page; T-210's sales-rollup/reconciliation screens against real Malvar data)

⚠️ **Shared-tree caveat**: this is one working directory used by several concurrent
Claude sessions (`ianla-92` — this one, `ianla-15`, and an Opus planner session, all
today). The gate numbers above were measured against the tree as it stood at that
moment, which may have included `ianla-15`'s then-in-progress, uncommitted T-211/T-217
files (`error.tsx`, `not-found.tsx`, `global-error.tsx`, edits to `staff/actions.ts` and
`sessions.ts`) sitting alongside the committed history — not a defect in the run, just
what "one tree, no build/test:integration beside a busy peer" actually means in
practice. The committed history itself (everything through `b5c2f9d`) is what the gates
are really vouching for.

## What happened this session (since the last wrap-up, `4a50781`)

**T-209b/T-209c** — AR/AP aging reconciled to control accounts; cash flow (indirect
method off `v_balance_sheet` deltas), per-store P&L comparison, drill-down to source
entries, and one shared CSV export wired onto all seven report screens shipped so far.

**T-157 golden master, diagnosed** — the 57 untriaged attendance divergences found
capturing the corpus turned out to be 55 real-but-explained: `attendanceConfig` is a
single live, unversioned document per store, so replaying an old session against
*today's* config necessarily disagrees when the config has since changed. Verified by
reading v1's own formula source directly — identical to v2's. **Decision recorded**:
DEF-170 (register) now carries the full diagnosis; Classes H/I added to the golden test
close 55 of 57. **3 residual items still open, low urgency** (2 anchor-mode label
mismatches, 1 real `unallowed`-anchor outlier) — not known to affect pay, not yet
assigned an owner.

**Bible §1.2d** (Ian, direct decision) — discovery now has a binding four-step method:
study v1 at source → write the GOAL down → count the live data → design v2 against that
goal, bar being *more* accurate/correct/effective/efficient, not merely not-flawed.
Recorded in `PROJECT_BIBLE.md` directly by Ian.

**T-210** — sales reporting over the ledger: day/month/store/channel/mode roll-ups (all
three groupings assert to the same total), POS-day ↔ ledger reconciliation reusing
T-177's live-POS-fetch pattern with every outcome (including "not configured") a named
non-throwing state. Smoketested live: sales rollup reconciles exactly on real Malvar
data (₱17,000 across ledger/channel/mode independently); the POS reconciliation screen's
not-configured state renders cleanly.

**T-213** — OIL wave 2, eight new derived read-only findings extending T-135:
`salesDayUnposted`, `expenseCategoryUnpostable`, `expenseInvoiceVoidedAfterLink`,
`receiptPriceSpike`, `newVendorFirstPurchase`, `advanceUnliquidated`,
`usageRecordMissing`, `meatSlabStale`. **Two corrected against the real schema**, not
just the phase-6 plan's one-line sketch: a "missing category" and an "orphan expense"
are both structurally impossible once T-130's `NOT NULL` columns exist — the live
conditions are a draft stuck on an unmapped account, and an invoice voided *after* an
expense already links it (built as insurance against a state the one sanctioned code
path, `voidInvoice`, is designed to prevent — same reasoning as `trialBalanceDrift`).
`advanceUnliquidated` and `usageRecordMissing` were each confirmed non-duplicates of an
existing detector before being added. Smoketested live: two of the eight fired on real
dev data on first load (`usageRecordMissing` on Malvar, `newVendorFirstPurchase` on
Smoketest Commissary), both rendered and bucketed correctly.

**DEF-172 filed** (register) — four pre-existing T-135 detectors
(`cashRequestFloatAgeing`, `supplierCreditAgeing`, `customerCreditAgeing`,
`reimbursablePayableOf`) age a business date against bare `current_date`, which
migration `0112`'s own comment names as a bible violation on a UTC server (up to a full
day's skew during Manila's early morning hours). Found writing T-213's own three
date-comparing detectors, which use the correct `Asia/Manila` conversion from the start.
**Not fixed** — out of scope, logged for a follow-up pass.

**DEF-173 + bible §3.6** (Ian + Opus planner, direct decision) — v1's recipe/cook
production engine has *never actually been run* in production (0 `productionRuns` at
every store, ever, despite T-176 porting the code path). Not removed — costs almost
nothing to keep, shares the slice code path — but nothing further gets built on it until
someone cooks once. Bible §4.2 rule 7 (no hand-maintained counters) is now explicit
that it covers every dashboard tile and operational KPI, not only accounting
statements — directly relevant to T-211, which is where it first bites.

**Roadmap refreshed** — `docs/ROADMAP.html`'s T-210/T-213 rows marked done with their
real final scope, Phase 6's status chips and the masthead gate line updated to the
fresh numbers above.

## Pick up here

1. **T-211 (manager/owner dashboard) and T-217 (shell hardening + PIN issuance)** are
   in progress right now, in this same tree, by `ianla-15` — check with that session
   (or its successor) before touching `apps/erp/src/app/staff/actions.ts`,
   `packages/db/src/repo/sessions.ts`, or the new `error.tsx`/`not-found.tsx`/
   `global-error.tsx` files. Bible §3.6 applies directly: no hand-maintained counter for
   any dashboard tile.
2. **T-212** (commissary/inventory KPIs) is next in the Phase 6 wave after T-211, and
   depends on it per the phase plan's own sequencing.
3. **DEF-172's follow-up** — align the four pre-existing `current_date` detectors in
   `packages/db/src/repo/findings.ts` to the `Asia/Manila` form. Small, self-contained,
   low urgency.

## Do not decide these alone — they are Ian's

- **DEF-063 (PIN sign-in rate limiting)** — deferred 2026-08-25 on the condition "no
  real staff, no real data." Production has been live since T-205 (2026-09-04) and the
  pilot is described as already running — that condition has arguably lapsed.
  Recommendation on the table: reactivate now rather than wait for the Oct pilot.
- **SC/PWD discount ID/name capture and BIR 1601-E withholding tax** — both live
  compliance exposures, neither v1 nor v2 handles either today. No recommendation yet
  beyond "these need your call, not more engineering."
- **DEF-170's 3 residual golden-master items** — low urgency, needs an owner (whoever
  holds the attendance lane) more than a decision from Ian specifically.
- **Service-charge distribution (T-187)** — do not enable service charge in POS before
  it exists (DEF-082, unchanged from prior handoffs).

## Traps that have actually bitten

- **This repo is a shared tree.** Multiple Claude sessions run here concurrently —
  `ListAgents` before starting; never run `build`/`test:integration` beside a busy
  peer (one `shareat_test` DB, one `migrations/meta/_journal.json`); expect
  task/DEF/migration number collisions; stage explicit paths, never `git add -A`.
- **`current_date` vs `(now() at time zone 'Asia/Manila')::date`** — bare `current_date`
  follows the session timezone, not Manila's; wrong on a UTC server for any
  business-date comparison (migration `0112`'s own comment; DEF-172).
- **`expenses.category_id` and `.supplier_invoice_id` are both `NOT NULL`** (T-130) —
  a "missing category" or "no linked invoice" cannot exist by construction; if a task
  spec assumes either, read the real schema before implementing, not just the plan.
- **`departments` has no store roster** — it's a flat org-wide list, no
  store↔department linking table exists. Don't assume "which departments does this
  store have" is answerable from the schema as it stands.

## The paste-ready prompt

```
Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md, then
docs/RULES.md if you haven't this session. Pick up Phase 6: T-211/T-217 may
already be in progress in this shared tree (check ListAgents first) — if so,
help with T-212 instead, or ask Ian which. Everything since the last wrap-up
is in docs/ROADMAP.html's Phase 6 section and this file's "What happened"
above; don't re-derive it.
```
