# Handoff — 2026-09-10 (evening) — for the NEXT ORCHESTRATOR

> **The tree is CLEAN, every gate is GREEN, `main` is at `692c931` and pushed.** Nothing is
> half-built. Ian invokes `/orchestrator shareat system` in your terminal himself; the skill is
> user-invocation only. Run the role from this file until he does.

## Where things stand

**T-260 shipped** — the sub-centavo money defect (DEF-272) is fixed across 19 call sites in 13
files behind one shared `parseMoneyInput()`. **T-261 is specified and unstarted**, waiting on an
Opus lane. Two defects filed (DEF-277, DEF-278). Production is unchanged.

⭐ **The most valuable thing in this session was not the fix. It was that three written-down
"facts" and two of my own measurements were wrong, and every one was caught only by re-checking.**

## Gates at `692c931`

Run by the orchestrator on the **shared** database, not a lane's:

- **typecheck** `--incremental false` → **exit 0**
- **unit** → **93 files, 1290 passed / 1 skipped, exit 0**
- **integration** → **110 files, 2706 passed, 0 failed, exit 0** — 1504s on `shareat_test`
- **build** → **exit 0**, port 9008 free, route table lists `ƒ Proxy (Middleware)`,
  `apps/erp/next-env.d.ts` restored afterwards
- **browser** → **14/14 at 1280** (`smoke-t260.mjs`, new)
- **caller census** → `controls: passed`; `parseMoneyInput` in neither `testOnly` nor
  `noRefsAnywhere`; totals 110, no baseline drift

⚠️ **Integration and browser were run at `ccac49d`. The only commit since (`692c931`) touches
`docs/ROADMAP.html` alone**, so they still hold — stated rather than silently re-claimed.
⚠️ No bible row was added this session, so `npm run toc` was not needed. **PROJECT_BIBLE.md was
not amended** (rule 14); DEF-275 is still Ian's.

## Pick up here, in this order

1. **T-261 — DEF-274, the hit counter reaches zero money screens.** ⭐ Spec is written
   (`docs/tasks/261-*.md`) and **opens with a DECISION, not code.** Bible §13 row 189 is Ian's and
   defers its next decision to *measured hit counts*; the counter is wired into payroll and
   settings only. ⛔ **A measurement that is blind where the risk is does not merely under-report —
   it misleads the decision it exists to inform.** ⚠️ The register's numbers are wrong and the
   difference decides the design: **17** call sites, not 19, and **~175** uncounted across 45
   files, not "~100". Three arms are written up with the trap on each. **Needs an Opus lane.**
2. **DEF-269 — re-census touch targets with a matcher that resolves inherited text size.** Also a
   judgement call, not execution: decide whether a text-scanning guard can do this at all or
   whether the assertion must move to rendered output. ⛔ Until then that guard's green is evidence
   about the shapes it can see and nothing more. **Needs an Opus lane.**
3. **DEF-278 — the client-side money floor is not uniform.** New. 17 of 26 money inputs exclude a
   sub-centavo value; **9 carry `min="0"` and permit one**, and two of those nine are DEF-277's
   deliberately-unfixed sites — so on exactly those, neither layer objects and the value is
   silently rounded. ⚠️ Do not raise any floor without checking whether zero is meaningful on that
   field; `overdraftLimit` is one where it is.
4. Then: **DEF-277** (DEF-272's quieter sibling, four sites), **DEF-260** (terminal pairing — Ian
   decided the design in row 190, so it is execution and belongs on Sonnet), **DEF-273** (sequence
   *after* T-261), **DEF-267**, **DEF-251/252**, **DEF-253/254/255**, **DEF-261/262**.

## What happened this session, by theme

**Two register rows were wrong in ways that changed the work.** DEF-272 cited
`money-transfers/index.ts:103` as an amount guard — that line is the distinct-accounts check and
has no amount in it; the real guard is `:155` and covers **two** amount fields. And its proposed
remedy ("reject what rounds to zero at the column's scale") would have **accepted `1.234` and
silently stored `1.23`**. The codebase already owned the right primitive: `money()` refuses both,
and `createCashRequest` did not import it at all.

**A one-line grep cannot find that set, and I proved it on myself.** My own census missed `:155`
because the comparison is on a variable rather than an inline `Number(...)`. So the census was
written **as a guard asserting zero**. It found three sites the spec's table never listed — and
still missed one (`releaseCashRequest`), which is now stated in the guard's own header alongside
three other blind-spot classes.

**The lane caught a defect in my spec before it reached sixteen more files.** A Done-when line said
`0.005` must keep working, contradicting the same spec's argument for `money()`. Ruled and amended:
**0.005 is refused deliberately** — the database boundary (does it round to zero) and the product
boundary (can it be stored exactly) are different boundaries, and the product's is stricter on
purpose. Silently rewriting a typed amount is a quieter version of the defect being fixed.

**I overruled one of the lane's own finds, by checking the schema rather than the code.**
`money-accounts/index.ts:232` looked identical to the others; its CHECK is `>= 0`, not `> 0`, and
its guard is `< 0` because **zero is a legitimate overdraft limit**. Fixing it would have refused a
valid entry. Filed as DEF-277 instead.

