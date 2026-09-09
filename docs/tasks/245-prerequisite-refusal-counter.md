# T-245 — The prerequisite counter: measure which walls people actually hit

> **Status**: 🔒 **RESERVED — spec not yet written.** Number allocated by the orchestrator
> (`ianla-44`) 2026-09-09 for **lane E** (`ianla-60`). Lane E writes the spec into this file
> **in plan mode**, sends `[E] SPEC`, and stops until it receives `APPROVED`. Nothing is
> approved yet.

## Why this number exists — it is Ian's "COUNT FIRST"

Ian decided (roadmap, 8 Sep evening) that the ten pages that get tutorials are chosen by **ranking
the walls people actually hit**, not by judgement:

> *page-level intuition was wrong three times in two days on this codebase (a sweep that left 17
> branches behind, a filter-row count one short, a width census 50% high), and a page is not even
> the unit — 34 of 98 carry more than one top-level layout region.*

`docs/discovery/30-tutorials-assessment.md` §3 names the missing number precisely:

> *How often does anybody hit an order-of-operations wall? Nothing counts it — those **130**
> prerequisite-shaped sentences are thrown as errors and no telemetry records them. It is the
> number that should decide this feature's size… log a counter when a domain function throws a
> prerequisite-shaped refusal, run for a month, and the tutorial backlog sorts itself by real
> frequency.*

This task is that counter (discovery 30 §8, "T-2xx b", half a day). **It ships before any tutorial
prose is written.** Its output is data, and the data decides the next task's size.

## The design problem, which is why this spec is written in plan mode

There is **no single base error class.** The domain throws at least eleven bespoke ones —
`AdjudicationError`, `AdjustmentError`, `AttendanceConfigError`, `CredentialError`, `PunchError`,
`TerminalError`, `PolicyUnreadableError`, `EmploymentError`, `TransitShortfallBlockedError`,
`SalesDayBlockedError`, `LaneHealthError` — plus `AuthenticationError` / `AuthorizationError` in
`packages/auth/src/errors.ts`. So the spec must answer:

1. **What makes a refusal "prerequisite-shaped"?** *"A supplier needs a name people will recognise"*
   is a validation refusal; *"a supplier must exist first"* is a wall. Only the second is a tutorial
   trigger. Give the rule, and give three examples it correctly excludes.
2. **How is one recorded?** A structured log line, or a table? §8 says *no migration* — if you
   argue for a table, argue it explicitly and ask; the slot is available (see the briefing) but it
   is not assumed.
3. **How does the number get read back** on the production droplet (`159.223.46.224`), by someone
   who is not in a terminal?
4. **What stops the next domain refusal being written without a decision** — the guard test.

## ⛔ Slice 1 only. The 130-site sweep is NOT in this slice

Two other lanes are working in this tree right now. Applying a marker across all 130 throw sites
would collide with both. **Slice 1 is: the census, the mechanism, the read-back, the guard, and
wiring it end-to-end in ONE representative domain area** that proves the path really records
something.

Choose that area in the spec and name it. ⛔ It may **not** be under `packages/domain/src/stores/`
(lane B) or `packages/auth/` (lane D). The full sweep is slice 2, sequenced by the orchestrator when
the tree is free.

⚠️ **The sweep-control rule applies to the census** (bible §12, §13 row 181): a count that reports a
total must first report a **known non-zero control**, or a regex that matches nothing exits 0 and
reports a confident zero.

## Required reading before writing the spec

- `docs/RULES.md`, then `PROJECT_BIBLE.md` §3.3, §9, §15.6 (observability from day zero)
- `docs/discovery/30-tutorials-assessment.md` — **all of it**, especially §3, §7, §8, §10
- `PROJECT_BIBLE.md` §13 row 176 and §4.2 rule 7 — derived, never a stored counter that
  accumulates separately
