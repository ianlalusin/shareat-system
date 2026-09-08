# Handoff — 2026-09-08 (evening) — for the NEXT ORCHESTRATOR

> **You are taking over as the ORCHESTRATOR of a running four-lane team.** All four worker sessions
> are ALIVE on this machine and parked clean at `6a3b9ac` — **re-adopt them by name, do not
> respawn.** Only the orchestrator is cleared at a milestone (`CLAUDE.md` § "Orchestrated sessions
> hand over"). **Do the same when you cross the next one.** Ian invokes `/orchestrator shareat
> system` in your terminal himself; the skill is user-invocation only — run the role from this file
> until he does.

## Where things stand

`main` is at **`6a3b9ac`**, pushed, **tree clean, every lane at a task boundary**. Six commits this
session, five tasks, eleven defects closed. **Ian's responsive shell (T-234) is SHIPPED** — the
sidebar becomes a rail and a drawer, and all 101 pages take their width from one rule. The
production sign-in is **still his and still the milestone**: T-232 has been deployed since this
morning and nobody can do that step but him.

## Gates at `6a3b9ac`

typecheck **exit 0** · unit **75 files, 1151 passed / 1 skipped** · integration **107 files, 2628 passed** (full `npm run test:integration` on `shareat_test` at HEAD, 1657 s, every lane parked) · build **exit 0** with 9008 free (⚠️ a first attempt reported `Missing script: "build"` — the shell had drifted to the scratchpad directory, not a build failure; re-run from the repo root)** · browser **115/115** (T-234 matrix: six routes ×
390/768/1280 plus `/sign-in` and `/clock`) and **15/15** (T-237 link/unlink) and **37/38** (T-232 +
T-235 surfaces; the one miss is the console check catching Firebase's expected 400 on a wrong
password). `shareat_dev` is migrated to **0137**, both credential indexes confirmed partial by
reading `pg_indexes` back rather than trusting the migrator's exit code.

## ⭐ The four agent sessions — re-adopt by name (`ListAgents`)

| Lane | Session · model | State | Lane DB | Next slice |
|---|---|---|---|---|
| **B** | `ianla-3a` · Opus 5 (built on Sonnet-able work) | T-234 slice 2 shipped; parked clean | `shareat_test_t229` | Open. It swept all 101 pages, so it holds more context on `apps/erp/src/app` than anyone |
| **C** | `ianla-87` · Sonnet 5 | QA; parked clean. ⚠️ It was cleared once today and re-briefed cold — if it does not ACK with context, re-brief it | `shareat_test_qa` (at 0137) | Gates + a line-by-line read on every READY |
| **D** | `ianla-0a` · Opus 5 | T-238 shipped; parked clean. **The migration lane** | `shareat_test_t216b` (at 0137) | **DEF-229** — `revoke_reason` on `person_credentials`. It has already scoped it; see its notes below |
| **E** | `ianla-60` · Sonnet 5 | T-234 slice 1 shipped; parked clean | `shareat_test_def219` | Open |

Re-adopt each with a first line `[X] RE-ADOPT: <one sentence>`; they know the protocol. **Name the
model in every briefing** (bible row 184), and put terminals Ian must switch in the board's "Needs
you" — a session cannot switch itself.

**Protocol the lanes follow:** first line `[X] STATUS: sentence`, STATUS ∈ ACK/QUESTION/SPEC/READY/
BLOCKED (lane C: VERIFIED/FAILED). Workers never run git, build, dev or `npm run test:integration`;
integration only via `node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`; a new lane
DB via `make-test-dbs.mjs <name>`. **You alone** stage explicit paths, commit with `git commit -F
<file>`, push, run the dev server and the browser, and edit the bible, register, roadmap and guards.
Lanes write specs; you approve; then they build.

### What each lane asked me to pass on

- **B**: the 17 early-return branches it fixed are **empty-state renders** — a route walk at three
  widths will not reach them, so if you want them covered, visit the empty states deliberately.
  `tests/unit/page-container.test.ts` hard-names `components/shell` and `AppShell.tsx`, so moving the
  shell turns it red for a non-defect; the repair is in the failure message. `PageHeader` and the
  `narrow` density ship with **zero callers on purpose**, each documented in its own comment. Its
  five aside nominations for the deferred two-column task are in its READY.
- **D**: its lane DB is at **0137**, ahead of the others; DEF-229's migration is **0138** and the
  journal's `when` continues the file's own +86 400 000 spacing (0137 is `1797910307084`).
  `migrations/meta/` holds snapshots only to 0019 — every migration since is hand-written per
  DEF-073/121, so ⛔ **`drizzle-kit generate` must never be run here**. For DEF-229 the shape to copy
  is `attendance_credentials`' triple CHECK, and the real question is what happens to the
  already-revoked rows that have no reason — it will put both options in the spec with a
  recommendation rather than pick one quietly.
- **C**: neither caller guard would catch a plain repo helper going callerless
  (`accessRepo.hasOtherActiveAdmin` has zero callers as of T-238 and nothing flags it). Unowned.

## Pick up here, in this order

1. **Ian's production sign-in is still the milestone** and is item 2 on his board. Everything else is
   secondary to it. If it fails, that becomes item 1 for every lane.
2. **Two timers to arm on the droplet** now that `807ce1b`+ have deployed: the recurring-expense
   drafting job (T-216) and the new order-wastage backstop (T-236, daily 02:30 Manila). Both ship in
   `docs/ops`, which the deploy artifact does not carry — copy the directory fresh, **delete the old
   copy first** (DEF-194: an `scp -r` into an existing path NESTS and you then run a stale script),
   then `provision.sh`. Its install loop is a glob as of T-238, so it now installs all thirteen units.
3. **DEF-229 to lane D** (a migration, so it holds the slot alone). Its own note above is the brief.
4. **DEF-234 is waiting on Ian** — see below. Do not write the bible row until he answers.
5. Then the queue: **DEF-218** (the harness must connect as a non-superuser, non-BYPASSRLS role —
   touches every job suite's fixture path, so alone on the tree), **DEF-216** + the tutorials
   question, **DEF-221**, **DEF-230**, **DEF-233**, T-231's two sweeps, and the two tasks T-234
   deliberately deferred: the **two-column detail page** (five candidates already nominated by lane B)
   and a real **`<FilterRow>` component**.

## Do not decide these alone — they are Ian's

- ⛔ **DEF-234 — who may remove an administrator.** An admin can demote a super_admin today:
  appointing one is gated, unmaking one is not, so the removal is the first move of a promotion.
  Lane D's full analysis is in the register row. The proposed rule is *the authority to UNMAKE a role
  is the authority to MAKE it* — you may remove a peer, never someone senior. **The reason it is
  Ian's**: one version makes a departed super_admin removable by nobody but him, which would be a
  **third** action depending on him personally (bible row 116 records two as accepted). It is on his
  board as item 7 with the three answers spelled out. **The bible row gets written with his answer in
  it**, so it is a decision he made rather than one he inherited.
- **Tutorials**: count the walls first (half a day) or pick ten by judgement (`docs/discovery/30` §10
  recommends counting).
- **Arming the two timers** (item 2) and **dropping the stale databases** — the classifier blocks the
  orchestrator from `DROP DATABASE`. Keep `shareat_dev`, `shareat_test`, and the four lane DBs
  (`_t229`, `_t216b`, `_qa`, `_def219`); this session also created and can drop `shareat_test_t235`,
  `_t236`, `_t236e` and `_t237`.

## Traps that have actually bitten — today

- ⭐ **A page is not a unit of work in this codebase — a wrapper is, a form is, a branch is.** 34 of
  98 pages carry more than one top-level `<main>` (one carries three) and a page can hold two filter
  rows. **Three separate defects today came from counting files**: a sweep that left 17 branches
  behind, a filter-row count that was one short, and a width census 50% high. Saved to memory as
  `reference_shareat_count_elements_not_files`.
- ⭐⭐ **The tablet rail passed every DOM measurement and was visibly broken.** Rail 64 px, links
  22 px, nothing overflowing its box — and a screenshot showed every label rendering full-length,
  wrapped and clipped, down the whole rail, on Ian's majority device. **Take the screenshot.** The
  matrix is `~/.claude/skills/orchestrator/tools/smoke-t234.mjs`.
- ⛔ **A review can return confident, wrong blockers.** One Opus read called `inert` untyped, stripped
  by React, and the closed drawer Tab-reachable. Typecheck was exit 0, the attribute rendered, and 40
  Tab presses landed inside the drawer **zero** times. **Measure a blocker before forwarding it** — a
  lane that receives a wrong blocker usually repairs working code.
- **Assert against the ACCESSIBILITY TREE, not the DOM.** The shell renders its nav twice and hides
  one with `display:none` / `inert`; a `querySelectorAll` count reports two landmarks on a shell that
  has one. `smoke-t234.mjs`'s `liveCount` is the helper.
- **Mixed line endings**: `package.json` and some tests are CRLF, most source is LF, so an LF-only
  scripted replace matches nothing and **exits 0**. A lane reported an edit that never landed and
  every gate stayed green. Edit with the file tool; verify a claimed edit with `git diff`, not the
  report. Memory: `reference_shareat_mixed_line_endings_silent_replace`.
- **`npm run build` rewrites `apps/erp/next-env.d.ts`** from the `.next/dev/types/…` import paths to `.next/types/…`, and `next dev` writes it back — so a build dirties the tree with a generated file that flips again on the next dev run. It is committed in its DEV form; after a build, `git checkout -- apps/erp/next-env.d.ts` rather than committing the flip. Found by this wrap-up, whose own build left it modified.
- **The classifier blocks** `DROP DATABASE`, ssh to the droplet, and — transiently — a backgrounded
  `npm run test:integration` or dev-server start; the plain re-issue goes through. Say what was
  blocked; never route it through a lane.
- **A guard's natural repair can be worse than the defect.** A first draft forbade every `max-w-*`
  and went red on 30 legitimate prose measures — the obvious fix would have been deleting 50 real
  line-length caps. Narrow the rule and add a control that keeps the legitimate case legal.
- **Stale lane DB after a peer's migration** reads as a regression (`column … does not exist`) —
  re-run `make-test-dbs.mjs <lane db>` before diagnosing. 0137 landed today, so every lane DB that is
  not `_t216b` or `_qa` may be behind.

## The status board — update it at EVERY commit

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** instead of chat
reports. `Artifact action:"read"` it, rebuild the HTML locally, republish with that `url` after every
commit and every lane state change. **Never create a second board.** `docs/ROADMAP.html` moves at the
same moments.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md
in full, then docs/RULES.md. Ask Ian to type /orchestrator shareat system in your terminal (the
skill is user-invocation only). Four agent sessions are ALIVE on this machine and parked clean at
6a3b9ac: run ListAgents, then re-adopt lane B = ianla-3a (Opus 5), lane C = ianla-87 (Sonnet 5, QA),
lane D = ianla-0a (Opus 5, the migration lane), lane E = ianla-60 (Sonnet 5) by SendMessage, first
line "[X] RE-ADOPT: <one sentence from the handoff's table>". Do not respawn and do not re-brief from
scratch — their lane DBs and next slices are in the handoff's table; name the model in every briefing
(bible row 184).

Ian's responsive shell (T-234) shipped today, with T-235 to T-238. His production sign-in is STILL
the milestone and still only his (handoff "Pick up here" item 1), and two systemd timers need arming
on the droplet (item 2). You own the dev server on 9008, builds, migrations and the browser passes;
lanes never run git, build, dev or npm run test:integration. Stage explicit paths, commit with -F,
push, and update docs/ROADMAP.html and republish the status board at EVERY commit. Every READY gets
lane C's gates on its DB and an Opus second read — measure any blocker it returns before forwarding
it, because one came back confidently wrong today. DEF-234 is waiting on Ian and its bible row is not
to be written until he answers. When Ian's production sign-in works — or any task completes with the
tree clean — that is a milestone: run /wrap-up, rewrite this file, and hand over. Keep your session
small.
```
