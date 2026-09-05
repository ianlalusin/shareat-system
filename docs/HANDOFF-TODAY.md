# Handoff — 2026-09-05

## Where things stand

Phase 1's two carried test-hygiene gaps are closed. A standing UI/UX design directive from Ian is
now recorded in the bible. Phase 6 has its first shipped task — the balance sheet renders, ties,
and is live at `/reports/balance-sheet`. AR/AP aging (T-209b) and cash flow/per-store comparison/
drill-down/CSV export (T-209c) are the remaining January-critical and follow-on Phase 6 work,
not started.

## Gates at `41c5458` (HEAD)

**typecheck clean · unit 1013/1014 (1 pre-existing skip, unrelated) · full integration suite, 84
files / 2262 tests, green · `npm run build` exit 0** (dev server confirmed stopped on 9008 first).
`/reports/balance-sheet` live-smoketested on 9008 against real dev data: renders, ties, store/
as-of/year-close filters round-trip through the URL, empty state confirmed for a pre-activity date.

## What happened this session

**T-111 — closed DEF-080 and DEF-081, Phase 1's two carried gaps.** `vitest.config.mts` now
routes `tests/invariants/**/*.test.ts` to the integration project (posts through the real
`postEntry`, needs real Postgres — `tests/golden/` stays under `unit`, already reachable since
T-157). `fast-check` added as a root devDependency. `tests/invariants/accounting-equation.test.ts`
generates random valid transaction sets into a **fresh, isolated org per run** and asserts
invariants 9 and 10 after every posted entry. ⭐ **Two real bugs found writing it, not planning
it**: sharing one org across fast-check runs let shrinking report a "counterexample" corrupted by
an earlier run's leftover state (fixed — isolate every run); and bucketing the accounting equation
by account TYPE while signing by each row's own `normalBalance` breaks for the three seeded contra
accounts (1590, 4900, 4950) — fixed by computing each type bucket from raw debit/credit totals
with one fixed sign convention. Verified failing for the right reason first, then reverted to
green. `docs/tasks/111-property-based-invariant-tests.md`.

**Carried forward a prior session's uncommitted Phase 6 discovery pass**, found sitting in the
shared tree at session start: `docs/discovery/26-reporting-dashboards-and-insights.md`,
`docs/plans/phase-6-reporting-and-dashboards.md`, two `docs/CAPABILITY-GAPS.md` additions, and
DEF-166 in the register. Committed separately from this session's own work so nothing was lost or
misattributed.

**Bible §1.2c added — UI/UX is a third authority, alongside §1.2b's WHAT/HOW split** (row 171,
version 3.4). Ian: *"the ui/ux design of this app must be an upgraded version of v1. i want it to
be uniform flexible across screens and respect the workflow of records like v1... i want it to
feel familiar but improved... i want the 3 apps erp, pos and customer to look and feel like they
belong to one family... actually in ui POS has cleaner [UI] than erp."* Extends decision row 6
("port the UI layer, rewrite the data layer") into a standing rule: v1's record workflows are the
floor for familiarity, not the ceiling for polish; one uniform, reusable pattern set across
screens; `apps/erp`/`pos`/`customer` (the latter two reserved) are one visual family once all three
exist under this monorepo; **POS, not ERP-rebuild, is named as today's presentation-quality
benchmark** where the two disagree. TOC regenerated (`npm run toc`); no already-shipped screen was
reopened.

