# Handoff — 2026-09-25

> ⚠️ NOT LAUNCHED. No present-tense claim about which commit production runs (DEF-360). A green push to `main`
> runs CI and a green CI **deploys** (`.github/workflows/deploy.yml`) — keep `main` green.

## Where things stand
Seven tasks shipped since 2026-09-24: T-337, T-339 (all five slices), T-340, T-342, T-276, and T-343 slices
S1–S4 (human-readable refusals). Migrations **0157** (T-276) and **0158** (DEF-236) are on `main`. **T-341**
(DEF-414, person grants per store) is specced and approved with slot **0159**; its red tests are written and
**parked** in `docs/tasks/341-wip/` (restore steps in its README) — source not built.

## Gates at b368a77 (the committed tree; run just before the commits)
typecheck 0 · unit 164/165 files (one transient 20s timeout in `t343-scheduler-status.test.ts`; passes alone and the full unit project re-run gave **165 files, 2995 passed, 1 skipped**) · integration **3069/3070** (147→151 files; the one failure was a DEF-279 assertion still expecting a raw UUID, amended per T-343 R1 and re-run 2/2 — the full suite was not re-run after that one-line amendment) · build 0 (port 9008 stopped).
⚠️ Watch `t343-scheduler-status.test.ts` for the timeout recurring.

## What happened this session (by theme)
- **Access defaults (T-337):** grouped + collapsible screen. S5 failed on screen (every area closed after a toggle);
  **Ian ruled "reopen the toggled area"** → spec Amendment A1. Screen-tested both themes, desktop and mobile.
- **Small defects (T-339):** DEF-412 (the integration suite is green again), DEF-165 (recipe scaling; one rounding),
  DEF-337 (provision-terminal refuses a non-bypass role), DEF-148 (sales-day store picker + wallets), DEF-236
  (blank revoke reason refused, migration 0158). DEF-181/220 were already fixed — stamped.
- **Money (T-340, DEF-393):** a non-number invoice line is refused with a sentence; one shared
  `assertFiguresReconcile` for trade and items.
- **Opening-balance refusal Ian hit (T-342, DEF-417 part 1):** five cutover actions passed a null tx → RLS hid the
  admin's own role. Fixed with `withOrgPrincipal`. `runDepreciation`'s null tx is deliberate (per-asset txs) and kept.
- **Raw ids on screen (T-343, DEF-417 part 2, Ian's rule 2026-09-25):** S1 redacts UUIDs to `[hidden]` at the error
  choke point; S2 `authorize()` refusals carry human sentences (ROLE_LABEL, 96 CAPABILITY_LABELs) with savepointed
  refusal-only lookups; S3 44 repo "not found" throws name the record kind; S4 scheduler failure lines name stores.
  Orchestrator defaults recorded in the spec header (Ian may override): fallback wording, labels, staging, privacy.
- **Fiscal periods (T-276, DEF-305):** monthly `fiscal_period_seed` job (Ian's option c), migration 0157.
- **Agents:** `frontend-developer`, `backend-architect`, `code-reviewer` moved to `~/.claude/agents/` (Ian).

Decisions recorded: T-337 A1 (spec), T-343 defaults + R1–R3 (spec), T-341 R1 (spec), T-342 A1 (spec),
Ian's human-readable rule (T-343 spec + DEF-417). ⚠️ **Unrecorded in the bible** (planner, §14): Ian's
"every user-visible message names things in human terms" rule and T-276's gap threshold deserve §13 rows.

## Pick up here
1. **T-341** (DEF-414): restore the parked tests (`docs/tasks/341-wip/README.md`), then build per the spec +
   Amendment R1. Migration slot 0159.
2. **DEF-422** (T-276 follow-up): the seed job only checks after the latest period end — earlier holes are
   never detected. Plus the queued small fixes listed at the end of the T-276 spec.
3. **T-343 S5+** (domain tail, rows 7–16) and **S8** (choke-point bypasses) — spec lists them. Widen the census
   scanner first (it misses concatenated/nested-template throws).
Then: T-338, T-334 tranche 2+, Select primitive, DEF-421 (non-nullable tx, with a runDepreciation exception),
DEF-416 (system-client silent fallback), DEF-418/419/420/423.

## Do not decide these alone — they are Ian's
- **Arm `shareat-fiscal-period-seed.timer`** on the production host (1st of month 04:00 Manila) before 2027-09-01.
- T-343 defaults (fallback sentence, the 96 labels in `packages/auth/src/capabilities.ts`) — override any time.
- T-341 heads-up: staff scoped by hand to a second store with no employment there lose their position's everyday
  access at that store (v1 behaviour); remedy is an employment or a hand-grant. Count before deploy.
- Still open from before: the Firebase terminal account; dark-mode `--brand`/`--warning`; duplicate "Server".

## Traps that have actually bitten
- **The local 9008 server connects as a bypass role** (`postgres`, `rolbypassrls = true`) — screens cannot reproduce
  RLS bugs like DEF-417. Proof comes from integration tests under `shareat_test_runner`.
- **A null tx is not always the bug** (`runDepreciation`). Read why the null branch exists.
- **Guards that match source text were weaker than they looked, four times** (T-342 scanner, T-342 order test,
  T-276 mirror negative, DEF-236 `/btrim/`). Prefer a type error or a behavioural test.
- **Postgres aborts a tx on any statement error** — `.catch()` does not un-abort; use a savepoint.
- The builder may never edit a test; when a builder's fix needs a test change, it goes back to the tester.

## Sessions
All worker sessions are **safe to /clear**: nothing in flight, no uncommitted work of theirs, all state in the repo.
Lane DBs (reusable by name): `shareat_test_t276_tester`, `shareat_test_t339s5_builder` (0158),
`shareat_test_t341_tester`, `shareat_test_t343_tester`, `shareat_test_t335_builder`, smoke DB `shareat_test_setup`
(SMOKE_ORG; now two stores SMK/SMK2, item "Pork belly", supplier "T340 Test Supplier", position "Commissary Lead").
Roles last used: tester `webapps-30` (Sonnet), builder `system32-19` (Sonnet), auditor
`auto-assign-staff-role-on-hire` (Opus). Re-brief from `~/.claude/skills/orchestrator/worker-briefing.md`.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then the
T-341 spec and docs/tasks/341-wip/README.md. GREP the register and bible, never Read them whole.
Goal (Ian): close as many defects as possible toward deployment. It is NOT launched; a green push deploys.
First job: T-341 (restore the parked red tests, build, audit, gates, commit). Then DEF-422, then T-343 S5+.
Messages are short. Render before deciding. Ask for the exact command behind any reported number.
Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```
