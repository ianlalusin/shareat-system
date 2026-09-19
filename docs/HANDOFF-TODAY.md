# Handoff — 2026-09-19

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED: *"make the app as close as possible to deployment."***
> ⚠️ **AND IT IS NOT LAUNCHED YET.** A previous session assumed "deployed to production" meant "staff
> are using it" and warned about live cashiers. There are none. That changes urgency, never
> correctness. ⛔ **This document makes no PRESENT-TENSE claim about which commit production runs**
> (DEF-360). Ask `/api/health` and compare all forty characters against `git rev-parse origin/main`.

## Where things stand

**T-324 is COMPLETE, both slices.** `1404609` (the cap — deployed, CI green with real Postgres,
production verified at all 40 characters) and `d776758` (the way to declare it — committed, **not
yet pushed at the time of writing; check**). **Closed: DEF-357 and DEF-366.**

A cash handover is now capped **per cashier account**: an account may not hand over more than it
*moved* over the settleable dates, plus whatever overage was declared on its own lines; the pooled
total is bounded separately against what the days owe. Before this, **nothing bounded it at all** —
134 migrations grepped, no CHECK, no trigger, no domain guard.

### Gates at wrap-up — real numbers

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0**, clean |
| unit | **1778 passed**, 1 skipped, 129 files, exit 0 |
| integration | **39/39** on lane DB `shareat_test_t324_builder` |
| `npm run build` | **exit 0**, 9008 free |
| CI (slice A) | ✅ green, and **`Integration tests (real Postgres) :: success`** confirmed at step level |

⚠️ **The build's "1 error line" is the known red herring** — a source line containing
`throw new Error(...)` quoted inside a pre-existing Turbopack warning. **Check it the same way each
time; do not start ignoring it.**

## ⛔⛔ 1. THE ONE RULE THIS DAY EARNED, AND IT COST EIGHT INSTANCES

**A LINE NUMBER IS A CLAIM WITH A SHELF LIFE MEASURED IN COMMITS. GREP THE ANCHOR, NEVER THE NUMBER.**

Eight times in two days a line number went stale and misled somebody. Not one was a careless edit:
an 11-line interface comment, a 5-line doc rewrite, a 6-line pointer restoration. **Twice the stale
number was inside a correction to an earlier stale number.** It cost: 25 spec citations, a builder's
placement instructions for a money check (which would have put it in the wrong place), and **three
separate renumbers of a unit-test census — one of which shipped red because the session that broke
it ran only `typecheck` and called that enough.**

⭐ **Both lanes were told to grep rather than trust, and both caught a wrong number sent by the
orchestrator.** That is the mitigation that works. `docs/tasks/324-*.md` now opens with an anchor
table instead of trusting its own citations.

## ⭐⭐ 2. §9.4 FOUND WHAT NO GREEN GATE COULD, TWICE IN ONE TASK

1. **Acceptance failed with a raw Postgres error on the operator's screen** — `0154` was applied to
   the two lane test databases and **not to the dev database the app runs against**. Typecheck,
   1,778 unit tests and 39 integration tests all ran against databases that *had* it. Only the
   screen could see it. **Production was never exposed** — `deploy.yml` migrates inside its unpack
   step, and *that step's own conclusion* was confirmed rather than the run's overall green. It also
   surfaced **DEF-378**.
2. **A blocking fix was invisible to every test we have.** The wiring guards read *source text*, so
   they see a conditional's contents whether or not it renders. The tester observed this and did not
   draw the conclusion — that the fix was verified by nothing. Settled by driving a store with a
   held-back day and no remittable day, reading the DOM rather than a screenshot.

⭐ **Also this shape:** the unit suite was green while `tsc` was red **on the same file** — vitest
strips types without checking them. A green suite is not evidence a file compiles.

## 3. Pick up here

1. ⛔ **PUSH `d776758` AND THE DOC COMMITS IF NOT ALREADY DONE.** `git log origin/main..HEAD`.
   ⚠️ A push to `main` **auto-deploys**. Slice A alone blocked any handover needing a declaration;
   slice B removes that, so shipping them together is correct.
