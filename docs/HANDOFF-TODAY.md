# Handoff — 2026-09-27 (evening)

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> This wrap-up PUSHED `567a564..HEAD` (Ian asked for the wrap-up; standing rule: push at wrap-up). It includes
> **migration 0165** (T-349 S1). Local `shareat_dev` is already migrated to 0165.

## Where things stand
T-343 (human-readable refusals) moved from S6 through S7 plus a string of money-input fixes the audits turned up;
T-349 (DEF-456, hold-own-right stays at the job's store) shipped S1, S2, S2b. The day's theme became **silent money
loss at the input edge**: three places where a mistyped amount was dropped and the money still moved (DEF-457, 460,
470), plus two off-by-one ceilings. T-343 S5.5t is approved with red tests half-written (uncommitted, see Sessions).

## Gates at `8d14e7a` (fresh DB, `node ~/.claude/skills/orchestrator/tools/gates.mjs --db shareat_test_gate_0927g --port 9008`)
typecheck 0 · unit **3360 passed, 1 skipped**, 6 failed = the uncommitted S5.5t red file only (not in any commit) ·
integration **3416/3416, 174 files** · build 0.

## What happened this session (by theme)
- **Labels (T-343 S6a–S6d):** item kinds, dispositions, wastage reasons and capability titles on screen; `/admin/users`
  shows labels with the raw key as muted grey text (**Ian**: grey text, not hover — recorded §S6 design rule 5); label
  wording approved as drafted (**Ian**, §S6a). DEF-431 FIXED.
- **Money refusals in human words (S5.5m):** `humanLabel` is required, so typecheck proves all 40 callers; wording table
  **Ian-approved**. DEF-454 FIXED.
- **Silent money loss (S5.5n/p/r/s):** a store credit or prepaid refund typed "1,000" was dropped and the full amount
  posted (DEF-457, DEF-460 — the refund box was also `type="number"`); money() and quantity() accepted one value past
  `numeric` (DEF-458/462); huge exponents, lost-precision and too-large now each get the right sentence (DEF-458/469).
  **Measured in Chrome 152:** a `type="number"` box turns typed "1,5" into **15** and "abc" into ''. S5.5s made 17
  money boxes text inputs; the rest is S5.5t + DEF-472.
- **Numbers that aren't numbers (S5.5q):** attendance settings, useful life, 13th-month year, asset terms (DEF-463
  partly, 464, 465, 467).
- **Wrappers (S7):** 13 app wrappers stopped pre-empting refusals (DEF-452); **Ian**: option A (friendlier admin
  sentences into `roles.ts`) and trade rows numbered now — both in §S7.
- **DEF-456 (T-349):** **Ian ruled "keep it at that store"** (register + T-349 spec). Org-scoped capabilities hold via the
  person-level row (orchestrator ruling, §3.2 item 9). S3 (repair already-widened rows) waits on Ian's Q1.
- **Incident:** the auditor's worktree teardown recursed through a junction and deleted shared `node_modules`; repaired
  with `npm ci` (Ian approved). Standing rule given to the auditor: remove a junction non-recursively first; ask before
  any delete outside its scratchpad.
- **Register:** FIXED 431, 452, 454, 456, 457, 458, 459, 460, 461, 462, 464, 465, 467, 469; PARTLY 463, 470; new open
  455, 466, 468, 471, 472, 473.

## Pick up here
0. **Post-commit `/code-review` still owed** for `33dbd3f` (S5.5s) and `8d14e7a` (T-349 S2b) — every other slice today had one.
1. **T-343 S5.5t** — approved (§S5.5t). Tester's R-legs exist in `apps/erp/tests/t343-s5-5t-number-boxes.test.ts`
   (6 red, uncommitted); the action-level file `apps/erp/tests/integration/t343-s5-5t-followups.test.ts` is not started.
   Note: attendance minute columns are `integer`, so the NaN mechanism differs from money — probe before asserting.
2. **T-343 S5.5u** (DEF-473: refund account with no amount; quantity huge-exponent arm; keep typed values after a
   refusal) — approved.
