# Handoff — 2026-09-10 (night) — for the NEXT ORCHESTRATOR

> **Tree CLEAN, every gate GREEN, `main` pushed. Two tasks shipped this session: T-261 and T-262.**
> Nothing is half-built. Ian invokes `/orchestrator shareat system` himself; run the role from this
> file until he does.

## Where things stand

**T-261 and T-262 both shipped.** The refusal counter now reaches every money screen, and the
touch-target guard measures a box height instead of a text size. **T-263 and T-264 are specced and
unstarted**, both created from decisions Ian made tonight. Production is unchanged — nothing has
been deployed.

⭐ **The finding of the session: eight counting or classification errors across two documents, and
every single one was caught by RE-DERIVING a number, never by reasoning about it. Two of them were
the orchestrator's. Twice the re-check introduced the next error, which only opening the file
caught.**

## Gates at `daf67b5` (+ the spec-status commit)

Run by the orchestrator on the **shared** tree and database:

- **typecheck** `--incremental false` → **exit 0**
- **unit** → **94 files, 1303 passed / 1 skipped, exit 0**
- **integration** → **111 files, 2709 passed, 0 failed** — 1367s on `shareat_test`, per-test
  durations normal, no starvation. All lanes were idle, so DEF-268 did not apply.
- **build** → **exit 0**, port 9008 free, route table lists `ƒ Proxy (Middleware)`,
  `apps/erp/next-env.d.ts` restored afterwards
- **browser** → **14/14** (`smoke-t260.mjs`, re-run against T-261 specifically) and T-262's own
  rendered pass at **390 and 1280**

⚠️ **Integration and build were run at `e619893`. Every commit since touches only `docs/`** — so
they still hold; stated rather than silently re-claimed.
⚠️ **A bible row WAS added this session (row 192), and `npm run toc` was run.** Do not skip it if
you add another.

## Pick up here, in this order

1. **T-263 — DEF-283, the date idiom the bible forbids.** ⭐ **Small change, wide blast radius,
   and the spec's longest section is about the tests because they encode the defect as correct.**
   `lastCompletedPeriod()` decides the month in raw UTC and never touches
   `packages/core/src/datetime.ts`, whose own header says *"there is exactly one date idiom here.
   Do not add a second."* This is the second. ⛔ Two live callers, not one — findings-observation
   fires at 01:30 Manila, always the previous UTC day, and asks about the wrong period on the 1st
   of every month. **Sonnet lane; the decision is already made.**
2. **T-264 — DEF-284, the lock nobody can arm.** Three slices; **slice 1 is not about locking at
   all** and fixes a live failure (nothing creates `fiscal_periods`, which is why depreciation
   fails today with *"no fiscal period covers …"*). Slice 3 must reuse migration `0005`'s
   transaction-local GUC pattern, not invent one. **Slice 1 is Sonnet; slice 3 wants Opus.**
3. **DEF-279** — the counter cannot name the five accounting invariants (no `USING CONSTRAINT`).
   Ian ruled it its own item, sequenced after T-261, which has now shipped. **Needs a migration
   slot.**
4. Then: **DEF-280** (11 catch-less server actions), **DEF-281**'s residue (triage the 151-control
   baseline), **DEF-278**, **DEF-277**, **DEF-260** (execution — Ian decided the design in row 190),
   **DEF-273**.

## What happened this session, by theme

**Both tasks opened with a decision rather than code, and in both the decision was the value.**
T-261's lane found a fourth arm nobody listed — wrap one chokepoint instead of hand-editing ~163
catch blocks — and the orchestrator verified the mechanism was stronger than the lane framed it: 44
files re-export `withOrgPrincipal`, but they all forward **one binding**, and exactly one app-layer
line imports it from `@shareat/db`. 12 files, not 45.

⛔ **Two defects were caught INSIDE approved specs, and either would have shipped.** F1: `till` and
`remittance` keep private message maps with zero overlap with the shared 26, so the obvious build
would have recorded **8 already-friendly constraints as unmapped** — corrupting the first hit report
exactly where it is read hardest. F8: the `transaction(run)` fallback that both the spec and the
orchestrator believed was test-only turned out to be **seven live server actions**.

⛔ **The orchestrator's own F8 verdict was wrong first and was withdrawn before it was reported.**
An RLS probe returned "53 rows visible, RLS is not closing that path" — it had measured its own
`postgres` superuser login (`rolbypassrls = true`), not the policy. Re-measured as `shareat_app`
with no principal: **0 rows.** The lane's RLS reasoning was right and its conclusion wrong, because
the policy was never the binding constraint. **The deciding evidence was a grep for null-first-arg
callers that neither party had run.**

