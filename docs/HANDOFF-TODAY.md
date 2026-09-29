# Handoff — 2026-09-30 (early morning)

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> This wrap-up pushes `8229a71..HEAD` — **no migrations** in it (0169–0171 went out with the previous push; the
> `pg_default_acl` check in `docs/ops/README.md` still applies to whichever deploy first carries 0169).

## Where things stand
Queue cleared: T-348 S2, T-359 (assessed + decided), T-360, T-362, T-361 all shipped and audited with executed
mutants. DEF-474, 488, 492, 495 FIXED. Nothing half-built in the tree. Next: T-348 S3 (DEF-440).

## Gates at `4e8f770` (fresh DB `shareat_test_gate_0930a`, FULL suite)
typecheck **0** · unit **3551/3551** (1 skipped) · integration **3952/3952** (207 files, 46 min) · build **0**

## What happened this session (by theme; Ian's rulings and where recorded)
- **Shipped** (red first, audited pre-commit, smoketested on 9008): `3372e5e` T-348 S2 / DEF-474 (102 descriptions on
  `PageDescription`, resolver taught the component) · `1aaa0dd` T-360 / DEF-488 (shift day parsed after
  `authorize()`, calendar round-trip) · `6ff230d` T-362 / DEF-495 (supplier credit terms get a writer, audited) ·
  `4e8f770` T-361 / DEF-492 (COD-credit rule in the domain; recurring job obeys it).
- **Ian's rulings** (bible §13): **248** AI brain Phase 0 approved, after launch; "looks personal" flags seen by owner +
  admin · **249** DEF-495 option (a): supplier terms editing before T-361 · **250** terms gated by `approve_supplier`
  (managers + admins) · **251** Q3 yes after the base-rate count; Q5 no receipt images to the AI (Phase 1b dropped);
  Q6 no v1 labelling — a manual "doubtful expense" flag (**T-363, after launch**) builds the labelled set.
- **Assessment:** `docs/discovery/ai-business-brain-assessment.md` (T-359).
- **New defects:** DEF-493 (app-boundaries can't see `@/`), 494 (core date parser accepts 2026-02-30), 496 (expenses
  form validates before `authorize()`), 497 (employment existence oracle before `authorize()`), 498 (supplier bank
  edits unaudited), 499 (due date from terms never built), 500 (Drizzle lacks the 0–365 CHECK), 501 ("0 day terms"
  copy), 502 (`no-committed-secrets` times out under full-suite load), 503 (one-off console 404 on first load).
- **Housekeeping (Ian approved):** 73 stale lane DBs dropped; stale worktrees `wt-t350`, `wt-s6b` removed. **Both held
  links into the main tree** (`wt-s6b/node_modules` was a junction to the main `node_modules`; `wt-t350/packages/db/
  node_modules` to the main one) — unlinked non-recursively first; main tree verified intact after.
- **Process:** orchestrator briefing template now requires `file <path>` (no CRLF) before READY/RED.

## What's left (Ian's standing ask)
1. **T-348 S3** — DEF-440, the eight two-column pages at full width (Ian's W2). Spec: `docs/tasks/348-*.md` §S3.
2. **Cheap follow-ups, all specced in their register rows:** DEF-496 + DEF-497 (authorise-first, T-352 pattern),
   DEF-494, DEF-500, DEF-501, DEF-502, DEF-498 (audit supplier bank edits — money-adjacent), DEF-499 (due date
   from terms), DEF-493 (before apps/pos|customer get source), DEF-503 (diagnose).
3. Carried: T-343 S5.4, S8, S9; DEF-491 (before a 2nd org); DEF-476 (before launch?); T-353 S4 latent notes.
4. **After launch:** AI-brain Phase 0 (spec it then), T-363 manual expense flag.

## Do not decide these alone — they are Ian's
- **After this deploy: set credit terms on real suppliers** (~68 carried a balance in v1; none importable). Until set,
  each is cash-on-delivery and credit is refused (row 247's default can't fire).
- **Apply 0169–0171 to `shareat_dev`?** (carried; recommendation yes). The prod `pg_default_acl` check before 0169.
- Carried: DEF-476; DEF-443; fiscal-period cleanup (DEF-424/426/433/434/439); arm `shareat-fiscal-period-seed.timer`
  before 2027-09-01; dark-mode `--brand`/`--warning`; the terminal Firebase account.

## Traps that have actually bitten
- **Worktrees can hold junctions INTO the main tree** (whole `node_modules`, or `packages/*/node_modules`). Before
  deleting any worktree: `cmd /c dir /AL /S /B <wt>`, unlink each with `[IO.Directory]::Delete(p,$false)`, re-scan,
  then delete. `git worktree remove --force` deregisters even when the delete fails ("Filename too long").
- **CRLF:** the Edit tool rewrote three files whole-file CRLF in two days. `file <path>` before every commit.
- **Stopping `next dev` can leave `apps/erp/.next/dev/types/routes.d.ts` half-written** — typecheck/build then fail
  with TS1109 on it. Delete `apps/erp/.next/dev/types` and re-run.
- **`shareat_test_setup` has every fiscal period Jan 2026 – Jan 2027 CLOSED** (closed 25–26 Sep by earlier smokes).
  Smoketest postings must be dated ≥ 2027-02, or reset the DB.
- **`no-committed-secrets.test.ts` / `t343-scheduler-status.test.ts` time out under full-suite load** — re-run solo
  before believing (DEF-502).
- Carried: raw `SAVEPOINT` inside `sql.begin` escapes `caught()`; `app.org_id` unset under RLS = 0 rows silently;
  `SELECT … FOR UPDATE` needs UPDATE; a bible row shifts the TOC → `npm run toc`.

## Sessions (all safe to clear; re-brief from this file)
Tester `webapps-30` · Builder `system32-19` · Auditor `auto-assign-staff-role-on-hire` (no worktree now — make a
fresh one with its OWN `npm ci` for mutants; DB `shareat_test_auditor`). Lane DBs: `shareat_test_t361_{tester,
builder}` (at HEAD's migrations; reusable or re-create with `make-test-dbs.mjs`), smoke `shareat_test_setup`
(`erp-smoke` on 9008), gate `shareat_test_gate_0930a`. Nothing in flight; no uncommitted lane work
(`apps/erp/next-env.d.ts` "M" is `next dev`'s own regeneration).

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md.
GREP the register and bible, never Read them whole. Goal (Ian): close defects toward deployment; NOT
launched. STANDING: commit slices locally; push ONLY at wrap-up; every wrap-up updates "what's left",
ROADMAP.html and the What's Left board. Queue: T-348 S3 (DEF-440) → DEF-496 + DEF-497 (authorise-first)
→ DEF-498 → DEF-494/500/501/502 → wrap up. Reds assert the target; every "not" gets a positive control.
Each tester/helper gets its own _test DB. No node_modules junctions; mutants only in a worktree with its
own install; scan a worktree for links before deleting it. `file` every edited file (no CRLF). Freeze
lanes during gates. Messages are short. Render before deciding. Ian runs this terminal on Opus 5.5 at
medium effort; do not ask him to switch.
```
