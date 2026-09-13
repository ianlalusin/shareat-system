# T-307 — nothing asserts that CI's own environment block satisfies the app's startup contracts

> **STATUS: NUMBER RESERVED, SPEC NOT YET WRITTEN.** Allocated 2026-09-13 by the orchestrator
> (`system32-85`) so the number cannot be taken twice — that has happened before, on 2026-08-31,
> when two sessions took task 196 and DEF-117 within 2m40s. **Do not implement from this file.**
> Whoever picks this up writes the spec first, in the format of `docs/tasks/2xx-*.md`
> (goal · scope · contract · invariants · tests · out of scope · done-when), and has it approved.

## Where the substance already lives

⛔ **Do not re-derive this.** The analysis is complete and sits in **`docs/DEFECTS-REGISTER.md`,
DEF-329**. That row already:

- names the fix — a unit test that parses `ci.yml`'s `env:` block and runs it through the same
  contract logic the application uses at startup;
- argues its **location** — the FAST project, deliberately, so it costs nothing on every run;
- **costs and rejects** the obvious alternative on a measurement rather than a preference
  (`.env.example:56` and `:78` are blank by design, so asserting against that file proves nothing).

**There was nothing left to decide, only to schedule.** That is why this is a task and not a
question.

## Why it is a task and not one of Ian's decisions

⚠️ **It was briefly filed under the handoff's *"Do not decide these alone — they are Ian's"*, and
that was a mis-routing.** The words there were *"unbudgeted, needs a task number"* — a **sequencing**
statement — under a heading that reads them as a **decision-rights** statement.

Checked against `docs/RULES.md`: this amends no bible row (§14), removes no capability (§1.2),
widens no door on the closed cross-org caller list (bible row 194), and deploys nothing. It adds one
assertion over data already committed to the repository. **§0.1 governs — Ian describes WHAT, Claude
decides HOW, and a test asserting CI's own env block is HOW.**

## Why it is worth doing, in one line

**DEF-328 was CI red for a one-character mismatch between two placeholder project ids**, and nothing
caught it but a person reading the log. That block is hand-maintained filler nothing asserts anything
about, so **the next contract the startup guard learns will break CI the same silent way.**

## ⚠️ Read before scoping — it may belong with DEF-336

**DEF-336** (the `CI` workflow was disabled by hand and every push went inert, unnoticed for nine
hours) is the same shape one level up: *nothing checks that CI is what we think it is.* T-307 asserts
CI's **contents** are valid; DEF-336's guard asserts CI **runs at all**.

⛔ **Whether these are one task or two is an open question put to lane C on 2026-09-13 and not yet
answered.** Resolve it before writing the spec — do not assume two.
