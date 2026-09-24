# Handoff — 2026-09-24: three tasks shipped, T-337 built but unverified

> Tree clean after the WIP commit, pushed. `main` == `origin/main`.
> ⛔ Integration: 3 failed / 3025, all DEF-412 (`findings.test.ts`), pre-existing and unchanged.
> ⚠️ NOT LAUNCHED. No present-tense claim about which commit production runs (DEF-360).

## 1. Shipped since 2026-09-22

| Commit | What |
|---|---|
| `cf3474f` | T-334 slice 3 **tranche 1**: 5 files adopt `<Input>`; dark `--danger` #f87171 (ADR-013 A5); focus ring `ring-ink` (A6) |
| `b7bb845` | **T-335**: new orgs get the six canonical positions (DEF-150 fixed) |
| `1ad9d03` | **T-336**: per-position defaults (38/store) on every new store; a hire gets `staff` + scope for the hired store; scope revoked when the employment ends (migration **0156**, `person_store_scope.source`) (DEF-413 fixed) |
| (this) | **T-337 WIP**: `/admin/access-defaults` grouped by business area, collapsible. Built; typecheck + unit + build green. ⛔ **NOT audited, NOT screen-tested, full integration not run** |

## 2. Numbers
Next task **T-339** · next defect **DEF-415** · next migration **0158** (**0157 = T-276**, allocated).
T-338 reserved (store readiness warns when a store has no manager). Grep the register before issuing a DEF.

## 3. ⭐ Pick up here — finish T-337
Spec: `docs/tasks/337-access-defaults-grouped-collapsible.md` (approved; commit-1 checkpoint recorded).
1. Rebuild and serve on 9008 against `shareat_test_setup` (recipe: `docs/SMOKETEST.md` §3; cookie via `forge-session.ts`; sessions EXPIRE, so forge a fresh one).
2. The tester takes the "after" set with `~/.claude/skills/orchestrator/tools/smoke-t337.mjs` (its header documents usage). "Before" = `t337-v1-desktop-{light,dark}-before.png`, `t337-v5-mobile-{light,dark}-before.png` in that folder. Run **S1** (column alignment across split tables) and **S5** (an open `<details>` survives the toggle redirect). ⛔ Either failing = STOP and report to Ian with screenshots; no improvised fallback.
3. The auditor reviews the T-337 diff (including checking the grid.tsx extraction is pure). Then full gates, then commit.

Then: **T-338** · **T-334 tranche 2+** (a Workflow; include one `w-full`-baking file, e.g. `/ap`, deliberately) · **Select primitive** (121 `<select>`s; cures the accepted dark bg mismatch) · **T-276** (slot 0157) · DEF-412's own task · **DEF-414** (person grants have no store: two-store staff are authorised at both).

## 4. Ian's standing rules added this session (all recorded)
- **Messages are short** (bible §3.5a, row 227; global CLAUDE.md). Only bring Ian what needs him.
- **Render before deciding**: any question whose answer depends on rendering is settled on screen, with measured numbers (spec §6 of slice 3 is the worked example).
- The orchestrator terminal already runs Opus 5.5 at medium effort. Never ask him to switch it.
- Manager stays a ROLE, never a seeded position (T-338).
- Position defaults: `docs/decisions/PROPOSAL-DEF-413-…md` (RULED, plus its Amendment).

## 5. Method findings (not visible from code)
1. ⛔ **A lane-scoped number reported as a gate** happened THREE times this session ("unit 956/956" was really 2084; "integration 10/10"; "lifecycle 8/8"), and each time the blocker was what it could not see. **Ask for the exact command, not the number.** The full integration run is the only certifier (bible §9 rule 3).
2. ⛔ **A number you caused is not a number you checked**: the orchestrator's own ADR-013 A6 hex was wrong (`#171717` is the dark surface; `--ink` is `#1a1a1a`).
3. A fixed-HEAD "before" in tests goes red on commit. Pin a SHA (`BEFORE_REF`).
4. The tap-target sweep only sees what it knows. Keep the census TOTAL pinned by hand (now 1041); a new primitive (Select) must be taught to it, or its sites vanish.
5. `/code-review` did NOT mutate the tree this session (checked by hash every round), but isolate it anyway.
6. Unexplained, once: a gates run saw `findings.test.ts` hit "column source does not exist" while other files had it; the rerun was clean. Watch for it.
7. `apps/erp/next-env.d.ts` is always dirty. Never stage it.

## 6. Sessions
All three worker sessions are **safe to /clear**: nothing in flight, no uncommitted work of theirs, all state in the repo. Lane DBs survive and are reusable by name: `shareat_test_t335_tester`, `shareat_test_t335_builder` (both migrated to 0156), and the smoke DB `shareat_test_setup` (SMOKE_ORG, one employee "T334 Smoke Tester", positions seeded). Re-brief from `~/.claude/skills/orchestrator/worker-briefing.md`. Roles last used: tester (Sonnet), builder (Sonnet), auditor (Opus).

## 7. Open for Ian
- The duplicate "Server" position resolution (T-335 §5), only if the backfill finds a collision.
- The dark-mode `--brand` and `--warning` values are unruled.
- The Firebase terminal account (still blocks a real end-to-end sign-in).
- DEF-412 needs its own task.

## 8. Paste-ready prompt for the next orchestrator
-----------------------------------------------------------------------------------------------
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, then
the T-337 spec. GREP the register and bible, never Read them whole.
Goal (Ian): get the app as close to deployment as possible. It is NOT launched.
First job: finish T-337 per §3 above: screen-test S1/S5 in both themes, audit, full gates, commit.
Messages are short (bible §3.5a). Render before deciding. Ask for the exact command behind any
reported number. Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
-----------------------------------------------------------------------------------------------
