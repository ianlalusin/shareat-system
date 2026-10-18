# Handoff — 2026-10-18 (covers the 17 Oct session)

## Where things stand
PRODUCTION: **d335959 LIVE** (PR #35, 17 Oct; healthy, database reachable). Migrations live through **0208**.
Built on main but **not released**: T-396 S1+S2 (migration **0209**), T-440 S1+S2, T-441 S1, T-398 S2a, and the
**DEF-675 security fix** (the app was reachable on port 9008 from the internet). These go out as release PR
**release/2026-10-18** (opened at wrap-up; full integration runs in its CI). Next free migration: **0210**.
In progress on branch **lane/t440-sweep** (pushed, not merged): T-440 S3-S7 (~384 fields converted).

## Gates at dfc310a (main)
typecheck clean · unit 7,445 passed in the full run; 5 more failed only under full-run load and **all pass alone**
(t343-s7-wrapper-refusals, t375-s0-census-script) or were fixed at wrap-up (t440-s2 typing, photo-compression,
t371 EXEMPT) · integration: not run locally — runs in the release PR's CI (row 296; 0209 is a migration) ·
build: not run locally. packages/etl/tests/capture.test.ts:113 is the known env-only failure.

## What happened this session (17 Oct)
- **Shipped live:** PR #34 (T-433 B2B, T-434 staff photo/signature, T-435 privacy gates, POS v2 T-424; 0202-0204)
  and PR #35 (T-436 leave tracking 0205, T-190 payroll statutory 0206, T-438 hire by Last/First/Middle + staff
  PIN-only 0207, T-439 Cook → Kitchen Staff 0208, Staff Positions tab, T-437 Customer v2 skeleton, DEF-656/670/671).
