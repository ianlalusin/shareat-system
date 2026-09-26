# Handoff — 2026-09-27 (morning)

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> ⛔ **NOT PUSHED.** Ian was away and said to skip anything that needs him, and a push deploys. Every commit
> since `bf6741c` is **local only**. Pushing is Ian's first action: `git push` after he looks at the log.
> ⭐ Standing (Ian, 2026-09-26): push only at wrap-up, unless Ian says otherwise.

## Where things stand
Ian's queue (T-343 S5.1b → S2b → S5a → S5.2 → S5.3) is done, and so are four follow-up slices the audits
produced (S5.2 follow-up, S5.1c, S5.1d, S5.3b). T-343 is open for S5.4 (after S6 labels), S5.5+ (≈180
domain sites), S6/S6b, S7, S8, S9.

## Gates at `60e81ec` (fresh DB, `node ~/.claude/skills/orchestrator/tools/gates.mjs --db shareat_test_gate_0927d --port 9008`)
typecheck 0 · unit **180 files / 3186 passed, 1 skipped** · integration **3311/3311 tests; 162/163 files** · build 0.
The one file: `attendance-credentials-scan-collision-migration.test.ts` "Hook timed out in 120000ms" under load.
It is untouched by this work and passes **2/2 alone** on the same DB. Earlier gate runs today were fully green
(`b16480f`, `b32f9a6`, `1c00abd`).

## What happened this session (by theme)
- **Refusals in human terms (T-343, DEF-417 part 2):** these slices were committed:
  - S5.1b `1456aaf`: commissary order messages.
  - S2b `b16480f`: DEF-430, a store refusal names where the person's job is.
  - S5a `ae55895`: roles and credentials.
  - S5.2 `83f9364` and its follow-up `1c04d52`: AP and customers.
  - S5.3 `1c00abd`: deliveries, catalogue, opening balances.
  - S5.3b `60e81ec`: receipt reasons, opening amounts, visible line numbers.
- **Bypasses closed:** six app wrappers answered before the shared `errorMessage`, so no human sentence
  could reach their screens:
  - commissary orders: S5.1c `b32f9a6`, DEF-445/446;
  - wastage, admin/stores, deliveries, locations: S5.1d `36b33df`, DEF-448/450.
- **FIXED:** DEF-430, 445, 446, 448, 450, 453 (an AP refusal named another STORE's expense; found by post-commit
  /code-review). DEF-444 half fixed.
- **Reported:** DEF-443 (a voided order accepts messages), 447 (row-5 hardening), 449 (second date call site),
  451 (three census blind spots), 452 (13 more wrappers), 454 (≈18 `parseMoneyInput` callers).
- **Screen tests on 9008:** S5.1b and S5.1c, light and dark. Seeded rows are marked `T343S51B`/`T343S51C`. Stores
  cannot be deleted (append-only config), so four deactivated test stores remain in `shareat_dev`. Scripts are in
  `~/.claude/skills/orchestrator/tools/t343s51b-*`.
- **Decisions, all recorded in `docs/tasks/343-*.md`:**
  - S2b: second-person voice; deactivated stores omitted.
  - K1's scope.
  - The S5.1b/S5.2/S5.3/S5.3b rulings.
  - Amendment R4.
  - The auditor runs `/code-review` post-commit in a throwaway worktree, never planting in the shared tree.
- **Process lessons, now standing lane conventions:**
  - Testers run `npm run typecheck` before reporting, because vitest never runs tsc; three test files shipped
    tsc-red to review.
  - Red claims in test comments are written in the past tense.
  - Legs written after a fix landed were verified red by setting the fix aside against HEAD, then restoring
    byte-identical (`diff -q`).

## Pick up here
1. **Ian: push** (see the banner), after `git log --oneline bf6741c..HEAD`.
2. **T-343 S6/S6b.** S6 adds labels for dispositions and item kinds, and is S5.4's precondition. S6b is DEF-431.
3. **DEF-454 sweep:** give all ≈18 `parseMoneyInput` callers a human label. Cheap and mechanical, a `Workflow`
   candidate.
4. **T-343 S7:** DEF-452's 13 wrappers, using the S5.1c/S5.1d pattern (`isPresentable` first).

## Do not decide these alone — they are Ian's
- The push itself.
- T-348's layout (from screenshots). ADR-014's open questions. The fiscal-period cleanup task (DEF-424/426/433/434/439).
- DEF-443: should a voided order's message thread be read-only?
- Still open from before: arm `shareat-fiscal-period-seed.timer` before 2027-09-01; the T-341 §8 / T-344
  production counts; dark-mode `--brand`/`--warning`; duplicate "Server".

## Unrecorded (planner, bible §14)
Bible §13 rows still needed (carried over): push only at wrap-up; Ian's human-terms rule; the T-276 gap threshold;
T-341 per-store grants; T-344 Q1–Q5; the T-345 catch-up rule. New: the post-commit `/code-review`-in-a-worktree
rule, and "a refusal may name only records the actor is entitled to see at THIS store" (DEF-453's lesson, stronger
than rule 7's org scope). Run `npm run toc` after each insert. POSTING-PATTERNS still needs the T-345 variant.

## Traps that have actually bitten
- **Specs had amendments unfolded.** Before any slice builds, have the auditor check the body against its amendments.
  Amendment R4 exists because of this.
- **A refusal lookup scoped by org only can leak another store's record** (DEF-453). Name by lookup only after the
  store-scoped guard.
- **vitest is not tsc.** Run `npm run typecheck` before calling a test file done.
- **A `'use client'` path must never reach `@shareat/db`.** `shared/money-input.ts` stays import-free (T-266).
- The census can't see a derived value behind a local `const`, a helper call, or a quoted key in a literal (DEF-451).
- **Freeze all lanes during full gates** (about 45 min now). Load timeouts recur in single files; re-run alone.
- Testers use their LANE DB via `run-with-db.mjs`, never `shareat_test`. One lane migrated the shared DB this session.
- `shareat_dev` stores can't be deleted (append-only attendance config), so deactivate them instead.

## Sessions
All lanes are idle, and nothing uncommitted is theirs. **Safe to /clear:** tester `webapps-30`, builder `system32-19`,
auditor `auto-assign-staff-role-on-hire`, and this orchestrator. Lane DBs are reusable by name:
`shareat_test_t343s5_{tester,builder}`. The review worktree is at `…/scratchpad/wt-review`; remove it with
`git worktree remove`. `webapps-a2`, `webapps-83` and `Shareat-system defect closure [cb99ee]` were unused this
session. The unmerged `daily-review/2026-09-17` branch still exists.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then
docs/tasks/343-def-417-human-readable-refusals.md: the Status line, "Later slices", and the S6/S6b lines.
GREP the register and bible, never Read them whole.
FIRST: confirm with Ian that bf6741c..HEAD has been pushed; if not, ask before pushing (a push deploys).
Goal (Ian): close as many defects as possible toward deployment. It is NOT launched.
STANDING: commit slices locally; push ONLY at wrap-up unless Ian says otherwise.
Queue: T-343 S6/S6b → DEF-454 sweep → S7 (DEF-452) → wrap up today's work. Have the planner spec S6
first; the auditor checks each spec body against its amendments before it builds. Freeze lanes during gates.
Testers run npm run typecheck before every report. The auditor runs /code-review post-commit in a worktree.
Messages are short. Render before deciding. Ask for the exact command behind any reported number.
Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```
