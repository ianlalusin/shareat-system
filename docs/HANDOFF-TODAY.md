# Handoff — 2026-09-19 (evening)

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED: *"make the app as close as possible to deployment."***
> ⚠️ **AND IT IS NOT LAUNCHED.** Production deploys exist; no staff use it yet. That changes urgency,
> never correctness. ⛔ **This document makes no PRESENT-TENSE claim about which commit production
> runs** (DEF-360). Ask `/api/health` and compare all forty characters against
> `git rev-parse origin/main`.

## Where things stand

**Two tasks shipped and pushed today.** `origin/main` is **`e0ed123`**.

| Commit | Task | Closes |
|---|---|---|
| `70c273f` | **T-325** — the money-positivity census is keyed by the comparison it guards | DEF-376 |
| `e0ed123` | **T-326** — a cashier-readable error from both ends | DEF-378, DEF-379 |

**Filed today: DEF-381, 382, 383, 384, 385.** Register is at 384 rows.

⭐ **BOTH ARE CI-VERIFIED AT STEP LEVEL, not merely green overall** — for each commit,
`Integration tests (real Postgres) :: success` **and** `Build :: success`, both *run*, neither
skipped. ⚠️ **That check exists because of 2026-09-19's earlier trap**: a docs push cancels the code
push's run beneath it, and the replacement run goes genuinely green while skipping integration and
the build as doc-only. **Both of today's commits carried their code AND their docs in one commit,
which avoids it by construction.** If you ever split them, push docs FIRST or re-run the cancelled
run — and ⛔ never use `gh api …?head_sha=`, which returned `total_count: 0` for a commit with two
runs on it. List unfiltered and match locally.

⛔⛔ **§9.4 IS UNMET ON BOTH, AND IAN AUTHORISED SHIPPING ANYWAY** — asked plainly, told which gate
did not run and what it left unproven, answered "push it" both times. **That authorisation is what
makes it acceptable (bible row 203); the silence would have been the defect.** See §2 for why the
screen could not be reached and what was done instead.

## ⛔ 1. PICK UP HERE — T-327 IS SPECCED IN ALL BUT NAME

**`docs/tasks/326-*.md` §3 already contains T-327's spec material**: all 56 candidate files
enumerated with an out-column, the method, the three patterns needed to see the population, and the
verdict for every site. **Do not re-derive it. Do not re-run the census.**

**T-327 = the 14 money sites T-326 deliberately did not convert.** T-326 fixed the 6 whose only
fault was an unreadable message. The other 14 **can store malformed values**, and **DEF-382** is why
that is not a cleanup task:

> ⛔ `Number('abc')` is `NaN`; **`NaN < 0`, `NaN <= 0` and `NaN > anything` are all `false`**, so
> every comparison guard *accepts* it; and `NaN.toFixed(2)` is the string `"NaN"`.
> ⚠️ **Postgres `numeric` ACCEPTS `NaN` as a value, and in Postgres ordering `NaN` is greater than
> every non-NaN — so `CHECK (amount > 0)` PASSES for it.** Reported by the auditor from the docs;
> **⛔ NOT YET EXECUTED against a live database — the probe was killed for memory before it answered.
> Run it first; it is one query and it sets T-327's severity.**

⭐ **The auditor's framing, and it is right:** *"T-327 needs a mechanical trigger, not a queue
position. The observable one is: any of the 14 that can reach a numeric column without `money()`."*
That is a grep. **If that set is non-empty, T-327 is not a cleanup task.**

**Then, in order:** DEF-374 (two concurrent handovers both pass a cap only one should) · DEF-380
(a positive variance has no correct remedy and T-324 made them routine — **needs Ian's decision on
what resolving a surplus means before any control is built**) · T-320 (+DEF-367) · DEF-373.

## ⛔⛔ 2. THE ENVIRONMENT IS BROKEN AND IT IS NOT THE CODE

**The dev server starts, `/api/health` returns 200 — and EVERY page route 500s.**