**T-262 re-anchored on box geometry after a rendered measurement, and the lane retracted its own
threshold.** 151 FAIL across 76 files, **127 of them `text-sm` or larger** and unreachable by any
text-anchored guard. ⭐ **Its falsifier fired TWICE — once catching a real error (three app-shell
controls flagged as the app's smallest targets when `.shell-nav-row` makes them 36px, 44px on
touch — the BEST targets we have), once benign (UNRESOLVED 53 vs the spec's 78, where rendered
measurement proved the SPEC wrong).** Both firings are recorded, deliberately.

**A spec told a lane to ship a permanently red gate.** §6.9 said "red"; §6.4 one section earlier
said "encode as an accepted baseline". Overruled in favour of §6.4 — a permanent red in a shared
tree teaches the next lane to say *"that red is expected"*, and that sentence is how a real
regression gets waved through.

**Ian's month-end instruction uncovered a silent wrong-month close.** DEF-241's own fix (03:00
Manila on the 1st) resolves to 19:00 UTC on the **last day of the previous month**, so the job would
have closed the month **before** the one that just ended, no-opped because it is idempotent, and the
real month would never have been closed. It never bit because `docs/ops` does not deploy (DEF-194).

## Do not decide these alone — they are Ian's

- ⛔ **The production DB username in `/srv/shareat-shared/.env.local`.** This single fact decides
  whether **DEF-282** is real work or closes as verified-safe: six server actions run with no tenant
  principal. On the test database that role is `postgres`, superuser, `BYPASSRLS`. DEF-250
  independently reports production as a bypass role. ⚠️ **Not a breach — `authorize()` still runs on
  all six — a missing defence-in-depth layer (bible §15.11).**
- **The month-end deploy.** Committed and ready; Ian said *"deploy later"*. The server is still
  running the 10:00-Manila version.
- **DEF-284's slice ordering** — he has decided the WHAT (lock + admin/super_admin override, closed
  on the 15th as a human prompt). Slice sequencing is open.
- **The fingerprint capture gap**, multi-week, in `CAPABILITY-GAPS.md`. ⚠️ He has still not been
  asked about face recognition, which v1 also has.
- **DEF-258's triage** — 47 same-digit dark-mode overrides across 28 files. Not all are defects.

## Decisions Ian made this session, and where each is recorded

| Decision | Recorded in |
|---|---|
| DEF-275 ratified — row 189's clause narrowed | **`PROJECT_BIBLE.md` §13 row 192** (`npm run toc` run) |
| Hit report: ranked constraint NAMES only, context `null` | `docs/tasks/261-*.md` §B header |
| Checkbox/radio IN SCOPE — assert box geometry | `docs/tasks/262-*.md` §6.1/§6.3 |
| DEF-278's remedy wording corrected to lane D's line | `DEFECTS-REGISTER.md` DEF-278, `262-*.md` §6.4 |
| `USING CONSTRAINT` logged as its own item | `DEFECTS-REGISTER.md` **DEF-279** |
| Month-end: 15th, 02:00 + 03:00 retry | `docs/ops/shareat-month-end*.timer`, **DEF-283** |
| Depreciation books at month end | `docs/tasks/263-*.md` (spec) |
| Period lock + override, admin/super_admin only | `DEFECTS-REGISTER.md` **DEF-284**, `docs/tasks/264-*.md` |

## Traps that bit TODAY

- ⛔ **A PERMISSION IS NOT EVIDENCE UNTIL YOU KNOW WHICH LAYER PRODUCED IT.** The F8 probe saw 53
  rows and blamed RLS; it had measured its own superuser login. Same shape as yesterday's red
  browser pass.
- ⛔ **A HAND-WRITTEN LIST OF EXAMPLES READS AS A POPULATION AND IS NOT ONE.** "Three CRLF files"
  were 23. "Four `className` shapes" were five. `README.md`'s enable list named four timers while
  six shipped. DEF-239's "4 instances" were 9.
- ⛔ **A COUNT IS WRONG UNTIL RE-DERIVED A SECOND WAY.** 192 `errorMessage` call sites were 173 (19
  were definitions). A `null`-first-arg sweep returns 18, not 7 — the discriminator is *"imported
  from `@shareat/domain` or `@shareat/auth`"*, and one orchestrator sweep was right only by accident
  because its regex happened to require a trailing comma.
- ⛔ **`grep DEFERRABLE` MISSES `deferrable`.** Both parties' counts were also inflated by SQL
  comments. Match the thing, not the spelling — and not the case.
- ⛔ **A SPEC CAN CONTRADICT ITSELF TWO SECTIONS APART** and a lane will faithfully implement the
  wrong half. §6.9 vs §6.4 (red vs baseline); §B7.1 vs §B7.3 (a test location the boundary guard
  forbids).
- ⚠️ **A BRIEFING'S TREE STATE IS A CLAIM WITH A TIMESTAMP.** One went stale in transit and a lane
  correctly sent BLOCKED. **Re-confirm the baseline at dispatch, never quote the one from when the
  spec was written** — and a lane cannot verify it, because git is on its NEVER list.
