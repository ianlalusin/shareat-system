# Handoff — 2026-10-01 (orchestrator, money-defect push day 2)

> ⛔ **CI CANNOT RUN — GitHub Actions billing.** Every CI job since 2026-09-30 was refused to start: *"recent account
> payments have failed or your spending limit needs to be increased."* So **prod is still at migration 0165** and the
> next green CI will deploy **0166–0176 together** (11 migrations). Only Ian can fix billing.
> ✅ The read-only prod checks for 0173–0176 (and 0169's `pg_default_acl`) were run on erp2 with Ian on 2026-10-01:
> **all zero rows**; prod holds 1 organisation. Pushed after that.

## Where things stand
Money-defect push (Ian: "close all open money defects in v2"). What's Left board **29 → 22 open money defects**
today. All committed and **pushed** at wrap-up after the prod checks — but nothing deploys until GitHub billing is fixed. T-366 done (S4 not needed). T-367 S1+S2 done. T-368 S0+S1 done. T-372 S1–S3 done.

## Gates at 5cabfc7 (fresh gate DB `shareat_test_gate`)
typecheck **0** · integration **4193/4193** (231 files, full suite) · unit **3642/3650** in the full run — the 7 failures are
repo-scanning tests over their 5 s limit; all 6 files pass solo (69/69) · build **skipped — dev server live on 9008**.

## What happened (themes; decisions and where recorded)
- **Closed:** DEF-386 (live screen), 201/517/520 + 546 (T-367 S1, 0173), 511 (T-372 S1+S2, 0175), 398/399/406 + 380
  posting half (T-366 S3/S5/S6), 396/508/518/519 (T-367 S2, 0176), 424 (T-368 S1; DB backstops 0174), 127 (T-372 S3),
  545 (test suite migrated mid-run; tooling + `journal.test.ts` now asserts the DB is current, incl. hash).
- **Logged:** DEF-547 (reversed handover leaves its variance open), 548 (app role can DELETE trade_orders), 549
  (receipt entries have no reversal — reopen when a receipt void is specced), 550 (**no screen can void a supplier
  payment**, so a paid bill can never be voided — T-369, priority).
- **Ian's rulings today:** smoke DB Oct 2026–Jan 2027 opened (done); `FB_DEV_TERMINAL_*` = Firebase clock-terminal
  account, `DEV_TERMINAL_*` = a separate local access account (Open Questions page); the same manager may confirm an
  overage → **bible row 261**. Orchestrator rulings made standing → **row 262** (render a money control only where
  usable; counts of work stay org-wide). Per-slice rulings are in each task's "review record" section.
- **0174 broke ~22 test files** (whole-month open-period CHECK + gap trigger); all repaired in `73927d6` and
  `3559128` (legacy holes built under `session_replication_role=replica`, as the cutover ETL would).
- **Tooling:** local `.git/hooks/pre-commit` refuses CR bytes (not committed — reinstall on a new clone);
  `.gitattributes` pins `*.sql eol=lf`; `gates.mjs` migrates its DB first.

## Pick up here
1. **Ian: fix GitHub Actions billing.** Then re-run CI on `main` (`gh run rerun` or an empty commit) and watch it: a
   green CI deploys 0166–0176. Check `https://erp2.shareat.net/sign-in` → 200 and the service after the swap.
2. **If prod data changes before that deploy**, re-run the prechecks in `docs/ops/README.md` first (they take a minute;
   SSH root@159.223.46.224 works from this machine; use `SYSTEM_DATABASE_URL` — the app role is RLS-filtered).
3. **T-368 S1 §9.4 is UNMET** — the close screen offers completed months only; redo on/after 2026-11-01 (register
   DEF-424 row). Then the next slices: T-372 S4 (posting pattern + re-read stale commissary patterns), S5, S6;
   T-367 S3–S6; T-368 depreciation slices (435/436 domain, 426 follow-ups in its spec); T-369 (**DEF-550 first**);
   T-370 S3 (DEF-409); T-371 last.

## Do not decide these alone — they are Ian's (Open Questions page, row 252)
DEF-539 charge scope (reco: only that person's handover days) · T-370 monthly floor (reco: never below zero) ·
T-367 Q3b which suspense account (reco: new "Unclassified payments") · HR statutory data owner.

## Traps that bit today
- **Gate a CHECK/trigger migration on the FULL suite on a FRESH gate DB.** Never let a gate DB see an uncommitted
  migration (its hash sticks). Start long runs with PowerShell `Start-Process`; `TaskStop` leaves vitest alive.
- **CRLF**: the Edit tool writes it; lanes' own checks missed it twice. The pre-commit hook now refuses it.
- **Lanes must never** `git stash`, start a dev server, or plant a mutant in the shared tree (all happened once today).
- Scripts in `~/.claude/skills/orchestrator/tools/` that import the whole `@shareat/domain` from outside the repo
  hang at startup — drive screens through the UI instead.
- The smoke DB `shareat_test_setup` now has Oct 2026–Jan 2027 open; 9008 points at it.

## Sessions — all three SAFE TO CLEAR (re-brief from this file)
Tester `webapps-30` · Builder `system32-19` · Auditor `auto-assign-staff-role-on-hire` — frozen, no uncommitted work of
their own, all work in the commits above. Lane DBs survive by name (`shareat_test_t36*_*`, `shareat_test_t372_*`,
`shareat_test_sweep{a,b,c,d}`, `shareat_test_fix34{4,5}`, `shareat_test_def546`, `shareat_test_gate` — gate DB is fresh).

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and
docs/plans/money-defects-2026-09-30.md. Read the Open Questions page (bible row 252) with ArtifactData
before building anything gated on Ian. GREP the register and bible, never Read them whole. Goal (Ian):
close all open money defects in v2; NOT launched. Queue: HANDOFF "Pick up here" 1→3.
⛔ CI is blocked by GitHub billing (Ian's to fix); prod is at 0165 and the next green CI deploys 0166-0176.
STANDING: commit slices locally; push ONLY at wrap-up; republish the What's Left board after every commit
that closes a DEF; every wrap-up updates "what's left", ROADMAP.html and the board. Reds assert the target;
every "not" gets a positive control. Each tester/helper gets its own _test DB. Gate any CHECK/trigger
migration on the FULL suite on a fresh gate DB. No git stash, no lane dev servers, no mutants in the shared
tree. Freeze lanes during gates. Messages are short. Render before deciding. Ian runs this terminal on
Opus 5.5 at medium effort; do not ask him to switch.
```
