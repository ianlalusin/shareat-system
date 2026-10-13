# Handoff — 2026-10-12 (orchestrator; PR #20 green, waiting on Ian's 0194 precheck)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) runs PR #16 (`e3856fb`), migration 0193.** It was deployed 12 Oct by
Deploy run 38163887950.

**PR #20** (`lane/t398-s1`) is **CI green** and carries:
- T-398 S1: **migration 0194**, 229 same-org composite FKs;
- DEF-640: the cutover purge takes one performer per org;
- T-391 S4-S6: the master-data load (suppliers/customers, positions/staff) and the readiness report;
- docs.

PR #20 merges only after Ian runs the read-only precheck **P0194a/b** (`docs/ops/README.md`, 0194 row) and gives his go.
Merge it **in a quiet window, or with `shareat-erp` stopped**: 0194 locks persons/stores per FK until COMMIT.

Next free migration: **0196**. 0195 is T-392 S3 on `lane/t392-s3`, and it merges after #20.

CI runs on GitHub-hosted runners again. Ian first said "keep" the self-hosted runner `ians-pc`, then removed it: on that
runner, memory starvation made tests time out.

## Gates (main, wrap-up 12 Oct)
See the wrap-up commit message for the real typecheck and unit numbers. The full integration suite ran green on PR #20's CI
(run 38187295489), which is main plus 0194.

## What happened this session
- **PR #16 merged and deployed.** Before that, five rounds of test-side CI fixes:
  - shaped item codes;
  - the t393 password-leak helper;
  - the t342 real purge;
  - the t348 baseline;
  - the T-387 kit-markup needles;
  - the drill's redacted key.
- **T-391 BUILD DONE (S1-S6).**
  - S4 and S5 each had two audit rounds. Their rulings are in the spec: P9-P13 and S10-S14.
  - S6 added **`canAt()`**, which shares `authorize()`'s decision code. authorize behaves exactly as before (auth tests
    655/655), and a census test keeps canAt out of `apps/**`.
- **T-398 S1 audited.** The audit fixes were RESET lock_timeout, the P0194 precheck and the deploy note.
  Its CI then found **DEF-640**: the cutover purge recorded C2 for every org under one person. Fixed on the lane.
- **T-392:**
  - S3 is built: migration 0195 and the v2 figures. It went through two Opus rulings rounds and a money audit.
  - S4 is built, but its audit requires key-mapping fixes.
  - The tender keys were ruled by Opus: credit, other, staff cash, COGS.
  - New slices: **S1b**, read v1 `channel_sales` before 2 Nov (an orchestrator decision), and **S4b**, document-level
    matching (R9).
