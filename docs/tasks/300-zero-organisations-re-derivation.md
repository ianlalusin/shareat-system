# T-300 — nine documents assert production has zero organisations; it has one

> **Status: RESERVED 2026-09-13 by system32-85 — dispatched to lane C (webapps-f7, Opus 5).**
> Number reserved before dispatch. Spec to be written by the lane and approved by the
> orchestrator before any edit.

## The measurement

`/var/log/shareat/budget-reissue.log` reads `budget-reissue: ok — created 0 · 1 orgs`, naming
**SHAREAT OPC**.

⭐ **The orchestrator derived what that number counts rather than quoting it.**
`scripts/budget-reissue.ts:74` prints `result.outcomes.length`. Outcomes come from
`listOrgsToRun(options.orgId)` with `orgId` **undefined** (the timer passes no `--org`), which is
`packages/db/src/repo/scheduler.ts` →
`select id, name from organizations where undefined order by name` — **no status filter, no active
filter, every row** — and it runs through `systemTransaction`, the system door, so RLS is not
hiding rows from it either. So `1 orgs` is a true `count(*) from organizations`.

**The premise holds. It is now derived, not quoted.**

## ⛔ Re-derive each, do not patch the number

`grep -rl "zero organi[sz]ation" docs/` returns nine files (20 assertions).
The premise was load-bearing in real conclusions — patching `zero` to `one` destroys the evidence
that the conclusion was reached on a false figure.
