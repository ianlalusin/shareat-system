# T-270 — DEF-279: the five deepest accounting invariants become visible to the counter

**Status:** `COMPLETE 2026-09-12` — shipped `f0aebed`, lane A. Migration `0142`. ⛔ Spec correction 1 is the important part: the fix on record since 2026-09-10 would have applied cleanly and changed nothing. ⚠️ The orchestrator caused a user-visible regression by widening scope beyond the defect; reverted, and DEF-301 filed for the trap behind it.

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

---

## ⛔ SPEC CORRECTION 1 — 2026-09-12. Part 2's Contract, built as written, would have changed NOTHING.

⭐ **Lane A verified the mechanism instead of implementing the spec, and stopped before writing a
line of SQL.** That is bible §3.4a exactly, and it caught a fix that would have applied cleanly,
looked right, and been inert. **The register's own disposition for DEF-279 was incomplete** — it
said the fix is `USING CONSTRAINT` on five statements; that is necessary and **not sufficient**.

### The measurement, reproduced independently by the orchestrator

Against `shareat_test_orch` through the same `postgres` driver the app uses:

| | `err.message` | `err.constraint_name` | regex on message |
|---|---|---|---|
| `RAISE EXCEPTION 'entry % is unbalanced', 'abc' USING CONSTRAINT = 'journal_entries_balance_check'` | `"entry abc is unbalanced"` | `"journal_entries_balance_check"` | **null** |
| a real CHECK violation | `...violates check constraint "_probe_chk_v_check"` | `"_probe_chk_v_check"` | matches |

`parseConstraintName` is `/constraint "([a-zA-Z0-9_]+)"/` run against the **message**.
`USING CONSTRAINT` populates a **separate structured field the parser never reads**. So all five
would have kept reporting a structural zero.

### ⭐ RULING on point 1 — do BOTH halves, and the parser half is the better half

⛔ Note the second row of that table: `constraint_name` is set for **real** constraint violations
too. So reading the structured field is not a workaround for our hand-written raises — it is
**strictly more robust than parsing English prose that PostgreSQL is free to reword.**

1. **The migration still adds `USING CONSTRAINT`** — it is what populates the field.
2. **`apps/erp/src/lib/constraint-messages.ts` IS NOW IN SCOPE** (it was listed out of scope; the
   spec's own exception said *"if you conclude otherwise, that is a QUESTION"* — you did, correctly).
   Add a resolver that takes the error object and **prefers `err.constraint_name`, falling back to
   `parseConstraintName(raw)`**. Keep `parseConstraintName` exported and unchanged as the fallback.
   Use it at **both** call sites — `errorMessage` (line ~112) and `recordIfUnmappedConstraint`
   (line ~169).

⚠️ **Check the user-visible consequence before you finish:** once `errorMessage` can resolve these
five, any of them present in the message map will start rendering their mapped sentence instead of
the raw `RAISE` text. Report which of the five are in the map and what a user will now see. If a
mapped sentence is worse than the raw text, say so — do not quietly accept it.

### ⭐ RULING on point 2 — thread the name as a parameter; do NOT catch-and-re-raise

You proposed catch-and-re-raise at each wrapper and rejected threading the name through the shared
function's signature. **I am reversing that**, because the reason to reject it has just evaporated:

`journal_check_entry_balance` has exactly **two callers in the world** —
`journal_entries_trigger_check_balance` and `journal_lines_trigger_check_balance`. Verified two
ways: `git grep` over the repo (only migration `0003` defines and calls it) and `pg_proc.prosrc`
against the live database. No application code, no other function. A signature change is therefore
free, and both callers are already in your migration.

**Contract:** `journal_check_entry_balance(p_entry_id uuid, p_constraint text)`; both raises use
`USING CONSTRAINT = p_constraint`; each wrapper passes its own trigger's constraint name.

⛔ **Why not catch-and-re-raise**, so this is not relitigated later:
- `EXCEPTION WHEN OTHERS` also catches deadlocks, serialization failures and statement
  cancellation, and would relabel them as constraint violations. Narrowing to `WHEN raise_exception`
  fixes the mislabelling but not the next point.
- Every PL/pgSQL exception block opens a **subtransaction** on each fire, on the hot path of every
  journal write.
- Parameter-threading has neither problem and needs no `SQLERRM`/`SQLSTATE` juggling to preserve the
  original text, because the original `RAISE` is never replaced.

⭐ Your instinct was sound and your rejected alternative was the right one — what made it look
expensive was a caller census nobody had run.

### Point 3 — accepted

`docs/discovery/33-def-279-live-trigger-bodies.md` is correct; 30–32 were taken. Good adaptation.

### Amended done-when

- [ ] Migration `0142` adds `USING CONSTRAINT` to all five raise sites, and re-declares
      `journal_check_entry_balance` with the new second parameter plus both wrappers.
- [ ] `constraint-messages.ts` prefers `err.constraint_name`, regex retained as fallback.
- [ ] The two-invariant proof (spec Part 3) now asserts the counter records the **correct** name —
      in particular that a line-only edit records `journal_lines_balance_check`, **not** the entries one.
- [ ] The user-visible message consequence reported.

## Done when

- [ ] `docs/discovery/30-def-279-live-trigger-bodies.md` exists with a per-function verdict.
- [ ] Migration `0142` hand-authored; journal `idx 142`, `when 1798342307084`.
- [ ] Applied cleanly to your lane DB; `pg_get_functiondef` after shows `USING CONSTRAINT` on all five.
- [ ] At least two invariants proven visible to the counter by a test that failed before.
- [ ] typecheck clean · unit green · integration green both with and without the restricted flag.
- [ ] READY carries the real output of every gate, and states what you did for each of the five.
