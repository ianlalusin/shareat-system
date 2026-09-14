# T-313 — the register's own row shape, guarded

> ### ✅ **Status: SHIPPED 2026-09-14 in `22d8697`, together with all thirty-three repairs.**
> See `docs/ROADMAP.html` (search `T-313`) for the outcome — the roadmap is the maintained record.
>
> ⛔⛔ **THIS FILE WAS WRITTEN AT WRAP-UP, AFTER THE TASK SHIPPED. THAT IS A RULES §1 RULE 8
> DEVIATION AND IT IS RECORDED HERE RATHER THAN TIDIED AWAY.** The rule is *no implementation
> without a written task spec in `docs/tasks/`*. T-313 was specified in an orchestrator briefing
> message to lane B and built from that message; **the number was allocated and the file never
> created.** Caught by the wrap-up's own roadmap pass on the same day, not by a guard.
>
> ⭐ **It is the live instance of DEF-349, committed by the session that filed DEF-349.** That row
> records T-148 as shipped with no spec file and unnoticed for seventeen days. This is the same
> defect, seventeen days' warning ignored, by the same orchestrator, within hours of writing the
> row about it.
>
> ⚠️ **Why this file exists at all, given DEF-349's disposition forbids a retrospective spec:** that
> ruling is about **archaeology** — reconstructing intent for a task that shipped weeks ago from a
> commit message, which produces a second copy of the roadmap's claim rather than evidence. This
> task shipped **today, in the session writing this**, and everything below is first-hand rather
> than inferred. ⛔ **The distinction is the date, and it is not a licence:** a file written days
> later would be the thing DEF-349 forbids, and the honest fix for the next occurrence is guard 4
> of T-317, which fails the build the day a `t-done` task has no file.

## Goal

A `docs/DEFECTS-REGISTER.md` row whose cell count disagrees with its section's header fails the
build, so `State` and `Disposition` cannot silently render in the wrong columns.

## Why it was needed — DEF-353

Closing DEF-346 and DEF-349 meant editing their cells, so the edit script asserted their rows were
well-formed first. They were. **Thirty-three others were not.** Two causes: 23 section-E rows
carried a stray `App` cell from the A–D schema, and 7 had an unescaped pipe inside inline code —
⛔ **DEF-303's `Defect` cell ended mid-sentence and the next opened `grep -i budget`, because a
shell pipeline was written inline and the pipe split the cell.** That is lost content in the
document of record, not a parsing inconvenience. Plus 1 row missing a cell entirely, and 2 where a
bare pipe had been used as an inline divider.

⭐ **DEF-348's pipe bug was one instance of thirty-three**, and the class was only visible because
a script refused to edit a row it could not parse.

## Contract

- Read each `## [A-E].` section's **own header row** to learn that section's column count.
  ⛔ **Never hardcode one** — sections A–D carry an `App` column and E does not, and hardcoding
  either is how the first audit condemned about fifty correct rows.
- Count **unescaped** pipes per `DEF-` row. ⛔ **Never a naive split on the pipe character** — a
  backslash-escaped pipe renders inside a cell and splits nothing. That error produced a count of
  **83** malformed rows, wrong by roughly fifty.
- Fail naming the row, its section, its count and the expected count.

## Invariants

1. **Non-vacuity** — a non-zero section count and a non-zero row count are asserted. A scanner that
   silently finds neither is indistinguishable from a clean register (DEF-179).
2. **An escaped pipe counts as zero separators** — pinned by a fixture comparing a row containing
   one against the same row with the sequence deleted.
3. **An unescaped pipe inside backticks still counts** — the opposite direction: a code span is not
   a shield. This is what DEF-303 proves.
4. **CRLF-safe** — this repo checks out `core.autocrlf=true` and `.` does not match `\r` (DEF-179).

## Tests — 8, as shipped

Non-vacuity · the per-section column-count pin · the real assertion · the escaped-pipe control ·
the unescaped-pipe-inside-backticks control · a fires-on-a-bad-synthetic-row control · a
silent-on-a-good-synthetic-row control · a CRLF regression.

## Out of scope

- Repairing the thirty-three. Done by the orchestrator in the same commit; the register is the
  orchestrator's row (§1 rule 14's sibling — a worker reports a row, it does not write one).
- `PROJECT_BIBLE.md` §13. **Deliberately not covered**, and that gap became **DEF-359** the same
  day: six §13 decision rows are malformed by the identical class, three of them consecutive and
  recent. T-317 guard 6 owns it.

## Done when

✅ All met 2026-09-14: guard green against the repaired register (8/8, run by the orchestrator), its
RED capture listing exactly the thirty-three taken before any repair, `npm run typecheck` clean,
and the full unit suite green.