3. **DEF-472 census** — every remaining money/quantity `type="number"` box → text + `inputMode`; the parsers already
   refuse "1,5". Needs a spec (planner).
Then: S5.4 (unblocked by S6), DEF-455, DEF-466, DEF-468, S8, S9.

## Do not decide these alone — they are Ian's
- **T-349 Q1:** re-scope the rows DEF-456 already widened (1 in dev; production counted at cutover)? Recommend yes.
- **DEF-471:** a blank overtime box records "approve 0 minutes"; the code's comment says blank means "not decided".
- **Owners:** a cleared agreed-amount box closes and locks the month at the ledger figure with no confirm (§S5.5s).
- Carried: DEF-443 (voided order's message thread); T-348 layout from screenshots; ADR-014 questions; fiscal-period
  cleanup (DEF-424/426/433/434/439); arm `shareat-fiscal-period-seed.timer` before 2027-09-01; T-341 §8 / T-344 counts;
  dark-mode `--brand`/`--warning`; duplicate "Server".

## Unrecorded (planner, bible §14 — not written this session)
Bible §13 rows still needed: push only at wrap-up; Ian's human-terms rule; the post-commit `/code-review`-in-a-worktree
rule; "a refusal may name only records the actor may see at THIS store" (DEF-453); DEF-456 ruling and T-349's
coexist-not-upgrade design (supersedes T-291 decision 5's mechanism); "a test asserts the target, never today's
behaviour"; the Chrome `type=number` finding as a UI rule. Carried: T-276 threshold, T-341 per-store grants, T-344
Q1–Q5, T-345 catch-up. Run `npm run toc` after each insert.

## Traps that have actually bitten
- **Tests that pin today's behaviour** pass before the fix and prove nothing (P2, S5.5q ×9 today). Assert the target.
- **Fixtures red for the wrong reason** (Q2: a missing rate refused before the quantity parse). Read the failure text.
- **`type="number"`** silently rewrites "1,5" → 15 in Chrome. A server fix behind one never runs from the screen.
- **Lane DBs go stale** after a migration lands: `make-test-dbs.mjs <db>` before rerunning (0164/0165 bit twice).
- **Register rows with `|` in code** break `register-row-shape`: escape as `\|`.
- **Never recursively delete through a junction** (the node_modules incident). Worktrees: `git -c core.autocrlf=false
  worktree add`, one root junction, `--no-cache`.
- An applied migration's header is never edited, even to correct it (0165's FK note is corrected in T-349 §3.2 item 8).

## Sessions
Lanes, all frozen at clean points, nothing half-edited in source: tester `webapps-30` (holds the uncommitted S5.5t red
file above — keep it), builder `system32-19`, auditor `auto-assign-staff-role-on-hire` (worktree `…/scratchpad/wt-s6b`,
safe to remove non-recursively). Lane DBs reusable: `shareat_test_t343s5_{tester,builder}` (migrated to 0165).
Seeded dev data, all tagged: T343S6B/S6C/S7/S55R/S55S items, a Dev Cashier hire at Lipa, two draft trade orders
(`01a0e1d2-…`, `01a0e1d4-…`), one verified sales day at T346 Smoketest. The unmerged `daily-review/2026-09-17` branch
still exists.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then in
docs/tasks/343-def-417-human-readable-refusals.md the Status line and §S5.5t, §S5.5u. GREP the register and
bible, never Read them whole. Goal (Ian): close as many defects as possible toward deployment; NOT launched.
STANDING: commit slices locally; push ONLY at wrap-up unless Ian says otherwise.
Queue: T-343 S5.5t (tester has R-legs uncommitted) → S5.5u → planner spec for the DEF-472 census → wrap up.
Ask Ian first: T-349 Q1, DEF-471. Reds assert the target. Freeze lanes during gates. Testers run npm run
typecheck before every report. The auditor reads diffs pre-commit and runs /code-review post-commit in a worktree.
Messages are short. Render before deciding. Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```
