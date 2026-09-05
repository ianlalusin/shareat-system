# Handoff — 2026-09-05

## Where things stand

The shell sprint the v2 completion blueprint called out as the fastest-available win is
done: **T-211** (manager/owner dashboard at `/`) and **T-217** (404/error boundaries +
sign-in PIN issuance, closing DEF-174) shipped this session, alongside **T-212**
(commissary/inventory KPIs, `ianla-25`) landing three more tiles on that same dashboard.
All three are committed and pushed. `ianla-25` is now mid-flight on **T-218** (findings
clock correctness + a receiving-dispute detector — the DEF-172/DEF-176 follow-ups) in
this same shared tree; check `ListAgents` before touching `packages/db/src/repo/findings.ts`.

## Gates at `b7c1eb7`

- **typecheck**: clean
- **unit**: 1012 passed / 1 skipped / 1 known-red (1014) — the pre-existing DEF-170
  golden-master residual, tracked, not a regression
- **integration**: **2327/2327, 92/92 files, 0 failures** — run against the shared
  `shareat_test` DB, ~20 min under this machine's current load. (`ianla-25`'s own run,
  same code, against their isolated `shareat_test_lane25`, got 2326/2327 — the one
  difference is DEF-178, a real-clock flake in `lane-health.test.ts` that passes 21/21
  alone; not seen in this run, consistent with it being a timing flake, not a regression.)
- **build**: exit 0 (Next.js 16.3.2/Turbopack, 6.5s compile + 20.8s typecheck, 11 static
  pages) — run once by `ianla-25` covering both sessions' work rather than building the
  shared tree twice; dev server on 9008 confirmed stopped first.
- **smoketested live on 9008**: dashboard tiles render real figures (balance sheet ties
  at ₱29,328.00); an unknown route returns a real HTTP 404; a staff role hitting
  `/reports/trial-balance` renders the custom error page (HTTP 500, digest shown), not
  Next's default chrome; a fresh hire shows "no PIN issued," issuing one persists and
  signs in from a clean browser context; `ianla-25`'s three T-212 tiles render correctly,
  including a real ₱700 short-receipt gap v1's own method would have silently absorbed.

## What happened this session (since the last wrap-up, `d612b95`)

**T-211 — the manager/owner dashboard.** Root `/` was the unmodified Phase 0 scaffold
since T-183; it's now nine live-query KPI tiles (sales/expenses/net income, balance
sheet ties, AR/AP outstanding, active staff, open cash-request floats, findings needing
attention, low stock) plus a sales-by-channel table. Every figure calls the same named
query function its own report page already calls — no second definition, no
`FieldValue.increment`-shaped cache (bible §4.2 rule 7). **Found in passing, not a
bug**: the combined "Expenses" tile can render negative over a short range when a
commissary→branch cost transfer dominates — matches the income statement byte-for-byte;
flagged for Ian in `docs/tasks/211-manager-owner-dashboard.md` in case four tiles read
better than three.

**T-217 — shell hardening + PIN issuance, closing DEF-174.** `not-found.tsx` /
`error.tsx` / `global-error.tsx` replace Next's default chrome (Next 16.3's recovery
callback is `retry`, not the older `reset` — confirmed against the bundled docs before
writing). Closed **DEF-174**: `setPin` had zero callers anywhere in `apps/erp`, despite
being fully built and tested — a hired staff member had no path to ever receive a
sign-in PIN. New `sessionsRepo.listLiveForPerson` (+3 integration tests) backs a
"Sign-in PIN" section on `/staff/[employmentId]`; the issue/re-issue action gates on
`enrol_staff` since `setPin` itself has no `authorize()` call of its own. Live-verified
the full round trip: hire → not-issued state → issue → persists across reload → sign in
from a cookie-free browser context → lands signed in. **Found DEF-177 in passing**:
`setPin` leaks a raw Postgres "duplicate key" error when a person's own current PIN is
re-submitted; mapped to a friendly message at the calling action without touching
`setPin` itself (flagged for whoever next changes it).

