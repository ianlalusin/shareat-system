# T-215 — Expense budgets

> **Status**: 📝 **SPECIFIED 2026-09-06, not built.**
>
> ⭐ **Pulled out of "deliberately deferred past January" by Ian on 2026-09-06** — *"do it now."*
> `docs/ROADMAP.html` listed it under *Deliberately deferred past January* on the grounds that it
> posts nothing to the ledger; `docs/plans/v2-completion-blueprint-2026-09-05.md` §9 scheduled it
> inside the Phase 6 bulk. The two documents disagreed and this is the resolution: **in scope,
> now, in Phase 6.** The roadmap's deferred list is corrected to match.
>
> ⚠️ **The roadmap's one-line scope is too small and its own implementer should know that.**
> ROADMAP.html one-lines T-215 as *"budget vs. actual as a query over `journal_lines`, per store
> per period."* That is the reporting half. v1's actual live feature is an **envelope with an
> auto-reissue cron** — `src/lib/financial/budget-reissue.ts` + `/api/cron/budget-reissue`, both
> confirmed working end to end. Read `ERP-rebuild/src/app/manager/budgets/budget-editor.tsx`
> before building, not just the query.

## Why this exists, and what v1 already learned

**Studied at source:** `ERP-rebuild/src/app/manager/budgets/page.tsx` (271 lines),
`budget-editor.tsx` (178), `src/lib/actions/expense-budget.actions.ts` (361),
`src/lib/financial/budget-reissue.ts` (73) and its test, `paths.expenseBudget.ts`, and
`src/app/api/cron/budget-reissue/route.ts` (39).

**The goal it was built to achieve**, written down before judging the implementation: *let a store
owner cap what a branch may spend in a category over a period, and let the branch see how much of
that cap is left before they commit the next peso.* It is a **control**, not a report — the number
matters at the moment of spending, not at month end.

**v1's model.** One document per `store × monthKey × expenseEntryId`
(`stores/{storeId}/expenseBudgets/{YYYYMM}_{expenseEntryId}`), carrying `budgetAmount`,
`consumedAmount`, an `autoReissue` flag and a `reissueInterval`. Two families of interval, and the
distinction is load-bearing:

- **Reset intervals** — `daily`, `weekly`, `bi_weekly`: zero `consumed` on the **same** document
  once the window elapses.
- **Period intervals** — `monthly`, `quarterly`, `annually`: create a **new** document for the
  next period, and only once that period has actually arrived. ⭐ v1's own comment states the
  reason — *"never pre-create future months, so the reissue processor can't run away."* That
  restraint is worth porting verbatim.

### The four verbs

| v1 behaviour | Verb | Here |
|---|---|---|
| Per store, per period, per category envelope | **Duplicate** | §2 |
| Remaining shown before the spend | **Duplicate** | §5 |
| Auto-reissue, two interval families | **Duplicate** | §4 — the restraint on pre-creation included |
| Reissue config integrity (auto-reissue on with no interval silently no-ops) | **Duplicate** | v1 validates this in the action and says why; keep it, move it to the database |
| **stored `consumedAmount`** | ⛔ **Correct** | §3. Phase 6's core rule: *no report figure is ever a hand-maintained counter*. v1's counter is incremented by the expense actions and has every drift mode a stored balance has — this is the same defect class as AR's `outstandingBalance`, measured wrong on 13.3% of rows |
| `remainingAmount` stored alongside it | **Delete** | Arithmetic on two numbers, one of which is already wrong |
| HTTP cron route (`/api/cron/budget-reissue`) | **Correct** | T-140 settled how anything scheduled runs in v2: a CLI job on the host timer, the system principal, one `scheduler_runs` row per run including a no-op, and a non-zero exit code. Not an HTTP route with a shared secret |

## Goal

A manager sets a spending cap per category per store per period. Anyone about to record an expense
in that category sees what is left. The cap rolls forward on its own schedule without anyone
remembering to recreate it, and **consumption is never stored**.

## Scope — files this task may create or modify

**Create**
- `packages/db/schema/expense-budgets.ts`
- `packages/db/migrations/XXXX_expense_budgets.sql` (generated — ⛔ never hand-written, and ⛔
  never hand-applied; see §7)
- `packages/domain/src/budgets/index.ts`
- `packages/db/src/repo/budgets.ts`
- `apps/erp/src/app/budgets/page.tsx`, `actions.ts`, `lib.ts`
- `packages/domain/tests/integration/budgets.test.ts`
- `scripts/budget-reissue.ts`
- `docs/ops/shareat-budget-reissue.service` + `.timer`

**Modify**
- `packages/db/schema/index.ts`, `packages/db/src/repo/index.ts`, `packages/domain/src/index.ts`
  (barrels)
