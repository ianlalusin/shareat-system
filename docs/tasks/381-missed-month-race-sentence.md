# T-381: the missed-month booking race answers in words (DEF-606)

**Status:** DONE 2026-10-07. Builder ran the mutants (no lock → R1-a/b red; asset-only → R1-b red; org-wide → R1-c red); A19 10/10; t345/t346/t368 110/110. SPEC 2026-10-07 (orchestrator, Opus). Blocks the push of `fe67577`: CI fails A19 on 2 of 2 runs.
**Model:** Sonnet tester, then Sonnet builder. **Migration:** none.

## Finding
`bookMissedMonth` (`packages/domain/src/missed-months/index.ts:136-153`) checks "already booked" by READING links and
posted periods, then writes. Two concurrent bookers of the same subject and month both pass the read; the loser is
stopped only by the 0174 trigger (`0174_t368_periods_depreciation_guards.sql:235,245`), whose message is a raw
`missed_month_adjustments: asset <uuid> already has a posted link …` (no constraint name, so no mapping to a sentence).
Money is safe (one entry posts). CI run 37622505921 failed A19 (`t345-missed-month.test.ts:831`) on both attempts.

## Ruling R1
Serialize bookers per subject: right after the subject is loaded (step 3) and BEFORE step 5's read, take a row lock on
the subject (`fixed_assets` or `prepaid_items` row, `FOR UPDATE`, org-scoped) through a NEW repo function in
`packages/db/src/repo/` (SQL lives only in the repo). The second booker then waits, re-reads after the first commits,
and throws the domain's own sentence `… is already booked for <P>`. The trigger stays as the backstop. No migration.

## Builder files
`packages/db/src/repo/fixed-assets.ts` and `packages/db/src/repo/prepaid.ts` (one lock function each, or one shared
helper in the repo — the builder's call; name it for what it locks), `packages/domain/src/missed-months/index.ts`
(call it after step 3, before step 5).

## Tests (tester first; integration, real Postgres, two real connections)
- R1-a (depreciation): connection 1 books (P) and does NOT commit; connection 2 starts booking the same asset and P —
  assert it is BLOCKED (has not settled after ~500 ms); commit 1; assert 2 rejects with `/already booked for/`, not the
  trigger text, and exactly one entry + one link. Mutant: remove the lock → 2 does not block (and/or gets the trigger text).
- R1-b: the same for a prepaid item. Mutant: lock only the asset path.
- R1-c: a DIFFERENT asset booked concurrently is NOT blocked (the lock is per subject). Mutant: lock a table or the org.
- A19 stays as is and must now pass deterministically.