**T-212 — commissary and inventory KPIs (`ianla-25`).** Three more dashboard tiles: in-
flight orders, open disputes (oldest age + value at cost — DEF-175 found and fixed a
schema doc-comment that had the wrong basis, transfer rate instead of cost), and goods
received this range, stating what v1's method would have silently missed (a real ₱700
gap between dispatched and received on seeded data — external franchisee sales were
being read as 100% short-received before a `counterparty_store_id` scoping fix, DEF-176
recorded separately: a detector the phase-6 plan assigned to T-213 that T-213 never
built).

**Roadmap refreshed twice** — `docs/ROADMAP.html`'s T-211 and T-212 rows both marked
done with real scope; Phase 6's status chips and the masthead gate line updated to the
final numbers above. The **v2 completion blueprint artifact**
(`https://claude.ai/code/artifact/d60fb51d-199c-43ff-a896-5f20a1402d69`) and its repo
copy (`docs/plans/v2-completion-blueprint-2026-09-05.md`) were both updated to mark the
shell sprint done throughout, rather than left describing a gap that no longer exists.

⚠️ **Shared-tree note, not a defect**: `ianla-25`'s DEF-175/DEF-176 register rows landed
inside this session's `3e0089f` commit — they were written to `DEFECTS-REGISTER.md`
between this session's `git add` and `git commit`, and `git add <path>` stages the
whole file. No content was lost and both rows are correctly attributed in `ianla-25`'s
own commit message (`f6350bd`), but if you read `3e0089f`'s diff cold and wonder why a
T-211/T-217 commit carries two T-212 defect rows, that's why — the same hazard
`project_shareat_system_concurrent_sessions` already documents.

## Pick up here

1. **⭐ Phase 7's user/role management screen — the single largest remaining "built but
   no caller" gap, same shape T-217 just closed for PIN issuance.** Confirmed this
   session:
   - `assignRole` / `elevateManager` (`packages/auth/src/roles.ts`, exported via
     `packages/auth/src/index.ts`) are fully built, with real invariants already
     implemented (revoke-then-insert on a role change; the admin-less-org elevated-grant
     fallback for a newly appointed manager, computed from `CAPABILITY_MATRIX`, never
     hand-listed).
   - `accessRepo` (`packages/db/src/repo/access.ts`) already has every read/write a
     screen would need: `activeRoleForPerson`, `hasActiveAdmin`, `grantStoreScope` /
     `revokeStoreScope` / `storeIdsForPerson`, `grantCapability` / `revokeGrantById` /
     `grantsForPerson`.
   - **Zero callers anywhere in `apps/erp/src`** — confirmed by grep, same check this
     session ran for `setPin` before finding DEF-174. No `/admin/users` or `/stores`
     route exists at all.
   - ⚠️ **Scope split worth confirming before starting**: user/role assignment
     (`assignRole` etc.) is fully primed and ready for a screen today. **Store
     creation/management is a different, larger question** — no `createStore`-shaped
     function was found anywhere in this pass; `packages/db/src/repo/stores.ts` only has
     cash-policy helpers. The blueprint bundles "admin/users, admin/stores" as one Phase
     7 item; the next session should verify whether store creation needs its own design
     pass before committing to both in one task, or ship user/role management alone
     first.
   - No `docs/tasks/` spec exists yet for this — per `docs/RULES.md` rule 8 ("no
     implementation without a written task spec"), write one first, same shape as
     `docs/tasks/217-shell-hardening-and-pin-issuance.md`.
2. **T-218 (`ianla-25`, in flight)** — findings clock correctness + a receiving-dispute
   detector, addressing DEF-172 (four detectors compare against bare `current_date`
   instead of `Asia/Manila`) and DEF-176 (`receivingDisputeOverdue` was assigned to
   T-213 by the phase plan and never built). Check `ListAgents` before touching
   `packages/db/src/repo/findings.ts` or its tests.
3. **DEF-170's 3 residual golden-master items** — low urgency, still needs an owner
   (whoever holds the attendance lane), unchanged from prior handoffs.

## Do not decide these alone — they are Ian's

- **Should the dashboard's "Expenses" tile split into Cost of sales / Operating
  expenses (four tiles instead of three)?** Found live-testing T-211 — the combined
  figure is correct but can read as a confusing negative when a commissary transfer
  dominates a short range. `docs/tasks/211-manager-owner-dashboard.md`'s Open Questions.
- **Should `/sign-in`'s default post-login redirect move from `/sales-days` to `/`
  now that `/` is a real dashboard?** Only sound for roles that pass
  `view_financial_reports` — staff would still need a different default. Deliberately
  not decided inside T-211.
- **Should PIN issuance require a capability distinct from viewing the staff roster?**
  T-217 reused `enrol_staff` (the existing hire capability) rather than inventing one
  unilaterally — flagged for Ian/Opus per `CAPABILITY-MATRIX.md`'s own process.
- **DEF-063 (PIN sign-in rate limiting)** — deferred 2026-08-25 pending real staff/real
  data; both conditions are now true (production live since T-205, pilot running).
  Recommendation on the table: reactivate now.
- **SC/PWD discount ID/name capture and BIR 1601-E withholding tax** — both live
  compliance exposures, neither v1 nor v2 handles either today. Unchanged from prior
  handoffs.
- **Service-charge distribution (T-187)** — do not enable service charge in POS before
  it exists (DEF-082, unchanged).

## Traps that have actually bitten

- **This repo is a shared tree, active today.** `ListAgents` before starting anything;
  never run `build`/`test:integration` beside a busy peer without checking first (one
  shared `shareat_test` DB) — a **per-lane test DB** (`shareat_test_lane25`, already
  migrated, left in place by `ianla-25`) is available and works well for exactly this;
  drop it when nobody needs it. Stage explicit paths, never `git add -A` — and even
  explicit paths can sweep in a peer's concurrent edit to the same file (see the
  DEF-175/176-in-`3e0089f` note above); say so plainly if it happens rather than
  quietly re-editing history.
