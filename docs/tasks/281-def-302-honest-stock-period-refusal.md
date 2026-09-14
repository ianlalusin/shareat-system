# T-281 — DEF-302: make the stock-movement period refusal honest

> **Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-281`) for the commit, date and outcome —
> the roadmap is the maintained record.
> ⭐ **Ian ruled disposition (b), 2026-09-12**, choosing it over (a) leave-it and (c) extend-the-
> exemption-to-stock. (c) is explicitly NOT sanctioned and must not be re-derived here.

Source defect: `docs/DEFECTS-REGISTER.md` DEF-302. Prior decision: `PROJECT_BIBLE.md` §13 row 193
(what the override is and, explicitly, what it deliberately is not).

⛔ **The non-negotiable: BEHAVIOUR DOES NOT CHANGE.** A stock movement into a closed OR locked
period is refused today and must still be refused after this task, for every role including
`admin` and `super_admin`. The only thing that changes is the SENTENCE the refusal carries when the
caller holds the period-override GUC. A version of this that lets the movement through is
disposition (c), which Ian did not choose.

## Goal

`stock_movements_check_period_open` (`packages/db/migrations/0063_t161_stock_ledger.sql:111-126`)
refuses any INSERT into `stock_movements` whose `moved_at` falls inside a fiscal period that is not
`open`, for every caller, unconditionally. It has no knowledge of the `app.period_override` GUC
migration 0143 introduced for the two journal triggers. Teach it to **read** that GUC — never to
act on it — so that when it fires while the GUC happens to be `'on'`, the exception text says
outright that the override does not extend to stock movements, instead of a generic "cannot move
stock" message that gives an admin holding the capability no way to tell, from the error alone,
whether their override was consulted and correctly refused, or never reached at all (DEF-302's own
framing: "a correctly-working system that reads as a broken one").

## The situation, measured

`git grep -n "RAISE EXCEPTION" packages/db/migrations/*.sql` narrowed to messages mentioning
"period" turns up exactly three enforcement functions across the whole migrations folder (full
grep output kept for review):

| Function | Defined | Superseded by | Exempted by 0143? |
|---|---|---|---|
| `journal_entries_check_period_open` | `0003_journal_entries_and_lines.sql:214-238` | `0143_t264_period_override.sql:34-72` | **Yes** |
| `journal_lines_check_period_open` | `0003_journal_entries_and_lines.sql:246-263` | `0143_t264_period_override.sql:75-103` | **Yes** |
| `stock_movements_check_period_open` | `0063_t161_stock_ledger.sql:111-126` | — (this task) | **No** |

No CHECK constraint enforces the rule anywhere — it cannot: the check needs a join to
`fiscal_periods`, which a CHECK constraint cannot express, only a trigger.

**Answer to the orchestrator's question: yes, `stock_movements_check_period_open` is the ONLY
period-enforcing function not exempted by 0143. Confirmed zero elsewhere** — `0105` (pay runs),
`0130` (finding occurrences) and `0131` (expense budgets) each have a column or index with "period"
in its name (`pay_runs.period_start/end`, `expense_budgets.period_key`, an index literally named
`..._period_idx`), and `0011`'s `fiscal_periods` rows are RLS isolation policy, not enforcement —
none of the four touches `fiscal_periods.status` at all. I read all three non-RLS hits at their
line numbers before excluding them; none is a period-open guard wearing a different name.

### Can a caller holding the override actually reach `stock_movements_check_period_open` with the GUC set? Measured, not assumed — no.

This matters because "reachable" is exactly the question DEF-310 turned on. Two independent facts,
each individually sufficient, and I checked both rather than stopping at the first:

1. **`beginPeriodOverrideContext` (`packages/db/src/repo/journal.ts:410-412`) is called from exactly
   one place** — `postEntry` (`packages/domain/src/ledger/post-entry.ts:190`), only after
   `authorize(actor, 'override_period_lock')` succeeds. Its own doc comment: *"Never called by any
   other path."* `git grep -n beginPeriodOverrideContext packages/` returns only its definition and
   that one call site.
2. **`git grep -n "periodOverride:" packages/domain/src apps/`** — the shape every real caller must
   use to reach it — returns **zero matches** anywhere in application code. The capability is
   exercised today only by `packages/domain/tests/integration/period-override.test.ts`. Nobody has
   wired a UI action or a domain function to request it.

And even bracketing fact 2 and imagining a future caller that does pass `periodOverride`: DEF-302's
own three cited flows all insert their stock movement(s) **before** calling `postEntry` in the same
transaction — I read all three call sites directly rather than trusting the register's line numbers:
`commissary/transfer.ts` `confirmReceipt` (movement `:385`, `postEntry` `:503`); `production/index.ts`
`runProductionPosting` (movements `:444` and `:503`, `postEntry` `:547`); `trade/returns.ts`
`recordInternalReturn` (movement `:447`, `postEntry` `:485`) — movement-first in every case, and none
of the three passes `periodOverride` to its `postEntry` call at all (consistent with fact 2). So the
GUC literally cannot be `'on'` yet at insert time in any of them, because nothing sets it before
`postEntry` runs, and `postEntry` runs after. `set_config(..., true)` is transaction-scoped and
persists for the rest of the transaction once set, so a *reordered* flow (`postEntry` first, movement
second, same `tx`) or a hypothetical future caller that invokes `beginPeriodOverrideContext` before
writing a movement **would** reach this trigger with the GUC on — which is exactly why the fix is
written to read the GUC generally rather than special-cased to "never fires."

**So: this is a confirmed zero for every path that exists today, and the fix is correctly-scoped
defensive/diagnostic work for the day a caller reaches it — not a change that alters what anyone
currently sees.** That asymmetry is worth Ian's eyes precisely because "cheap, changes no behaviour"
(the register's own words for option (b)) is true for a stronger reason than the register states:
it is not just cheap, it is currently unobservable by any exercised path. I did not extend scope to
fix the reordering itself — that is a production-code change to three files this task's scope
excludes, and it is not what was ruled.

*(The existing `period-override.test.ts` header, written by the T-264 slice 3 lane, already
independently documents point 1's consequence in its own words — "a test written against one of
those three would fail for a reason that has nothing to do with this task" — which cross-checks my
reading rather than being the source of it; I read the repo function and its one call site before
finding that comment.)*

## Scope — the exact files this task may create or modify

- `packages/db/migrations/0145_t281_def302_honest_stock_period_refusal.sql` — new file.
- `packages/db/migrations/meta/_journal.json` — one new entry, idx 145, appended after idx 144.
- `packages/domain/tests/integration/stock-movements-period-override.test.ts` — new file.
- `docs/tasks/281-def-302-honest-stock-period-refusal.md` — this file.

No `packages/db/schema/` change: `git grep -n "check_period_open\|hand-added in migration" packages/db/schema/stock-ledger.ts` has no hit — this function has never had a mirror or a `// NOTE: … hand-added` comment there, unlike tables that do. Nothing to touch.

## Contract

1. `stock_movements_check_period_open` keeps its exact current signature, trigger timing (`BEFORE
   INSERT`) and refusal condition: `period_status IS NOT NULL AND period_status <> 'open'` —
   **byte-identical** to `0063`'s condition. No branch added that lets the `INSERT` through under
   any circumstance the current function refuses.
2. When the refusal condition is true and `coalesce(current_setting('app.period_override', true),
   '') = 'on'` (migration 0143's exact idiom, read-only, reused rather than reinvented per the
   briefing and per `RULES.md` §1 rule 9's neighbour rule against inventing a second mechanism) —
   the exception message states, in terms, that the period-override capability does not extend to
   stock movements, and names the reason (back-dating recomputes inventory layers and COGS).
3. When the refusal condition is true and the GUC is not `'on'` — the exception message is
   **exactly** today's text: `'cannot move stock into a % period (moved_at = %)'`, unchanged, so
   every existing caller and every existing test that depends on that string keeps working.
4. The GUC is read **exactly once**, **after** the refusal condition is confirmed true — never
   before, so an open-period insert never even evaluates `current_setting` (matches 0143's own
   ordering: locked-status check first, override read only inside the branch that needs it).
5. `locked` and `closed` are **not** given different override wording. Unlike the journal triggers
   — where `locked` is unconditionally refused and `closed` is the only status the override ever
   bypasses, so the two need visibly different sentences — stock movements bypass **neither**
   status through the override, ever. One message template, parameterised by `period_status`,
   correctly describes both without inventing a distinction that would misrepresent 0143's own rule
   (`locked` is out of the override's reach for journal entries specifically because a later
   year-close already depends on it — ADR-006 §7.5 — a rationale that doesn't even apply here, since
   stock movements were never going to be exempted for `closed` either).

## Invariants

1. ⛔ **Never branch on the GUC to allow the `INSERT` through.** That is disposition (c) — extending
   the exemption to stock movements, an inventory-layer/COGS decision nobody has made (bible row
   193's own text; DEF-302's disposition). The GUC is consulted for **message text only**. *This is
   the one a reviewer should read for first*, per the briefing.
2. **Behaviour-preservation, proven, not assumed**: for every `period_status <> 'open'` with the GUC
   unset or absent, `stock_movements_check_period_open`'s observable behaviour (rejects the
   transaction, exact message text) is identical before and after this migration.
3. **The override remains transaction-local and set only by `beginPeriodOverrideContext`
   (`packages/db/src/repo/journal.ts:410`)**, called only by `postEntry` after `authorize()` — this
   task adds no new setter, no new caller-supplied parameter, no route that lets a caller assert the
   flag directly (bible §7.1, landmine 17, restated for 0143 and unchanged here).
4. `0063` stays applied and unedited (bible §2 rule 8) — this migration `CREATE OR REPLACE`s the
   function forward, the exact pattern `0143` used on `0003`.
5. Migration numbering: idx **145**, `when = 1798515107084 + 86_400_000 = 1798601507084` (one day
   past idx 144 on the DEF-091 grid), tag `0145_t281_def302_honest_stock_period_refusal` — matches
   both the file name and the ADR-012 §5 / README checklist (`packages/db/migrations/README.md`).

## Tests — write first, watch the right one fail for the right reason

All five in the new file, against `shareat_test_lanea` only, via
`node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_lanea packages/domain/tests/integration/stock-movements-period-override.test.ts`
— never `npm run test:integration`.

Fixture: one org, one store, one location, one person (staff), one item — the minimal subset of
`stock-transfers.test.ts`'s fixture shape, trimmed to what this trigger reads (`org_id`, no role or
capability machinery needed since nothing here calls `authorize()`). Insert `stock_movements` rows
by raw SQL directly — the same choice `period-override.test.ts` made to isolate the *trigger* from
the domain layer above it — inside `withOrgPrincipal` (`@shareat/db`), so RLS is live exactly as it
is in production.

1. **Baseline, closed, no override** — insert into a `closed` period with the GUC unset. Rejected;
   message matches `/^cannot move stock into a closed period \(moved_at = /` and, critically,
   **does not** match `/override/i` — this is the pre-existing behaviour, captured byte-for-byte so
   a future edit that drifts the wording is caught here, not discovered in production.
2. **Baseline, locked, no override** — same, `locked` period. Rejected; message matches
   `/^cannot move stock into a locked period \(moved_at = /`, no `/override/i`. (The current
   function has never special-cased `locked` — this proves that stays true.)
3. **⭐ THE TEST THAT PROVES THIS WAS DONE RIGHT.** Closed period. Call
   `journalRepo.beginPeriodOverrideContext(tx)` directly — the real mechanism, not a hand-rolled
   `set_config` — inside the same transaction, **before** the raw-SQL insert, simulating the one
   condition under which any caller, now or in the future, could ever reach this trigger with the
   flag on. Assert: the `INSERT` **still rejects** — `admin`-equivalent access to the real override
   mechanism does not get a movement through a closed period — **and** the message matches
   `/does not extend to stock movements/i`. If this test is written first against the current `0063`
   function, it must fail on the message assertion while the *rejection* half already passes
   (`beginPeriodOverrideContext` has no bearing on today's function at all) — that is "failing for
   the right reason": the refusal was never the missing part, the honesty was.
4. **Same as 3, for `locked`.** Rejected, and the message still matches `/does not extend to stock
   movements/i` (invariant 5 — no separate "locked" wording).
5. **Open period, GUC on** — sanity: no exception at all, row inserted, matching the un-refusable
   case being genuinely untouched (the GUC read never executes when the refusal condition is false —
   contract point 4 — but the *outcome* must be identical regardless).

## Out of scope

- ⛔ **Extending the override to actually let a stock movement post into a closed or locked period**
  — disposition (c), not chosen.
- ⛔ **Reordering `confirmReceipt` / `runProductionPosting` / `recordInternalReturn`** to call
  `postEntry` (with `periodOverride`) before writing their stock movement(s), even though the
  "situation, measured" section above shows that is the only thing that would make the honest
  message observable on a real flow today. That is a production-code change to three files across
  `commissary/`, `production/` and `trade/`, none of which this task's briefing scoped in, and
  reordering side-effect-bearing writes inside an existing transaction is exactly the kind of change
  that wants its own spec, not a drive-by inside a message-text task.
- ⛔ Wiring any UI action or domain function to actually request `override_period_lock` for a stock
  path — nothing does, today, for stock or otherwise outside `postEntry`.
- ⛔ `packages/db/schema/` — confirmed empty of any mirror for this function; nothing to touch.
- ⛔ `apps/erp/src/lib/constraint-messages.ts` — this is a hand-raised `RAISE EXCEPTION`, not a
  driver-native constraint violation, so per DEF-301/DEF-279 it would sit in that map matching
  nothing, silently. Not attempted.
- ⛔ `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md` —
  reported to system32-85 for those edits, not touched directly.
- ⛔ Migrations 0001–0144, `scripts/`, `tests/unit/`, `docs/reference/` — lane B's territory or
  applied-and-frozen.

## Done when

- typecheck clean · unit unaffected (none exist for this function; not adding any — it is
  Postgres-only) · **integration green against `shareat_test_lanea`**, all 5 new cases plus the full
  existing suite unaffected · self-reviewed line by line.
- The migration applies cleanly to `shareat_test_lanea` from its current head.
- The report to system32-85 states real gate output (numbers, exit codes), not a claim.
- Report ends with a `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-302; `PROJECT_BIBLE.md` §13 row 193; `docs/decisions/ADR-006`
§7.5; `docs/decisions/ADR-012-hand-authored-migrations.md` §5;
`packages/db/migrations/0143_t264_period_override.sql`;
`packages/domain/tests/integration/period-override.test.ts`.
