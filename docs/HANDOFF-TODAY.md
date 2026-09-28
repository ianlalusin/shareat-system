# Handoff — 2026-09-29

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> This wrap-up PUSHED `141de73..HEAD`, including **migrations 0167 and 0168**. Local `shareat_dev` is at **0167**
> (Ian ruled 0167 → dev); **0168 is NOT applied to dev** — Ian's call.

## Where things stand
Nine defects closed toward deployment: DEF-477 (admin-only payout account, T-350 S1–S5), DEF-480–483 (T-351),
DEF-484 (T-353 + S2), DEF-486, DEF-487 (T-354: 18 immutability triggers ALWAYS on). `audit_log` now has its first
writer (payout-account changes; org-scoped + append-only, 0167). T-349 S2c/S2d shipped. Specced and ready: **T-349
S2e**, **T-352** (DEF-478), **T-348 S1–S3** (Ian picked T1 + W2).

## Gates at `aa14108`
Full suite on a fresh DB (`shareat_test_gate_0929a`): typecheck 0 · integration **3624/3624** (191 files) · build 0 ·
unit **3488 passed, 1 skipped**; the one unit red was `db-generate-retired` timing out at 6.8 s under load — **2/2 on a
solo re-run**. (Flaky under load; same shape as `no-committed-secrets` yesterday.)

## What happened this session (by theme; Ian's rulings and where recorded)
- **Post-commit audits RAN code this time.** The auditor now has its own DB (`shareat_test_auditor`) and runs mutants
  in its own worktree; every slice got an executed review. Pattern it named twice: *a remedy reintroduces its own
  defect class one slot over* (T-350 S4→S5). Acceptance criterion adopted: every rendered sentence has a leg that reds
  when its own arm is deleted.
- **T-350** (`0ffb0fe`, `55077ef`, `fc9a1d4`, `abe22f2`, `fa83e01`): capability `set_channel_payout`; audit row per
  change (0167); banner derived only from the audit row. Ian: **audit log YES** (bible row 238), **adminless manager
  keeps it** (row 239).
- **T-349 S2c/S2d** (`7415676`, `bad8c32`): Ian Q2 close-and-replace; banner wording. **S2e specced** (§4e) — the
  concurrency legs E7/E9 rely on a 300 ms sleep and pass under the mutant at 0 ms; wording → "at every store they have
  access to".
- **T-351** (DEF-480–483), **T-353** (DEF-484 — Ian: before launch; row 240), **T-354** (DEF-487 — Ian: before
  launch; row 241).
- **T-348 S0**: Ian picked **T1** (inline chevron) and **W2** (table density) from rendered sheets (Amendment A1,
  row 240).
- **New defects:** DEF-484 (fixed), 485 (AP-invoice embedded expense form probably can't save — **unverified on
  screen**), 486 (fixed), 487 (fixed). DEF-169 partly fixed.
- **Tools** (`~/.claude/skills/orchestrator/tools`): `run-with-db.mjs` now runs in the CALLER's cwd (it forced the
  main tree — a worktree review ran main-tree code). `.claude/launch.json` gained `erp-smoke` (9008 against
  `shareat_test_setup` for forged-session smoketests; that DB is at 0167).

## Pick up here
1. **T-349 S2e** — tester first (`docs/tasks/349-*.md` §4e): real `pg_stat_activity` barriers, branch assertions,
   the two-caller leg, "at every store they have access to". No source mutants in the shared tree.
2. **T-352** (DEF-478) — `docs/tasks/352-*.md` incl. amendments M1–M6; Ian has already said go to the tester.
3. **Post-commit audits still owed:** `fa83e01` (T-350 S5), `0cd0fb6` (T-354 / 0168), `aa14108` (T-353 S2). The
   auditor needs Ian's "go" per sha and re-migrates its DB from its worktree.
4. Then **T-348 S1–S3**, **DEF-485** (verify on screen first), S5.4, S8, S9.

## Do not decide these alone — they are Ian's
- **Apply 0168 to `shareat_dev`?** Recommendation: yes, so dev matches the code (dev `audit_log` has 0 rows).
- **DEF-485** fix before launch? Recommendation: verify on screen first; if real, yes (it blocks expenses from AP).
- Carried: erp2 hold-button grants check (0166); DEF-476 before launch?; DEF-443; ADR-014; fiscal-period cleanup
  (DEF-424/426/433/434/439); arm `shareat-fiscal-period-seed.timer` before 2027-09-01; dark-mode `--brand`/`--warning`;
  create the terminal Firebase account (real sign-in for §9.4 is still impossible locally — every smoketest today used
  forged sessions: screens, not authentication).

## Traps that have actually bitten
- **Two helpers on one lane DB** truncate each other — every tester/subagent gets its own `_test` DB.
- **`page.content()` includes Next's RSC payload** (it embeds searchParams) — assert on the visible element's text.
- **`renderToStaticMarkup` emits `&#x27;`** — normalise before matching (bit four times today).
- **A negative assertion with no positive control** passes when the feature is deleted — pair every "not" with a "is".
- **A fixed `setTimeout` is not a concurrency barrier.**
- **Adding a directory under `packages/*/src`** needs a `t343-throw-ratchet` CEILINGS entry.
- **Bible rows shift the TOC** — `npm run toc` after every row.

## Sessions
Tester `webapps-30` (no uncommitted files; next S2e then T-352; asks Ian per new task). Builder `system32-19` (clean,
idle). Auditor `auto-assign-staff-role-on-hire` (worktree `wt-t350`, DB `shareat_test_auditor` at 0167; queue: `fa83e01`,
`0cd0fb6`, `aa14108`). Lane DBs: `shareat_test_t343s5_{tester,builder}`, `shareat_test_helper_s5` — re-run
`make-test-dbs.mjs` for 0168. All three sessions are safe to clear and re-brief from this file.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then
docs/tasks/349-def-456-store-scoped-hold-own-right.md §4e and docs/tasks/352-def-478-attendance-parse-after-authorize.md.
GREP the register and bible, never Read them whole. Goal (Ian): close as many defects as possible toward
deployment; NOT launched. STANDING: commit slices locally; push ONLY at wrap-up unless Ian says otherwise.
Queue: T-349 S2e → T-352 → post-commit audits of fa83e01, 0cd0fb6, aa14108 (Ian's go per sha) → T-348 S1
→ DEF-485 (verify on screen) → wrap up. Reds assert the target; every "not" gets a positive control.
Each tester/helper gets its own _test DB. Freeze lanes during gates. Messages are short. Render before
deciding. Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```
