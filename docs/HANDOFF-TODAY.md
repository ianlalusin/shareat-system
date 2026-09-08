# Handoff — 2026-09-09 — for the NEXT ORCHESTRATOR

> **You are taking over as the ORCHESTRATOR of a four-lane team, and this time the lanes are COLD.**
> All four worker terminals have been cleared and re-spun on `opusplan`. They remember nothing —
> **brief them from scratch**, do not "re-adopt" them. That is a change from every previous handoff
> and it is deliberate (bible row 187).
>
> Ian invokes `/orchestrator shareat system` in your terminal himself; the skill is user-invocation
> only — run the role from this file until he does.

## ⭐ The milestone was reached: production sign-in WORKS

Ian signed in on **https://erp2.shareat.net** with his real v1 email and password, created the
organisation from `/setup`, and is inside the app. That had been item 1 for two days. The window in
which any account in v1's Firebase project could have claimed the organisation is now closed.

It failed first, and the diagnosis is worth carrying because none of it was in the code:

| Fault | What was wrong |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | **The GitHub secret had never been created.** A missing secret interpolates to `""`, `next build` inlines the empty string, the artifact ships and the workflow goes green |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` / `_PROJECT_ID` | Pointed at **`shareat-hub-v2`** — the POS/storage project — instead of the identity project `studio-7300228488-a394e`. Every correct password would have come back unverifiable |
| the project id's value | Carried a **trailing newline** from a paste into the GitHub web form |
| the droplet's `FIREBASE_PROJECT_ID` | Also `shareat-hub-v2`. The browser and the server must name the same project |

All four are fixed and **verified by reading the deployed JS chunk back**, not by trusting the green
tick. That habit is the point: `curl` the bundle and grep for the inlined values.

## ⛔ Read this before you brief anybody — two rules changed today

**1. All four lanes run `opusplan`.** It selects Opus **in plan mode** and Sonnet otherwise, so bible
row 184 is now automatic and nobody types `/model` any more. ⛔ **But a spec written as ordinary work
gets SONNET.** Specs are where Opus has repeatedly paid for itself here — one lane caught that a
proposed bible mnemonic contradicted the rule beneath it *while specifying*; another named three
green-but-broken traps before writing a line. **Your briefing must tell the lane to write its spec IN
PLAN MODE and exit plan mode to build.** A lane that specs outside plan mode has silently downgraded
the most valuable half of its work.

**2. Say when a lane is SAFE TO CLEAR, in that lane's own terminal** (bible row 187, Ian's directive).
From outside, "idle" and "safe to clear" look identical and are not the same thing. State *why* it is
safe: nothing in flight · no uncommitted work of its own in the shared tree · no lane state that
lives only in the session · its lane DB survives and is re-attachable by name · the commit its work
landed in. Last night three lanes were free and the fourth held two finished, fully-verified tasks
that existed **only as uncommitted changes in the shared tree**.

## Where things stand

`main` is at **`5116c66`** plus this wrap-up commit, pushed, **tree clean, every lane cleared**.
Production is live and running `c598517`.

Six commits since the previous handoff. **Four tasks shipped — T-239, T-240, T-241, T-242** — one
defect decided by Ian and written into the bible, and four defects filed (DEF-235, DEF-236, DEF-237,
DEF-238).

## Gates

typecheck **exit 0** (⚠️ use `--incremental false` — a stale `tsconfig.tsbuildinfo` on this shared
tree reports phantom errors on a file a peer lane is mid-edit; it cost two lanes a false "the tree is
not committable" report yesterday) · unit **77 files, 1163 passed / 1 skipped** · build **exit 0**
with 9008 free · integration **green in CI on `5116c66`** — ⚠️ stated precisely because it matters:
the local `npm run test:integration` was **killed by the OS for memory pressure**, not failed, so
there is no local number for it. `ci.yml:68` runs the same `npm run test:integration` against real
Postgres and the run for `5116c66` completed `success`, as did typecheck, unit and build. If you need
a local full run, expect it to want most of the machine — close the lane terminals first · browser:
**77/78**
(T-240, six routes × 1280/1440/1536 on seeded records), **150/150** (T-241, 25 routes × 390/1280),
**10/10** (T-239, `/admin/users/[personId]` × 390/1280). `shareat_dev` is at **0138**.

## ⭐ The four agent sessions — CLEARED, brief them cold (`ListAgents`)

| Lane | Session · model | State | Lane DB | Suggested next slice |
|---|---|---|---|---|
| **B** | `ianla-3a` · opusplan | Cleared. Shipped T-240 | `shareat_test_t229` | Open. It has no memory of the 101-page sweep any more — that context is gone, so do not ask for it |
| **C** | `ianla-87` · opusplan | Cleared. The QA lane | `shareat_test_qa` (0138) | Gates + a line-by-line read on every READY. Brief the full QA protocol; it will not remember it |
| **D** | `ianla-0a` · opusplan | Cleared. Shipped T-239 + T-242. **The migration lane** | `shareat_test_t216b` (0138) | The migration slot is **free** |
| **E** | `ianla-60` · opusplan | Cleared. Shipped T-241 | `shareat_test_def219` | Open |

**Protocol the lanes follow** (they must be told, they no longer know it): first line
`[X] STATUS: sentence`, STATUS ∈ ACK/QUESTION/SPEC/READY/BLOCKED (lane C: VERIFIED/FAILED). Workers
never run git, build, dev or `npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`; a new lane DB via
`make-test-dbs.mjs <name>` **run from the repo root**. **You alone** stage explicit paths, commit with
`git commit -F <file>`, push, run the dev server and the browser, and edit the bible, register,
roadmap and board. Lanes write specs (in plan mode); you approve; then they build.

## Pick up here, in this order

1. **Two systemd timers still need arming on the droplet** — the recurring-expense drafting job
   (T-216) and the order-wastage backstop (T-236, daily 02:30 Manila). Ian's call, made and not yet
   executed: copy `docs/ops` fresh, **delete the old copy first** (DEF-194: an `scp -r` into an
   existing path NESTS and you then run a stale script), then `provision.sh`. Its install loop is a
   glob as of T-238, so it installs all thirteen units. ⚠️ **`159.223.46.224`, not `.78.207`** — see
   DEF-238.
2. **Eighteen stale databases to drop** — Ian said drop all eighteen; the classifier blocks the
   orchestrator from `DROP DATABASE`, so it is his keystroke. Keep `shareat_dev`, `shareat_test`, and
   the four lane DBs. ⚠️ One of the eighteen, `shareat_test_setup2`, **was** a harness default; that
   default has been removed (`smoke-t232.mjs` now demands `SMOKE_DB`), so dropping it is safe.
3. **Tutorials — Ian decided: COUNT FIRST.** Rank the pages by the walls people actually hit, half a
   day, before a single tutorial is written. **DEF-216** (the store-readiness checklist that lost
   v1's `href`/`doc` links) is step one either way. His reasoning is on the roadmap.
4. **DEF-218** — the harness must connect as a non-superuser, non-BYPASSRLS role. It touches every
   job suite's fixture path, so it runs **alone on the tree**. ⭐ The census is already measured and
   listed: `docs/discovery/29` §3.4a names all **34** suites that do not switch principal (of 107).
   Do not recount it a third time.
5. Then the queue: **DEF-237** (a manager elevated while an org had no admin keeps those powers for
   ever — a real lifecycle decision, not a patch), **DEF-221**, **DEF-230**, **DEF-233**, **DEF-220**,
   the rest of **DEF-238**'s doc sweep, and T-231's two sweeps.

## Do not decide these alone — they are Ian's

- **DEF-237's shape.** Revoke the elevated grants when an organisation gains an active administrator,
  or mark them conditional at grant time and have `authorize` ignore them once the condition lapses.
  Rank already makes it non-escalating, so there is time to ask rather than patch.
- **Anything that adds a third thing depending on Ian personally.** Bible rows 116 and 186 record
  three now; he accepted the third knowingly. A fourth is a decision, not an implementation detail.

## Traps that have actually bitten — the last two days

- ⛔ **A missing GitHub secret is an EMPTY STRING, and the deploy goes green.** DEF-235. Verify a
  deployment by reading the shipped bundle, not the workflow's tick.
- ⛔ **`sed`'s `&` in a replacement means "the whole match".** A `&ndash;` in replacement text
  expanded and corrupted a roadmap line this session. Use the file tool for prose; if you must use
  `sed`, check `git diff --stat` afterwards and confirm the line count is what you intended.
- ⛔ **A harness that defaults its database silently checks the wrong one.** `smoke-t232.mjs` defaulted
  `SMOKE_DB` to `shareat_test_setup2` while the browser drove whatever the dev server pointed at, so
  a person id read from the wrong database opened a 404 that read exactly like a regression in the
  page under test. Fixed to fail loudly. **Measure a blocker before forwarding it** — that one nearly
  sent a lane to repair working code.
- ⛔ **A CHECK constraint passes when its expression is NULL.** The natural spelling of a non-blank
  clause accepts the exact row it exists to forbid. Always add the explicit `IS NOT NULL` term and a
  raw-SQL control that goes red without it (T-239 §10 case 3 is the model).
- ⭐ **Tailwind breakpoints are VIEWPORT queries and this app has no container-query plugin.** ANY
  responsive grid moved into a narrow container — rail, drawer, split pane, modal — keeps its
  N-across layout while every automated gate stays green. And do the arithmetic for the **whole
  narrowed column**, not just the block that moved: that is what caught a nested grid whose fields
  would have fallen to 164px one level in.
- ⭐ **A page is not a unit of work — a wrapper is, a form is, a row is.** The filter-row population
  was wrong twice (22 files → 26 rows across 25 files; one page carries two).
- **Nothing exists in any database until you make it.** Six detail-page modules were empty
  everywhere, so T-240's screenshots were impossible until one record per module was seeded through
  the domain's own creators. `/attendance/lane`'s filter row needs a **second store** to render at
  all (`{stores.length > 1}`).
- **A stale `tsconfig.tsbuildinfo`** reports phantom errors on a peer's mid-edit file. `--incremental
  false` before believing a red.
- **The classifier blocks** `gh secret set`, `DROP DATABASE`, ssh to the droplet, and editing a live
  auth guard to test the pre-fix behaviour. **Say what was blocked; never route it through a lane.**
  When QA hit the last one it stopped and traced the code path instead, which was a better proof.
- **`npm run build` rewrites `apps/erp/next-env.d.ts`**; after a build,
  `git checkout -- apps/erp/next-env.d.ts` rather than committing the flip.

## The status board — update it at EVERY commit

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** instead of chat
reports. `Artifact action:"read"` it, rebuild the HTML locally, republish with that `url` after every
commit and every lane state change. **Never create a second board.** `docs/ROADMAP.html` moves at the
same moments.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md
in full, then docs/RULES.md. Ask Ian to type /orchestrator shareat system in your terminal (the skill
is user-invocation only). Four worker terminals exist and are ALL CLEARED and running opusplan:
lane B = ianla-3a, lane C = ianla-87 (QA), lane D = ianla-0a (the migration lane), lane E = ianla-60.
Run ListAgents, then BRIEF THEM COLD — they remember nothing, so do not re-adopt and do not assume
any context. Every briefing must tell the lane to write its spec IN PLAN MODE and exit plan mode to
build: opusplan gives Opus only in plan mode, so a spec written as ordinary work silently runs on
Sonnet (bible rows 184, 187).

Ian's production sign-in WORKS and the organisation exists — that milestone is closed. You own the
dev server on 9008, builds, migrations, git and the browser passes; lanes never run git, build, dev
or npm run test:integration. Stage explicit paths, commit with -F, push, and update docs/ROADMAP.html
and republish the status board at EVERY commit. Every READY gets lane C's gates on its DB and an Opus
second read — measure any blocker before forwarding it. Tell a lane in its own terminal when it is
SAFE TO CLEAR, and say why. Pick up at "Pick up here": the two droplet timers and eighteen stale
databases are Ian's keystrokes, then DEF-216/tutorials-counting, then DEF-218 alone on the tree.
When a task completes with the tree clean, that is a milestone: run /wrap-up, rewrite this file, and
hand over. Keep your session small.
```
