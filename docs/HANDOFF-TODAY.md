# Handoff — 2026-09-10 — for the NEXT ORCHESTRATOR

> **The tree is CLEAN, all gates are GREEN, and every lane is idle.** Nothing is half-built.
> Ian invokes `/orchestrator shareat system` in your terminal himself; the skill is
> user-invocation only. Run the role from this file until he does.

## Where things stand

**Five tasks shipped** (T-251a, T-252, T-253, T-254, T-256) and **thirteen defects filed**
(DEF-251…263). Production is live and unchanged. `main` is green and pushed.

⭐ **Ian cleared his entire decision backlog today.** Ten decisions, all recorded — see the table
below. Two carried items that had sat for three days (DEF-241, DEF-242) are closed or handed off.
**There is no queue of unanswered questions waiting for him**, which has not been true for a week.

## Gates

All run by the orchestrator on the **shared** database, not a lane's:

- **typecheck** `--incremental false` → **exit 0**
- **unit** → **87 files, 1244 passed / 1 skipped, exit 0** (re-run after `f3c63bd`)
- **integration** → **109 files, 2674 passed, 0 failed, exit 0** — 1391s (~23 min) on `shareat_test`
- **build** → **exit 0**, 9008 free, route table lists `ƒ Proxy (Middleware)`
- **browser** → T-253 **10/10** at 390 **and** 1280 (`smoke-t253.mjs`)

⚠️ Code gates were run at `0a984eb`; every commit after it is docs, ops config or the bible, so
they still hold. **Re-run them anyway before your first commit** — that is the standing rule and it
costs ten minutes.

⭐ **Run the integration suite with `--reporter=verbose`.** It takes ~23 minutes and the default
reporter prints *nothing* for that entire time, which is how a healthy run got killed for looking
dead two sessions ago (DEF-245). Verbose makes progress visible. The one-line `package.json` change
to make that the default is **still not done** and is still worth doing.

## Pick up here, in this order

1. **T-257 — DEF-259: there is no way to sign out of the ERP.** ⭐ **Ian's explicit call: this is
   next.** `signOutAction` is complete and correct and *nothing calls it*; a sweep for every
   spelling of sign-out across every `.tsx` returns zero. Sign-in is store-scoped and sessions are
   server-side, so a shared machine cannot be handed over. **The hard part is already written** —
   this is a control in the shell plus a placement decision. Spec is at
   `docs/tasks/257-def-259-sign-out.md`.
2. **T-259 — DEF-235: the deploy preflight.** A deploy shipped an empty required secret and
   reported success; the only signal was a person unable to sign in. ⚠️ The
   **trailing-whitespace** case is the one that will bite — an emptiness check alone does not close
   it. `docs/tasks/259-def-235-deploy-preflight.md`.
3. **T-255 — DEF-257: the ~38 private `errorMessage` copies.** Sequenced deliberately after T-252
   so there is one correct implementation to converge on. ⛔ **Delete the copies; do not sanitise
   each in place** — 38 hand-maintained copies is *how* the drift happened.