2. **DEF-376 — the structural fix is now OWED.** Its own trigger ("two shifts, the third is the one
   to act on") fired the same day it was written. The guard is keyed by `file:line`, and it cannot
   tell a correct renumber from a wrong one: assertions are key-presence only, `m.raw` is captured
   and used only to print. Its positive control is hard-coded to a line number too — renumber that
   onto a site the scan still matches and **the control passes while controlling nothing.**
3. **DEF-380** — a positive variance can only be *charged to someone* or *written off*, both
   short-only remedies, and **T-324 makes positive variances routine.** Decide what resolving a
   surplus means before building a control; the likely answer is "attribute it when the day is
   verified", which may mean automatic rather than a button.
4. **DEF-378** — the error sanitiser covers only errors naming a constraint. Reachable in production
   without any deployment drift, via the truncation class already in this register.
5. **DEF-379** — `parseMoneyInput` is not exported from `@shareat/domain`, so the app layer cannot
   use the cashier-readable money error at all. Add a `./money-input` subpath **and sweep**.
6. **DEF-374** — READ COMMITTED, nothing locked: two concurrent handovers both pass.
7. **T-320** — still a placeholder, no spec. Take **DEF-367** with it.
8. **DEF-373** — `deploy-preflight.ts` has no denylist. Security-relevant, unspecced.

## 4. Traps that bit today

- ⛔ **`gh api …?head_sha=<sha>` RETURNED `total_count: 0` FOR A COMMIT WITH TWO RUNS ON IT.** Exit 0,
  no error, flatly empty. The unfiltered list showed both. **Trusting it would have reported that CI
  never ran.** Use the unfiltered list and filter locally.
- ⛔ **A "killed for memory" notice does NOT mean the child died.** Both emulators and the dev server
  kept serving after their wrappers were reaped. Check the port, **then check functionally.**
- ⛔ **`callers.mjs` cannot attribute an edit to a session in a shared tree.** It flagged the tester's
  untracked file as a forbidden path on every builder run, every round. Quote it; never treat it as
  proof of who wrote what.
- ⛔ **Disjoint PATHS are not disjoint STATE.** A test run executes the other lane's source by
  definition. While a builder is mid-edit, every run the tester does measures a moving target.
- ⚠️ **Chrome returned a STALE screenshot** showing a previous page after a completed navigation, and
  timed out on CDP three times. Cross-check against `location.href`.
- ⚠️ **`next-env.d.ts` flips** after a build. Revert it; never commit it.

## 5. Numbers to allocate from

Next task **T-325** · next defect **DEF-381** · next migration **`0155`**
⛔ **`0154` IS APPLIED — never edit it.** Reserved, do not re-issue: `0149`/`0150`/`0151`.

## 6. Live agent sessions

⛔ **ASK A SESSION ITS MODEL; NEVER READ IT OUT OF THIS TABLE** (DEF-361).

| Session | Role | State |
|---|---|---|
| `system32-4f` | orchestrator | **clear it** |
| `webapps-9e` | TESTER | idle, frozen, clean. Sonnet. ⭐ Found the loose refusal matchers, three type errors `tsc` never reported, a fourth paren-scanner with the same bug, and the migration gap — none of them asked for |
| `webapps-71` | BUILDER | idle, frozen, clean. Sonnet. ⭐ Refused to migrate a database it did not own; refused a fix that would have made things worse and asked instead |
| `webapps-f8` | AUDITOR | idle, clean. **Opus.** ⭐ Found two defects hiding each other, a regression test our own slice had disarmed, and argued the orchestrator out of a wrong filing decision |
| `webapps-5a` | **UNKNOWN — foreign** | appeared ~11:00, never identified. Touched nothing in T-324's paths (verified against the frozen reference object). **Ask Ian.** |

⚠️ **`docs/reviews/NEXT-PROMPT.md` (modified) and `docs/reviews/2026-09-17.md` (untracked)** are an
exited session's, deliberately uncommitted since 2026-09-17. **Leave them.**

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED. Production
deploys exist; no staff use it yet. That changes urgency, never correctness.

⭐⭐ THREE SESSIONS, THREE FIXED ROLES: a TESTER who writes the red and drives the real screen, a
BUILDER who makes it green and never edits a test, an AUDITOR who runs /code-review READ-ONLY on
every slice. Read SKILL.md §2 before briefing anybody. ⛔ GIVE EACH LANE ITS LANE DB IN THE
BRIEFING — a slice B briefing dropped it, the builder had no alternative, and it ran against the
SHARED database.

⛔⛔ THE RULE THIS PROJECT EARNED ON 2026-09-19, AT THE COST OF EIGHT INSTANCES: A LINE NUMBER IS A
CLAIM WITH A SHELF LIFE MEASURED IN COMMITS. GREP THE ANCHOR, NEVER THE NUMBER. Twice the stale
number was inside a correction to an earlier stale number. Tell both lanes to grep what you send
them; both caught a wrong number from the orchestrator that way.

⛔⛔ BIBLE ROW 214 HAS A MIRROR AND IT IS THE HIGHEST-YIELD CHECK YOU HAVE: a PRESERVED line can be
falsified by a change made elsewhere, and a deletion audit is structurally blind to it. IT NEEDS A
SEARCH FOR THE OLD CLAIM, NOT A READ OF THE DIFF. On 2026-09-19 it found three stale screen
paragraphs and a regression test our own slice had silently disarmed — the test still ran, still
passed, and no longer detected what it was written for.

⛔ §9.4 IS NOT A FORMALITY. Twice in one task it found what no green gate could: a migration applied
to the test databases but not the dev one (invisible to typecheck, 1,778 unit tests and 39
integration tests, because they all ran against databases that had it), and a blocking fix that
source-reading guards cannot see at all because they read text whether or not it renders.

⛔ VERIFICATIONS THAT LIE, ALL OBSERVED: `gh api ?head_sha=` returned total_count 0 for a commit with
two runs on it. A "killed for memory" notice does not mean the child died — check the port, then
check FUNCTIONALLY. callers.mjs cannot attribute an edit to a session in a shared tree. vitest was
green while tsc was red on the same file. Chrome returned a stale screenshot after a completed
navigation. DO NOT QUOTE A VERDICT LINE YOU HAVE NOT READ THE BODY OF.

Read: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md rows 204-215, DEFECTS-REGISTER.md
section E. ⛔ GREP the big ones — the register is ~1MB and the bible ~418KB.

⛔ T-324 IS COMPLETE AND PUSHED: 1404609 (cap) + d776758 (the declaration UI). DEF-357 and DEF-366
are closed. Do not re-open them.

NEXT UP, in the order a previous orchestrator would take them: DEF-376's structural fix (its own
trigger fired), DEF-380 (positive variances have no correct remedy and T-324 made them routine),
DEF-378, DEF-379, DEF-374, then T-320 (+DEF-367) and DEF-373.

Next task T-325 · next defect DEF-381 · next migration 0155.

-----------------------------------------------------------------------------------------------