```
FATAL: An unexpected Turbopack error occurred
Failed to write app endpoint /fixed-assets/page
Caused by: [project]/apps/erp/src/app/globals.css [app-client] (css)
  - creating new process
  - node process exited before we could connect to it with exit code: 0xc0000142
```

`0xc0000142` is Windows failing to start a process. Turbopack cannot spawn the PostCSS worker. API
routes work because they do not import CSS; every page does. **Reproduces after deleting `.next` on
a fresh process, and no CSS was touched.**
⚠️ **Four background jobs were killed for memory today**, including two full gate runs. 15 node
processes were live at the worst point; it is process-handle exhaustion, not RAM (5 GB was free).
⭐ **Before concluding anything about §9.4, check this first** — it may simply be gone after a
reboot, and it is the only thing standing between this project and a working screen test.

⛔ **AND THE SIGN-IN CONSTRAINT IS STILL SEPARATE AND STILL REAL:** all five
`NEXT_PUBLIC_FIREBASE_*` in `.env.local` are empty, and `/sign-in` has no emulator path of its own
(DEF-371). **A token or a password is off-limits to an agent and "it is a throwaway emulator
credential" is NOT an exemption.** Even with a working renderer, reaching a signed-in screen needs
Ian.

⭐ **WHAT TO DO INSTEAD, AND IT IS CHEAPER THAN THE SCREEN.** The auditor's suggestion, which
worked: *"if Ian can run one command, it should not be the screen."* Executing the real code path
produced the operator-visible sentences without a renderer —

```
bad amount       → the cost — "abc" is not a valid amount. Use at most two decimal places.
connection lost  → The database refused that change… the detail is in the server log.  (no host, no port)
database rule    → cannot post journal entry into period 42 (status = locked)           (verbatim)
```

**That is not a substitute for §9.4 and it was not reported as one** — but it is a far stronger thing
to hand Ian than an absence, and it is repeatable in one vitest file.

## ⛔ 3. THE LESSONS THIS DAY ACTUALLY EARNED

**(a) THE ORCHESTRATOR IS THE LEAST-POLICED SESSION, AND IT SHOWED — THREE TIMES.**
Every collision today was mine: contradictory instructions that put two `test:integration` runs on
one lane database; editing a lane's source file mid-verification without telling it (the builder
spent real effort investigating a "regression" that was my mutation test); and creating a `.test.ts`
under `packages/` while a gate run was scanning it. **The lanes caught all three.** ⭐ The structural
reason: the orchestrator touches every lane's territory and nobody polices it. **Apply your own
freeze rules to yourself, and when you take a gate over from a lane, say explicitly "this supersedes
my earlier instruction to X" rather than assuming the newer one wins.**

**(b) SPELLING IS NOT SHAPE — THREE INSTANCES IN ONE TASK.** The sweep bound was `str(formData` (35
files); the real population was `str(fd|formData` (56), with **21 files invisible** and **seven
carrying human-typed money**. Then the builder found a third level — template-literal field names
like `` str(fd, `lineOverage_${i}`) `` — invisible to *both*. ⚠️ **This repo already wrote the lesson
down** — grep `local-errormessage-convergence.test.ts` for its own census note about counting `function
errorMessage` and missing four. **We reproduced it one spelling over, twice.**

**(c) AN ANCHOR DOES NOT SURVIVE THE EDIT THAT DELETES THE ANCHORED CODE.** The line-number rule says
grep the anchor. In an extract/move task the anchored code is *what moves*, so five of ten anchors
returned nothing mid-task and the builder was one step from reconstructing a regex from prose.
⭐ **In a move task, every anchor pointing into the moved code carries a git ref
(`git show <sha>:<path>`); anchors into untouched files stay bare.**

