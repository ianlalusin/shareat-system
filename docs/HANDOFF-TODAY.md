# Handoff — 2026-09-12

## Where things stand

**Everything yesterday's handoff named as blocking the production database role switch is built
and pushed.** All three of bible row 194's cross-organisation subsystems now go through
`systemTransaction()`, and Ian ruled the one question that was reserved for him. Four tasks shipped
(T-267 – T-270), seven defects filed, one bible row added.

**Nothing is half-built and nothing is mid-flight.** Both worker lanes were brought to a clean stop
at a task boundary with no uncommitted work of their own.

⭐ **DEF-218 IS CLOSED. The restricted role is ON BY DEFAULT, and the production database role
switch is unblocked.** The flip was held back all evening for one reason — all 115 files had been
seen green only *in pieces*, two halves plus re-runs with a migration landing in between, and
*"it was green in parts"* is a belief rather than a measurement. The single clean run finished
after the wrap-up began: **116 files / 2747 tests / 0 failed, one invocation, quiet machine,
migration 0142 applied.** The flip was then made and **verified three ways** rather than assumed
(§Gates).

⚠️ **What remains is Ian's, not an engineering step:** actually tightening `DATABASE_URL` on the
production host. Nothing in the codebase blocks it now.

---

## Gates at `f0aebed`

⚠️ **Measured at `f0aebed`, the last commit that changed CODE.** Everything after it is documentation — registers, roadmap, task statuses, this file. Stating the code sha rather than `HEAD` because a gate number is only true of the tree it was run against.

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0**, clean |
| `npm run test` (unit) | **97 files · 1351 passed · 1 skipped** |
| `npm run build` | **exit 0** (run twice today, dev server stopped first and process-verified both times) |
| Smoketest on 9008 | **passed** — `/sign-in` 200; `/setup` with a forged setup cookie returns *"This system is already set up."* |
| Integration, **default** role | green |
| Integration, **restricted** role | ⭐ **116 files · 2747 passed · 0 failed** — one clean single invocation, 1642s, quiet machine, `0142` applied |
| The DEF-218 flip itself | ⭐ **proven, not assumed** — throwaway probe run three ways then deleted: unset → `shareat_test_runner`; `=0` → `postgres`; `=1` → `shareat_test_runner`. Post-flip sample with **no flag at all**: 6 files / 51 passed |

⚠️ **Every number above was re-run by the orchestrator on its own database, never accepted from a
lane.** Each lane's numbers matched on every slice.

⚠️ **The smoketest cannot prove the fix, only the absence of regression** — local dev connects as
`postgres` with `rolbypassrls = t`, so `systemTransaction()` and `transaction()` are byte-identical
there. The proof is the restricted-role integration suite.

---

## What happened this session

### The routing, which was the whole point

| Task | Sha | What |
|---|---|---|
| T-267 | `a381b84` | Till-event org resolution · orphaned-file sweep (DEF-287) · **two of three** bootstrap sites · two guard repairs |
| T-268 | `7f621ff` | The ETL pipeline (DEF-289) — ⚠️ **8 call sites, not the 6 on record** |
| T-269 | `9793175` | DEF-297 + DEF-298 in the orphan sweep · the third bootstrap site |
| T-270 | `f0aebed` | DEF-279, migration `0142` — the five invariants name themselves |

**Ian's decision, recorded in `PROJECT_BIBLE.md` §13 row 195** (`869bdba`): the bootstrap question
*"has this system been set up at all?"* goes through bootstrap's own door rather than widening the
auth door. ⚠️ It was asked in **three** places, not the one the handoff reserved — and
`scripts/bootstrap-org.ts` contradicted itself, guarding with an unprincipalled read before a write
that already used `systemTransaction()`. Bible version bumped to 3.14; it had been stale since
2026-09-09, so rows 190–194 had landed without one.

### ⛔ The four findings worth more than the tasks they came from