- **Next.js 16.3's error-boundary recovery callback is `retry`, not `reset`** (stable
  as of 16.3.0) — confirmed against `node_modules/next/dist/docs/.../error.md`'s own
  version table before writing `error.tsx`/`global-error.tsx`. Worth checking the
  bundled docs for any other file-convention component before assuming prior training
  data still describes this version.
- **`setPin` (`packages/auth/src/sessions.ts`) has no `authorize()` call of its own** —
  unlike `enrolCard`/`enrolFingerprint`, which do. Any new caller needs to add its own
  gate, not assume one exists. It also has the DEF-177 same-PIN-resubmit rough edge
  (mapped to a friendly message in `staff/actions.ts`, not fixed at the source).
- **`current_date` vs `(now() at time zone 'Asia/Manila')::date`** — bare `current_date`
  follows the session timezone, wrong on a UTC server for any business-date comparison
  (migration `0112`'s own comment; DEF-172, being fixed now in T-218).
- **`trade_discrepancies.value` is written AT COST, not at the transfer rate** — a
  schema doc comment said otherwise until DEF-175 fixed it today; read the code
  (`packages/domain/src/commissary/transfer.ts`), not just the comment, before writing
  arithmetic against that column.

## The paste-ready prompt

```
Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md, then
docs/RULES.md if you haven't this session. Pick up Phase 7's user/role
management screen — assignRole/elevateManager (packages/auth/src/roles.ts)
and accessRepo (packages/db/src/repo/access.ts) are fully built and tested
with zero UI callers anywhere, same "done but uncalled" shape DEF-174 was.
Write a docs/tasks/ spec first (RULES.md rule 8) before implementing, and
confirm with Ian whether store creation/management is in scope for the same
task or a separate one — no backing function for creating a store was found
this pass. Check ListAgents first: ianla-25 may still be on T-218
(packages/db/src/repo/findings.ts) in this same shared tree.
```