- `packages/domain/src/scheduler/index.ts` — add `budget_reissue` to `JobOutcome['job']`
- `apps/erp/src/components/nav.tsx` — one entry
- `packages/auth/src/capabilities.ts` — one capability (§6)
- `package.json` — one script
- `docs/ops/README.md`, `docs/ops/provision.sh` — the new unit
- `apps/erp/src/app/expenses/new/page.tsx` — the remaining-budget hint (§5)

⛔ **`PROJECT_BIBLE.md` is not in scope** (RULES rule 14).

## Contract

### 1. A budget is not a ledger document

⭐ Say this in the schema header so nobody later tries to make it post. A budget is an
**intention**; the ledger records **facts**. Nothing in this task calls `postEntry`, and
`journal_entry_id` appears nowhere in it. This is exactly why the roadmap deferred it once, and it
remains the reason the task is cheap.

### 2. `expense_budgets`

| Column | Notes |
|---|---|
| `id` | `uuidv7()` |
| `org_id`, `store_id` | FK, restrict |
| `category_id` | FK → `expense_categories`, restrict |
| `period_key` | `text`, `YYYYMM`, CHECK `~ '^\d{6}$'` — v1's key, ported |
| `amount` | `numeric(14,2)`, CHECK `>= 0`. ⚠️ Zero is meaningful and is **not** the same as absent: zero means *spend nothing here*, absent means *no cap* |
| `auto_reissue` | `boolean not null default false` |
| `reissue_interval` | `text`, nullable, enum of the six |
| `reissued_from_id` | self-FK, nullable — provenance of an auto-created row |
| `last_reset_at` | `timestamptz`, nullable — reset intervals only |
| `created_by`, `created_at`, `updated_at` | as every other table |

**Constraints:**
- `unique (org_id, store_id, category_id, period_key)` — one envelope per category per store per
  period. This is the whole integrity story.
- ⭐ CHECK: `auto_reissue = false OR reissue_interval IS NOT NULL`. v1 enforces this in the action
  with an explicit comment — *"an auto-reissue budget MUST carry a valid interval, else the
  reissue processor silently skips it (no-op)"* — and that is precisely the class of rule bible
  §2 says belongs in the database, not the service layer.

### 3. ⛔ Consumption is derived, and there is one specific trap

Consumed for a budget = the sum of **posted, non-voided expenses** at that store, in that
category, whose date falls in the period.

```sql
select coalesce(sum(e.total_amount), 0)
from expenses e
where e.org_id = $1 and e.store_id = $2 and e.category_id = $3
  and e.status = 'posted'
  and to_char(e.expense_date, 'YYYYMM') = $4
```

⛔ **Do NOT derive this from `expense_categories.account_code`.** Measured, not assumed: **three
account codes in the seed are shared by two categories each** — `6890`, `6620`, `6600` (39
categories, 36 distinct codes). A query grouped by account code over-counts consumption for six
categories, and the failure is silent — a manager sees a budget as exhausted when half the spend
belongs to a different envelope. Group by `category_id`, always.

⚠️ **Draft expenses are excluded, and that is a judgement worth stating.** A drafted-but-unposted
expense is not yet a fact. A manager who wants to see committed-but-unposted spend is asking a
different question; if that turns out to matter, it is a second column, not a redefinition of this
one. → **Open question 2.**

### 4. Reissue — a scheduler job, not a cron route

`runBudgetReissue` in `packages/domain/src/scheduler/index.ts`'s existing shape, entry point
`scripts/budget-reissue.ts`, `npm run budget-reissue`, a systemd `.service`/`.timer` pair in
`docs/ops/`, **daily**.

- **Reset intervals** (`daily`/`weekly`/`bi_weekly`): consumption is derived, so there is no
  counter to zero. What resets is the **window** — stamp `last_reset_at` and derive consumption
  from that timestamp forward rather than from the period start. ⭐ This is a real simplification
  v1 could not have: its reset *had* to mutate a stored number.
- **Period intervals** (`monthly`/`quarterly`/`annually`): insert the next period's row carrying
  the same amount and config, `reissued_from_id` set, **only once that period has arrived**. Port
  v1's restraint and its reason.
- ⛔ **Idempotent.** A second run the same day creates nothing. The `unique` constraint makes this
  a database fact rather than a promise; the job must still handle the conflict rather than
  throwing. ⚠️ Per `reference_postgres_batch_needs_savepoint`: one DB error aborts the
  transaction, so a per-row failure needs its own savepoint or the run's own `scheduler_runs`
  write is refused too.
- One `scheduler_runs` row per run **including a no-op**, non-zero exit on failure — T-140's
  contract, unchanged.

⚠️ **The timer must actually be armed on the droplet, and only Ian can do that.** `provision.sh`
is the only thing that installs unit files. A job that ships unarmed is T-199's and T-214's exact
outcome twice over — name it in the handoff, do not report the task done without saying it.

### 5. Screens