**(d) RE-DERIVING A NUMBER CHANGES IT — FOUR TIMES TODAY.** "Eight domain modules" was 14. "56
callers" was 52 files / 210 call sites, and `errorMessage` has **24 separate definitions**, so a raw
name count measures nothing. "95 raises" was case-sensitive and missed the entire lowercase
attendance subsystem where the developer-facing messages live. And a casualty list led with a
sentence that was **protected**, because `CREATE OR REPLACE` supersedes and the caveat had been
written down one paragraph earlier and not applied.
⛔ **Corollary, learned the expensive way: DO NOT PUT A COUNT IN A TEST NAME.** It is the most-read
and least-maintained place a stale figure can live.

**(e) A CHECK REPORTS SUCCESS BECAUSE NOBODY NAMED ITS INPUT SET.** The auditor's own words, about
its own miss: it confirmed the carve-out preserved "the five" — correctly — and never asked *what
else lands in step 4*. The answer was ~90 more sentences. ⭐ **Ask of every passing check: who chose
its population?**

**(f) ASK "WHAT VALUE WOULD HAVE TO BE WRONG FOR THIS TO GO RED, AND DOES THE CODE UNDER TEST SUPPLY
IT?"** Four instances in T-325 alone: a positive control keyed by line number; a grep for literal
keys in a table that has none; a control computing its expected value with the function under test;
and two negative assertions that passed only because nothing called the spy.

## 4. Live agent sessions

⛔ **ASK A SESSION ITS MODEL; NEVER READ IT OUT OF THIS TABLE** (DEF-361).

| Session | Role | State |
|---|---|---|
| `system32-4f` | orchestrator | **clear it.** Ran T-325 and T-326 end to end; context is long and nothing in it is needed that is not in this file |
| `webapps-1c` | **AUDITOR** | idle, clean, read-only throughout. **Opus.** ⭐ Found the ~90-sentence carve-out hole, the `errorMessage(null)` throw, the P0001 developer-facing class, and corrected two of its own reported figures unprompted |
| `webapps-36` | **BUILDER** | idle, frozen, clean. Sonnet. ⭐ Found the `NaN` bypass, the third spelling-not-shape level, two other money validators, and refused to touch a test file three separate times |
| `webapps-37` | **TESTER** | idle, frozen, clean. Sonnet. ⭐ Found the third export file (`apps/erp/tsconfig.json`), a bug in its own test's premise, and caught a wrong example in the orchestrator's own casualty list by verifying before using it |
| `webapps-5a` | **IAN** — his own session | Not a lane, not foreign work |

⭐ **The workers stay alive and keep their names.** Re-brief them from the spec on disk; the briefing
format is self-contained by design.
⚠️ **`docs/reviews/NEXT-PROMPT.md` (modified) and `docs/reviews/2026-09-17.md` (untracked)** are an
exited session's, deliberately uncommitted since 2026-09-17. **Leave them.**

## 5. Numbers to allocate from

Next task **T-327** · next defect **DEF-386** · next migration **`0155`**
⛔ **`0154` IS APPLIED — never edit it.** Reserved, do not re-issue: `0149`/`0150`/`0151`.
Lane databases that exist: `shareat_test_t325_{tester,builder}`, `shareat_test_t326_{tester,builder}`.

## 6. ⛔ FOR IAN — open decisions nobody else can make

1. **`DEF-370` is cited twelve times across `docs/reviews/` and HAS NO ROW IN THE REGISTER** — the
   numbering jumps 369 → 371. Anyone chasing it finds nothing.
2. **`docs/reviews/NEXT-PROMPT.md` has an uncommitted edit that REINSTATES a remedy its own committed
   version had struck out as FALSE.** That file names itself the next session's instructions. Left
   untouched all day as instructed; whether it is corrected or discarded is Ian's call.
3. **DEF-380 needs a business decision before any code** — what does resolving a *surplus* mean? The
   two existing remedies both assume money is missing.
4. **The machine.** See §2. A reboot may simply fix §9.4 for everyone.

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED. Production
deploys exist; no staff use it yet. That changes urgency, never correctness.

