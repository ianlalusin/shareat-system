# Handoff — 2026-09-05

## Where things stand

Production has been live at erp2.shareat.net since 2026-09-04. Phases 0–4 are done, Phase 3
(inventory, 20/20) shipped this week, Phase 5 (payroll) is 16/18 with the last two gated on real
HR data, and Phase 6 (reporting) has only T-209a shipped with T-209b (AR/AP aging) in flight right
now under a concurrent session. This session did no application code — it audited v2's current
state end-to-end, tried the running app live, ran a scoped real-data pull, and wrote the completion
blueprint Ian asked for.

## Gates at 892889d

**Not run this pass — deliberately, not an oversight.** This session's own changes are four
documentation files (no `.ts`/`.tsx` touched), which cannot affect typecheck/test/build. A
concurrent session (`ianla-15`, T-209b) has substantial uncommitted code in the shared tree right
now — new AR/AP aging report pages, domain modules, and integration tests, plus edits to
`nav.tsx`, `packages/db/src/repo/{ap,ar}.ts`, and `packages/domain/src/index.ts`. Running
`test:integration` or `build` against that mixed, in-progress state would test neither session's
work cleanly and risks colliding with theirs mid-edit (`docs/RULES.md` §3.4 row 94). **Last known-
good gates are DEF-080/081's own close, same day: typecheck clean · unit 1013/1014 (1 pre-existing
skip) · integration 83 files / 2258 tests · build exit 0.**

## What happened this session

**Ian asked for a plan to finish v2 as fast and as completely as possible** — explicitly separate
from `ROADMAP.html` — covering shell/auth completeness (signup, login, pending, 404) and every
viable v1 page, regrouped. Delivered as `docs/plans/v2-completion-blueprint-2026-09-05.md` (also
published as an artifact for Ian to read outside the terminal). **Status: Sonnet-drafted, flagged
for an Opus review pass before being treated as bible-equivalent** (`docs/RULES.md` §3.1a — planning
docs are normally an Opus job).

**Four decisions Ian made this session, and where each is now recorded:**

| Decision | Recorded in |
|---|---|
| No self-service signup, ever, for anyone — the admin-driven hire flow is final | Blueprint §5/§11. **Not yet in the bible** — needs an Opus-planner row per §14 |
| `manager/budgets` is in scope | Turned out to already be **T-215** (Phase 6) — not a new decision so much as a correction; `docs/CAPABILITY-GAPS.md` fixed in place rather than double-counted |
| Onboarding is in scope, **redesigned**: one linear, strictly-gated track (one step visible at a time, `current_step_index` per staff member) replacing v1's five-kind library + versioning + proposal pipeline + open-ended grading | Blueprint §6, `docs/CAPABILITY-GAPS.md` (gap count 38→39) |
| Ran the count-only ETL re-capture Ian approved | `docs/plans/v2-completion-blueprint-2026-09-05.md` §8 |

**Live audit found three new, previously-unlogged defects** (`docs/DEFECTS-REGISTER.md` section E):
**DEF-167** (`manage_users`/`enrol_staff`/`grant_capability` fully authorized and tested, zero
screen anywhere — the highest-value Phase 7 item, since every primitive it needs already exists),
**DEF-168** (no custom `not-found.tsx`/`error.tsx` anywhere — small, independent, high visual
payoff), **DEF-169** (`packages/db/schema/audit-log.ts` has zero writers *and* zero readers, not
just no viewer).

**Ran a scoped, count-only `npm run capture`** across the 4 real operating stores (Lipa, Malvar,
Banay-Banay, Davao) for 13 collections never pulled before (attendance, inventory, payroll) —
**10,916 documents counted, zero read.** Concretely useful: this unblocks
`tests/golden/attendance-adjudication.test.ts` (T-157), which has been sitting skipped in the repo
with the comment *"needs Ian"* — that data is now counted and ready to fetch.

**`docs/ROADMAP.html` updated**: Phase 7's one-line stub now points at the blueprint's proposed
scope and the two new shell defects.

**Coordinated with a concurrent session** (`ianla-15`, starting T-209b mid-session) — confirmed no
collision before running anything, stopped my own dev server on 9008 when they needed it, and
staged only the four files this session actually touched (`git status` reviewed, nothing of
theirs picked up).

## Pick up here

1. **Approve or hold the ETL `--fetch`** on the 52 already-counted targets (blueprint §8,
   §11 Unresolved #1) — small, scoped, but lands real PII permanently, so it's the one thing this
   session deliberately did not do unilaterally.
2. **Shell sprint** (blueprint §9, week 1): dashboard (T-211), DEF-168 (404/error pages), a
   "credential not yet issued" state for a hired-but-not-PIN'd staff member. All small, independent,
   no dependency on anything else.
3. **DEF-167** (user/role management screen) — needs a task spec in `docs/tasks/` before anyone
   builds it (bible §2.7); every primitive it needs (`assignRole`, the capability matrix) is already
   built and tested.
4. Route the whole blueprint through an **Opus planner review pass** before any of its Phase 7
   proposal or its four decisions get written into the bible.

## Do not decide these alone — they are Ian's

- SC/PWD discount ID/name capture and BIR 1601-E withholding tax — both live compliance exposures,
  both still need a yes/no (blueprint §7 items 3, unchanged from before this session).
- Service-charge distribution (T-187) — do not enable service charge in POS before it exists
  (DEF-082, unchanged).
- PIN sign-in rate limiting (DEF-063) — previously deferred by Ian; worth a second look now that
  the pilot is live with real staff.

## Traps that have actually bitten

- **The working tree is shared, live, right now.** `ianla-15` has uncommitted T-209b work in it as
  of this handoff — check `git status` and `ListAgents` before touching `nav.tsx`,
  `packages/db/src/repo/{ap,ar}.ts`, `packages/domain/src/index.ts`, or the new `reports/ap-aging`/
  `ar-aging` files, and before running `build` or `test:integration`.
- `HANDOFF.md` (not this file) is ~10 days stale and materially understates progress — trust
  `ROADMAP.html`, not it.
- `etl_source_documents` now (potentially, pending the `--fetch` decision) holds real PII the
  moment anyone runs `--fetch` — never export it, never copy it into a shared report or fixture
  (`secrets/README.md`).

## The paste-ready prompt

```
Read docs/HANDOFF-TODAY.md, then docs/plans/v2-completion-blueprint-2026-09-05.md in full.
Check ListAgents and git status before touching anything — the tree may still have another
session's in-flight work in it.

Start with whichever of these Ian has greenlit: (1) the ETL --fetch on the already-counted
52 targets, (2) the shell sprint (dashboard T-211, DEF-168's 404/error pages), or (3) a task
spec for DEF-167 (user/role management screen). If none are greenlit yet, that's the first
thing to ask him.
```