**`/budgets`** — store picker, period picker, one row per category with a cap: amount, consumed
(derived), remaining, a bar, and an over-budget marker. Categories with no budget row listed below
under *No cap set*, each with an inline *set a cap* action. Editing is inline; there is no detail
page — a budget is four fields.

**`/expenses/new`** — when a category with a cap for the current period is selected, show
`remaining after this expense`. ⭐ **This is the point of the whole task.** The cap matters at the
moment of spending; a report at month end is a post-mortem. Read-only — it warns, it never blocks.

⛔ **It must not block, and this is a decision, not an oversight.** T-175 already settled the
pattern in this codebase — *a finding replaces v1's block: nag whoever can act, never block
whoever cannot.* A cashier who cannot buy gas because a cap was set wrong will buy it with their
own money and the expense leaves the system entirely.

### 6. Capability

One new capability, `manage_expense_budgets`, **store**-scoped, `super_admin`/`admin`/`manager`
true, `staff` false — matching `set_credit_limit`'s shape and reasoning (a manager who runs a
branch's money sets that branch's caps). Reading a budget needs no capability beyond store scope;
seeing the remaining figure on `/expenses/new` must not require the capability to set one.

## Invariants

1. No stored consumption, anywhere, ever.
2. One envelope per `(store, category, period)` — a database constraint.
3. `auto_reissue` without an interval is unrepresentable.
4. Reissue is idempotent; a second run creates nothing.
5. Future periods are never pre-created beyond the next one.
6. A budget never posts to the ledger.
7. A cap never refuses an expense.

## Tests

Integration, `packages/domain/tests/integration/budgets.test.ts`:

1. Consumption sums posted expenses in the category/store/period and excludes draft and voided.
2. ⭐ **Two categories sharing one account code have separate consumption** — seed both from real
   colliding codes (`6890`), post to each, assert neither figure includes the other. This is the
   §3 trap, and it is the one test that would catch the wrong implementation.
3. Voiding a posted expense reduces consumption on the next read.
4. `auto_reissue = true` with a null interval is refused by the database.
5. A duplicate `(store, category, period)` is refused by the database.
6. Monthly reissue creates next period's row once and only once across two runs.
7. Reissue does not create a period that has not arrived.
8. A `weekly` budget's `last_reset_at` moves and consumption is measured from it.
9. The job writes a `scheduler_runs` row on a no-op run.

Plus: `npm run budget-reissue` against `shareat_dev`, run twice, second run creating nothing —
the same proof T-214's `finding_observation` used.

**Smoketest on 9008:** set a cap → record an expense in that category → the bar moves → exceed it
→ the warning shows and the expense still posts → next period's row appears after a reissue run.
0px horizontal overflow at 390px.

## Out of scope — with reasons

- **Budgets for anything but expense categories.** v1 has none; payroll and COGS have their own
  controls.
- **Approval workflow for setting a cap.** v1 has none.
- **Org-wide (all-store) budgets.** v1's envelope is per store. A roll-up is a report, and
  `/reports/store-comparison` is where it would live. → **Open question 3.**
- **Blocking on exceed.** §5, deliberate.
- **A budget-breach finding.** The right shape, and it belongs with the OIL detectors. → **Open
  question 1.**

## Open questions — for Ian

1. **Should an exceeded budget raise a finding?** It is the natural v2 idiom — derived, no new
   screen, shows up beside every other thing needing attention. Recommendation: **yes**, as a
   soft-severity `budgetExceeded`, but as a follow-up so this task stays small.
2. **Do draft expenses count against a cap?** Recommendation: no (§3). Reversible.
3. **Do you ever set one cap across all stores at once?** If yes, that is a bulk-apply action on
   `/budgets`, not a different data shape — cheap to add later, wrong to guess at now.

⚠️ **One thing this task cannot fix and the next reader should know.** Budgets key off
`expense_categories`, and **nothing in v2 can create or edit a category** — no `createCategory` or
`updateCategory` exists anywhere in `packages/domain` or `packages/db/src/repo`; the 39 rows come
from `packages/db/seed/expense-categories.ts` and that is the only writer. Filed as **DEF-193**.
Budgets work fine on the seeded 39; a store that needs a fortieth category cannot have one, and
therefore cannot budget for it.

## Done when

- [ ] A cap can be set, edited and removed per store/category/period
- [ ] Consumption is derived and correct for two categories sharing one account code
- [ ] `/expenses/new` shows remaining and never blocks
- [ ] Reissue runs daily, is idempotent, and pre-creates nothing
- [ ] Nine integration tests green, written first and seen failing for the right reason
- [ ] The job run twice against `shareat_dev`, second run a proven no-op
- [ ] Unit files committed to `docs/ops/` **and the handoff names the arming step as Ian's**
- [ ] Live-smoketested on 9008, 0px overflow at 390px
- [ ] `npm run build` exit 0 with the dev server stopped