**A shipped task's paperwork said it was never built.** T-256 had been on `main` since the morning
(`0a984eb`) while both `docs/ROADMAP.html` and its own spec header still read "reserved, nothing
built" — and the previous wrap-up claimed to have fixed three stale spec headers. Both corrected.

**Decisions recorded:** no new Ian decisions this session. DEF-275 remains the only item proposing
a bible change and it is **reported and stopped** for him.

## Do not decide these alone — they are Ian's

- ⭐ **DEF-275 — one clause of bible §13 row 189 is unsupported by its own examples.** Unchanged
  from this morning. ⛔ Not a reversal — sanitise-first-then-count stands. If Ian agrees, row 189
  wants a superseding row narrowing that clause and citing DEF-272.
- **The fingerprint capture gap** — multi-week, in `CAPABILITY-GAPS.md`. ⚠️ Ian has still **not
  been asked about face recognition**, which v1 also has.
- **DEF-258's triage** — 47 same-digit dark-mode overrides across 28 files. ⛔ Not all are defects.
- **DEF-237's residue** — grants written before `grant_source` existed stay NULL for ever.

## Three things Ian must do himself

1. ⚠️ **Apply the month-end timer on the droplet.** `docs/ops` does not ship (DEF-194). Verify with
   `systemctl list-timers`: NEXT should read **19:00 UTC on the 30th/31st**, not 02:00 UTC on the
   1st. **Carried over from this morning; still the only production item on his board.**
2. ⛔ **Lane C will not answer.** It sat in `waiting` for about an hour, came unstuck on its own,
   and has now ignored **two** probes asking only which model it runs. It was never briefed —
   briefing a window whose model is a guess is how row 184 gets broken quietly. **Both remaining
   pick-up items need it.**
3. ⚠️ **A fifth session appeared mid-session that the orchestrator did not start** —
   `webapps-d8 [8370e0]`, busy. If it is editing this tree it is a writer nobody is tracking.

## Traps that bit TODAY — every one caught a real mistake

- ⛔ **A REFUSAL IS NOT EVIDENCE UNTIL YOU KNOW WHICH LAYER PRODUCED IT.** The T-260 browser pass
  was RED twice and both reds were the probe never reaching the server. (a) The form's own
  `<input type="number" min="0.01">` makes the **browser** refuse `0.004` — **an unfixed build
  would have produced an identical green**, and the tell was that the cases meant to SUCCEED also
  failed. When every case behaves the same you are measuring whether the form submits, not whether
  the guard works. (b) `removeAttribute('step')` does **not** disable step validation — step falls
  back to its HTML default of `1`, so the bypass looked applied and had not landed.
- ⛔ **KILLING THE DEV SERVER LEAVES A TRUNCATED GENERATED TYPES FILE THAT FAILS TYPECHECK, AND IT
  READS LIKE A SOURCE ERROR.** After `Stop-Process` on the 9008 server, `tsc` failed with
  `apps/erp/.next/dev/types/routes.d.ts(163,5): error TS1109` — the file was cut mid-declaration.
  It is gitignored, so the repo is fine and only the local gate is affected. `rm -rf apps/erp/.next`
  and re-run. **Check the PATH of a typecheck error before believing it is your code.**
- ⛔ **A LINE-WISE GREP OVER JSX ANSWERS PLAUSIBLY AND WRONGLY.** Counting money inputs with a
  client floor by `grep -A2` gave "4 of 18"; counting whole `<input>` elements gave **17 of 26**,
  and then checking the *value* of `min` (not merely its presence) gave the real answer — 9 carry
  `min="0"`, which permits the very value the floor looks like it excludes. Three passes, three
  different numbers, and only the last one is true.
- ⛔ **A SERVER ACTION'S `redirect()` DOES NOT SETTLE BEFORE `networkidle`.** Reading `p.url()`
  there returns the pre-redirect URL with no query, so every case reported `ok=null error=null`
  including ones that demonstrably created rows. `Promise.all([waitForURL(...), click()])` is what
  captures the action's own verdict — which is far more precise than scraping rendered copy.
- ⚠️ **`git add` stages whole files**, so a shared file cannot be split across task commits, and a
  lane's in-progress work must be excluded by naming paths explicitly.
- ⚠️ **`resize_window` in the Chrome tooling does not change the page viewport here.** Use the
  Playwright harness in `~/.claude/skills/orchestrator/tools/`.
- ⚠️ **A PRODUCTION BUILD CANNOT BE SMOKE-TESTED LOCALLY** — `npm start` refuses without production
  Firebase credentials. Every local browser pass is a dev-mode pass (DEF-276).
- ⛔ **Do not run the integration suite with lanes active (DEF-268)** — starvation presents as a RED
  TEST with absurd durations, not a crash. Check durations before believing any red taken while
  lanes were live. This session's run was clean: 1504s, all per-test durations millisecond-level.
- ⚠️ **`/F` in Git Bash becomes `F:/`.** Kill by PID (`Stop-Process -Id`), never by image name —
  five sessions share this machine.
