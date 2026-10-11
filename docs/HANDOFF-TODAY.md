# Handoff — 2026-10-11 evening (orchestrator; PR #16 open: 0192 + 0193, CI re-running)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) runs migration 0191** (PR #10 merged and deployed 10 Oct; T-386
recode applied with Ian, post-check `{ not_shaped: 0 }`). **PR #16** (`release/2026-10-11`, head `5abdc83`) carries
T-386 S6 (**0192** item-code CHECK), T-391 S1 (**0193** buying unit + v1_master_links), T-391 S2+S3, T-390 S2/S3/S5,
T-392 S1+S2, T-393 (backups, built, NOT switched on), T-389 S4/S5, and today's CI test fixes. It merges only when
CI is green **and** Ian has run prechecks **P0192a / P0193** (`docs/ops/README.md`) **and** says go.
⚠️ **Do not push `main` directly** — a push to main runs CI then Deploy, which would apply 0192/0193 before the
prechecks. Local main is ahead of origin/main; today's work is saved on the branch `wrap/2026-10-11` and in PR #16.
Next free migration **0195** (0194 is T-398 S1, on its lane).

## Gates (main `59ace55`+docs)
- typecheck 0 (main at `5abdc83`, 11 Oct). Unit: see the wrap-up commit message for the real count.
- Integration: the full suite runs in CI on PR #16 (a local full run is unreliable under lane load).
- The 5 CI failures from PR #16's second run were fixed test-side (`470f697`): t390-s2 shaped item codes,
  t393 password-leak helper `tests/integration/t393-no-leak.ts`, t342 1b runs the real C2 purge. All 5 files green on
  a lane DB.

## What happened this session
- **T-391 S3** merged (item apply). **S4** (suppliers and customers) built green, audited; 4 audit fixes in flight
  (ruling P13). Rulings P9-P13 are in the T-391 spec.
- **T-390 S5** browser smoke passed end to end except asset valuation (no asset shell in the smoke DB).
  Found **DEF-637** (/prepaid empty state after a save, unconfirmed) and **DEF-638** (refused POST shows its reason ~12 s late).
- **T-398 S1** (0194, 229 same-org FKs) committed on its lane, `247c537`. It gets its own PR and the 0194 precheck.
- **T-387** (UI session) rulings recorded as bible rows **308-312**; roadmap updated. S1-S4 on main; S8 in PR #14;
  S5-S7 on `release/t387-s5-s7`, one PR after #14.
- Caller baseline regenerated (`a3c0ca2`): `loadCountSheet` is now dead (superseded by `loadRoomCountSheet`), and a
  follow-up chip exists to remove it.

## Pick up here
1. **PR #16:** CI green → Ian runs P0192a/P0193 → merge on his go → watch Deploy → record in `docs/ops/README.md`.
   If CI is red, fix test-side on a lane branched from main, then push main's HEAD to `release/2026-10-11`.
   If the UI session merges #14 first, merge origin/main into the release branch.
2. **T-391 S4** (wt-t385, `lane/t391-s4`, DB `shareat_test_t391s4`, UNCOMMITTED): finish the 4 audit fixes
   (contract: `applyMasterData` precheck, `plan.listed`, unmapped VAT holds, bad credit days nulled), re-audit,
   commit, merge. Then S5 (staff), S6 (readiness).
3. **T-398 S1 PR** with Ian's 0194 precheck; T-392 S3 (migration 0195); T-390 S4 after the T-391 apply.

## Lanes (Sonnet subagents of the orchestrator; none live after this session)
| Worktree | Branch | Lane DB | State |
|---|---|---|---|
| `wt-t385` | lane/t391-s4 | shareat_test_t391s4 | **uncommitted S4 work** — commit or finish first |
| `wt-t386` | lane/t398-s1 | shareat_test_t398s1 | committed `247c537`, unmerged |
| `wt-t390` | lane/ci16-fixes | shareat_test_ci16 | merged, free |
| `wt-t391` | lane/t390-s5 | — | merged, free |
Smoke DB `shareat_test_smoke383` is at 0193 and has had the C2 purge **and an opening entry POSTED** — recreate it
before the next cutover smoke.

## Do not decide these alone — they are Ian's
- `def636-staff-roster-cap` (recommended `enrol_staff` at that store). t395-q1. POS "collected" follow-ups.
- The prechecks P0192a / P0193 / (later) P0194.

## Traps that have actually bitten
- Pushing main deploys. Use the release branch / PR.
- `node -e` with backticks in bash leaves stray files named like `{console.log(r)`; write a script file.
- Two agents on one lane DB truncate each other's fixtures. A crashed drill test leaves `foo_drill` behind, and the
  auto-mode classifier blocks a subagent's DROP.
- The full unit suite times out under lane load; rerun failed files with `--testTimeout 60000`.
- Lane worktrees hold a `node_modules` junction: never `rm -rf` / `worktree remove --force`.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and
docs/plans/remaining-build-plan.md §0b. GREP the register and bible, never Read them whole.
State: production at 0191. PR #16 (release/2026-10-11) carries 0192+0193: merge only when CI is green, after Ian's
P0192a/P0193 prechecks, on his go. NEVER push main directly (it deploys). Local main is ahead of origin; the branch
wrap/2026-10-11 holds it.
Next: finish T-391 S4 in wt-t385 (uncommitted, audit fixes per spec ruling P13), then T-391 S5/S6; T-398 S1 own PR
(0194 precheck); T-392 S3 (migration 0195). Next free migration 0195.
STANDING: lanes are Sonnet subagents (tester/builder/auditor separate, own _test DB, worktrees; workers never run
git); Opus for specs and a fresh Opus review of money/auth specs; never commit a lane while its agent runs;
byte-check \r and \x08; republish docs/WHATS-LEFT.html after every DEF close; CI once a day (row 296).
Messages are short.
```
