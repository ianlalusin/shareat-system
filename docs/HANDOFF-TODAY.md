# Handoff — 2026-09-26

> ⚠️ NOT LAUNCHED. No present-tense claim about which commit production runs (DEF-360). A green push to `main`
> runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`). Keep `main` green.

## Where things stand
T-341 (DEF-414 + DEF-429) and T-344 (DEF-422) shipped, with migrations **0159** and **0160**. The deploy of `347fb00` ran green, so 0160's pre-flight check found no bad period data in production. CI had been red since
24 Sep (DEF-432, shallow clone). It was fixed in `1e7862c`, and the backlog (16 commits, 0156–0159) deployed green on
25 Sep. Four specs are **approved and queued**, in Ian's order: **T-345 → T-346 → T-343 S5 → T-347**, then wrap up.
None of them is built.

## Gates at 1225c19 (fresh DB `shareat_test_t344_gate3`, `node ~/.claude/skills/orchestrator/tools/gates.mjs`)
typecheck 0 · unit **167 files / 3020 passed, 1 skipped** · integration **155 files / 3138 passed** · build 0 (9008 stopped).
⚠️ Under memory pressure the unit project has timed out (t343-scheduler-status, deferral-staleness …). Those files pass
alone. Close idle sessions before a full run.

## What happened this session
- **T-341 (`4e986a3`)**: position grants carry their store (0159), and authorize() axis 3b matches the grant's store.
  Three audit rounds (spec Amendments R1–R3) stopped two migration versions that would have WIDENED access. Already-hit
  DEF-429 victims go to the cutover count for hand remedy. Pushed on Ian's word; production is not launched.
- **DEF-432 (`1e7862c`)**: the CI verify job checks out with `fetch-depth: 0`. Ian approved deploying the backlog; the
  deploy succeeded.
- **T-344 (`1225c19`)**: the job classifies every hole. The admin "Create the missing month" action is on /findings,
  with the capability `create_missing_period`. 0160 guards the order both ways and the locked year, under a per-org
  advisory lock, with a pre-flight check of existing data. Screen-tested.
- **Ian's decisions, all recorded in specs or the register:**
  - T-344 Q1–Q5: report only inside closed books; build the admin action; refuse and name blocking activity; fill part-months; missed depreciation becomes T-345.
  - T-345: the catch-up books to this month's expense 6700/6750, `[prior period]`.
  - DEF-427/428 get built before launch (T-346).
  - T-347: prepaids are purged, and disposed assets are deleted at cutover.
  - DEF-430/431 are folded into T-343 (S2b, S6b).
- **Registered**: DEF-424…439 (see the register). Open and unowned: 424, 425, 426, 433, 434, 435, 436, 439.
- **Agents**: `backend-architect` wrote the specs; `code-reviewer` did the independent reviews (it found the
  T-344 races and the T-347 TRUNCATE blocker).

## Pick up here
1. **T-345** (`docs/tasks/345-*.md`, migration **0161**): brief the tester first (red), then the builder.
2. **T-346** (`docs/tasks/346-*.md`, S1 **0162**, S2 **0163**, S3 no migration): three slices, one migration each.
3. **T-343 S5** (`docs/tasks/343-*.md` §S5 + its Amendment R1): groups S5.0 → S5.1 → S5.1b → S2b → S5a → … Hold
   the fixed-assets/stores/scheduler groups until T-346 lands.
4. **T-347** (`docs/tasks/347-*.md`, **0164**). Then wrap up.

## Do not decide these alone — they are Ian's
- **Arm `shareat-fiscal-period-seed.timer`** on the production host before 2027-09-01.
- The cutover counts: T-341 §8 (hand-scoped staff and DEF-429 victims) and the T-344 production hole count. Both
  need production read access.
- Check each store's backfilled opening date once T-346 S1 is live.
- Still open from before: the Firebase terminal account; dark-mode `--brand`/`--warning`; the duplicate "Server".

## Unrecorded (planner, bible §14)
Bible §13 rows are needed for Ian's human-terms rule, the T-276 gap threshold, T-341's per-store position grants,
T-344's Q1–Q5, and the T-345 catch-up rule. POSTING-PATTERNS needs the T-345 `[prior period]` variant (after it
builds). Run `npm run toc` after each insert.

## Traps that have actually bitten
- **A migration edited after it was applied leaves lane DBs stale.** Re-create the DB from 0000 (`make-test-dbs.mjs`
  with a new name) before trusting a number. That cost a cycle today.
- **Row-level BEFORE triggers that query the table misfire on multi-row UPDATEs.** Use statement-level AFTER triggers
  with transition tables (0160).
- **redirect() inside a try is swallowed by its catch**, and the user sees "NEXT_REDIRECT". Guarded now by
  `apps/erp/tests/redirect-in-catch-sweep.test.ts`.
- **Fixtures that relied on the DEF-414 leak** (staff scoped to a second store with no job there) had to hire at both
  stores (ap, ap-aging).
- **Killing "vitest" processes by name kills the workers' runs too.** Kill only the gate's own process tree.
- The auditor session did not answer its last AUDIT NOW; a `code-reviewer` subagent did the final audit instead.

## Sessions
All are **safe to /clear**: nothing in flight, all work committed and pushed (`347fb00`), no state lives only in a
session. Lane DBs are reusable by name: `shareat_test_t341_*`, `shareat_test_t344_tester2`, `shareat_test_t344_builder3`,
smoke DB `shareat_test_setup` (SMOKE_ORG, stores SMK/SMK2, admin PIN 246810, T-344 smoke periods 2026-09..2027-02).
Roles last used: tester `webapps-30` (Sonnet), builder `system32-19` (Sonnet), auditor
`auto-assign-staff-role-on-hire` (Opus). Re-brief from `~/.claude/skills/orchestrator/worker-briefing.md`.
Foreign sessions `webapps-a2` and `ERPNext Digital Ocean migration` are not part of this work.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then the
T-345 spec. GREP the register and bible, never Read them whole.
Goal (Ian): close as many defects as possible toward deployment. It is NOT launched; a green push deploys.
Queue, in order: T-345 (0161) → T-346 (0162/0163) → T-343 S5 → T-347 (0164) → wrap up today's work.
Use the backend-architect agent for specs and code-reviewer for independent reviews.
Messages are short. Render before deciding. Ask for the exact command behind any reported number.
Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```