**T-209a — the balance sheet**, Phase 6's first shipped task and half of ADR-005's January-critical
subset (the other half, AR/AP aging, is T-209b). `v_balance_sheet` (migration 0128) is a fourth
reporting view, signed by account TYPE like `v_income_statement` — **never** by each row's own
`normal_balance` like `v_trial_balance`/`v_account_balance`, which would add a contra account
(`1590` accumulated depreciation) to gross assets instead of subtracting it. ⭐ **Found live, not
planned**: `getBalanceSheet` folds unclosed net income into Equity as a derived "Current period
earnings" line, because a first draft without it failed its own contra-account regression test the
instant an entry touched an expense account — assets fell but nothing on the liability/equity side
moved to match, since income/expense only formally become equity at a year-close. Fixed by reusing
`getIncomeStatement` for the same range rather than re-deriving revenue/expense signing a second
time (Phase 6's own §2.1 rule). `/reports/balance-sheet` reuses `view_trial_balance` via the
existing `reportScope`/`runReport` DEF-064 guard; nav entry added (this repo's own DEF-139
precedent: a shipped, untested-by-nav screen is reachable only by typing the URL).
`docs/tasks/209-reporting-read-model-and-statements.md`.

**Roadmap brought current**: Phase 1's "2 gaps" chip removed (T-111 closed both); Phase 6's chip
moved from "8 tasks planned, 0 built" to "T-209a shipped", with T-209 split into T-209a (done) /
T-209b / T-209c to match the task doc; masthead gate counts and date updated.

**Coordinated with a peer session (`ianla-92`)** auditing the build and running the app to find
edge cases: confirmed no dev server or shared-DB use was in flight before they started, and flagged
migration 0128 / `v_balance_sheet` so they pull latest first.

## Pick up here

1. **T-209b — AR aging and AP aging**, reconciled to their control accounts (`1210`/`2110`) with no
   tolerance. The aging math already exists in `repo/ap.ts`/`repo/ar.ts` (bucketed by due date);
   the reports and screens do not. This is the other half of ADR-005's January-critical subset —
   the 15 Nov go/no-go is judged partly on it.
2. Then **T-209c** — cash flow, per-store P&L comparison, drill-down from a report line to its
   journal entries, one shared CSV export path.
3. **`/wrap-up`/`/daily-review` need `shareat-system` registered as a working directory** (see
   below) before the next session can invoke either by name instead of reading the SKILL.md by
   hand.

## Do not decide these alone — they are Ian's

- Nothing new this session. Carried from 4 Sep: DEF-153 (bible infra summary still describing the
  rejected Cloud SQL + Firebase App Hosting architecture) is still open.

## A tooling issue, diagnosed — Ian's to action, not a code fix

**`.claude/skills/wrap-up/SKILL.md` and `.claude/skills/daily-review/SKILL.md` were not
discoverable this session** — `Unknown skill: wrap-up` from the Skill tool, and neither appeared
in the available-skills listing. Root cause (confirmed against Claude Code's own docs): skill
discovery is scoped to the session's starting directory (and its parents) plus any explicitly
added directories — `shareat-system` was never registered as one (unlike `ERP-rebuild`/`POS`/
`CUSTOMER`/`Shareat Website`, which were), even though ordinary file read/write worked all session.
The frontmatter in both SKILL.md files is fine — this is purely a directory-registration gap, not
a bug in either skill. **Fix (needs Ian, once — not something this session can do to itself):**
either run `/add-dir C:\Users\ianla\webapps\shareat-system` each session, launch future sessions
with that directory as the working directory, or add it to `~/.claude/settings.json`'s
`permissions.additionalDirectories` for a permanent fix. Until then, this ritual runs by reading
`.claude/skills/wrap-up/SKILL.md` directly and following it by hand, as this run did.

## Traps that have actually bitten (this area, right now)

- **fast-check + a mutated shared database don't mix.** Any future property test that posts through
  `postEntry` across multiple generated runs needs a **fresh, isolated org per run** — shrinking
  replays the property function on a smaller input but cannot undo a discarded attempt's real
  Postgres writes, so a shared org makes a "counterexample" describe the wrong entry.
- **A type-bucketed ledger total (assets, revenue, etc.) must never sign by each row's own
  `normal_balance`.** Three seeded accounts are contra accounts (1590, 4900, 4950) whose
  `normal_balance` deliberately disagrees with their type. Sign by TYPE, uniformly, using raw
  debit/credit totals — `v_income_statement` and now `v_balance_sheet` both do this; a naive
  `v_trial_balance`-style per-row signing breaks the moment a contra account is touched.
- **A balance sheet does not tie on an ordinary business day without folding in unclosed net
  income.** "Assets = Liabilities + Equity" is only literally true right after a formal year-close;
  every other day needs the current period's running P&L added to Equity, or any expense-touching
  posting looks like it broke the equation when it did not.

## The paste-ready prompt

```
Working in C:\Users\ianla\webapps\shareat-system. Read docs/RULES.md, then
docs/plans/phase-6-reporting-and-dashboards.md and docs/tasks/209-reporting-
read-model-and-statements.md. T-209a (the balance sheet) is done — pick up
T-209b (AR aging + AP aging, reconciled to 1210/2110 with no tolerance; the
aging math already exists in packages/db/src/repo/ap.ts and repo/ar.ts, the
reports and screens do not). Run `ListAgents` first to check for a busy peer
before running any gate. Follow docs/RULES.md's TDD and definition-of-done
exactly: typecheck, unit, integration against real Postgres, live-smoketested
on 9008, self-reviewed, then update docs/tasks/209-*.md's status line and
docs/ROADMAP.html before committing.
```
