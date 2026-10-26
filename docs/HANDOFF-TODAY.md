# Handoff — 2026-10-25 (second orchestrator of the day; covers since wrap-up 5456c1b)

## Where things stand
PRODUCTION: **9f1bd3b LIVE**, health ok, migrations through **0216**. Main = **ef1b3b0** (#66 T-455 S2), its CI + Deploy
were running at handoff. Ian's instruction this session: *"merge all unmerged branches first before continuing the build"*:
done. Every old branch was merged, dropped (Ian) or deleted (70 merged remote branches, list + shas in
`C:\Users\ianla\webapps\shareat-coord\deleted-branches-2026-10-25.txt`), and 22 old worktrees were removed safely
(links first). **The merge queue and every rule live in `C:\Users\ianla\webapps\shareat-coord\BOARD.md` — read it first.**

## Gates
- Main: each merge went through the required check "typecheck, test, build" on GitHub-hosted runners (full unit +
  integration + build). The self-hosted desktop runner was tried and ROLLED BACK (CI_RUNNER unset; board note).
- This wrap-up PR: docs only (bible row 388, DEF-746, roadmap, task status lines, this file). Full suite runs in its CI.
- Laptop memory is tight: local runs are typecheck + touched tests; full suites run in CI (ADVISOR, 25 Oct).

## What happened this session
- **Merged + live:** #62 T-475 S1 (AP live checks) · #56 T-474/T-477 refund/Z fixes (AUDIT) · #64 T-455 S1 lobby tables
  (0215, renumbered from 0217) + #63 T-479 party-shrink cap · #67 POS T-472 receipt bridge (0216) + T-478 · #68 DEF-775
  status (AUDIT) · #65 T-475 S2 (expense forms E1-E4, P1-P3 live). **Merged, deploying:** #66 T-455 S2 (lobby domain).
- **Open PRs:** **#69** T-475 S3 self-verify (migration 0217; Ian ran `p0217-check.sh`: only Ian gains it; Ian said
  "merge 69 when green") · **#70** T-455 S3 customer lobby server routes (needs Ian's "merge" — asked, not yet
  answered). Both had CI fixes pushed late in the session; check their current head before merging.
- **Built, not yet PR'd:** T-455 S4 lobby screens (`lane/t455-s4`, pushed; based on S3, PR after #70 merges) ·
  T-398 S5a+S5b (`lane/t398-s5`, pushed: posting patterns + migration 0218; **6 audit findings to fix first**).
- **Dropped (Ian):** `claude/pos-v2-907a29` (settings allow-list removal) and Codex's `codex/erp-action-forms` + #57
  (competed with T-448's modal forms) + `audit/t461-delivery-history`.
- **Decisions (Ian), where recorded:** QI-1 = (a) → **bible row 388** + `docs/tasks/398-s5/QUESTIONS.md`. Merge goes for
  #62 #64 #65 #66 #67 #69 and "go with A" (hosted CI re-run for #62) → BOARD.md. Orchestrator rulings: T-455 S2/S3/S4
  rulings in `docs/tasks/455-customer-lobby.md`; T-398 S5 QO-1 (system supplier bill at PG's receive, spike first) and
  tester rulings in `docs/tasks/398-s5/QUESTIONS.md`; role-only capability mechanism (`ROLE_ONLY_CAPABILITIES`) in #69.
- **Defect logged:** DEF-746 (cutover date-scoped delete order; fixed in #66).

## Pick up here
1. **Merge queue (BOARD.md):** confirm #66's Deploy → merge **#69** when green (0217 must deploy BEFORE 0218) → **#70**
   when green AND Ian says merge → open T-455 S4's PR (`lane/t455-s4`, merge main first) → UI UX's T-448 A3 form sweep
   (slot 6, waits for Ian's go in UI UX). This wrap-up PR can go any time (docs only).
2. **T-398 S5:** fix the 6 audit findings in `docs/tasks/398-s5/QUESTIONS.md` (tests first: freeze shipment money
   columns after receipt; receive-input legs; buyer must not read void_reason/voided_by; scheduler job kind only with
   S5e; NOT VALID constraints; ops row), then S5c (seller side, QO-1 spike first) and S5d (buyer side) in parallel, S5e,
   S5f (two-org smoketest). Worktree `C:\Users\ianla\webapps\wt-t475` (branch lane/t398-s5), lane DB `shareat_test_t398`.
3. **T-455 S4b** (lobby menu read + package/flavour chips) and **S5** (POS lobby card, POS session's area); **T-475 S4**
   (linkage). T-485 (app-wide live checks) still awaits Ian's OK.

## Do not decide these alone — they are Ian's
- **#70 merge** (customer lobby server; no migration; lobby stays off until S9). Recommended: yes.
- **Q5 VAT** for Padre Garcia (accountant, due 13 Nov) — S5 builds without VAT, lines FENCED.
- T-485 plan; Banay-Banay staff (T-454); Lipa encoder hire.

## Traps that have actually bitten (this session)
- **Lane DB names must contain `shareat_test`** (e.g. `shareat_test_t455`, not `shareat_t455_test`): 9 files refuse otherwise.
  And an EXISTING lane DB can hold stale migrations: drop + recreate (a lower `when` is skipped silently).
- **Census/pin tests move with every migration** (t398-s3/s4 registry, NO_FK_REFERENCES, ALWAYS triggers, capability
  counts, action-link sweep, audit catalogue ceiling now 210): re-measure, never hand-add.
- **The verify job in ci.yml is hash-pinned** (ci-app-jobs case 13): additions go inside `# >>> Name` / `# <<< Name`
  markers (POS v2, Customer lobby) and the test strips them.
- **Agents write CRLF and real newlines for `\n`**: pre-commit catches CR; write backslashes via chr(92).
- **Two writers in one worktree**: `git commit -am` swept a tester's file into the wrong commit once; stage explicit paths.
- **Worktrees:** remove with the links-first pattern, never `--force`. `C:\Users\ianla\webapps\wt-audit-t474` is a
  link-free leftover folder Windows had locked — delete it by hand when nothing holds it.

## Live worktrees (keep)
`wt-t455` (lane/t455-s4) · `wt-t475` (lane/t398-s5) · `wt-t475b` (this wrap branch; own node_modules — reuse it) ·
`wt-audit-t478`, `wt-audit-t479` (scheduled audit run) · `wt-pos-t472` (POS) · `wt-t448-sweep` (UI UX).
Lane DBs: shareat_test_t455, shareat_test_t475, shareat_test_t475b, shareat_test_t398.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global /orchestrator
skill. Start COLD: read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and C:\Users\ianla\webapps\shareat-coord\BOARD.md
(merge queue, number blocks, port lock, rules - you own it). GREP the bible and register, never Read them whole.
Production = 9f1bd3b (migrations through 0216); main = ef1b3b0 (#66) deploying. Ian already said merge #69 (0217)
when green; #70 needs his "merge". Then: T-455 S4 PR (lane/t455-s4), T-398 S5 audit fixes then S5c/S5d
(lane/t398-s5, worktree wt-t475, migration 0218 after 0217). Other sessions may be live (POS, AUDIT, UI UX, ADVISOR):
ListAgents + gh pr list first. Next free: migration 0219, DEF-747, task T-486, bible row 389.
STANDING: lanes are subagents (tester/builder/auditor separate, own *shareat_test* DB, worktree per lane, workers never
run git, LF only); model per job (Haiku mechanical, Sonnet build/test/audit, Opus specs/reviews); full suites in CI
(laptop memory); production steps are read-only scripts Ian runs; talk to Ian in plain language; messages short.
```
