# Handoff — 2026-09-28

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> This wrap-up PUSHED `0fcd7b1..HEAD`, including **migration 0166** (T-349 S3). Local `shareat_dev` is migrated to 0166.

## Where things stand
T-343's number-box work is finished: every money, quantity and whole-number input is a text box and the server refuses
unreadable input in human words (DEF-470/471/472/473 fixed). T-349 S3 (0166) repaired the grants DEF-456 widened.
Specced and waiting to build: **T-350** (admin-only payout account, red tests half-written), **T-349 S2c**, **T-348**.

## Gates
Full suite at `0944455` (code unchanged since; later commits are docs only), fresh DB `shareat_test_gate_0928b`:
typecheck 0 · unit **3406 passed, 1 skipped** (198 files) · integration **3531/3531** (178 files) · build 0.
Re-run at wrap-up on the final tree: typecheck 0 · unit **3407 passed, 1 skipped**. The only red is the UNCOMMITTED
T-350 file (6 red, 1 green, by design) — kept out of `main` so CI stays green.

## What happened this session (by theme; Ian's rulings and where each is recorded)
- **T-343 S5.5t/u/v/w** (`7896e2a`, `0944455`): the last 31+7 number boxes; value checks, never digit-run checks
  (`.5`, `005`, `8.` accepted, ceilings stated); settlement preview never shows NaN, lists every refusal, sends gross/net
  raw; parse after `authorize`. Every slice: tester red → builder → auditor read → Chrome → gates.
- **Ian's rulings** (bible §13 rows 228–237, task specs): blank minutes box = "not decided" (DEF-471); blank whole-number
  attendance settings refuse, auto clock-out blank = "never"; blank settlement gross/net refuse; blank fixed-OT rate
  refuses in fixed mode (already did, via a DB check); T-349 Q1 **yes** (0166), Q2 **close and replace** (§4c; supersedes
  row 188); channel payout account **admin only** (T-350); page descriptions full width, 3-line clamp (T-348); keep the
  stuck Lipa dev draft until DEF-479; apply 0166 to dev at wrap-up (done).
- **T-349 S3 / 0166**: audits stopped two wrong versions (would have narrowed deliberate grants; would have silently
  repaired one org only — `person_grants` is FORCE RLS, now wrapped in `SET LOCAL row_security off/on`).
- **New defects:** DEF-474 (descriptions), 475 (picker double-click 23505), 476 (amounts/reasons in URLs), 477 (payout
  account), 478 (attendance forms refuse before authorize), 479 (draft sales day cannot be edited/voided).
- **Audit coverage correction:** `0944455`'s body overstates the pre-commit reads — see the T-343 doc
  ("Audit-coverage correction"). The auditor has since read S5.5v A3 and the S5.5u tests (clean; two reach notes on PV4).

## Pick up here
1. **Post-commit `/code-review 0944455`** — Ian types it in the worktree session (`…\scratchpad\wt-s6b`, prepared).
2. **T-350** — tester: finish the render file (R1–R3) + ratchet edit; builder: build (capabilities.ts + page + domain);
   **orchestrator adds the CAPABILITY-MATRIX row in the same commit** (a pre-wired row made unit red today).
3. **T-349 S2c**, then **T-348 S0** (screenshots for Ian), DEF-478, DEF-475. Then S5.4, S8, S9.

## Do not decide these alone — they are Ian's
- **erp2 check:** read-only look for hold-button grants made after 2026-09-27T10:59:23Z and before S2 deployed; 0166
  leaves those org-wide (safe side).
- **T-348 picks:** expand control (inline chevron / "Show more" / right-margin chevron) and the two-column width.
- **DEF-476:** fix before launch or follow-up? Carried: DEF-443; ADR-014; fiscal-period cleanup (DEF-424/426/433/434/439);
  arm `shareat-fiscal-period-seed.timer` before 2027-09-01; dark-mode `--brand`/`--warning`.

## Traps that have actually bitten
- **Reds written against today's behaviour** (five times today: M5, O1, D3–D5, PV4, the S5.5v owners legs). Read the
  assertion, not just the failure.
- **Digit-run regexes narrow valid input** (`.5`, `005`, `8.`) — check the value, state the ceiling.
- **A CAPABILITY-MATRIX row without its `capabilities.ts` entry** fails `capability-matrix.test.ts`.
- **`/code-review <path>` reviews the main tree**, not the path — open a session AT the worktree.
- **FORCE RLS tables filter the owner** — data migrations need `SET LOCAL row_security = off/on` spanning every step.
- `apps/erp/next-env.d.ts` flips between dev and build paths — leave it uncommitted.

## Sessions
Tester `webapps-30` (T-350: `apps/erp/tests/integration/t350-channel-payout-change.test.ts` UNCOMMITTED — keep it; render
file next). Builder `system32-19` (clean, idle; T-350 next). Auditor `auto-assign-staff-role-on-hire` (worktree
`…/scratchpad/wt-s6b` at `0944455`, one root junction — remove it non-recursively). Lane DBs:
`shareat_test_t343s5_{tester,builder}` (re-run `make-test-dbs.mjs` — 0166). None of the three holds state that lives
only in its session; all are safe to clear and re-brief from this file.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then
docs/tasks/350-def-477-change-channel-payout-account.md and T-349 §4c. GREP the register and bible, never
Read them whole. Goal (Ian): close as many defects as possible toward deployment; NOT launched.
STANDING: commit slices locally; push ONLY at wrap-up unless Ian says otherwise.
Queue: /code-review 0944455 (Ian types it in the worktree session) → T-350 → T-349 S2c → T-348 S0
screenshots for Ian → DEF-478 → wrap up. Reds assert the target. Freeze lanes during gates. Testers run
npm run typecheck before every report. Messages are short. Render before deciding. Ian runs this terminal
on Opus 5.5 at medium effort; do not ask him to switch.
```
