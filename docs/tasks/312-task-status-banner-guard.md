# T-312 — nineteen shipped tasks have files that still say they have not shipped

> **STATUS: NUMBER RESERVED, SPEC NOT YET WRITTEN.** Allocated 2026-09-14 by the orchestrator
> (`system32-85`) at wrap-up. **Do not implement from this file** — write the spec first, in the
> format of `docs/tasks/2xx-*.md`, and have it approved.
>
> ⭐ **This file is itself an instance of the class it exists to close**, and will be the guard's
> first honest `NUMBER RESERVED` hit once T-312 ships. That is fine: the assertion is *"a task the
> roadmap marks DONE must not advertise itself as unstarted"*, not *"no file may say reserved"*.

## Where the substance already lives

⛔ **Do not re-derive this.** `docs/DEFECTS-REGISTER.md` **DEF-348** carries the measurement, the
list of nineteen, the reproducible query, and the reason the sweep alone is the wrong fix. **DEF-122**
is the same defect filed on 2026-09-02 against one of these exact files — **which is still wrong
today**, and is the single strongest argument in that register for guards over intentions.

## The assertion

**A task the roadmap marks `t-done` must not open with a banner saying it is unstarted.**

Cross-reference, per DEF-348:

1. Parse `t-done` task ids out of `docs/ROADMAP.html` — `<div class="task t-done"><div class="task-id">…`,
   which may name more than one id in a row (e.g. `T-303 · T-304`).
2. Derive each `docs/tasks/*.md` file's id from its numeric filename prefix.
3. Flag any file whose opening lines match
   `AWAITING APPROVAL|SPEC NOT YET WRITTEN|NUMBER RESERVED|not yet implemented|awaiting APPROVED|Number reserved`
   while its id is in the done set.

⚠️ **The roadmap is the authority.** A task file is written once and abandoned; the roadmap is
maintained. The guard must not be inverted into "the roadmap must match the task files".

## Why a test and not a sweep

⛔ **Correcting nineteen banners by hand restores exactly the state DEF-122 left behind on
2026-09-02** — correct, unguarded, and free to rot again. Twelve days later that instance had not
even been repaired, let alone generalised.

⭐ **`tests/unit/toc-freshness.test.ts` is the precedent**: a document-consistency fact the build
enforces rather than a person remembers. Same project (fast, no network, no database), same shape.

## Two things to settle in the spec

1. **What the banner should say for a shipped task.** The guard fails a file; something has to tell
   the next writer what "fixed" looks like. Propose a one-line convention and apply it to all
   nineteen as part of this task — ⛔ the repair is in scope, the guard alone is not the deliverable.
2. **Whether the phrase list is the right detector**, or whether the banner should carry a machine-
   readable status token instead. ⚠️ A regex over prose is the cheap version and will drift; a token
   is stricter but touches every task file. **Say which and why** — the cheap version may well be
   correct here, since the roadmap already carries the authoritative state.

## ⭐ Fix `130-accounts-payable.md` first

It is DEF-122's own subject. When it goes green, **say in DEF-122's row that it is finally closed** —
a defect whose subject is still broken twelve days after filing deserves to be closed by name.
