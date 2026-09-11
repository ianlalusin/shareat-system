# T-270 — DEF-279: the five deepest accounting invariants become visible to the counter

**Status:** `spec approved` — lane A (`webapps-4e`, Sonnet). Opened 2026-09-12 by orchestrator
`system32-85`. Reserves task number 270. **Migration slot 0142 allocated to this lane** (the only
slot outstanding).

> ⛔ **Part 1 is a verification pass and it is NOT optional.** Yesterday's handoff names this task
> and attaches exactly one non-negotiable to it: *"Before writing the migration, diff the five
> proposed function bodies against live `pg_get_functiondef` output. **Do not trust the spec's
> copies.**"* That instruction outranks anything I write below about what those functions contain.

---

## Goal

The five `CREATE CONSTRAINT TRIGGER` invariants raise with `USING CONSTRAINT = '<name>'`, so
`recordIfUnmappedConstraint`'s `parseConstraintName` can identify them and the refusal counter stops
reporting a structural zero for the five invariants it most needs to see.

## Background — why a zero here is not safety

`recordIfUnmappedConstraint` identifies a constraint by parsing `constraint "name"` out of the
driver's error text. These five raise a bare `RAISE EXCEPTION 'journal entry % is unbalanced: …'`
and never emit that text, so the counter no-ops on all five **wherever the recorder sits** — it is
not a placement bug and cannot be fixed by moving the recorder:

```
journal_entries_balance_check
journal_lines_balance_check
stock_movements_no_negative_on_hand_trg
stock_layer_consumptions_ties_trg
order_wastage_allocations_sum_100_trg
```

⛔ **These are the population bible §13 row 189's double-signal rule cares most about.** A hit on a
balance or negative-stock invariant means nothing above it refused first — the high-value half of
the signal. ⚠️ **Their silence is absence by construction, not safety**; reading it as safety is
DEF-274's own failure one layer down. Ian ruled 2026-09-10: log it, sequence it after T-261.

---

## Part 1 — ⛔ Verify against the LIVE database before writing a single line of SQL

Produce `docs/discovery/30-def-279-live-trigger-bodies.md` containing, for each of the five:

1. The **live** body, from `pg_get_functiondef(p.oid)` against a migrated database (use your own
   lane DB, `shareat_test_lanea` — it is migrated to 0141).
2. The **migration-file** body — whichever `packages/db/migrations/*.sql` last defined it. Find it;
   do not assume it is the one that first created it.
3. **A diff, and an explicit verdict per function: identical, or not.**

⛔ **If any live body differs from what the migrations say it should be, STOP and report `[A]
BLOCKED`.** A drifted function means something was applied by hand, and writing a migration from
the file's copy would silently revert it. That is the exact failure DEF-039 and DEF-242 are about,
and it is why this part exists.

⚠️ Also record, per function: its **exact `RAISE EXCEPTION` statement(s)**, including every
`%`-placeholder and any `ERRCODE`/`HINT`/`DETAIL` already present, and **how many** RAISE sites each
function has — a function with two raise paths needs both amended or the fix is half-done.

## Part 2 — the migration

**Slot: `0142`.** ⛔ Hand-authored — `npm run db:generate` is retired and fails closed (ADR-012 §5,
bible §13 row 191, DEF-242). Follow `packages/db/migrations/README.md`'s checklist.

⚠️ **The journal `when` must exceed the previous entry's** or the migration is silently skipped
(DEF-039, which is precisely how `0007` was skipped on two databases with no error). Previous entry
is `idx 141`, `when 1798255907084`. Use **`1798342307084`** (+86400000, the established one-day
step) and `idx 142`.

**Contract:** each of the five `RAISE EXCEPTION` statements gains `USING CONSTRAINT = '<its own
constraint name>'`. Nothing else about the functions changes — not the message text, not the
placeholders, not the logic, not the trigger definitions.

⛔ **A migration is never edited once applied — write a new one.** ⛔ Do not `DROP` and recreate the
triggers if `CREATE OR REPLACE FUNCTION` suffices; replacing a constraint trigger changes its
timing/deferrability and these are deferred by design.

## Part 3 — prove the counter can now see them

⭐ **A test that only ever passed proves nothing.** For at least **two** of the five (one accounting,
one inventory — e.g. `journal_entries_balance_check` and
`stock_movements_no_negative_on_hand_trg`), write an integration test that:

1. provokes the invariant for real (an unbalanced entry; a movement driving on-hand negative);
2. asserts the refusal is **recorded by the counter under that constraint's name** — not merely that
   the write was refused;
3. demonstrably **failed before the migration**. Run it against `HEAD` first and record the output.

⚠️ The remaining three may be covered by assertion on the raised error's `constraint` field rather
than a full end-to-end provocation, if provoking them is disproportionate — **say which you did for
each, and why**.

## Invariants

1. ⛔ **The live database is the authority on what those functions contain.** Part 1 before Part 2.
2. ⛔ **Never weaken an invariant to make it testable.** If provoking one cleanly is hard, that is a
   note in your report, not a reason to relax a CHECK or a trigger.
3. ⛔ **No RLS policy added or weakened.**
4. ⚠️ The refusal counter must not become a second source of truth — it counts, it never gates.
5. Money is integer centavos (bible §2.5 / §6).

## Out of scope

- ⛔ `recordIfUnmappedConstraint` / `parseConstraintName` themselves — the parser is correct; the
  functions are the ones not speaking its language. If you conclude otherwise, that is a QUESTION.
- ⛔ `packages/etl/**`, `packages/db/src/repo/etl.ts` — lane B.
- ⛔ Guards in `tests/unit/*`, `packages/db/src/client.ts`, `packages/db/src/index.ts`.
- ⛔ `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md`.
- ⛔ Any git write command · `npm run build` · `npm run dev` · `npm run test:integration`.
- ⛔ Any migration index other than 0142.

## Done when

- [ ] `docs/discovery/30-def-279-live-trigger-bodies.md` exists with a per-function verdict.
- [ ] Migration `0142` hand-authored; journal `idx 142`, `when 1798342307084`.
- [ ] Applied cleanly to your lane DB; `pg_get_functiondef` after shows `USING CONSTRAINT` on all five.
- [ ] At least two invariants proven visible to the counter by a test that failed before.
- [ ] typecheck clean · unit green · integration green both with and without the restricted flag.
- [ ] READY carries the real output of every gate, and states what you did for each of the five.
