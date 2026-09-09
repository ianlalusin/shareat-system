# Handoff — 2026-09-09 (late) — for the NEXT ORCHESTRATOR

> **You are taking over as ORCHESTRATOR of a four-lane team, and the lanes are COLD.**
> Brief them from scratch — do not "re-adopt" them (bible row 187). Ian invokes
> `/orchestrator shareat system` in your terminal himself; the skill is user-invocation only.
> Run the role from this file until he does.

## Where things stand

**Eight tasks shipped today** (T-243, T-244, T-245, T-246, T-247, T-248, T-249, T-250) — the last
two in this session. Production is live and unchanged. `main` is green and pushed; the only
uncommitted thing in the tree is nothing. **Lane E is parked mid-task on T-251a with a spec written
and zero source touched**, which is a clean stopping point, not a half-build.

Three lanes were told **SAFE TO CLEAR** with reasons (bible row 187). Lane E was not — it holds an
approved-but-unbuilt spec, and its next step needs your `APPROVED`.

## Gates at `245c102` (docs-only changes after it)

- **typecheck** `--incremental false` → **exit 0**
- **unit** → **82 files, 1186 passed / 1 skipped, exit 0**
- **integration** → **107 files, 2666 passed, 0 failed, exit 0** — 1851s (~31 min) on the shared `shareat_test`
  ⭐ **The first completed local run in three sessions — see below before you skip it.**
- **build** → **exit 0**, 9008 free, route table lists `ƒ Proxy (Middleware)`
- **browser** → T-248 **10/10** at 390px · T-250 **24/24** at 390 **and** 1280

⚠️ **Before any integration run:** `node ~/.claude/skills/orchestrator/tools/make-test-dbs.mjs
shareat_test` — head is **0140** and a stale lane DB fails as a missing column, which reads exactly
like a code bug.

## What happened this session

