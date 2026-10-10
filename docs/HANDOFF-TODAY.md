# Handoff — 2026-10-10 evening (orchestrator; PR #10 open: T-395 S2, T-389 S2+S3, T-390 S1 + 0191)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) runs `90c546f`, migration 0190** (PR #8 merged and deployed 10 Oct
after Ian's 0190 precheck: T-383 S2, T-386 S5, T-388, T-389 S1, T-395 S1; PR #7 T-387 docs too). **PR #10**
(`release/2026-10-10b`) carries everything since: T-395 S2, T-389 S2 + S3, T-390 S1 with **migration 0191**, docs.
It merges only when CI is green **and** Ian has run the 0191 READ ONLY precheck (P0191a/P0191b in `docs/ops/README.md`;
P0191b lists each store's default room — a store with none cannot record its opening count) **and** says go.
Next free migration **0192**. Progress against the cutover plan: `docs/plans/remaining-build-plan.md` §0b.

## Gates (lane worktrees; the full integration suite runs in CI on PR #10)
- T-395 S2: typecheck 0; unit 4912 + reruns green; integration 156/156 (8 files); smoke on 9008 passed.
- T-389 S3: unit 4921 pass; integration 69/69 (8 files) + 348/348 touched pages; smoke passed (4 forms).
- T-389 S2: unit 4924 pass; integration 125/125 (10 files); smoke passed (5 forms).
- T-390 S1: unit 4919 pass; integration 161/161 (9 files); smoke on 9008 in progress at handoff time.
- Env-only unit fails in a worktree: `packages/etl/tests/capture.test.ts` (no `.env.local`); `t375-s0-census-script` flaky.
- ⚠️ A LOCAL full integration run stalled 10 h on `commissary-kpis.test.ts` (one test 39,075,232 ms) — use CI for the
  full suite; do not trust a local full run while other lanes load the machine.

## What happened this session
- **Merged/deployed PR #8** on Ian's go after his 0190 precheck (recorded in `docs/ops/README.md`).
- **T-395 done** (DEF-063 fixed): findings `pinSignInFailures` / `pinSignInStopped`, `reopenPinSignIn` + panel on /staff.
- **T-389 S2 + S3**: 19 forms keep typing on refusal. S4 (10 stock/item forms) waits for T-390 S1 (shares
  `cutover/actions.ts`, now merged — S4 can start); S5 closes.
- **T-390 S1**: per-room opening counts, cost source, R3 one cost per item per store with an advisory lock (audit).
- **Rulings made at build (orchestrator; bible rows being added by an Opus planner):** "last 7 Manila days" = today +
  6 before; a stopped store's figure counts the 24 h before the stop; T-389's typed slot supersedes T-380 `keep` for
  record forms (server draws stored values only); hyphen allowed in kept field names; business TIN/branch code may be
  kept; T-390 R3 siblings (a count without a cost changes no cost; a new/null-cost room row takes the store cost).
- **Defects:** DEF-063 fixed; DEF-628 (platform-sales amount dropped when "no sales" ticked) and DEF-629 (intermittent
  hydration warning on /staff and /findings) reported.
- Docs: ROADMAP (published v17), What's Left (published v65), task status lines, plan §0b, ops 0191 row.

## Pick up here
1. **PR #10:** CI green → Ian runs the 0191 precheck → merge on his go → watch Deploy (it runs after main's CI;
   a second merge to main cancels the first CI run, as PR #7 did today) → record results in `docs/ops/README.md`.
2. **T-386 S5 recode dry run on production with Ian**, then `--apply`, then S6 (item-code CHECK; migration 0192+).
3. **Lanes:** T-390 S3 (tie-out; serialises with S2/S4/S5 on `repo/cutover.ts` and `domain/cutover/index.ts`);
   T-389 S4 then S5; specs in plan mode (Opus) for T-393 (backups) and T-391 (master data).

## Lanes (all Sonnet subagents of the orchestrator; none is live after this session)
| Worktree | Branch at handoff | Lane DB | Free? |
|---|---|---|---|
| `wt-t385` | lane/t389-s2 (merged) | shareat_test_t389s2 | yes — branch a new lane from main |
| `wt-t386` | lane/t389-s3 (merged) | shareat_test_t389s3 | yes |
| `wt-t390` | lane/t390-s1 (merged) | shareat_test_t390s1 | yes |
Smoke DB for 9008: `shareat_test_smoke383` (migrated to 0191; SMOKE_ORG, SmokeAdmin, SmokeAdmin2, SmokeManager,
SmokeOtherManager, SmokeStaff). The UI/UX session (T-387 S1, branch `release/t387-s1`) borrows 9008 by message;
its DB is `shareat_test_t387s1`.

## Do not decide these alone — they are Ian's (Open Questions page)
- `plan-q1`..`plan-q13` (Q1: what v2 runs on 1 Jan; Q2: what "ties" means; Q5: item conflict rulings; Q7: Spaces key).
- `t390-q2` opening-stock cost basis (holds T-390 S2); `t390-q1`; `t395-q1` (50-a-day stop needs an email-capable
  manager per store to reopen). t387-q4..q7. POS "collected" follow-ups.

## Traps that have actually bitten
- Two agents on one lane DB truncate each other's fixtures; an agent that reports "background work still running"
  must be told to stop it before the next agent uses that DB.
- An auditor ran tests against the shared `shareat_test` and reported a false red — give auditors the lane DB.
- `gates.mjs --repo <worktree>` cannot find `.env.local`; run integration via `run-with-db.mjs` from the worktree.
- Lane worktrees hold a `node_modules` junction into the main tree: never `git worktree remove --force` / `rm -rf`.
- Smoke fixtures need a stock layer, not only a movement; stock never goes below zero.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md and
docs/plans/remaining-build-plan.md §0, §0b, §1-§3. Read the Open Questions page (bible row 252) with ArtifactData
before building anything gated on Ian. GREP the register and bible, never Read them whole.
State: production at 0190 (90c546f). PR #10 (release/2026-10-10b) carries T-395 S2, T-389 S2+S3, T-390 S1 + 0191:
merge only when CI is green, after Ian's 0191 precheck, on his go. Then the T-386 recode dry run with Ian.
Next: T-390 S3, T-389 S4-S5, specs (plan mode) for T-393 and T-391. Next free migration 0192.
STANDING: bible row 298 speed practices (worktree per lane, template DBs, Workflow sweeps approved); GitHub CI once a
day at wrap-up (row 296; exceptions: early PR to unblock Ian, migrations prechecked); lanes are Sonnet subagents
(tester/builder/auditor separate, own _test DB, worktrees wt-t385/wt-t386/wt-t390; never two agents on one DB at once;
workers never run git); Opus for specs and a fresh Opus review of every money/auth spec; never commit a lane while its
agent has background work; byte-check every changed file for \r and \x08; republish docs/WHATS-LEFT.html after every
DEF close. Messages are short.
```