- **Production ops (Ian ran the scripts):** Lipa master data loaded (227 items, 33 suppliers, 6 customers; T-391,
  Lipa only, Lipa's units are the standard); the six built-in positions backfilled; Lipa's hand-made
  Cashier/DishWasher/Server retired by Ian. Lipa readiness: **no encoder/verifier yet** (Ian hiring).
- **Built on main, unreleased:** T-396 S1+S2 (06:00 Manila POS day import, status on /sales-days, heartbeat alert),
  T-440 S1+S2 (live field checks + coverage guard), T-441 S1 (shared photo-upload control, POST /files/upload),
  T-398 S2a (DEF-421 ratchet pinned at 206/188), DEF-675.
- **Specs written + Opus-audited:** T-193 statutory payments, T-396, T-398 (amended B1-B14, C1-C6 with Ian's
  10 Oct answers), T-440 (+ S9 auth-first plan), T-441 (+ lightbox fix L1), T-442 receipt-photo link backfill.
- **Ian's decisions (bible rows 357-364):** 357 stand numbers not tables; 358 package + à la carte in the first
  order; 359 Convert kept as its own feature (T-427); 360 names Last/First/Middle shown "Last, First M.";
  361 staff sign in by PIN only; 362 Cook → Kitchen Staff; 363 live field checks, Save truly disabled;
  364 one photo-upload control. Plus: Positions tab approved; PR #35 merge approved; standing rule saved to memory —
  **every test/CI/deploy wait = plan + Opus-audit the next slices**.
- **Defects:** DEF-670..677 logged (672 receipt photos unlinked; 673 POS v2 profile photo public link; 674 PNG/WebP
  metadata; 675 port exposed — fixed in code; 676 field check before authorize — S9; 677 POS v2 build deletes src/server).
- **Side sessions** (cleared by Ian at wrap-up): full reports in **docs/handoff/2026-10-17-session-reports.md** —
  POS v2 lane (branch `claude/pos-v2-907a29` @ 68b5c39, local only, not merged: T-425 built WIP unaudited,
  T-426/T-427 red tests, T-428 researched), Customer v2 (merged), POS v1 (safe void, birthday song, PIN fix,
  tablet app #244, 7,668 stale joins closed).

## Pick up here
1. **Release PR #36 (release/2026-10-18, https://github.com/ianlalusin/shareat-system/pull/36)**: watch CI; merge + deploy **only on Ian's go** (it carries DEF-675 — ship soon).
2. **T-440 sweep (lane/t440-sweep)**: fix the 2 failing `t440-s6-money-refusals` settlement cases (settledOn is
   checked before the rule set), then run **S9** (auth before field checks, 172 sites, guard G6, spec §S9) and the
   days-to-pay "when" rule; audit; merge.
3. **T-441 S2-S7** (after the sweep merges — same screens) incl. lightbox fix L1; then **T-442**. Then T-398 S2b-S6.

## Do not decide these alone — they are Ian's (Open Questions page: https://claude.ai/artifact/LMQCEXDZqHyAJz69FCy7FN)
- **By Fri 23 Oct:** POS store ids for Malvar/Banay-Banay/Davao + add them to the POS key + wallet accounts (q-t396-pos-ids) — else no 2 Nov double entry.
- T-193 Q1-Q4 (employer number, penalties, penalty account, void paid month) — recommendations a/a/a/a.
- Paid leave as PhilHealth/Pag-IBIG basic (q-t190-leave-in-basic, rec. a); VAWC shown as "Leave" (rec. a).
- POS stand numbers; Padre Garcia Q11 (HR on v2, rec. no) and pay-now at dispatch (rec. no); T-396 actor/alert/closed-day/link date (rec. a's).
- Lipa: HR start dates in `C:\Users\ianla\shareat-master-data\2026-10-17\sheets-lipa\staff-roster.csv`; hire encoder + manager, then run `lipa-readiness.sh`. Three people have conflicting v1 pay (HR).
- Host firewall (ufw 22/80/443) at the next provision (DEF-675 follow-up). Arm the 06:00 timer + heartbeat after the release.

## Traps that have actually bitten
- **Agents cannot run anything on production** (classifier blocks reads and writes): write a script under
  `C:\Users\ianla\shareat-master-data\…` and have Ian run it with `& "C:\Program Files\Git\bin\bash.exe" <path>`
  (plain `bash` in PowerShell starts WSL). Scripts on the droplet must load `.env.local` and use NODE_ENV=production.
- **`\b` / `\s` get mangled** when written through shell/python (a backspace landed in t384; `split(/s+/)` in FieldCheck). Verify bytes.
- **CRLF** from agents fails the pre-commit hook — strip with `sed -i 's/\r$//'`.
- **Under full-suite load** several tests time out; rerun alone before calling red.
- **Merging another session's branch** needs Ian's own word; never push those branches.
- **APK builds can move `apps/pos/src/server` aside** (DEF-677) — check `git status` in the POS v2 worktree after a build.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global /orchestrator
skill. Start COLD: read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and docs/handoff/2026-10-17-session-reports.md.
GREP the bible and register, never Read them whole. State: production = d335959 (PR #35). Release PR #36
(release/2026-10-18; T-396 S1+S2 with migration 0209, T-440 S1+S2, T-441 S1, T-398 S2a, DEF-675 port fix) is open:
check its CI; merge+deploy only when Ian says so. Next: finish T-440 on lane/t440-sweep (2 red settlement tests,
then S9 auth-first + days-to-pay "when" rule), then T-441 S2-S7, T-442, T-398 S2b-S6. POS v2 lane work sits on
branch claude/pos-v2-907a29 (not merged). Next free migration 0210, task T-443, DEF-678.
STANDING: lanes are subagents (tester/builder/auditor separate, own _test DB, worktree per lane, workers never run
git, LF only); every test/CI/deploy wait = plan + Opus-audit the next slices; Sonnet/Haiku for work, Opus for specs
and reviews; production steps are scripts Ian runs; talk to Ian in plain language; messages are short.
```