**⭐ THE INTEGRATION GATE IS REAL AGAIN, and that is the biggest thing here.** DEF-245 recorded two
consecutive sessions failing to complete this suite, and warned that a gate nobody can run stops
being a gate and becomes a formality. It ran: **107 files, 2666 tests, 0 failures, exit 0, in 31
minutes**, using that row's own suggested remedy — `npx vitest run --project integration
--reporter=verbose`.

⛔ **State the conclusion narrowly, because the tempting one is bigger than the evidence.** This does
NOT prove the default reporter causes a hang. It proves the suite is **healthy and takes ~31
minutes**, and that under the default reporter it prints nothing for that entire time — so a
40-minute abort is indistinguishable from a hang. The most likely reading of yesterday's "stall" is
therefore that **a working run was killed for looking dead.**
⚠️ **The 2026-09-08 failure is NOT explained by this** — that one was OS-killed for memory pressure
with lanes running concurrently. My run had no peer doing heavy work, so the memory ceiling is still
untested and may bite again.
⭐ **Cheap durable fix: make `test:integration` verbose by default**, so nobody again has to tell a
silent 31-minute run from a hang. Not done — it is a one-line `package.json` change and belongs to
whoever picks it up.


**T-248 shipped, and the interesting part is what nearly shipped with it.** The mechanism Ian
decided (bible row 188) works: appointing an administrator revokes the elevated grants and leaves
deliberately-given ones alone, watched on the real screen with the rows confirmed behind it. But a
**fresh-eyes review by a cleared lane** found a hole in the task's own guarantee —
`grantCapability`'s idempotent branch never re-tagged provenance, so a capability an elevated
manager *deliberately* hand-granted to another was still swept on arrival. Reachable, because
`grant_capability` is itself in the elevated set. Fixed as a **monotone upgrade**: a stored
`grant_source` may only ever move toward being LESS revocable, never more.

**T-250 shipped, and the guard is the half that matters.** Five remaining undersized tap targets,
plus the sweep test rewritten from a *spelling* match to a *shape* match — because the guard that
was supposed to prevent DEF-243 was itself spelling-based, which is how the idiom reached nine.

**Three defects found by people not looking for them.** Lane C was sent to verify a small filed bug
(DEF-230), proved it absent against all 1136 real constraint names, and found **DEF-246** underneath
it. A screen it could not reach for an unrelated capture turned out to be **DEF-249**. Lane E,
specifying the DEF-218 fix, found **DEF-250**.

**A brief being wrong is now the expected case, not the exception.** Of four lanes this session:
lane B re-counted its brief and found a line number stale; lane D found the parked task's guarantee
did not hold; lane E found the orchestrator's entire framing of DEF-218 was wrong; lane C found the
defect it was sent to verify did not exist. **Only lane C's brief survived contact, and only because
its answer was "no".**

**Ian's decisions this session, and where each is recorded:**

| Decision | Recorded in |
|---|---|
| DEF-246: sanitise the fallback first, then count hits and improve by hit rate | **bible §13 row 189** — with the evidence that arrived *after* he ruled |
| (carried) DEF-242, DEF-241 — still open, still his | `docs/DEFECTS-REGISTER.md` |

## Pick up here, in this order

1. **Approve lane E's `[E] SPEC` for the T-251/251a split, then let it build 251a.** The spec is
   written (`docs/tasks/251a-system-transaction.md`) and the lane is parked waiting. ⛔ **Read
   bible §13 row 185 first** — 251a touches the one sanctioned owner-role path, and row 185 says in
   terms that it is *not a precedent*. The lane's recommended amendment is in DEF-250's remedy
   column; **it is Ian's to approve, not yours to assume.**
2. **DEF-246's fix, per row 189** — sanitise the fallback, then instrument it. ⚠️ **Reuse T-245's
   counter**, including the part that was hard: its first version wrote inside the transaction the
   refusal aborts and would have recorded nothing for ever with nothing red.
3. **DEF-249** — but ⚠️ **trace the consequence before proposing a fix.** Nobody has checked what
   payroll actually does against a store with no attendance policy, and the code's own warning says
   it "fails quietly in the direction that looks fine". That answer decides whether this is wiring
   or a live payroll problem.
4. Then: **DEF-244** (the row-height design question behind T-249's 32px compromise), **DEF-247**,
   **DEF-220** (one-line default), **DEF-248** (two dark-mode classes), **DEF-230** is closed.

## Do not decide these alone — they are Ian's

- **DEF-242 — `npm run db:generate` is broken for everyone.** Hand-authored SQL has become the
  convention without anyone deciding it. **Repair the generator, or write the convention down?**
  It governs every future schema change here. *Carried from yesterday, still open.*
- **DEF-241 — month-end is the only timer with no timezone**, so it runs 10:00 Manila while every
  sibling is staggered into the small hours. Possibly deliberate; nothing records it.
- **Bible row 185's amendment** (see item 1). Not written, deliberately.
- **DEF-237's residue** — grants written before `grant_source` existed stay NULL and out of scope
  for ever. Accepted; worth Ian knowing it is permanent.

## Traps that bit TODAY

- ⛔ **A brief is a hypothesis, and this session it was wrong four times out of four.** Read the
  source, not the register row. When a lane says *"this specific thing is not proven"*, that is the
  most valuable sentence it can send — lane D said it about the org-scoping, and the test written
  because of it caught a real regression when deliberately broken.
- ⛔ **A search is only as wide as the directories you thought to name.** T-248's new CHECK broke a
  test in `packages/db`; the lane had searched `auth` and `domain` and reported honestly that they
  were clean. They were.
- ⛔ **Backticks in a Bash double-quoted string are COMMAND SUBSTITUTION.** Writing register prose
  through `node -e "..."` silently ate three words and **exited 0**. Use a script file or the Edit
  tool for any markdown containing backticks. This is in memory and I still walked into it.
- ⛔ **`elementFromPoint` is VIEWPORT-relative and returns null below the fold.** A browser pass over
  a 38-row list reported 3 hit-testing failures that did not exist. **The tell: fewer failed at 1280
  than at 390** — a real hit-testing bug does not care about viewport height. Scroll into view, then
  measure.
- ⛔ **`--reporter=basic` does not exist in this Vitest.** The run died loading the reporter, the
  pipeline still exited 0, and it looked like a clean pass. **Check the command's own exit line, not
  the pipeline's.** Valid: `default`, `verbose`, `dot`, `json`, `junit`, `tap`, `tap-flat`.
- ⚠️ **A markdown table row with one stray pipe renders an extra cell and nothing warns.** Bible row
  188 had six columns in a five-column table since yesterday's correction. Found by *counting
  columns against a neighbour*, not by reading. Count them after any bible row edit.
- ⚠️ **Data-modifying CTEs all see the same snapshot** — a `DELETE` and an `INSERT` in one statement
  do not see each other, and the insert hits the unique index. Two statements.
- ⚠️ **`npm run build` rewrites `apps/erp/next-env.d.ts`**; `git checkout --` it afterwards.
- ⚠️ **Sign-in is store-scoped — pick the store BY NAME** (`Smoke Store`), never index 0. Index 0 in
  `shareat_test_t240` is a readiness probe with no credentials.
- ⚠️ **Nothing exists in a database until you make it.** `/cutover/count` early-returns with **no
  back-link at all** on a store-less org — an empty screen there looks exactly like a broken change.

## The four lanes — CLEARED, brief them cold

Lanes **rename themselves per task**, so match on the `[ref]` from `ListAgents`, not the name.

| Lane | ref | Last shipped | Lane DB | Suggested next |
|---|---|---|---|---|
| **B** | `242a5b` | T-243, T-246, T-249, **T-250** | `shareat_test_t229` | DEF-248 + DEF-220, or DEF-244's design question |
| **C** | `f32df4` | QA — no code; found DEF-246, DEF-249 | `shareat_test_qa` | QA. It is the lane that finds things |
| **D** | `8b22c7` | T-244, T-247, **T-248** | `shareat_test_t216b` | DEF-246's fix (row 189) |
| **E** | `815ab6` | T-245; **T-251a specced, not built** | `shareat_test_def219` | **Finish T-251a — it is mid-task** |

**Protocol they must be told** (they will not remember): first line `[X] STATUS: sentence`, STATUS ∈
ACK/QUESTION/SPEC/READY/BLOCKED (lane C: VERIFIED/FAILED). Workers never run git, build, dev, or
`npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`. **You alone** stage explicit
paths, commit with `-F`, push, run the dev server and browser, and edit the bible, registers,
roadmap and board.

⭐ **Tell each lane to write its spec IN PLAN MODE and exit plan mode to build** — `opusplan` gives
Opus only in plan mode, so a spec written as ordinary work silently runs on Sonnet.
⚠️ **Each of those raises a prompt in that lane's terminal** — tell Ian, or three lanes stall
silently and he will not know why.
⚠️ **Lane D reported its model flipping between Opus and Sonnet mid-plan-mode**, twice, unprompted.
If `opusplan` is not holding Opus across a whole plan-mode span, row 187's corollary does not hold.
Unresolved; on Ian's board.

## Databases

`shareat_dev` · `shareat_test` · four lane DBs · **`shareat_test_t240`** — the browser-pass
database: seeded stores, **PIN `246810`** on `Smoke Store (SMK)`, 38 expense categories, 3 active
sales channels, and one employment `01a086bb-2a14-7064-8f65-7682450dbdb7` seeded for T-250's
credentials route. **Do not drop it.** Head is **0140** on every database including `shareat_dev`.

Browser scripts: `smoke-t248.mjs` and `smoke-t250.mjs` in the orchestrator tools folder — both
working, both carrying the sign-in-by-name and the scroll-then-probe fixes.

## The status board

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** rather than chat.
`Artifact action:"read"` it, edit, republish with that `url` at **every commit**. **Never make a
second one.** `docs/ROADMAP.html` moves at the same moments — do both.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read
C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md in full, then docs/RULES.md, then
PROJECT_BIBLE.md §13 rows 185, 188 and 189. Ask Ian to type /orchestrator shareat system in your
terminal (the skill is user-invocation only). Four worker terminals exist on opusplan — run
ListAgents and match them by [ref], not name, since lanes rename themselves: B=242a5b,
C=f32df4 (QA), D=8b22c7, E=815ab6. B, C and D are CLEARED — brief them cold, they remember
nothing. E is PARKED MID-TASK on T-251a with a spec written and no source touched.

Every briefing must say: write the spec IN PLAN MODE, exit plan mode to build — and warn Ian
that each of those raises a prompt in that lane's terminal or the lanes stall silently.

You own the dev server on 9008, builds, migrations, git and every browser pass; lanes never run
git, build, dev or npm run test:integration. Stage explicit paths, commit with -F, push, and
update BOTH docs/ROADMAP.html and the status board at EVERY commit. Re-run every gate yourself
on the shared database rather than accepting a lane's numbers.

⛔ Treat every register row and task stub as a HYPOTHESIS. Yesterday four of four lanes found
their brief wrong — including the orchestrator's entire framing of DEF-218. When a lane says
"this specific thing is not proven", that is the most valuable sentence it can send.

Pick up at "Pick up here": approve lane E's split and let it build T-251a (READ BIBLE ROW 185
FIRST — row 185's amendment is Ian's call, not yours), then DEF-246's fix per row 189, then
DEF-249 but trace the consequence before proposing a fix. DEF-242 and DEF-241 are Ian's.
When a task completes with the tree clean, that is a milestone: run the wrap-up ritual
(.claude/skills/wrap-up/), rewrite this file, and hand over. Keep your session small.
```
