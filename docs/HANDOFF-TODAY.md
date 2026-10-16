# Handoff — 2026-10-17

## Where things stand
PRODUCTION: 841d0f8 LIVE (PR #33, 16 Oct; /api/health ok, database reachable). Migrations live through 0201.
Release **PR #34** (`release/2026-10-16e`) is open with T-433, T-434, T-435, POS v2 T-424 and migrations 0202-0204;
Ian approved "merge and deploy when CI is green". Three lanes are mid-build in their own worktrees (below) and were
left running at wrap-up by Ian's instruction. Next free migration: **0207** (0205 = T-436, 0206 = T-190, both on lanes).

## Gates
Local at e8a1f01 (main): typecheck pass · unit 7,089 passed / 3 failed / 4 skipped — t343-s7 and t370 sweep pass alone (68/68, machine load), t402-s1a = DEF-656 (git-history scan sees unmerged lane branches; skipped on CI's shallow clone). Integration: not run locally (4 lanes active); PR #34 CI runs the full suite. Build: not run locally.

## What happened this session (16-17 Oct; decisions = bible rows 347-356)
- **Shipped live (PR #32, PR #33):** T-415 cash-float row locks (DEF-657/658/659/661), T-416 per-person admin-PIN cap
  (0200), T-417 POS/Customer v2 monorepo setup, T-418 one-click draft delete (posted keeps PIN), T-419 cooking on the
  usage screen, T-420 usage check counts posted cooking, T-421 dashboard chart (flat smooth gross line + thin channel
  lines, hover card), T-430 recurring catch-up (0201, DEF-663), T-431 "Everything unpaid" page, T-432 AP float picker +
  "Pay this bill" (DEF-662), DEF-664 re-add retired position (Ian's Cashier bug), Staff page retitled.
- **In PR #34 (not live yet):** T-433 B2B trade orders (pay now, delivery receipt, BIR booklet no. 0203, credit-limit
  lock/override), T-435 personal-data access gates (DEF-665/666/667; staff search name+branch only), T-434 staff photo +
  on-screen signature (0204, view_staff_signature, every view audited, 60 s links), POS v2 T-422/T-423/T-424 (copy of
  v1 floor screens, centavo money + terminal receipt numbers, server approvals 0202; NOT in use until the ops steps in
  docs/ops/pos2-runbook.md).
- **On lanes, built, not merged (all pushed to origin):** T-190 payroll statutory (wt-t390, lane/t190, 0206; audited,
  audit fixes done, all t190 tests green: ready to merge AFTER T-436), T-436 leave tracking (wt-t403, lane/t436, 0205;
  built; tester-owned baselines + case 18a pending, then audit), Staff "Positions" tab with expandable position cards
  (wt-t386, lane/staff-positions-tab; built + tests green; render and screenshot for Ian before merging).
- **POS v2 session** [local_69ee3ed8-4372-4365-be64-9c561821f583] (own worktree .claude/worktrees/pos-v2-907a29):
  T-425 PC-5 offline spec in Opus review; PC-6 SC/PWD next; task numbers 425-429 are that lane's.
- **Ian's decisions (all recorded):** rows 347-350 (decisions page round 2; customer.shareat.net → order.shareat.net
  later; diners in the people list), 351 (POS v2 money via our server, ERP PIN), 352 (B2B = customers + trade orders,
  not a channel), 353 (personal data strictly guarded; signatures strictest), 354 (backups ON + restore drill; leave
  before 1 Jan; NO 1601-E; statutory now), 355 (leave rules; no contribution until the agency number is on file;
  backups unencrypted), 356 (no offline refunds; offline unpaid void manager-only). App ids: net.shareat.pos2 /
  net.shareat.order (T-417 spec).
- **Defects logged:** DEF-661..669 (DEF-669: repo scanners walked a nested worktree; the census now skips .claude/).

## Pick up here
1. **PR #34**: CI failed on T-434 guard leftovers; a fix (redirect literal, EXEMPT entries, access-defaults counts
   103/83) was committed with this wrap-up. Watch CI; when green, merge and deploy (Ian approved), then confirm
   /api/health shows the new sha.
2. **Merge order for the lanes: T-436 (0205) before T-190 (0206)** so the journal stays in order. Each: tester
   baselines → audit (Sonnet) → merge main into the lane → guards → merge → release PR with full CI (migration rule).
3. **Staff Positions tab** (lane/staff-positions-tab): render it on the dev server, send Ian a screenshot, then merge.

## Do not decide these alone — they are Ian's
- **Backups (T-393):** waiting on Ian's six steps (Spaces bucket shareat-pg-backups, bucket key, healthchecks.io,
  drill DB user, disk check, secrets into /srv/shareat-shared/.env.local). Then run the first backup + drill, then arm.
- **Payroll rates:** who confirms them (gets manage_payroll_rates) and each store's region for minimum wage. Payroll
  POSTING is refused until rates are confirmed (by design); preview works.
- **POS v2 1-centavo sign-off** on Ian's Open Questions page (q-t423-centavo); recommendation: accept.
- **"placeholder" session** (local_a0bf395c…) is a stray created by a subagent; recommend archiving (Ian to say yes).
- **SC/PWD:** 0 discounts ever recorded in POS v1; Ian is asking the stores how they handle it.

## Traps that have actually bitten
- Agents sometimes run git or commit despite the rule (one subagent committed 12f9595 and spawned a stray session).
  Check `git log` for unexpected commits before merging.
- A nested worktree under `.claude/worktrees/` is visible to any repo walker; walkers must skip `.claude/`.
- Tests must never pin a lane database name (T-424 did; CI couldn't run them).
- Two lanes adding migrations collide in `_journal.json`; resolve by idx order and verify on a fresh copy.
- Census/count baselines (action-link-sweep, capability counts, t348, caller baseline) move with every new control or
  capability; the tester bumps them, never the builder.
- Under machine load whole-suite runs time out; rerun failing files alone before calling red.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global /orchestrator
skill. Start COLD: read docs/HANDOFF-TODAY.md (all) and docs/RULES.md. GREP the bible and register, never Read them whole.
State: production = 841d0f8 (PR #33). PR #34 (T-433, T-434, T-435, POS v2 T-424; migrations 0202-0204) is approved to
merge+deploy when CI is green. Lanes still running: T-190 (wt-t390, 0206), T-436 (wt-t403, 0205), Staff Positions tab
(wt-t386); POS v2 session local_69ee3ed8… on T-425. Merge 0205 before 0206. Next free migration 0207.
FIRST: check PR #34 CI; merge+deploy if green; then finish the three lanes (tester baselines → audit → merge).
STANDING: lanes are subagents (tester/builder/auditor separate, own _test DB, worktree per lane, workers never run git,
LF only); keep agents busy; Haiku/Sonnet for work, Opus for specs and reviews; never remove a worktree except by the
junction-safe method in memory; talk to Ian in plain language. Messages are short.
```
