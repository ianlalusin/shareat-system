# Handoff — 2026-09-09 (evening) — for the NEXT ORCHESTRATOR

> **You are taking over as ORCHESTRATOR of a four-lane team, and the lanes are COLD.**
> Brief them from scratch — do not "re-adopt" them (bible row 187). Ian invokes
> `/orchestrator shareat system` in your terminal himself; the skill is user-invocation only.
> Run the role from this file until he does.

## Where things stand

**Six tasks shipped today** (T-243, T-244, T-245, T-246, T-247, T-249) and **one is parked as
committed WIP** (T-248). Production is live and unchanged. **Both droplet timers are finally armed
AND proven working** — that item had been open on Ian's board since 7 Sep. `main` is green and
pushed; nothing is uncommitted.

## Gates at `f61bd7f`

- **typecheck** `--incremental false` → **exit 0**
- **unit** → **82 files, 1185 passed / 1 skipped, exit 0**
- **build** → **exit 0**, 9008 free (route table lists `ƒ Proxy (Middleware)`, which is how you know
  T-246's proxy actually registered rather than merely existing as a file)
- **integration** → ⛔ **THE LOCAL FULL RUN STALLED AND WAS ABANDONED. There is no local number.**
  Stated bluntly because a vague gate line is how a red gets buried. It ran ~40 minutes, produced a
  12.8 MB log containing **only Postgres truncate NOTICEs and not one test-progress marker**, then
  the log size froze while 33 node processes stayed alive. I stopped it. **This is not a reported
  failure — it is an absence of evidence**, and it is the *second* session running: the previous
  orchestrator had the same suite **OS-killed for memory pressure**.
  - **What IS known:** every suite touched today passed in targeted runs on the **shared** database
    — 468 across T-243+T-244, 22 for T-245 — plus 455 for T-248 on its lane DB.
  - **CI (`ci.yml:68`) runs the same command against real Postgres and is the backstop.** ⚠️ Check
    the run for `68ccdaa` before trusting a green tree; do not assume it.
  - ⭐ **Worth treating as a defect rather than an inconvenience** — a suite nobody can run locally
    stops being a gate and becomes a formality. Two sessions have now failed to complete it. If it
    stalls for you too, file it rather than working around it a third time.
- ⚠️ **Before any integration run: `node ~/.claude/skills/orchestrator/tools/make-test-dbs.mjs
  shareat_test`.** Migration head moved twice today (0139, 0140) and a stale DB fails as a missing
  column, which reads like a code bug.

## What happened, by theme

**Two defects that were invisible by construction.** T-247 found that a test placed in the obvious
directory matched no vitest glob — it never ran and was counted as passing. Proven by planting a
guaranteed-failing file and watching *every suite stay green with it in the tree*. T-245 built the
counter for the ~130 order-of-operations refusals the app throws and never recorded, which is Ian's
"count first" ruling made real.

**Two screens fixed on the device staff actually use.** T-246 stopped the ERP navigation rendering
on the wall-mounted clock kiosk. T-249 doubled the size of small tap targets — landing at 32px, not
the 44px designed, because 44px was *measured* to make adjacent customer rows overlap so a tap in
the gap opened the wrong customer's record.

**Authority.** T-244 fixed a super-admin-run organisation being treated as leaderless. T-248 (WIP)
adds the provenance column its successor needs.

**Ian's decisions this session, and where each is recorded:**

| Decision | Recorded in |
|---|---|
| Revoke elevated grants when an admin arrives (Option 1) | **bible §13 row 188** — with the rejected alternative named so it is not re-proposed |
| Drop the 18 stale databases | done; board item closed |
| Arm the timers "later, when all is done" | done and proven; board item closed |
| ⚠️ Row 188's "no migration" claim was **the planner's error** | corrected inline in row 188 |

## Pick up here, in this order

1. **Finish T-248** — it is committed WIP at `ae8262e`, not shipped. Outstanding: the lane's
   line-by-line diff self-review, and **the browser pass, which is yours** (`/admin/users`,
   appointing a manager). ⛔ Read **bible row 188** before touching it; the shape is Ian's and settled.
   ⚠️ `/staff/hire` needs a job **position** defined or it silently refuses — that blocked the
   T-244 browser pass and will block this one the same way.
2. **DEF-218** — the test harness connects as a superuser that bypasses RLS, so any job or policy is
   untested by construction. **It runs alone on the tree** (34 suites). The census is measured and
   listed in `docs/discovery/29` §3.4a and was re-verified unchanged at `5fc6d70` — **do not recount
   it a third time.**
3. **DEF-243** — five more undersized tap targets, already located. Apply T-249's `ACTION_LINK`.
   Then **DEF-244**, which is the real one: those customer rows are too short to host a 44px target
   at all, and fixing that is a layout decision.
4. Then the queue: **DEF-220** (one-line default), **DEF-230**, T-231's two sweeps.

## Do not decide these alone — they are Ian's

- **DEF-242 — `npm run db:generate` is broken for everyone.** 13 snapshots against a 123-entry
  journal; it fails with a *false rename question about `expense_categories`* before reaching your
  table. Hand-authored SQL has quietly become the convention without anyone deciding it. **Repair
  the generator, or write the convention down?** It governs every future schema change here.
- **DEF-241 — month-end is the only timer with no timezone**, so it runs 10:00 Manila, mid-working
  day, while every sibling is deliberately staggered into the small hours. Possibly intentional
  ("someone is awake when it fails"); nothing records it.
- **DEF-237's residue** — grants written before `grant_source` existed stay NULL and out of scope
  forever. Accepted deliberately; worth Ian knowing it is permanent.

## Traps that bit TODAY

- ⛔ **A brief is a hypothesis.** Four of six tasks found theirs wrong — including two claims the
  orchestrator wrote (bible row 188's "no migration", DEF-239's population count, which was out by
  more than half). **Read the source, not the register row.**
- ⛔ **An exact-string grep finds only what matches the string you wrote down.** DEF-239 counted 4
  by literal; searching for the *shape* found 9. Count the shape, not the spelling.
- ⛔ **`provision.sh` INSTALLS every unit and ENABLES none** — and its own printed list was
  hand-written and short by two. Fixed (DEF-240), but the shape recurs: **a fix that globs the
  machinery and leaves the neighbouring human instruction hand-maintained has moved the defect.**
- ⛔ **A write inside a transaction that is about to abort is rolled back with it.** T-245 round 1
  would have recorded nothing, forever, with nothing red. Use `withOrgPrincipal` for an independent
  transaction — and note it takes a *second connection*, so awaiting it inside an open transaction
  is a deadlock shape if the outer one holds a conflicting lock.
- ⛔ **A CHECK constraint passes when its expression is NULL.** Always the explicit `IS NOT NULL`
  term plus a raw-SQL control that goes red without it.
- ⚠️ **`middleware.ts` is deprecated in Next 16** (installed: **16.3.2**) and renamed `proxy.ts`; the
  header must be `NextResponse.next({ request: { headers } })` or it leaks to the client while
  looking correct. **Read `node_modules/next/dist/docs/`, not your training data.**
- ⚠️ **Nothing exists in a database until you make it.** Every store was already "ready", so T-243's
  new links would have rendered on no screen; `t240` had zero customers; all 38 expense categories
  are system rows so the Rename button does not exist. Seed, then look.
- ⚠️ **Sign-in is store-scoped.** Pick the store by name (`Smoke Store (SMK)`), never index 0 — a
  store you just created has no credentials and fails with *"that PIN is not valid for this store"*.
- ⚠️ `npm run build` rewrites `apps/erp/next-env.d.ts`; `git checkout --` it afterwards.
- ⚠️ Stale `tsconfig.tsbuildinfo` on a shared tree reports phantom errors on a peer's mid-edit file.
  Use `--incremental false` before believing a red.

## The four lanes — CLEARED, brief them cold

Lanes **rename themselves per task**, so match on the `[ref]` from `ListAgents`, not the name.

| Lane | ref | Last shipped | Lane DB | Suggested next |
|---|---|---|---|---|
| **B** | `242a5b` | T-243, T-246, T-249 | `shareat_test_t229` | DEF-243 + DEF-244 (its own findings) |
| **C** | `f32df4` | QA — no code | `shareat_test_qa` | QA. ⚠️ at 0139, re-migrate |
| **D** | `8b22c7` | T-244, T-247; **T-248 WIP** | `shareat_test_t216b` | Finish T-248 |
| **E** | `815ab6` | T-245 | `shareat_test_def219` | Open — DEF-218 wants a lane alone |

**Protocol they must be told** (they will not remember): first line `[X] STATUS: sentence`, STATUS ∈
ACK/QUESTION/SPEC/READY/BLOCKED (lane C: VERIFIED/FAILED). Workers never run git, build, dev, or
`npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`. **You alone** stage explicit
paths, commit with `-F`, push, run the dev server and browser, and edit the bible, registers,
roadmap and board. ⭐ **Tell each lane to write its spec IN PLAN MODE and exit plan mode to build** —
`opusplan` gives Opus only in plan mode, so a spec written as ordinary work silently runs on Sonnet.
⚠️ **Exiting plan mode raises a prompt in that lane's terminal**, roughly one per task — tell Ian, he
will not otherwise know why three lanes have stalled.

## Databases

`shareat_dev` · `shareat_test` · four lane DBs · **`shareat_test_t240`** — the browser-pass database:
seeded stores and **PIN `246810`** on `Smoke Store (SMK)`. **Do not drop it.** Head is **0140**.

## The status board

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** rather than chat.
`Artifact action:"read"` it, edit, republish with that `url` at **every commit**. **Never make a
second one.** `docs/ROADMAP.html` moves at the same moments — ⚠️ today T-246 was updated on the board
and *not* the roadmap, and read as in-flight after shipping. Do both.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read
C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md in full, then docs/RULES.md, then
PROJECT_BIBLE.md §13 row 188. Ask Ian to type /orchestrator shareat system in your terminal (the
skill is user-invocation only). Four worker terminals exist and are ALL CLEARED on opusplan —
run ListAgents and match them by [ref], not name, since lanes rename themselves: B=242a5b,
C=f32df4 (QA), D=8b22c7, E=815ab6. BRIEF THEM COLD; they remember nothing. Every briefing must
say: write the spec IN PLAN MODE, exit plan mode to build — and warn Ian that each of those
raises a prompt in that lane's terminal or the lanes stall silently.

You own the dev server on 9008, builds, migrations, git and every browser pass; lanes never run
git, build, dev or npm run test:integration. Stage explicit paths, commit with -F, push, and
update BOTH docs/ROADMAP.html and the status board at EVERY commit. Re-run every gate yourself
rather than accepting a lane's numbers, on the shared database rather than the lane's own.

⛔ Treat every register row and task stub as a HYPOTHESIS: four of six tasks yesterday found
their brief wrong, two of them written by the orchestrator. When a lane says "this specific
thing is not proven", that is the most valuable sentence it can send — act on it.

Pick up at "Pick up here": finish T-248 (committed WIP at ae8262e, needs a diff self-review and
your browser pass), then DEF-218 alone on the tree. DEF-242 and DEF-241 are Ian's calls, not
yours. When a task completes with the tree clean, that is a milestone: run /wrap-up, rewrite this
file, and hand over. Keep your session small.
```