1. **DEF-299 — `sweepOrphanedFiles` has no production caller and never has.** No systemd unit, no
   npm script, no route; four calls, all in its own test file. ⭐ **This recontextualises DEF-298**,
   the data-loss race found the same afternoon: it has never fired. A landmine, not a bleed — and
   worse for it, because whoever eventually scheduled that cron would have done so believing it had
   been running safely for months. **Both bugs are now fixed, so it is safe to wire. It was not
   this morning.**
2. **DEF-279's recorded disposition was wrong, and had survived a ruling.** `USING CONSTRAINT`
   populates `err.constraint_name`, never `err.message` — which is what `parseConstraintName`
   reads. The fix on record since 2026-09-10 would have applied cleanly, looked right, and changed
   nothing. ⛔ **A disposition in the register is a hypothesis too.**
3. **DEF-295 — a guard scanning two of nine source roots** while asserting *"no file outside the
   closed list."* `scripts/` was unscanned though the guard *requires* a caller from it, as was
   `packages/etl/src` — the package T-268 was about to add six callers to. ⭐ Its positive control
   (`files.length > 50`) could never have caught this: **a control on the SIZE of a scanned set
   says nothing about whether it is the RIGHT set.**
4. **DEF-296 — a staleness check that could not detect staleness.** It verified the exempted file
   still *existed*, never that it still *needed* the exemption. Found three dead entries, one stale
   for weeks and unrelated to today.

### Where the orchestrator was wrong, which is the useful part

- ⛔ **In a shared tree you cannot take a baseline after a lane has started.** Lane A reported my
  red table was wrong; verifying, I measured 0 red on two databases and briefly concluded the lane
  had erred. It had not — it had already applied its fix to the shared tree, so I was measuring the
  fix and calling it a baseline. **Only the lane's own pre-edit measurement is a baseline.**
- ⛔ **A census run concurrently with a build is not a census.** I caused three phantom failures in
  lane B's census that way. Re-run quiet: 44/44 in 85 seconds.
- ⛔ **Prefer the codebase's own checker over a fresh regex.** My grep said a file still reached a
  raw handle; it was counting matches inside comments. The guard's comment-stripping function was
  right.
- ⛔ **The scope I added was the part that broke.** I widened `errorMessage` when only the counter
  needed it, replacing a precise accounting sentence with a content-free one. Reverted.

---

## Pick up here

⚠️ **The flip is DONE — do not redo it.** `tests/integration/setup.ts` is opt-OUT now. If you need
a permissive run for debugging, `INTEGRATION_RESTRICTED_ROLE=0`, and ⛔ say out loud that you did:
a green run with the flag at `0` proves nothing about tenancy.

**1. T-264 slice 3 — the fiscal-period override.** Unblocked now the routing has landed. Needs a new
`override_period_lock` capability and **migration slot 0143** (`when` must exceed `1798342307084`).
⛔ Non-negotiables are in `docs/tasks/264-*.md`: reuse migration `0005`'s transaction-local GUC so
an unset flag fails **closed**; set the flag only after `authorize()`; never implement the override
in TypeScript around the trigger; **watch a manager's override be refused before wiring the
exemption.**

**2. The year-close journal entry** (ADR-006), still unassigned: one entry via `postEntry`, dated
the following Jan 1, zeroing income/expense into 3300, with a distinct `source_type`.

**3. DEF-299, once Ian rules** — wiring the orphan sweep to a timer, on the pattern of the six in
`docs/ops/`. Both its bugs are fixed, so it is safe now; it was not this morning.

⚠️ **Exit code 0 is not a result.** A killed background census reported exit 0 twice today, and a
completed one reported exit 0 while its own summary said 3 tests failed. **Read the output.**

---

## Do not decide these alone — they are Ian's

| Question | Recommendation on the table |
|---|---|
| **DEF-299** — should abandoned uploads be swept at all, and on what schedule? | Wire it, on the pattern of the six existing timers in `docs/ops/`. Both its bugs are fixed. ⛔ Wiring it before today would have started deleting bytes out from under just-claimed files on night one |
| **DEF-293 / DEF-294** | Two findings against ratified ADR-006 — a close gate that can never fire, and three of five gates that are continuous rather than period-scoped. Neither implies a code change. Untouched today |
| **DEF-301** | The message map matches by raw-text substring, so a key for DEF-279's five would match nothing, silently. Fixing it changes what *every* already-mapped constraint renders — **its own task with a before/after pass**, never a drive-by |

