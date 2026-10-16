# Handoff — 2026-10-16

## Where things stand
main = 0f2156a, LIVE since 16 Oct 10:44 Manila: PR #28 (a879264) plus PR #30 (release/2026-10-16b), which added
T-414 (cash requests in the expense payment list; auto-created staff cash account, row 347) and DEF-654 (collection void
and owner write-off admin PIN, liability retire retype). Nothing is half-built on a lane. POS/Customer v2 is designed, not built: the phase plan is drafted (`docs/plans/pos-customer-v2-phase-plan.md`)
and ADR-015 carries a 15 Oct amendment. Next free migration: **0200**.

PRODUCTION: 0f2156a LIVE since 16 Oct 10:44 Manila (PR #30: T-414 + DEF-654; deploy success; /api/health ok, database reachable). Migrations through 0199.

## Gates at c4aabaf (PR #28 CI, the release head merged as a879264)
typecheck pass · unit 6,761 passed / 3 skipped · integration 8,052 / 8,052 · build compiled.

## What happened this session (decisions: bible §13 rows 337-346)
- **Stock usage (T-401 S6, 0198).** The v1 POS pull now creates a pre-filled usage DRAFT per store+day; staff correct,
  the manager posts; unposted pull drafts auto-post at 14:00 Manila next day (timer `shareat-usage-auto-post`). Day-close
  warning, month-close block, manager scorecard. Rows 341-342; rulings A1-A12 in `docs/tasks/401-erp-menu-catalog-master.md`.
- **Destructive actions (T-412, 0199).** Two tiers: retype the name, or an admin PIN verified on the server. M6
  (per-person PIN budget) deferred as DEF-653; AR collection void missed (DEF-654).
- **Shipped on default answers:** T-408 VAT/OR on supplier invoices + /ap/vat, T-409 slice/cook rules, T-411 RowLink on
  30 tables, T-413 recipe admin, plus T-412. Ian has NOT answered their page questions yet (row 346).
- **Also merged:** T-410 single-identity guard; T-400 parallel integration tests (PR #18); PR #27: T-394 S3 runbook
  draft, T-402 S3 (500-code-point cap, row 344), T-406 batch 2, T-407 (DEF-649/650 fixed; Q1-Q3 row 340).
- **Ian's rulings:** repo stays public (337); POS/Customer v2 in this repo as apps/pos + apps/customer, one APK each
  (338); no Turborepo for now (339); round-2 POS/customer answers (343); keep agents busy (345).
- **Register:** DEF-651/652 (POS v1 unsafe void live in build #238; receipts not locked in v1 rules), DEF-653..656.
  POS/Customer v1 studies are `docs/discovery/39-*` and `40-*`.
- **Roadmap and What's Left:** updated (T-401, T-406..T-413 done; follow-ups added).

## Only Ian can do these
1. Give YANIYOW (`C:\Users\ianla\webapps\YANIYOW`) its own dev port. It was holding 9008, which is ERP v2's (DEF-660).
2. Tell managers: POS usage now arrives as drafts; staff correct, manager posts; anything left posts itself at 14:00
   the next day.
3. Answer the decisions page https://claude.ai/artifact/H8YVDBG9nuBDBQi2Sguwrs (newest first): business-day cut-off,
   first-store date (11 Jan), v1 freeze, v1 safe-void fix, VAT strictness, recipe questions, admin PIN for email-only
   admins, and the T-408/409/411/412/413 questions.
4. Run the read-only counts in `C:\Users\ianla\t409-counts.sql` and paste the results back.

## Pick up here
1. Confirm PR #30 is live (T-414, DEF-654). The usage auto-post timer is already installed (16 Oct, first run 14:05 Manila).
2. DEF-657 + DEF-658 as one small task: row-lock the cash-request float in `recordApPayment`
   (`packages/domain/src/ap/index.ts:1295-1320`) and in settle/return (`packages/domain/src/cash-requests/index.ts:333-350`),
   re-checking live balance. Add DEF-659 (silent null from `ensureStaffCashAccount`) if cheap.
3. DEF-653 (T-412 M6): per-person daily PIN miss cap. Needs storage, so a migration (0200).
4. POS v2 PC-2: monorepo setup for `apps/pos` / `apps/customer` (phase plan). Spec in plan mode first.
5. The rest of `docs/plans/2026-10-14-ian-answers-worklist.md`.

## Do not decide these alone — they are Ian's
- Business-day cut-off for POS v2 (recommendation on the page).
- Whether to patch POS v1's unsafe void before the v1 freeze (DEF-651; recommended: yes, route the page to the fixed
  component).
- Any T-408/409/411/412/413 answer that differs from the default reopens that task.
- What reset `/srv` group-write on the droplet (DEF-655): find it, do not change the box without Ian.

## Traps that have actually bitten
- Two vitest runs on one database give false failures. One run per DB.
- Migrate the test DB first (`DATABASE_URL=<test url>` with the migrate script), then run tests.
- Timeouts under machine load: rerun the failing file alone before calling it red.
- `\b` written into a .ts file becomes a backspace (\x08); write backslashes via chr(92).
- Never `git worktree remove --force` or `rm -rf` a lane worktree: its node_modules junction reaches main. Read the
  memory note first.
- t402-s1a "scanned live from git history" turns main red when an unmerged branch on origin adds an uncatalogued
  action (DEF-656).

## Lanes and worktrees (all merged, all idle)
| Worktree | Branch | State |
|---|---|---|
| wt-t385 | wrap/2026-10-16b | this wrap-up's records |
| wt-t386 | lane/t401-s6 | merged |
| wt-t390 | lane/specs-1015 | merged |
| wt-t401 | lane/t413 | merged |
| wt-t402 | detached at release/2026-10-16 | merged |
| wt-t403 | lane/t412 | merged |
| wt-t400 | lane/t400 | merged (PR #18) |

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global /orchestrator
skill. Start COLD: read docs/HANDOFF-TODAY.md (all) and docs/RULES.md, then the spec of the lane you start.
GREP the bible and register, never Read them whole.
State: main = 0f2156a (PR #30: T-414, DEF-654), live; migrations through 0199; next free 0200. Check the PRODUCTION line.
FIRST: confirm PR #30 is live; ask Ian whether he answered the decisions page.
Next: DEF-657/658 float row locks (one small task), DEF-653 (per-person PIN budget, 0200), POS v2 PC-2 (spec in plan mode).
STANDING: lanes are subagents (tester/builder/auditor separate, own _test DB, worktree per lane, workers never run git,
LF only); keep agents busy while tests run; Haiku where it can do the job, Sonnet for money/auth/schema, Opus for
specs and rulings; never remove a worktree except by the junction-safe method in memory; talk to Ian in plain
language. Messages are short.
```