- **T-387 (UI session):** all 8 slices are on main (#14, #19). Bible rows 308-312.
- **Defects:**
  - DEF-637: /prepaid shows empty after a save (unconfirmed).
  - DEF-638: a refused POST is slow to say why.
  - DEF-639: the PIN budget allowed 11 instead of 10 on CI. Diagnosed as a WSL2 clock step, not a race.
  - DEF-640: the purge performer, fixed in PR #20.

## Pick up here
1. **PR #20:**
   - Ian runs P0194, then picks a quiet window.
   - Merge, then watch Deploy.
   - Record the result in `docs/ops/README.md`.
   - Merge `origin/main` into local main.
2. **T-392 S4 audit round** (`wt-t385`, `lane/t392-s4`, DB `shareat_test_t392s4`, WIP committed):
   - The tester's cases a-l pin the audit findings and the tender keys (spec section "S4 tender keys").
   - The builder makes them green.
   - Then re-audit, commit, and merge after S3.
3. **T-392 S3** (`lane/t392-s3` `5eb5c7b`) merges after #20. Then S4, then **S1b** and **S4b**, then the **S5** screens.
   All of it must land before the 2 Nov dual run.
4. **T-391 rollout with Ian:** extract on his machine, answer the sheets, dry run, then apply per store. T-390 S4
   follows the T-391 apply.

## Lanes (Sonnet subagents; none live after this session)
| Worktree | Branch | Lane DB | State |
|---|---|---|---|
| `wt-t385` | lane/t392-s4 | shareat_test_t392s4 (0195) | WIP committed, audit round in flight |
| `wt-t386` | lane/t398-s1 | — | = PR #20, green |
| `wt-t390` | lane/t392-s3 | shareat_test_t392s3 (0195) | committed `5eb5c7b`, pushed |
| `wt-t391` | lane/t390-s5 (merged) | — | free |

## Loose ends not covered above (swept 12 Oct, pre-cleanup)
| Item | State | Owner / next step |
|---|---|---|
| ~~PR #17 T-399 runner caches~~ | **CLOSED 12 Oct** (Ian: the self-hosted runner is gone, so there's nothing to cache for). Branch deleted on origin | Do not revive. `wt-t399` is left for local cleanup |
| **PR #18** T-400 integration on 2 workers (`lane/t400-parallel-integration`, `wt-t400`) | open; no task doc | Rebase on main after #20, re-run CI, fill Outcome numbers, merge or close |
| Uncommitted on main: `loadCountSheet` + `countTotalsByItem` removed (superseded by `loadMergedLines`, T-390 S5); t390-s1 test and `production-caller-baseline.txt` updated to match | **verified safe 12 Oct**: no references left, `tsc -p apps/erp` 0 errors, t390-s1 2/2 green | Ian said not to commit it on its own; commit it at the next wrap-up |
| `docs/ops/home-backup/` (moved from `webapps\shareat-db-home-backup`; no secrets) | untracked; pointer added in `docs/ops/README.md` Backups | Commit it at the next wrap-up |
| Leftover folders `webapps\wt-t387-s3` (partial, git no longer tracks it) and `webapps\wt-t384-s1a` (empty, locked by a process) | not deleted | Delete them only by the reparse-point method in memory `worktree-node-modules-junction`. **Never** `rm -rf` or `git worktree remove --force` |
| `docs/ops/self-hosted-runner.md` | stale: the runner was removed 12 Oct | Banner it or archive it |
| `.claude/launch.json` | **trimmed 12 Oct** to `erp` only | — |
| Old lane handoffs (inventory, T-387, merge reviews, pending-verification) | **moved 12 Oct** to `docs/archive/` (see its README); links repointed | History only |
| `~/.claude/skills/orchestrator/tools/` | **591 one-off files** (smoke scripts, screenshots, tokens, probe SQL) **moved 12 Oct** to `tools/_archive-2026-10-12/`; 12 live tools remain | Write new one-off probes to the scratchpad, not `tools/` |
| Open specs with no lane (on ROADMAP, not in Pick-up): T-325, 326, 328, 335, 336, 338, 339, 347, 348, 377, 378, 379, 380, 382, 393; T-343 and T-375 part-built | parked behind T-392 / 2 Nov | Next orchestrator ranks them after the dual run |
| Remote branches `checkpoint-logs`, `claude/beautiful-bohr-sfpkxt` | **deleted 12 Oct** (Ian's go) | — |

## Do not decide these alone — they are Ian's
- **P0194**, and the deploy window for PR #20.
- `def636-staff-roster-cap` (recommended: `enrol_staff` at the store).
- Whether a cancelled order's badge is red in lists.

## Traps that have actually bitten
- **Pushing main deploys.** Ship through a PR. Local main is ahead of origin, and `wrap/2026-10-11` mirrors it.
- **Lane DBs:**
  - `make-test-dbs.mjs` and `drop-test-db.mjs` must run from the MAIN tree; they read `.env.local`.
  - To migrate a lane DB with the lane's migrations, run `RUN_WITH_DB_CWD=<worktree> run-with-db.mjs <db> npm run db:migrate`.
- **Line endings:** Sonnet builders sometimes write CRLF.
  - Check with `tr -cd '\r' < f | wc -c`. `grep -c $'\r'` can count lines instead.
- **The shared `shareat_test` DB:** a subagent once ran without TEST_DATABASE_URL and hit it. Recreated 12 Oct.
- **Same-org FKs (0194):** a fixture that crosses orgs now fails at the DB. Fix the fixture; never add an exemption.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md and
docs/tasks/392-dual-run-comparator.md (status line + every rulings section at the end). GREP the register and
bible, never Read them whole.
State: production at 0193 (PR #16). PR #20 (lane/t398-s1: 0194 + DEF-640 + T-391 S4-S6) is CI green; merge only after
Ian's P0194 precheck and his go, in a quiet window. NEVER push main directly (it deploys).
Next: T-392 S4 audit round in wt-t385 (builder makes the tester's a-l green), then S3 → S4 → S1b → S4b → S5, all before
the 2 Nov dual run. Next free migration 0196. Also clear the "Loose ends" table (PR #18, uncommitted count-sheet cleanup, open specs).
STANDING: lanes are Sonnet subagents (tester/builder/auditor separate, own _test DB, worktrees; workers never run
git; LF only); Opus for specs/money rulings and a fresh Opus review of money/auth specs; never commit a lane while its
agent runs; byte-check \r and \x08; republish docs/WHATS-LEFT.html after every DEF close. Messages are short.
```
