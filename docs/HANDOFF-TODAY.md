# Handoff — 2026-10-03 (orchestrator, money-defect push day 4)

## Where things stand
Goal (Ian): close every open money defect in v2. **Not launched.** This session (2 Oct evening → 3 Oct) shipped
**9 slices to `main`** and closed **13 money defects**. The register was also recounted against git, which corrected
**15 rows** that were fixed but still marked open. **10 money defects are open**, plus DEF-491 and 421 deferred by
Ian's ruling.
**T-371 (the NaN sweep) is mid-flight on branch `wip/2026-10-03b` (`ad6f856`, 188 files), not on `main`.** Its spec
(✎R9) keeps `main` green at every commit, so its red tests and partial writer flip stay off `main` until S4 closes
them.

## Gates at f3ee87c (main; docs commits follow)
typecheck **0** · unit **3758/3764** in the full run (5 load timeouts that pass alone, 98/98; 1 skipped) · integration FULL suite on fresh `shareat_test_orch_wrap1003`, **262 files, 4650/4650** · build **OK**. The T-371 branch is NOT gated (10 tsc errors on it; S4 owns them).

## What happened (themes; each record lives where it says)
- **Shipped to `main`:**
  - T-367 S3: DEF-420, 499, 500 (`1d28795`).
  - T-368 S4: DEF-434 (`39b2a35`).
  - T-369 S8: DEF-551, plus DEF-571, an S3 regression the auditor caught (`8086ff4`).
  - T-369 S8b: DEF-556 (`629abef`).
  - T-369 S9: DEF-557, 558, 573 (`35c1a31`).
  - T-372 S5: guard tests (`10d84c5`).
  - T-372 S6: DEF-512, 513, migration **0179**, full suite 4645/4645 (`3774d2c`).
  - T-372 S4: freight posting pattern (`c49a407`).
  - **T-368 and T-372 are complete.**
- **Register (`9830f85`, `3774d2c`):** 15 money rows corrected to fixed after a git-verified sweep (DEF-105, 108, 374,
  426, 433, 494, 496, 497, 498, 506, 516, 529, 534, 535, 541). New rows DEF-568 to 578. The ones that matter most:
  - DEF-574: no screen for the branch recount return.
  - DEF-577: 19 UTC "today" defaults pre-fill yesterday's date before 8 a.m. Manila.
  - DEF-578: "Void the pull first" is a dead end, because nothing can void a usage pull.
- **T-373 spec approved (`f3ee87c`):** DEF-547, 552, 555, 559. An Opus planner wrote it and an independent Opus review
  added 10 changes, including R7, a guard against a double usage pull after re-entering a voided date. Four slices can
  run in parallel; S3 takes migration **0180**.
- **Deploy gate:** `docs/ops/README.md` now has a precheck table for 0177–0179 (production is at 0176).
- **Ian's decisions this session:**
  - T-373 Q1 → (a), recorded in the T-373 spec and on the Open Questions page with the R7 note.
  - "Use a workflow for T-371", recorded in the T-371 status line.
  - No bible row was written: both rulings are task-scoped, and the bible is planner-only.
- **T-371 progress (on the branch):**
  - S0: census, guards G1–G4 and per-module NaN tests, audited three times. The census was hardened after audits found
    bulk inserts and `Math.abs(Number(x))` invisible. 43 self-tests prove each detector can fail.
  - S1: `decimal()`, `SafeInsert`/`SafeUpdate`, `parseDecimalInput`. Audited.
  - S3: entry parse in 37 modules, via Workflow. Audited: no wrong money outcome. 61+13 EXEMPTs, all date, id or count
    orderings.
  - S2: writer flip via Workflow, 28 of 31 groups. **till-fiscal, statutory-discounts and ledger failed on an expired API
    token** and must be re-run.
  - The branch tree has **10 tsc errors**, all callers passing plain strings to now-typed writers, which is S4's job:
    trade/index.ts:378, attendance/config.ts:140, stock consume/count-sessions/supplier-returns, trade/returns.ts:383/500,
    and 3 setThreshold test/script callers.