4. Then: **T-258** (DEF-244, whole-row tap targets — Ian decided the shape, the spec must resolve
   rows needing a second action first), **DEF-260** (terminal pairing, per bible row 190),
   **DEF-251/252** (the sweep's silent skip and `leftOpen: 0`), **DEF-253/254/255**, **DEF-261/262**.

## Ian's decisions today — all ten, and where each is recorded

| Decision | Recorded in |
|---|---|
| **DEF-259 — sign-out is next, top of the queue** | `docs/tasks/257-*.md`, DEF-259 |
| **DEF-260 — a MANAGER confirms terminal pairing on screen**, not a device-announce route; his reason: 1–2 tablets per store | **bible §13 row 190**, DEF-260 |
| ⭐ **The clock terminal is a downloaded Android APK (GitHub-compiled) with a fingerprint reader on an OTG dongle — biometric in/out, as v1 does** | **bible §13 row 190** + `CAPABILITY-GAPS.md` |
| **DEF-241 — the month-end timezone was an oversight**; moved to 03:00 Asia/Manila | `docs/ops/shareat-month-end.timer`, DEF-241 |
| **Bible row 185 — add the implementation pointer**; substance unchanged | **bible §13 row 185** |
| **DEF-263 — downgrade to a note about the name clash**; `packages/etl` is Phase 8 machinery, not dead | DEF-263 |
| **DEF-256 — short-shift half-day OT stays ON**, re-confirmed with the fix pending | DEF-256 |
| **DEF-244 — the WHOLE ROW becomes the tap target** | `docs/tasks/258-*.md`, DEF-244 |
| **DEF-235 — add the preflight, fail closed**; post-deploy smoke check deliberately deferred | `docs/tasks/259-*.md`, DEF-235 |
| **DEF-242 — ANSWERED AND SHIPPED by Ian's own agent at `f3c63bd`: DOCUMENT, do not repair; `db:generate` retired** | **ADR-012** · DEF-242 · ⚠️ **it proposes bible row 191 — Ian to ratify** |

## Do not decide these alone — they are Ian's

- ⛔ **The fingerprint capture gap is the big one, and it is now fully mapped.** v1's clock is a
  **Capacitor APK** whose fingerprint reader is a **custom Android plugin over the ZKTeco ZKFinger
  SDK** (`ERP-rebuild/src/lib/biometric/fingerprint.ts:3-6`) — APK-only, a browser cannot talk to a
  USB sensor. **That is why T-203 concluded "no capture device exists in this stack" and shipped
  paste-only enrolment: the conclusion was right for the stack it was looking at, and the stack was
  the wrong one.** Every v1 file is named in `CAPABILITY-GAPS.md` so a port is guided. ⚠️ It is
  **multi-week** — four punch methods, a native plugin, an offline queue and a re-arm state machine.
  **Ian has not been asked about face recognition, which v1 also has.**
- ⭐ **RATIFY BIBLE ROW 191 — DEF-242 is answered and shipped, and its row is proposed but NOT
  written** (rule 14: only the planner amends the bible). Ian's own agent shipped `f3c63bd` +
  **ADR-012**: `npm run db:generate` is **retired**, fails closed with its reasons, and
  hand-authored SQL is now the written convention. ⭐ **It found the real blocker, and it was not
  the one anyone feared.** The feared problem — a regenerated snapshot silently disagreeing with
  what 124 hand-written migrations built — **does not exist**: measured, **0 real disagreements**
  across 127 tables, 1,636 columns, 518 FKs, 312 indexes, 356 checks. ⛔ **The unfixable half is
  the journal clock.** drizzle-kit stamps every entry with `+new Date()`, while this journal sits
  on DEF-091's deliberate one-day-per-index grid where **90 of 124 entries are in the future and
  head 0140 is dated 2026-12-25** — so a generated entry sorts ~106 days BELOW the head and is
  **silently skipped** (DEF-039's trap, already sprung here once). No option controls `when`, and
  the head advances faster than the clock. Plus RLS on all 127 tables and 122 policies that
  `generate` cannot emit at all. **Verified by the orchestrator after it landed:** typecheck 0,
  unit 87 files / 1244 passed.
- **DEF-237's residue** — grants written before `grant_source` existed stay NULL for ever.
  Accepted; permanent.
- **DEF-258's triage** — 47 same-digit dark-mode overrides across 28 files. ⛔ Not all are defects
  and the row says so; triage before touching, and **do not bulk-replace on a regex**.

## Two things Ian must do himself

1. ⚠️ **Apply the month-end timer on the droplet.** `docs/ops` does not ship (DEF-194), so the
   server still runs the old **unzoned** unit — month-end will next fire 10:00 Manila.
   Verify with `systemctl list-timers`: NEXT should read **19:00 UTC on the 30th/31st**, not 02:00
   UTC on the 1st.
2. The paste-ready DEF-242 prompt was handed to him in chat this session; it is not in a file.

## Traps that bit TODAY

- ⛔ **A brief is a hypothesis, and today it was wrong FIVE times** — including the handoff's own
  first line ("four worker terminals exist"; none did) and DEF-249's own count. **Read the source,
  not the register row.**
- ⛔ **A tested function with no production caller is not a feature, it is a claim.** A lane
  proposed shipping a counter no caller invoked; that is DEF-226/227/249's exact shape. It was
  refused and 8 real callers were wired instead. **Check every new export has a caller before you
  commit it** — `node scripts/production-caller-census.mjs` now does this mechanically.
- ⛔ **A census is a MEASUREMENT, never a verdict.** The orchestrator filed DEF-263 against
  `packages/etl` — which is Phase 8 cutover machinery whose zero callers are *expected* — after
  recording the lane's own warning that most zero-caller exports are built ahead of their screens.
- ⛔ **A guard that can emit a wrong list is one someone will believe.** The census was wrong twice
  and **both times printed a complete, plausible list rather than an error**. Its control is now
  built in and fails closed. Same family: three sweeps on this project have reported nothing as
  success.
- ⛔ **An injection you have not proven landed tells you nothing.** A lane's first attempt to prove
  its own control worked used `sed`, the escaping silently did not apply, and the run looked like
  the control failing. It only knew because it diffed the patched file first.
- ⚠️ **Barrels are the orchestrator's, and the pause is the point.** One lane asked before adding a
  barrel line — and that pause caught that exporting all four new functions would open a route the
  guard cannot match. Another lane added its barrel line itself; the line was fine, but nobody
  looked.
- ⚠️ **A lane running `npm run dev` on 9008 during your `npm run build` corrupts the `.next` you
  are serving.** One lane did run the dev server; no collision occurred, but two builds ran that day.
- ⚠️ **`npm run build` rewrites `apps/erp/next-env.d.ts`**; `git checkout --` it afterwards.
- ⚠️ **Sign-in is store-scoped — pick the store BY NAME.** For the T-253 pass, sign in at **Lipa**
  (a branch) on `shareat_dev` deliberately: it is the store the defect used to select wrongly.
- ⚠️ **`shareat_test_t240` has NO commissary at all** — the commissary defect only reproduces on
  `shareat_dev`, where `Smoketest Commissary` holds the only outgoing link.
- ⚠️ **A bible row means `npm run toc`.** Two rows were added today; both were followed by it.
- ⚠️ **Backticks in a Bash double-quoted string are command substitution**, and a long heredoc can
  exceed the command-length limit outright. **Write a script file with the Write tool and run it** —
  that is what worked today, repeatedly, after shell quoting failed twice.

## The four lanes — ALL IDLE, all SAFE TO CLEAR

Lanes **rename themselves per task**, so match on the `[ref]` from `ListAgents`, not the name.
All four were sent a SAFE TO CLEAR notice with reasons (bible row 187).

| Lane | ref | Shipped today | Lane DB |
|---|---|---|---|
| **B** | `6b575a` | T-253 | `shareat_test_t229` |
| **C** | `523c43` | QA — DEF-249 traced, the census, 11 findings | `shareat_test_qa` |
| **D** | `074c83` | T-252 | `shareat_test_t216b` |
| **E** | `505d06` | T-251a, T-254, T-256 | `shareat_test_def219` |

⭐ **Assign by MODEL, not by lane history — it worked, and Ian asked for it.** Probe each terminal
first (*"reply with MODEL / CONFIGURED / PLANMODE"*). A task whose spec already exists is pure
execution and belongs on a **fixed-Sonnet** terminal, where row 184 makes Sonnet *correct*, not a
compromise. A trace or a judgement call belongs on a **fixed-Opus** one. Only `opusplan` terminals
need plan mode — **that dropped Ian's approval prompts from eight to four.**

⚠️ **Tell each `opusplan` lane: write the spec IN PLAN MODE, exit plan mode to build** — and warn
Ian, because **each raises a prompt in that lane's terminal** or the lane stalls silently.

**Protocol they must be told** (they will not remember): first line `[X] STATUS: sentence`,
STATUS ∈ ACK/QUESTION/SPEC/READY/BLOCKED (lane C: VERIFIED/FAILED). Workers never run git, build,
dev, or `npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`. **You alone** stage explicit
paths, commit with `-F`, push, run the dev server and browser, and edit the bible, registers,
roadmap and board.

## Databases

`shareat_dev` · `shareat_test` · four lane DBs · **`shareat_test_t240`** — the browser-pass
database: PIN `246810` on `Smoke Store (SMK)`. **Do not drop it.** Head is **0140** and every
database was verified at **124/124** today.
`shareat_dev` signs in as **Dev Admin, PIN `111111`**.

Browser scripts in the orchestrator tools folder: `smoke-t248.mjs`, `smoke-t250.mjs`,
**`smoke-t253.mjs`** (new — carries sign-in-by-name and a negative control).

⭐ **New in the repo: `scripts/production-caller-census.mjs`** with `docs/production-caller-baseline.txt`
(111 names). Run it at a phase boundary and diff the names. Regenerate the baseline with `--names`;
**never hand-edit it.**

## The status board

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** rather than chat.
`Artifact action:"read"` it, edit, republish with that `url` at **every commit**. **Never make a
second one.** `docs/ROADMAP.html` moves at the same moments — do both.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read
C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md in full, then docs/RULES.md, then
PROJECT_BIBLE.md §13 rows 185, 188, 189 and 190. Ask Ian to type /orchestrator shareat system
in your terminal (the skill is user-invocation only).

The tree is CLEAN and all gates were green at handoff. No lane terminals exist — ask Ian to
open them, then run ListAgents and match by [ref], not name. ⭐ PROBE EACH TERMINAL FOR ITS
MODEL BEFORE ASSIGNING: a task whose spec already exists is pure execution and belongs on a
fixed-Sonnet terminal; a trace or judgement call belongs on fixed-Opus; only opusplan lanes
need plan mode. Tell every opusplan lane to write its spec IN PLAN MODE and exit plan mode to
build — and warn Ian that each raises a prompt in that lane's terminal or it stalls silently.

You own the dev server on 9008, builds, migrations, git and every browser pass; lanes never run
git, build, dev or npm run test:integration. Stage explicit paths, commit with -F, push, and
update BOTH docs/ROADMAP.html and the status board at EVERY commit. Re-run every gate yourself
on the shared database rather than accepting a lane's numbers. Run integration with
--reporter=verbose; it takes 23 minutes and prints nothing otherwise.

⛔ Treat every register row and task stub as a HYPOTHESIS. Yesterday five briefs were wrong,
including the handoff's own claim about which terminals existed and DEF-249's own count.
⛔ Never commit a new export with no production caller — that is DEF-226/227/249's shape;
scripts/production-caller-census.mjs checks it mechanically.

Pick up at "Pick up here": T-257 (DEF-259, no way to sign out — Ian's explicit next), then
T-259 (DEF-235 deploy preflight), then T-255 (DEF-257). DEF-242 is DONE (ADR-012, db:generate
retired); its bible row 191 is PROPOSED, NOT WRITTEN — Ian ratifies, rule 14. The fingerprint
capture gap is Ian's and is mapped in CAPABILITY-GAPS.md.
When a task completes with the tree clean, that is a milestone: run the wrap-up ritual
(.claude/skills/wrap-up/), rewrite this file, and hand over. Keep your session small.
```