---

## Traps that have actually bitten — live in this area right now

- ⛔ **`git status` can lie about another session's file.** It reported one clean while
  `git hash-object` already differed from `git rev-parse HEAD:<path>`. **Run
  `git update-index --refresh` first.** Two reads of the same line seconds apart disagreed because
  a lane was writing it — use one authoritative command, not two that agree by luck.
- ⛔ **Never `git stash` in this tree.** It sweeps every session's work, and untracked files have no
  recovery path. To answer *"is this mine?"* use `git diff HEAD -- <path>`.
- ⛔ **Never `npm run test:integration`** — it hits the shared database and truncates a peer's
  fixtures mid-run. Give every lane its own DB (`make-test-dbs.mjs`). No collision all day.
- ⛔ **Stop the dev server before `npm run build`** and verify by process enumeration, not by
  intent. A build clobbers the `.next` a dev server is serving and presents as a phantom
  application bug in whatever you happen to be testing.
- ⚠️ **In PowerShell, `VAR=1 cmd` does not set the variable.** Use
  `$env:INTEGRATION_RESTRICTED_ROLE=1` as its own statement, or the suite passes and you conclude
  nothing is broken.
- ⛔ **Never add an RLS policy to make the app role work on the ETL tables.** They carry FORCE RLS
  with zero policies *by design* (`0011:142-160`) and hold captured production PII. A policy that
  admits the app role admits every tenant.
- ⭐ **Ask a lane a question, not only for a change.** T-267's invariant 4 asked *"does the sweep's
  delete actually delete?"* That one sentence produced DEF-297, DEF-298 and DEF-299. None would
  have been found by a test.
- ⭐ **Name the expected reds in the briefing.** Both lanes hit guard failures that were correct
  consequences of correct work; because the briefing predicted them by name, both reported them
  verbatim instead of "fixing" a shared guard.

---

## Live agent sessions at wrap-up

| Session | Lane | Model | Lane DB | State |
|---|---|---|---|---|
| `webapps-4e` | A | Sonnet 5 | `shareat_test_lanea` | **released, idle**, no work in flight. Built T-267, T-269, T-270 |
| `webapps-65` | B | Sonnet 5 | `shareat_test_laneb` | **released, idle**, no work in flight. Built T-268 |
| `system32-85` | orchestrator | Opus 5 | `shareat_test_orch` | this session — clear it |

⭐ **`webapps-65` was brought onto the team by Ian today**, reversing yesterday's *"reports to you
but does not take orders from you."* He pasted the worker line and ran `/model sonnet` himself.
⛔ **Confirm with Ian before assuming that again** — it was a decision for one day, not a standing
change.

**Worker lanes stay alive and are re-adopted; only the orchestrator is cleared** (CLAUDE.md, Ian
2026-09-07).

---

## The paste-ready prompt

```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system), picking up
from the 2026-09-12 handoff. Run the global /orchestrator skill.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §3/§9/§13 rows 194-195,
docs/DEFECTS-REGISTER.md section E (DEF-295 to DEF-301 are today's).

DEF-218 is CLOSED and the restricted role is on by default — do not redo that flip. Your first
job is T-264 slice 3, the fiscal-period override; §Pick up here has its non-negotiables and its
migration slot. Tell Ian that tightening DATABASE_URL on the production host is now unblocked and
is his call, not an engineering step.

Two worker sessions are alive and idle and are yours to re-adopt: webapps-4e (lane A,
shareat_test_lanea) and webapps-65 (lane B, shareat_test_laneb), both Sonnet 5. Confirm with Ian
before tasking webapps-65 — it joined the team for one day only.

Migration slot 0143 is free; `when` must exceed 1798342307084. Next task T-271, next defect DEF-302.
```