- ⚠️ **Three files in this tree use CRLF** (`attendance/lane/actions.ts`, `inventory/usage/actions.ts`,
  `statutory-discounts/actions.ts`) — a sweep matching on a line ending silently skips them.

## The lanes

Lanes **rename themselves per task**, so match on the `[ref]` from `ListAgents`, not the name.

| Lane | ref | Model | This session | Lane DB |
|---|---|---|---|---|
| **B** | `6b575a` | Sonnet 5 (confirmed) | idle — held deliberately | `shareat_test_t229` |
| **C** | `523c43` | **UNCONFIRMED** — will not answer | never briefed | `shareat_test_qa` |
| **D** | `074c83` | Sonnet 5 (confirmed) | idle — held deliberately | `shareat_test_t216b` |
| **E** | `505d06` | Sonnet 5 (confirmed) | **T-260** | `shareat_test_def219` |

⭐ **Probe for the model before assigning — it paid off again.** Three answered and were briefed
or held correctly; the fourth never answered, which is how its stuck state was found at all.
⚠️ **B and D were held idle on purpose.** Both remaining items are judgement calls, and DEF-268
means the integration gate cannot run with lanes active — so starting filler work would have
delayed T-260's gate. That is the stronger reason; say so if Ian asks.
⭐ **Lane E self-disclosed a hard-limit violation** (one read-only `git diff --stat`) that nobody
would have found. Read-only, changed nothing, redone without git. The limit stands; the disclosure
is the culture working.

**Protocol lanes must be told** (they will not remember): first line `[X] STATUS: sentence`,
STATUS ∈ ACK/QUESTION/SPEC/READY/BLOCKED. Workers never run git, build, dev, or
`npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`. **You alone** stage explicit
paths, commit with `-F`, push, run the dev server and browser, and edit the bible, registers,
roadmap and board. ⭐ **Ask each lane for its exact path list before committing.**

## Databases

`shareat_dev` · `shareat_test` · four lane DBs · **`shareat_test_t240`** — PIN `246810` on
`Smoke Store (SMK)`. **Do not drop it.** `shareat_dev` signs in as **Dev Admin, PIN `111111`**.
⚠️ Sign-in is store-scoped — **pick the store BY NAME**, never index 0.
⚠️ `smoke-t260.mjs` left five cash requests in `shareat_dev` with purposes beginning `T260-`.

Browser scripts in the orchestrator tools folder: `smoke-t248.mjs`, `smoke-t250.mjs`,
`smoke-t253.mjs`, `smoke-t257-t258.mjs`, **`smoke-t260.mjs`** (new — carries the two-layer
discipline, the deliberate client-floor bypass with its justification, and the redirect-capture
pattern).

## The status board

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** rather than chat.
`Artifact action:"read"` it, edit, republish with that `url` at **every commit**. **Never make a
second one.** `docs/ROADMAP.html` moves at the same moments — do both. ⭐ Edit both with an
**anchored script that refuses unless each anchor matches exactly once** — it earned that this
session, refusing a bad anchor rather than silently no-opping.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read
C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md in full, then docs/RULES.md, then
PROJECT_BIBLE.md §13 rows 184, 189, 190 and 191. Ask Ian to type /orchestrator shareat system
in your terminal (the skill is user-invocation only).

The tree is CLEAN, main is at 692c931 and pushed, and all gates were green at handoff. Run
ListAgents and match lanes by [ref], not name, and PROBE EACH FOR ITS MODEL BEFORE ASSIGNING:
execution belongs on Sonnet, a trace or judgement call on Opus. ⛔ Lane C (523c43) has ignored
two probes — do not brief it on a guess; ask Ian. B (6b575a) and D (074c83) are confirmed
Sonnet and idle.

You own the dev server on 9008, builds, migrations, git and every browser pass; lanes never run
git, build, dev or npm run test:integration. Ask each lane for its exact path list, stage explicit
paths, commit with -F, push, and update BOTH docs/ROADMAP.html and the status board at EVERY
commit. Re-run every gate yourself on the shared database rather than accepting a lane's numbers.

⛔ Treat every register row and task stub as a HYPOTHESIS — two were wrong yesterday in ways that
changed the work. ⛔ And treat your OWN measurements the same: a line-wise grep over JSX gave
three different answers before the true one. ⛔ A REFUSAL IS NOT EVIDENCE UNTIL YOU KNOW WHICH
LAYER PRODUCED IT — yesterday's browser pass was red twice because the probe never reached the
server, and an unfixed build would have gone green identically. ⛔ Do not run the integration
suite while lanes are active (DEF-268) — starvation presents as a RED TEST with absurd durations.

Pick up at "Pick up here": T-261 (DEF-274 — spec written, opens with a DECISION not code, needs
an Opus lane), then DEF-269 (also judgement), then DEF-278 (the client money floor is not
uniform). DEF-275 proposes narrowing one clause of bible row 189 — Ian ratifies, rule 14. The
month-end timer is still the only production item on his board.

When a task completes with the tree clean, that is a milestone: run the wrap-up ritual
(.claude/skills/wrap-up/), rewrite this file, and hand over. Keep your session small.
```
