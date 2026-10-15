# Handoff — 2026-10-14 (orchestrator, cold start)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) still runs `c7cf55a`, migrations through 0197.** Nothing deployed today.
Today's work sits on **`release/2026-10-14`**, pushed, with **one PR to `main`** (see "Pick up here"). Merging it deploys.
No new migration today; the next free number is still **0198**.

## Gates at the release head
- **typecheck:** exit 0.
- **unit:** 6,497 passed / 7 failed / 4 skipped across 6,508 in one full run. All 7 failing files pass when run alone (34/34): load timeouts on this laptop.
- **integration:** run per lane on each lane's own DB (T-392 149/150 incl. 1 skip; T-394 S1+S2 35+44; T-401 S3-S5 290+; T-402 S2 1,222). **The full suite runs in CI on the PR.**
- **build:** passed (109 s) on the combined branch, port 9008 free.

## What happened this session (decisions are in bible §13 rows 319-336)
- **T-392 dual run, build complete:** S1b (v1 channel receivables), S4b (document matching), S5 (screens `/reports/dual-run`, go/no-go pack, dispositions). Ian: v2 enters Grab/Foodpanda payouts; a disposition counts only after a fresh extract + compare (laptop on for 15 Nov); only admins record dispositions (rows 332-334).
- **T-394 rehearsal:** S1 (guards, start/migrate/predump/purge/mark/app-env-check/rollback-check) and S2 (verify, verify --after-post, sanitised report). A rehearsal predump can no longer ping production's backup monitor.
- **T-401 menu:** S3 (store-menu projection), S4 (menu screens), S5 (usage source switch, v1 maps → menu rules). Ian: manager-posted staff usage drafts move stock; the POS pull becomes a ±10% check only. That is **S6**, specced in the T-401 doc, needs a migration (row 335).
- **T-402 activity log:** S2 done (security events). The first audit caught a pool-deadlock risk; it was redesigned (in-process outbox; `can()` for render probes). **S3 built on `lane/t402-s3` (pushed) but NOT merged**: open audit findings incl. one data-loss race in the purge, listed at the end of `docs/tasks/402-activity-log.md`.
- **Cloud session (T-404) merged in:** supplier page, stores form, wording fixes. **Ian answered the 14 questions** (`docs/feedback/2026-10-14-ian-answers.md`, rows 319-331); work list `docs/plans/2026-10-14-ian-answers-worklist.md`.
- **T-405** (names, never a raw person id) and **T-406 batch 1** (account names instead of codes on 20 screens) done, built mostly on Haiku. Ian: use Haiku where it can do the job (row 336).
- **Defects:** DEF-649 (email sign-in ignores ended employment; ending employment leaves sessions — serious, unowned), DEF-650 (null-tx session ends, minor).
- Roadmap, What's Left and task status lines updated.

## Pick up here
1. **The PR:** watch CI. If green and Ian says go, merge (= deploy). If red, fix on `release/2026-10-14`.
2. **T-402 S3:** fix the open audit findings on `lane/t402-s3` (the purge lock first), re-audit, merge into the next release.
3. **DEF-649** (sign-in after employment ends) — spec and fix; then **T-401 S6** (migration 0198), **T-394 S3** runbook (due 7 Nov; include: close psql/Drizzle Studio before `verify`, and dump dir needs an ACL on Windows), **T-406 batch 2**, work-list items.

## Do not decide these alone — they are Ian's
- **Public GitHub repo** (made public 13 Oct): recommend private. Still unanswered.
- **Merge tonight's PR** after CI is green.
- **Grab/Foodpanda payout sample files** (zip/xls/pdf) — needed before the settlement parsers (row 320).
- T-391 rollout, T-393 backups on before 1 Nov, T-396 POS ids/keys — unchanged from 13 Oct.

## Traps that have actually bitten
- **Two agents on one test DB** produce random FK/deadlock failures — one lane, one DB, one runner at a time.
- **Lanes pass alone and break each other's guards when combined** (28 tests today: `can()` mocks, counts, COMMANDS labels). Run the guard/census files on the combined branch before the PR.
- **Tests that leave orgs behind** poison later files (T-394 fixed; watch for it in new purge/rehearsal tests).
- Worktree removal follows node_modules junctions into main — never remove one except by the memory's method.
- Pushing `main` deploys. Ship through the PR.

## Lanes and worktrees (all idle)
| Worktree | Branch | State |
|---|---|---|
| `wt-t385` | lane/account-label | merged into release |
| `wt-t386` | lane/t394-s2 | merged into release |
| `wt-t390` | lane/t392-s4b | merged into release |
| `wt-t401` | lane/t392-s5 | merged into release |
| `wt-t402` | lane/t401-s5 | merged into release |
| `wt-t403` | lane/t402-s3 | **unmerged, pushed** — S3 findings open |
Lane DBs (`shareat_test_*` from today) are throwaway; drop with `drop-test-db.mjs` when convenient.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global /orchestrator
skill. Start COLD: read docs/HANDOFF-TODAY.md (all) and docs/RULES.md, then the spec of the lane you start.
GREP the bible and register, never Read them whole.
State: production runs c7cf55a (migrations through 0197). Today's work is on release/2026-10-14 with one open PR —
check its CI; merge only when green AND Ian says go (merging deploys). Next free migration 0198.
FIRST: ask Ian the public-repo question (still open) and whether to merge the PR.
Next: T-402 S3 audit fixes (lane/t402-s3), DEF-649, T-401 S6 (migration 0198), T-394 S3 runbook (7 Nov), T-406 batch 2.
STANDING: lanes are subagents (tester/builder/auditor separate, own _test DB, worktree per lane, workers never run git,
LF only); Haiku where it can do the job, Sonnet for money/auth/schema, Opus for specs and rulings; never remove a
worktree except by the junction-safe method in memory; talk to Ian in plain language. Messages are short.
```