- ⚠️ **A LANE'S `[ref]` SURVIVES A RESTART AND ITS MEMORY DOES NOT.** "Lane E did T-260" is a fact
  about a window, not about a mind. Brief every lane as if it knows nothing.
- ⚠️ **A LANE MAY BE HELD BY ITS OWN AUTHORIZATION GATE**, which looks identical to being stuck.
  Ask; do not route around it.
- ⚠️ Killing the dev server leaves a truncated `apps/erp/.next/dev/types/routes.d.ts` that fails
  typecheck and reads like a source error. `rm -rf apps/erp/.next` first.
- ⚠️ `/F` in Git Bash becomes `F:/`. Kill by PID, never by image name.

## The lanes

Lanes rename themselves per task — **match on `[ref]`, never the name.**

| Lane | ref | Model | This session | Lane DB |
|---|---|---|---|---|
| **B** | `6b575a` | Sonnet 5 | **built BOTH T-262 and T-261** | `shareat_test_t229` |
| **C** | `523c43` | **Opus 5** | decided T-261 (Arm D), released | `shareat_test_qa` |
| **D** | `074c83` | **Opus 5** | decided T-262 (geometry), released | `shareat_test_t216b` |
| **E** | `505d06` | Sonnet 5 | held by its own user-authorization gate | `shareat_test_def219` |

⚠️ **C and D are still on Opus and are idle** — Ian's keystroke to `/model sonnet`. Cost, not risk.
⭐ **Probe every lane for its model before assigning.** The lane last night's handoff said would not
answer replied on the third try and was Opus all along — which is why T-261 could start at all.

**Protocol lanes must be told** (they will not remember): first line `[X] STATUS: sentence`, STATUS
∈ ACK/QUESTION/SPEC/READY/BLOCKED. Workers never run git, build, dev, or
`npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`. **You alone** stage explicit
paths, commit with `-F`, push, run the dev server and browser, and edit the bible, registers,
roadmap and board.

## Databases and tools

`shareat_dev` · `shareat_test` · four lane DBs · **`shareat_test_t240`** — PIN `246810` on
`Smoke Store (SMK)`. **Do not drop it.** `shareat_dev` signs in as **Dev Admin, PIN `111111`**.
⚠️ Sign-in is store-scoped — **pick the store BY NAME**, never index 0.
⚠️ `smoke-t260.mjs` left five cash requests in `shareat_dev` with purposes beginning `T260-`.

Browser scripts in `~/.claude/skills/orchestrator/tools/`: `smoke-t248`, `t250`, `t253`,
`t257-t258`, `t260`, **`smoke-t262.mjs`** (runs 390 AND 1280 — it hard-coded 390 and reported a
one-breakpoint result as a fact about the app), **`smoke-t262-verdict.mjs`**, and the three
**`f8-*.ts`** RLS probes.

## The status board

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** rather than chat.
`Artifact action:"read"` it, edit, republish with that `url` at **every commit**. **Never make a
second one.** `docs/ROADMAP.html` moves at the same moments — do both, with an **anchored script
that refuses unless each anchor matches exactly once.** It refused twice today and was right both
times.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read
C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md in full, then docs/RULES.md, then
PROJECT_BIBLE.md §13 rows 184, 189, 190, 191 and 192.

Tree is CLEAN, main pushed, all gates green. T-261 and T-262 shipped. Run ListAgents, match lanes
by [ref] not name, and PROBE EACH FOR ITS MODEL BEFORE ASSIGNING — execution on Sonnet, judgement
on Opus. Lanes C (523c43) and D (074c83) are idle on Opus and should be switched back to Sonnet.
Lane E (505d06) is held by its own user-authorization gate — ask Ian, never route around it.

You own the dev server on 9008, builds, migrations, git and every browser pass; lanes never run
git, build, dev or npm run test:integration. Ask each lane for its exact path list, stage explicit
paths, commit with -F, push, and update BOTH docs/ROADMAP.html and the status board at EVERY commit.
Re-run every gate yourself on the shared database rather than accepting a lane's numbers.

⛔ EIGHT counting errors happened yesterday across two documents and every one was caught by
RE-DERIVING a number, never by reasoning — two were the orchestrator's, and twice the re-check
introduced the next error. Treat every register row, task stub, spec section AND YOUR OWN
MEASUREMENT as a hypothesis. ⛔ A refusal or a permission is not evidence until you know which
layer produced it. ⛔ A spec can contradict itself two sections apart and a lane will faithfully
build the wrong half. ⛔ Re-confirm a lane's baseline AT DISPATCH — a briefing's tree state is a
claim with a timestamp, and a lane cannot check it.

Pick up at "Pick up here": T-263 (DEF-283, the date idiom the bible forbids — Sonnet, decision
already made), then T-264 (DEF-284, the period lock — slice 1 is Sonnet and fixes a live failure),
then DEF-279.

FOR IAN, still open: the production DB username in /srv/shareat-shared/.env.local, which decides
whether DEF-282 is real work; and the month-end timer deploy, which he has held deliberately.
```
