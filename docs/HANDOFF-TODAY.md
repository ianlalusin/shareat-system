# Handoff — 2026-10-25 (covers 22-25 Oct)

## Where things stand
PRODUCTION: **fb17323 LIVE**, health ok, migrations through **0214**. Twelve PRs merged and deployed since 22 Oct (list
below). **Main is protected**: the required check "typecheck, test, build" applies to admins too (bible row 385), so
everything goes through a PR. Several sessions work on this repo at once; the orchestrator runs ONE merge queue and the
rules live OUTSIDE the repo in **`C:\Users\ianla\webapps\shareat-coord\BOARD.md`** — read it before any push, PR,
merge, migration, port use or new number.

## Gates
- main fb17323: CI green (full unit + integration), Deploy green.
- PR #60 (T-398 S2b): local full integration on a fresh DB 10,489 pass; the 4 failing files pass alone (journal +
  t357 63/63, t393 11/11) or need pg_dump (t394, not installed locally); unit 9,079 pass (etl capture = known env-only).
  CI running, auto-merge ON.
- lane/t475-ap-live-checks (S1): t475-s1 + t440 + t384 + t343 1,649 pass in one run; typecheck clean; browser smoke
  (forged sign-in, 1280/375, light/dark) ALL PASS on the re-run after fixing the Save-re-enables bug the first run found.
- lane/t455-customer-lobby (S1): t455-s1 85/85; same-org census, t354, journal green; typecheck clean.
- Build: run by CI on each PR; not run locally.

## What happened (22-25 Oct)
- **Live:** #46 T-453 audit follow-ups · #43 T-442 receipt-link backfill (+T-441 S2) · #47 POS v2 release · #48 DEF-742
  (scripts listed orgs on a connection row security hid) · #49 T-464 POS tablet pairing + Employee ID/PIN sign-in
  (0212) · #51 POS deploy fix · #52 T-441 S3-S7 one photo-upload control (staff photo, leave certificate, signature,
  viewers, guard) · #50 T-448 modal forms/density + DEF-740 hydration fix · #55 T-473 failed POS build keeps last good
  POS · #58 T-476 deploy never prunes the running POS release · #59 T-448 report filters · #53 T-398 S3+S4 same-org
  composite FKs + validator triggers (0213/0214; caught a deferrable-FK bug that would have broken attendance).
- **Production runs by Ian (read-only):** receipt-link check EXIT=0 (nothing to link); staff codes 0 bad / 0 duplicate;
  P0212/P0214 prechecks ALL ZERO.
- **Decisions (Ian), where recorded:** rows 376-377 (QRPH -> Maribank; drop Banay-Banay) and row 380 (repo public by
  choice) on main; rows 384-387 in PR #60 (Banay-Banay bought back by Lipa; required check for admins; customer lobby
  rulings; T-475 rulings incl. "1b 2a 3a"). T-472 answers (read-only service account yes, no personal data, catch
  >7-day changes) are the POS session's row 392 (its PR #54). Lobby + T-475 answers also in their task files on their
  branches.
- **Coordination:** BOARD.md created (merge queue, port lock, number blocks; rule 4b no `--auto` before your slot;
  rule 4c migrations must land in number order because drizzle silently skips a lower `when`).

## Pick up here
1. **PR #60** merges itself when green -> confirm Deploy + health show its sha; update BOARD.md.
2. **T-475:** S1 is done and smoke-passed: open its PR (no migration) and ask Ian for "merge"; then S2 (expense forms) and
   S3 (`verify_own_supplier_invoice`, migration 0216 — must merge AFTER 0215 POS T-472 or be renumbered, rule 4c).
3. **T-455 customer lobby:** S2 (lobby rules: check-in, booking code, limits, purge; must expire pending discount
   claims when an entry closes) — spec docs/tasks/455-customer-lobby.md on lane/t455-customer-lobby; migration 0217.
Then: T-485 (app-wide live checks, plan awaits Ian's OK), T-398 S5-S7 (Padre Garcia inter-entity sale, view, onboarding).

## Do not decide these alone — they are Ian's
- **T-485 plan:** wave 1 = the 10 most-hit errors + shared facts (closed month, account balance, stock), then waves
  2-3. Recommended: yes, after T-475 S1 merges.
- **Banay-Banay staff:** move to Lipa, or separate with final pay in v1? (T-454)
- **POS session:** #54 (POS v2 T-470/T-471, with AUDIT's #56 money fixes inside) is next in the queue but its session
  was closed — Ian reopens it; it reads BOARD.md.
- Lipa readiness: encoder (a Cashier) still to hire; manager hired.

## Traps that have actually bitten
- **Run the FULL integration suite on a fresh DB before any migration PR** — #53 failed CI because only the slice's
  tests had run; the full run then found a real production bug.
- **Lane DB names must contain `shareat_test`** (9 tests refuse other names). Rebuild the lane DB from zero after a
  main merge — a stale DB hid 0212's staff-code CHECK and 49 failures.
- **Migrations land in number order** (rule 4c). **No `--auto` merge before your queue slot.**
- Fixtures: employments.staff_code must be SE-NNN; never hex-only typed values (DEF-744); no new single-column org->org
  FK (T-398 census).
- `\b`/`\s` written by agents can become control bytes — verify bytes. Planner files came out CRLF once.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global /orchestrator
skill. Start COLD: read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and C:\Users\ianla\webapps\shareat-coord\BOARD.md
(merge queue, number blocks, port lock, rules - you own it). GREP the bible and register, never Read them whole.
Production = fb17323 (migrations through 0214); main is protected (required check applies to admins). PR #60 (T-398
S2b) auto-merges when green - confirm its deploy. Then: T-475 (lane/t475-ap-live-checks, S1 done + smoke PASS: open
the PR, then S2/S3), T-455 customer lobby (lane/t455-customer-lobby, S1 done, next S2), T-485 awaits
Ian's OK. Other sessions may be live (POS, AUDIT, UI UX): ListAgents + gh pr list first. Next free: migration 0218
(0215 POS, 0216 T-475, 0217 T-455 reserved), DEF-746, task T-486, bible row 388.
STANDING: lanes are subagents (tester/builder/auditor separate, own *shareat_test* DB, worktree per lane, workers never
run git, LF only); model per job (Haiku mechanical, Sonnet build/test/audit, Opus specs/reviews); full integration suite
before migration PRs; production steps are read-only scripts Ian runs; talk to Ian in plain language; messages short.
```