⭐⭐ THREE SESSIONS, THREE FIXED ROLES — a TESTER who writes the red and drives the real screen, a
BUILDER who makes it green and never edits a test, an AUDITOR who runs /code-review READ-ONLY on
every slice. Read SKILL.md §2 before briefing anybody. ⛔ GIVE EACH LANE ITS OWN LANE DB IN THE
BRIEFING. The three workers from 2026-09-19 are alive, idle and clean: webapps-1c (AUDITOR, Opus),
webapps-36 (BUILDER, Sonnet), webapps-37 (TESTER, Sonnet). ⛔ ASK each its model; never read it out
of a table (DEF-361). Ian may need to accept your briefing in each terminal before it ACKs.

⛔⛔ THE ORCHESTRATOR IS THE LEAST-POLICED SESSION AND IT CAUSED EVERY COLLISION ON 2026-09-19: two
integration runs on one lane database from contradictory instructions; a lane's source file edited
mid-verification without telling it; a .test.ts created under packages/ while a gate was scanning it.
APPLY YOUR OWN FREEZE RULES TO YOURSELF. When you take a gate over from a lane, say explicitly "this
supersedes my earlier instruction to X".

⛔⛔ THE DEV SERVER CANNOT RENDER ANY PAGE on this machine — Turbopack cannot spawn the PostCSS worker
(0xc0000142); /api/health returns 200 and every page 500s. Four background jobs were killed for
memory. CHECK WHETHER THIS IS STILL TRUE BEFORE PLANNING ANY SCREEN TEST; a reboot may have fixed it.
§9.4 was reported UNMET on both of 2026-09-19's tasks and Ian authorised shipping anyway, twice,
after being told plainly. THE AUTHORISATION IS WHAT MAKES THAT ACCEPTABLE — the silence would have
been the defect (bible row 203).

⭐ WHEN THE SCREEN IS UNREACHABLE, EXECUTE THE PATH INSTEAD. One vitest file calling the real
functions produced the operator-visible sentences and closed an invariant no other gate covered.
"If Ian can run one command, it should not be the screen."

⛔ SPELLING IS NOT SHAPE. A census bound by one spelling missed 21 of 56 files, seven carrying
human-typed money; a third spelling (template-literal keys) was invisible to both. This repo already
wrote that lesson down in local-errormessage-convergence.test.ts and we reproduced it twice.

⛔ AN ANCHOR DOES NOT SURVIVE THE EDIT THAT DELETES THE ANCHORED CODE. In a move/extract task, every
anchor into the moved code carries a git ref.

⛔ RE-DERIVING A NUMBER CHANGED IT FOUR TIMES ON 2026-09-19. Never put a count in a test name.

⛔ ASK OF EVERY PASSING CHECK: who chose its input set? And of every assertion: what value would have
to be wrong for this to go red, and does the code under test supply it?

Read: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md rows 204-215, DEFECTS-REGISTER.md
section E. ⛔ GREP the big ones — the register is ~1MB and the bible ~418KB.

⛔ T-325 (70c273f) and T-326 (e0ed123) ARE COMPLETE, PUSHED AND CI-VERIFIED. DEF-376, DEF-378 and
DEF-379 are closed. Do not re-open them.

NEXT UP: T-327 — the 14 money sites T-326 deliberately did not convert. ⭐ ITS SPEC MATERIAL ALREADY
EXISTS in docs/tasks/326-*.md §3: all 56 files enumerated with an out-column. DO NOT RE-RUN THE
CENSUS. ⛔ FIRST, EXECUTE THE ONE QUERY NOBODY HAS RUN: does Postgres numeric accept 'NaN' past a
CHECK (amount > 0)? The auditor says yes from the docs and the probe was killed before it answered.
That single result sets T-327's severity — if the 14 can write a poison value past every CHECK, it is
not a cleanup task. Then: DEF-374, DEF-380 (needs Ian's decision first), T-320 (+DEF-367), DEF-373.

Next task T-327 · next defect DEF-386 · next migration 0155.

-----------------------------------------------------------------------------------------------