## Pick up here
1. **Finish T-371.**
   1. Restore the branch: `git checkout wip/2026-10-03b -- .`. Check that `git status` shows 188 paths. The branch is a
      snapshot to restore from, not history to merge.
   2. Re-run S2 for the 3 failed groups: `till-fiscal` (till-shifts.ts, fiscal-periods.ts, findings.ts),
      `statutory-discounts`, `ledger` (journal.ts). The script is saved at
      `~/.claude/projects/C--Users-ianla-webapps-shareat-system/50393d91-…/workflows/scripts/t371-s2-writer-flip-wf_7d9b6956-30b.js`;
      resume with `resumeFromRunId: wf_7d9b6956-30b`, and the 28 done groups replay from cache.
   3. **S4 (builder):**
      - the 10 caller errors;
      - remove the `?? ZERO` at now-optional writer call sites (ar fee, ap fees, trade fees, production labour,
        sales-days figures);
      - exact helpers in core for qty×cost, value÷qty and ÷12 (supplier-returns:327, separation:63,
        thirteenth-month:91, money-lines:249, trade/returns recordInternalReturn);
      - `checkDraw` takes Money;
      - money-lines/load.ts:82 and MoneyLines.tsx:295.
      The tester adds the 2 S2 EXEMPT requests (`%TEMP%/t371-s2-exempt-requests.txt`) and fixes the setThreshold test
      callers.
   4. Then the auditor reads the joined diff, the FULL suite runs on a fresh DB, and the smoke from the T-371 spec runs
      (`abc` in three boxes). Commit T-371 as one green commit set.
2. **T-373** (after T-371): four parallel slices; S3 = migration 0180, gated on the full suite.
3. **Then:** DEF-054 (T-367 S5/S6, needs Ian's production count), DEF-198/291/314 (rest of T-369 S5b/S6b), and the new
   follow-ups DEF-574/577/578.

## Do not decide these alone — they are Ian's
- **Open Questions page** (bible row 252):
  - **t371-blank-on-edit (new):** on an edit screen, a blank box keeps the stored figure, and the person types 0 to zero
    it. Recommended (a), and that is what T-371 builds.
  - **HR statutory data:** due end of October.
- **Production with Ian, before any push that DEPLOYS 0177–0179:** the precheck table at the top of
  `docs/ops/README.md`. Run on `159.223.46.224`, never `.78.207`.

## Traps that bit this session
- **The browser pane auto-starts the `erp` dev config on 9008.** It wrote a half-built `apps/erp/.next/dev/types` file
  that broke repo-wide tsc. If 9008 is busy and no lane admits it, check `preview_list` before suspecting a peer.
- **A census nominates; running settles.** The first T-371 census under-reported by about 30%: it missed bulk inserts,
  `Math.abs(Number(x))` and nullable strings. Only self-tests that prove each detector can fail made it trustworthy.
- **A sentinel must outlive the fix.** One "this site is flagged" sentinel would have forced weakening the guard once
  the site was repaired.
- **Snapshotting WIP with a fresh index and `git add -A` re-normalises line endings repo-wide** (442 files instead of
  188). Stage only the `git status` paths: `git add --pathspec-from-file`.
- **Grep every caller when a blank's meaning changes.** DEF-571 (the recurring job's due date) came from S3 checking
  only the form caller.
- Memory is tight: run integration files one at a time, and freeze lanes during the full suite.

## Sessions — all three SAFE TO CLEAR (re-brief from this file)
| Role | Session | Lane DBs (survive by name) |
|---|---|---|
| Tester | `webapps-a2` | `shareat_test_t371_tester`, `shareat_test_t372_s6_tester`, `shareat_test_t369_s8_tester` |
| Builder | `webapps-02` | `shareat_test_t371_builder`, `shareat_test_t372_s6_builder`, `shareat_test_t369_s8_builder` |
| Auditor | `system32-2f` | — |
Workflow agents left per-module DBs `shareat_test_t371wf_<module>` and `shareat_test_t371s2_<group>`; they can be
dropped. None of the sessions holds uncommitted work; everything is on `main` or on `wip/2026-10-03b`.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md,
docs/plans/money-defects-2026-09-30.md and docs/tasks/371-nan-sweep.md (status line + S2/S4).
Read the Open Questions page (bible row 252) with ArtifactData before building anything gated on Ian.
GREP the register and bible, never Read them whole. Goal (Ian): close all open money defects in v2;
NOT launched. Queue: HANDOFF "Pick up here" 1→3. T-371 is on branch wip/2026-10-03b (restore with
git checkout wip/2026-10-03b -- .); re-run the 3 failed S2 groups, then S4, audit, FULL suite, smoke,
commit. Then T-373 (S3 = migration 0180). Next free migration index: 0180.
STANDING: lanes run Sonnet (auditor too); Opus only via subagents for specs and judgement. Ian opted
in to Workflows for T-371. Commit slices locally; push ONLY at wrap-up; republish the What's Left
board after every commit that closes a DEF; every wrap-up updates "what's left", ROADMAP.html and the
board. Reds assert the target; every "not" gets a positive control. Each tester/helper gets its own
_test DB. Gate any CHECK/trigger migration on the FULL suite on a fresh gate DB. No git stash, no lane
dev servers, no mutants in the shared tree. Freeze lanes during gates. Messages are short. Render
before deciding. Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```
