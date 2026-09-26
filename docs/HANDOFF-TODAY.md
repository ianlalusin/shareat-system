# Handoff — 2026-09-26 (evening)

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> ⭐ **Standing rule (Ian, 2026-09-26): push ONLY at wrap-up, unless Ian says otherwise.** Commit each clean
> slice locally; one push at the end of the session.

## Where things stand
Ian's queue for 26 Sep is done except T-343 S5's later groups. **Shipped:** T-345 (missed-month catch-up,
0161), T-346 (store opening date + in-service date, 0162/0163; DEF-427, DEF-428), T-347 (cutover purge,
0164; DEF-437), T-343 S5.0 (refusal foundation) and S5.1 (sales days + expenses in human terms).
**Designed only:** ADR-014 (the "AI brain", PROPOSED, post-launch). **Reserved:** T-348 (DEF-440, page width).

## Gates at `c6c761a` (fresh DB, `node ~/.claude/skills/orchestrator/tools/gates.mjs --db shareat_test_s51_t347_gate --port 9008`)
typecheck 0 · unit **173 files / 3125 passed, 1 skipped** · integration **162 files / 3278 of 3279** · build 0 (9008 stopped).
The one integration failure is `stock-usage.test.ts` "Hook timed out in 30000ms" under load (that file took 41 min in
the suite); **21/21 alone**. Untouched by today's work. The wrap-up pushed this exact tree (docs-only commits on top).
⚠️ Load timeouts recur: `t343-scheduler-status`, `t336-canonical-position-defaults`, `no-committed-secrets`,
`stock-usage` all passed alone. Run full gates with other sessions idle.

## What happened this session
- **T-345** `7c26f6d`: an admin books a missed month's depreciation/amortisation into this month, `[prior period]`,
  amount from the schedule. Audit added a floor (never before the org's earliest fiscal period).
- **T-346** `1ac1bca` / `78350ce` / `22475b1`: `stores.opening_date`; `fixed_assets.in_service_on/_source` with a
  fill trigger and a guard over posted months; reversals behind an in-page confirm; findings and store comparison
  honour the opening date. Spec Amendments R2–R6.
- **T-343 S5.0** `76557b0`, **S5.1** `e62ef27`: `refuse()` sanitises; per-directory throw CEILINGS measured at HEAD;
  56 sales-day/expense sites converted. The S5.1 builder built before release; red was then confirmed against HEAD
  with its code set aside and restored (byte-diff verified).
- **T-347** `c6c761a`: purge engine in `packages/db/src/cutover/purge.ts`; FK drop → TRUNCATE → one-statement shell
  clear → FK re-add, one transaction; sequences reset only if owned by a purged table. Rehearsed on a dev copy.
- **Local environment** (Ian): `shareat_dev` rebuilt from zero; terminal provisioned at LIP; Ian's email linked.
  Recipe now in `HANDOFF.md` §4a; values in `.env.local` (`DEV_TERMINAL_*`, `DEV_IAN_*`).
- **Registered:** DEF-440 (narrow two-column pages, T-348), DEF-441 (a confirm pins intent, not plan), DEF-442
  (asset can be created at a deactivated store, reported). **Fixed in the register:** DEF-427, 428, 437.
- **Docs:** ADR-014 + `docs/discovery/38-ai-brain.md` (PROPOSED; open questions for Ian at the end of the ADR).
- **Decisions by Ian, and where they live:** T-345 floor/confirm rulings → spec Amendments; push only at wrap-up →
  **UNRECORDED in the bible** (see below); T-348 "must be fixed" → `docs/tasks/348-*.md`; rebuild shareat_dev →
  `HANDOFF.md` §4a.

## Pick up here
1. **T-343 S5.1b** (commissary order messages, `messages.ts`, sole owner of `commissary/orders/[id]/actions.ts:106`),
   then **S2b** → **S5a** (measure the roles.ts two-arg sites with the S5.0 scanner BEFORE writing K1 — spec
   rulings at the end of `docs/tasks/343-*.md`) → S5.2 → S5.3 → S6/S6b → S5.4.
2. **T-348** once Ian picks a layout from rendered screenshots (tester renders `table` density vs record+aside on
   the eight pages at 1366/1920/phone).
3. A fiscal-period cleanup task for DEF-424/426/433/434/439 (proposed to Ian; not approved yet).

## Do not decide these alone — they are Ian's
- T-348's layout (from screenshots).
- ADR-014's open questions (pilot use case, providers, budget, knowledge scope, approver, Infisical when).
- The fiscal-period cleanup task above.
- Still open: arm `shareat-fiscal-period-seed.timer` before 2027-09-01; the T-341 §8 and T-344 production counts;
  check each store's backfilled opening date now that 0162 is live; dark-mode `--brand`/`--warning`; duplicate "Server".

## Unrecorded (planner, bible §14)
Bible §13 rows still needed: **push only at wrap-up (Ian, 2026-09-26, standing)**; Ian's human-terms rule; the T-276
gap threshold; T-341 per-store position grants; T-344 Q1–Q5; the T-345 catch-up rule. POSTING-PATTERNS needs the
T-345 `[prior period]` catch-up variant. Run `npm run toc` after each insert.

## Traps that have actually bitten
- **Specs had their review amendments unfolded** (T-346 S1/S2, T-343 S5, T-347): the body a builder implements from
  still said the old thing. Before building any slice, have the auditor grep the body against its amendments.
- **Freeze the whole tree during full gates** — a "write-only" test edit mid-gate invalidated a run. Set other lanes'
  in-progress files aside (backup, restore, `diff -q`) rather than gating a mixed tree.
- A **working-tree** throw ratchet counts another lane's uncommitted files; measure at HEAD, one key per directory.
- `pg_sequences` has no `is_called` on PG 18 — read the sequence relation itself.
- Backticks inside an SQL comment inside `sql\`…\`` end the template literal.
- `scripts/cutover-purge.ts` writes `docs/reviews/cutover-purge-<date>.md` on every run; tests set `CUTOVER_PURGE_REPORT_DIR`.
- Signing out in Chrome drops the terminal connection; screen testers must never sign out.

## Sessions
All six are **safe to /clear**: nothing in flight, every slice committed and pushed, nothing lives only in a session.
Last roles: T-347/T-346 tester `webapps-30`, builder `system32-19`; T-343 tester `webapps-a2`, builder `webapps-83`;
auditor `auto-assign-staff-role-on-hire` (Opus). Lane DBs reusable by name: `shareat_test_t343s5_{tester,builder}`,
`shareat_test_t347_{tester,builder}`. Re-brief from `~/.claude/skills/orchestrator/worker-briefing.md`.
An unmerged `daily-review/2026-09-17` branch exists — merge or discard it deliberately.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then
docs/tasks/343-def-417-human-readable-refusals.md §S5 (groups table, S5.1b, and the rulings at the end).
GREP the register and bible, never Read them whole.
Goal (Ian): close as many defects as possible toward deployment. It is NOT launched.
STANDING: commit slices locally; push ONLY at wrap-up unless Ian says otherwise.
Queue: T-343 S5.1b → S2b → S5a → S5.2 → S5.3 → wrap up today's work. Before any slice builds, have the
auditor check the spec body against its amendments. Freeze all lanes during full gates.
Use the backend-architect agent for specs and code-reviewer / the auditor for independent reviews.
Messages are short. Render before deciding. Ask for the exact command behind any reported number.
Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```
