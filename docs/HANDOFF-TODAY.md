# Handoff — 2026-09-29 (evening)

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> This wrap-up PUSHES `46f006d..HEAD`, including **migrations 0169, 0170, 0171**. ⛔ **Before the deploy that carries
> 0169, Ian runs the read-only `pg_default_acl` query in `docs/ops/README.md` ("Restores and replica mode" →
> DEF-489) as `doadmin` on the database `SYSTEM_DATABASE_URL` names.** 0169 aborts (safely, before the symlink swap)
> if a stray grantor holds a wide default — the query finds that first. Local `shareat_dev` is at **0168** (Ian
> approved 0168 today); 0169–0171 are NOT applied to dev.

## Where things stand
Queue cleared. Nine slices shipped since the last wrap-up; DEF-478, 484, 485, 489, 490 FIXED; DEF-474 in progress
(S1 component shipped, S2 sweep next). The three post-commit audits Ian authorised (`fa83e01`, `0cd0fb6`, `aa14108`)
ran with executed mutants; each produced follow-ups, all shipped. Nothing is half-built in the tree.

## Gates at `6ac13d0` (fresh DB `shareat_test_gate_0929w`, FULL suite)
typecheck 0 · unit **3532/3532** (1 skipped) · integration **3876/3876** (200 files, 49.5 min) · build **0**

## What happened this session (by theme; Ian's rulings and where recorded)
- **Shipped** (all audited pre-commit, reds first, smoketested where there is a screen):
  `24b0f1d` T-349 S2e · `a47e0a7` T-352/DEF-478 · `8c145d4` T-348 S1/DEF-474 · `88fcba7` T-350 S6 ·
  `f32fb24` T-353 S3/DEF-484 (+ the day's records) · `2fa99ab` T-355 (0169) · `6d24297` T-356 (0170) ·
  `cf7f71c` T-358/DEF-485 · `6ac13d0` T-357 (0171).
- **Ian's rulings today** (bible §13): row **242** DEF-489 option (a), before launch; **243** T-356 yes + Ian runs the
  prod `pg_default_acl` query; **244** DEF-490 before launch; **245** DEF-485 before launch; **246** the other
  same-org FKs (DEF-491) before a SECOND org onboards, persons + stores first; **247** AP-invoice expense defaults to
  Credit (remaining pre-filled) for suppliers with terms, Cash for COD. Also: 0168 → `shareat_dev` (done).
- **New defects:** DEF-488 (attendance `shiftDay` never parsed), DEF-489 (fixed), DEF-490 (fixed), DEF-491 (schema-wide
  same-org FKs; before a 2nd org), DEF-492 (COD-credit rule only in the web action, not the domain).
- **New request (Ian):** an **AI business brain** — phase 1 watches expenses daily (correctness, anomalies,
  non-business spend). Recorded as `docs/plans/ai-business-brain.md` + **T-359** (assessment first, nothing built).
- **Incident:** a lane's worktree had `node_modules` junctioned to the main tree; a recursive delete followed it and
  wiped `.bin` and most `@`-scoped packages. Repaired with `npm ci`. Standing rule now: **no node_modules junction in
  any worktree; mutants never in the shared tree** (auditor's worktree now has its own install).
- **Process notes that paid off:** independent Opus spec audits caught a stock-transfer-breaking revoke (T-355 R3) and
  a wrong actor (T-357 B1); the builder BLOCKED three times on tests that pinned retired behaviour (T-353) — right.

## What's left (Ian's standing ask: always listed at wrap-up)
1. **T-348 S2** — sweep ~102 page descriptions onto `PageDescription`. **First** teach the action-link resolver that
   `PageDescription` supplies `text-sm` (Amendment A2), red first.
2. **T-359** — the AI business brain assessment (`/research-evaluate-propose`; Opus; plan stub has the questions).
3. **DEF-488** (spec it: parse `shiftDay` in the domain after `authorize()`), **DEF-492** (move the COD-credit rule
   into the domain) — both small, both unowned.
4. **DEF-491** — before a second organisation onboards (not a launch blocker).
5. Carried: T-343 remainder, S5.4, S8, S9 (see ROADMAP), T-353 S4 latent notes (L1/L2).

## Do not decide these alone — they are Ian's
- **Run the prod `pg_default_acl` query before the deploy carrying 0169** (row 243).
- **Apply 0169–0171 to `shareat_dev`?** Recommendation: yes, so dev matches the code.
- Carried: DEF-476 before launch?; DEF-443; ADR-014; fiscal-period cleanup (DEF-424/426/433/434/439); arm
  `shareat-fiscal-period-seed.timer` before 2027-09-01; dark-mode `--brand`/`--warning`; the terminal Firebase account
  (real sign-in for §9.4 is still impossible locally — smoketests use forged sessions).

## Traps that have actually bitten
- **Never junction `node_modules` into a worktree; never recursive-delete one.** `rmdir` a junction first.
- **The Edit tool writes CRLF here** — check `file <path>` before READY; whole-file diffs mean line endings.
- **A raw `SAVEPOINT` inside `sql.begin` lets an error escape `caught()`** — use `tx.savepoint(...)` (T-355 N2, T-357 F4/F5).
- **A test with `app.org_id` unset under RLS affects 0 rows silently** — reds forever for the wrong reason (T-356).
- **`SELECT … FOR UPDATE` needs UPDATE privilege** — never revoke it from a table something row-locks.
- **Unit timeouts under load are flakes** (5–30 s legs while another lane runs mutants) — re-run solo before believing.
- **A bible row shifts the TOC** — `npm run toc`.

## Sessions (all safe to clear; re-brief from this file)
Tester `webapps-30` · Builder `system32-19` · Auditor `auto-assign-staff-role-on-hire` (worktree `wt-t350`, its OWN
`node_modules` now, DB `shareat_test_auditor`). Lane DBs: `shareat_test_t343s5_{tester,builder}` (builder at 0171;
re-run `make-test-dbs.mjs`), smoke DB `shareat_test_setup` (0168; `erp-smoke` on 9008). Nothing in flight, no
uncommitted lane work (the three `apps/erp/src/app/{ap,liabilities,money-accounts}/page.tsx` "M" entries are a stale
stat cache — `git diff` is empty).

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md.
GREP the register and bible, never Read them whole. Goal (Ian): close defects toward deployment; NOT
launched. STANDING: commit slices locally; push ONLY at wrap-up; every wrap-up updates "what's left" and
ROADMAP.html. Queue: T-348 S2 (resolver first, Amendment A2) → T-359 AI-brain assessment (Opus) →
DEF-488 → DEF-492 → wrap up. Reds assert the target; every "not" gets a positive control. Each
tester/helper gets its own _test DB. No node_modules junctions; mutants only in a worktree with its own
install. Freeze lanes during gates. Messages are short. Render before deciding. Ian runs this terminal
on Opus 5.5 at medium effort; do not ask him to switch.
```
