# T-317 — five guards for the class that beat the wrap-up ritual three times in one day

> ### **Status: SPEC APPROVED 2026-09-14 by `system32-85` (Opus planner). NOT BUILT.**
>
> **Ian, 2026-09-14:** *"how can we make every document updated always i included them already in
> wrap up skill the updating of these documents"* — then, on the answer below: *"go"*.

## Why this exists, and why more instruction cannot be the answer

⛔ **`.claude/skills/wrap-up/SKILL.md` ALREADY instructs exactly this, at full strength, and three
documents went stale under it today.** Not by omission — by design that cannot work:

| Line | What it already says |
|---|---|
| 95 | *"**What is now done, and what is next** &mdash; `docs/ROADMAP.html` — **every wrap-up, no exceptions**"* |
| 121 | *"⭐ The roadmap is updated EVERY wrap-up — Ian, 2026-08-28. **Not 'if it changed.'**"* |
| 139 | *"not-started — **the exact staleness this rule exists to stop**"* |
| 153 | *"`HANDOFF.md` … **it goes stale silently otherwise**"* |

⭐ **So the instruction is not the missing piece; the COMPARISON is.** Three reasons a ritual loses
this, all three demonstrated today:

1. **A wrap-up runs once a day; a fact goes stale the instant the code changes.** T-229 falsified
   DEF-193 in early September. Nobody re-read that row until it mis-costed two lanes on 09-14.
2. **A wrap-up can only fix what the reader NOTICES**, and all three were invisible to a careful
   one: `docs/ops/README.md` contradicted itself 230 lines apart (DEF-354); *"~5 weeks away"* reads
   as ordinary prose while being 3 weeks wrong (DEF-350); a register row nobody had cause to reopen
   (DEF-193).
3. **It asks a human to diff two documents** across 192 register rows and 207 task files — the one
   job a machine does perfectly and a person does badly at scale.

⭐ **The three tiers that DID work today, in order of preference — and this task is only tier 3:**
**delete** the moving fact (DEF-347's corollary: `HANDOFF.md` and `docs/ops/README.md` were both
fixed by deletion, never by refreshing) → **derive** it (DEF-350: the roadmap countdown is now
computed from an absolute date, which is Phase 6's *no figure is ever a hand-maintained counter*
applied to documentation) → **guard** it, when it can be neither deleted nor derived.

## Goal

Five assertions in the fast unit project, each earned by a defect filed today, so that a document
disagreeing with the code fails the build instead of waiting for somebody to notice.

## Scope — the only paths this task may create or modify

- `tests/unit/deferral-staleness.test.ts` — **guard 1 only**, because it already owns this marker
  family (T-220). Do not move its existing assertions.
- `tests/unit/document-facts.test.ts` — **new**; guards 2–5.
- `docs/DEFECTS-REGISTER.md` — ⛔ **marker insertions ONLY**, and only on rows guard 1 names. No
  prose, no state, no disposition changes. **Report any row whose state looks wrong; do not fix it.**
- `docs/tasks/317-document-facts-guards.md` — this file.

⛔ **Out of scope and orchestrator-owned:** `docs/ROADMAP.html`, `PROJECT_BIBLE.md`,
`docs/RULES.md`, `docs/CAPABILITY-GAPS.md`, `docs/HANDOFF-TODAY.md`, `docs/ops/README.md`,
`.claude/skills/wrap-up/SKILL.md`, any other `docs/tasks/*.md`. **The wrap-up edit is mine** — you
report which of its lines the guards make redundant; I remove them.

## The five guards

### 1. A register row asserting an ABSENCE must name what would falsify it — DEF-193

**The instance:** DEF-193 said *"nothing in the codebase can create or edit one"*. `createCategory`
and its form shipped with T-229; the row stayed `reported` for weeks and then cost two lanes a
wrong costing of Ian's staff-food allowance (*"small, but it is code"* against the honest answer:
**zero code, two screens**).

**Mechanism — extend T-220's existing marker family, do not invent a second one.** Two variants,
and the row's author picks whichever actually falsifies the claim:

| Marker | Goes red when |
|---|---|
| `STALE-IF-EXISTS: <repo-relative path>` | the path exists (T-220's existing form) |
| `STALE-IF-REACHABLE: <exportedSymbol>` | the symbol has a caller under `apps/` |

⭐ **`STALE-IF-REACHABLE` is the one DEF-193 needed**, and the repo already knows how to answer it:
`tests/unit/domain-actions-have-callers.test.ts` resolves `apps/` callers. **Reuse that resolution
rather than writing a second one** — two implementations of *"is this reachable"* is the drift this
whole task is about.

**Seeding, and this is the non-vacuity requirement:** a marker guard whose every marker is green has
proved nothing. ⛔ **Required red control, using real data rather than a synthetic:** a fixture row
carrying `STALE-IF-REACHABLE: createCategory` **must fail**, because that symbol is reachable from
`apps/erp/src/app/settings/expense-categories/page.tsx` today. **That is DEF-193's own case, turned
into the test that would have caught it.**
⚠️ Then apply real markers to register rows that currently assert an absence **which is still true**
(so they are green and honest). Find them; do not guess at a count.

### 2. No relative date in a document of record unless it is derived — DEF-350

**The instance:** four hand-typed countdowns on the roadmap rail, all correct as at 2026-08-24 and
all ~3 weeks stale, on *"the five dates that do not move"*. The worst said the 30 September gate was
*"~5 weeks away"* when it was **16 days** — on the one date the page itself calls *"the only part
that gets more expensive with delay"*.

**Mechanism:** scan `docs/ROADMAP.html`, `PROJECT_BIBLE.md`, `docs/RULES.md`,
`docs/CAPABILITY-GAPS.md`, `docs/HANDOFF-TODAY.md`, `HANDOFF.md` and `docs/ops/README.md` for a
relative-interval claim — `~N weeks away`, `N weeks away`, `N days away`, `N months away`,
`in N weeks`. Fail with the file, the line and the matched text.

⛔ **Two exemptions, both required or the guard is useless:**
- **A derived value.** The roadmap's countdown is now produced at runtime from a `data-until`
  attribute, so the source carries no number — nothing to match. If a file legitimately needs one,
  the exemption is that it is computed, not that it is exempt.
- **A quoted span.** DEF-350's own row quotes the stale values it corrects. **A document recording
  the defect is not committing it** — the ruling already established for T-256 and T-304 on
  2026-09-14 (DEF-348), and the same quote-stripping applies.

### 3. An arming or status claim in `docs/ops/README.md` lives only in a dated section — DEF-354

**The instance:** the `## The jobs` section asserted four units *"are **NOT YET ARMED**"* in the
present tense, while **the same file, ~230 lines below, records Ian arming the last of them** and a
measured `exit 0`. Three readers took the stale half in sequence; the third was the orchestrator,
who reported it to Ian as fact and put it on the trial-readiness checklist.

⭐ **This is bible §13 row 204's sharpest form: not merely stale, but CONTRADICTED INSIDE THE SAME
FILE — with the wrong copy nearer the top.** A reader who stops when they find an answer finds the
wrong one.

**Mechanism, deliberately narrow and deliberately file-specific:** in `docs/ops/README.md`, outside
a dated `## ` section, forbid a present-tense arming claim — `NOT YET ARMED`, `is armed`,
`currently armed`, `not armed`, `is enabled`, `unarmed`. Quoted spans exempt (the repaired section
quotes its own old claim, in the past tense, on purpose).
⚠️ **Say in the test's own header that it is scoped to one file and why** — the general problem
(*does this document contradict itself?*) is not mechanisable, and a guard that pretends otherwise
would be the wrong kind of confidence.

### 4. A roadmap-`t-done` task must have a task file — DEF-349

**The instance:** T-148 is `t-done` and `ls docs/tasks/148*` returns nothing, ever
(`git log --diff-filter=A` confirms it never existed). It shipped in `90da2d6` with migration
`0050` and a live caller — a RULES §1 rule 8 violation that went unnoticed for seventeen days
because every downstream reader had the capability in front of them.

**Mechanism:** every id in the roadmap's `t-done` set has a `docs/tasks/<id>-*.md`.

⛔ **It is RED today on T-148, so it ships with T-148 as a NAMED, CITED exemption** — the
`UNLINKED_BY_DESIGN` pattern this repo already uses — reading *"T-148: shipped `90da2d6` with no
spec file; DEF-349 owns the disposition."* ⭐ **And a second assertion deletes that exemption the
moment `docs/tasks/148*` appears**, which is T-220's lesson: an exemption that outlives its reason
is the next stale fact.

### 5. A task file claiming SHIPPED must have a roadmap row — DEF-352

**The instance:** roadmap coverage began at T-119, so 27 shipped tasks and 2 partial ones had no
row — which made T-312's banner guard **structurally blind to 31 task files**, and T-292 was
already a stale-banner instance sitting inside that blind spot. Backfilled 2026-09-14 in `ff31f07`.

**Mechanism:** a `docs/tasks/*.md` whose leading status claim says shipped/built/complete has an id
present in `docs/ROADMAP.html`. **Reuse T-312's leading-claim extractor** — quote-stripping and the
`ORIGINAL STATUS` cut included. ⛔ **Do not write a second one.**

⚠️ **This one may be green with no exemptions after `ff31f07`, which makes non-vacuity the whole
risk.** Assert a non-zero scanned population **and** prove the mechanism with a synthetic row that
claims shipped and has no roadmap id.

## Invariants, with citations

1. **Every guard is seeded RED against a real instance, or against a real-data fixture where the
   instance is already repaired** — RULES §3.2, *a test that only ever passed proves nothing*.
2. **Every guard asserts a non-zero scanned population** — DEF-179: a scanner that silently matches
   nothing is indistinguishable from a clean tree, and it nearly shipped that way once already.
3. **CRLF-safe by construction.** This repo checks out `core.autocrlf=true`; `.` does not match
   `\r`. Normalise before any line-oriented match (DEF-179).
4. **Unescaped-pipe counting, never `split('|')`**, anywhere a register row is parsed — an escaped
   pipe renders inside a cell and splits nothing. The first audit of that kind reported **83**
   malformed rows and was wrong by about fifty (DEF-353).
5. **A quotation is not a claim.** Quote-stripping and the `ORIGINAL STATUS` cut are required
   wherever a document records a defect it once committed (DEF-348's corrected assertion).
6. **No second implementation of a question the repo already answers** — `apps/` reachability comes
   from `domain-actions-have-callers`, leading-claim extraction from `task-status-banner`. Two
   answers to one question is the drift this task exists to prevent.

## Tests

Per guard: the real assertion · a **must-fire** control · a **must-not-fire** control where a
legitimate lookalike exists (a quoted span, a derived value, a dated section) · and the non-vacuity
assertion. ⭐ **Guard 1's must-fire control uses `createCategory` and real data**, not a synthetic —
it is DEF-193's own case rendered as the test that would have caught it.

## Out of scope

- Any prose, state or disposition edit to a register row. **Markers only.**
- A general *"is this defect still true"* sweep. **Not mechanisable** — mark only rows asserting an
  absence, and say so in the test header.
- A general *"does this document contradict itself"* check. Guard 3 is one file, on purpose.
- Repairing T-148's missing spec file. ⛔ DEF-349's disposition forbids a retrospective spec: one
  written to satisfy a guard is a second copy of the roadmap's claim, not evidence, and it would
  make the absence permanently undetectable.
- **The wrap-up skill edit.** Report which lines the guards make redundant; the orchestrator removes
  them.

## Done when

- Five guards exist in the two named files, each with its RED capture recorded in the READY message.
- `npm run typecheck` clean; `npm run test` green; no integration test needed — state that if it is
  your conclusion.
- Guard 4's T-148 exemption is present, cited, and paired with the assertion that deletes it.
- The list of wrap-up lines the guards supersede is in the READY message, not edited into the skill.
- ⚠️ **Not in done-when:** proof that no document is stale. These five close five measured holes;
  they do not make the class impossible, and the honest limit — *no guard catches a prose claim
  nothing else in the repo knows about* — belongs in the test headers, not in a promise here.
