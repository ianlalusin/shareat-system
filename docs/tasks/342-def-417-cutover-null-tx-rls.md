# T-342: DEF-417 (part 1) — cutover and depreciation actions run without an org principal, so RLS hides the admin's own role

**Status:** DONE 2026-09-25 — five cutover actions fixed (runDepreciation excluded, Amendment A1); proven under the RLS-enforcing test role.
**Closes:** DEF-417 part 1 (the refusal). Part 2 (raw ids in user-visible messages) is a separate task, specced from
the auditor's census.
**Model:** Sonnet, both roles. **Migration:** none.

## Root cause (auditor, verified in source 2026-09-25)
1. `apps/erp/src/app/cutover/actions.ts:77` calls `addOpeningFigure(null, actor, …)`.
2. `packages/domain/src/cutover/opening.ts:114-115`: `if (tx) return run(tx); return transaction(run);` — bare
   `transaction` from `@shareat/db`.
3. `packages/db/src/client.ts:83-85`: `transaction()` sets no role, no `app.org_id`, no `app.principal_kind`
   (contrast `withOrgPrincipal`, `packages/db/src/rls/principal.ts:122-124`).
4. `packages/auth/src/authorize.ts:94` → `accessRepo.activeRoleForPerson` (`packages/db/src/repo/access.ts:52-63`) on
   that tx; `person_roles` is RLS `org_column` (`packages/db/src/rls/registry.ts:250`) → zero rows → `:95-99` throws
   "person … has no active role in org …".
Data is fine. It fires wherever `DATABASE_URL`'s login role enforces RLS — i.e. everywhere since the 2026-09-12 role
swap (same family as DEF-337/DEF-416).

**Blast radius — every app call that passes a null tx (census 2026-09-25, `grep -rnE "\((undefined|null), *(actor|ctx)" apps/erp/src`):**
- `apps/erp/src/app/cutover/actions.ts:39` `attestStep`, `:58` `recordOpeningCount`, `:77` `addOpeningFigure`,
  `:96` `removeOpeningFigure`, `:113` `postOpeningBalances`
- `apps/erp/src/app/fixed-assets/actions.ts:147` `runDepreciation`

## Fix (BUILDER)
Follow the established app pattern (e.g. `apps/erp/src/app/admin/access-defaults/actions.ts:93`): each of the six
actions opens `withOrgPrincipal(actor.orgId, async (tx) => domainFn(tx, actor, …))` and passes the tx. Keep
`recordingRefusalsFor(actor.orgId, …)` wrapping exactly as today (it must still record refusals). Do NOT change the
domain functions' `tx | null` signatures in this task (scheduler/scripts may rely on the null branch — out of scope,
see DEF-416).
**BUILDER paths:** `apps/erp/src/app/cutover/actions.ts`, `apps/erp/src/app/fixed-assets/actions.ts`.

## Tests (TESTER first; raw red)
**TESTER paths:** `apps/erp/tests/t342-no-null-tx-from-actions.test.ts` (new),
`packages/domain/tests/integration/t342-cutover-under-rls.test.ts` (new).
1. **Guard (unit, source census):** scan every `apps/erp/src/**/actions.ts` (and any `'use server'` file) for a domain
   call whose first argument is literally `null` or `undefined` followed by `actor`/`ctx`. Expect ZERO. Red today:
   lists the six sites above. Negative half: the scanner finds a planted fixture string (prove it can see a hit).
2. **Integration under an RLS-enforcing role** (the `packages/db/tests/integration/restricted-role.test.ts` technique —
   connect as the non-bypass role): an org admin can `addOpeningFigure` and `attestStep` when the call is wrapped in
   `withOrgPrincipal(orgId, tx => …(tx, actor, …))`. ⛔ Negative half: the same call through the bare null-tx branch
   (`addOpeningFigure(null, actor, …)`) under the restricted role rejects with `/has no active role/` — this proves the
   test really runs under RLS (if it resolves, the test is not exercising the enforcing role and must say so).
   Use the tester's lane DB.
3. **S1 (tester, http://localhost:9008):** signed in (forged session) as the smoke org's admin, `/cutover/opening`:
   add one opening figure → it saves, no "no active role" banner; remove it → removed. Only valid if the server's
   `DATABASE_URL` role is RLS-enforcing — the tester states which role the server uses (`select rolbypassrls from
   pg_roles where rolname = current_user` via the lane runner against the same DB URL). If the local server role
   bypasses RLS, S1 cannot reproduce the bug and says so.

## Invariants
- Every app write runs under a principal-bound transaction (bible §15.11 tenancy layering; RLS is the second wall,
  never bypassed by the app role).
- Refusals are still recorded (`recordingRefusalsFor` unchanged).
- No domain signature change; no migration.

## Out of scope
- The raw-id wording of the refusal (DEF-417 part 2, separate task).
- Scripts/scheduler/ETL null-tx paths (DEF-416).

## Done when
Guard red→green (0 sites); integration red→green with its negative half; S1 reported with the role check; typecheck,
unit, full integration green; build green with 9008 stopped. One commit; DEF-417 part 1 stamped.

## Amendment A1 (2026-09-25) — `runDepreciation` is OUT, and must be reverted
The T-342 tester found `apps/erp/src/app/fixed-assets/actions.ts:147` passing null is DELIBERATE, not DEF-417-shaped:
`fixed-assets/actions.ts:132-134` and `packages/domain/src/fixed-assets/depreciate.ts:251-253` — one transaction PER
ASSET so one bad asset does not roll back the rest; `depreciate.ts:282` `if (tx) throw err; // Atomic mode`. The null
branch already opens `withOrgPrincipal`/`authorize` per asset (DEF-287, `depreciate.ts:206-209,264`). Wrapping it in
one `withOrgPrincipal` turned it ATOMIC — a regression. **Builder reverts `fixed-assets/actions.ts` to HEAD.** The
guard test allowlists `fixed-assets/actions.ts runDepreciation` with this reason; the T-261 census
(`withorgprincipal-chokepoint.test.ts`) keeps runDepreciation and drops the five cutover sites (genuinely fixed).
Blast radius is the five cutover actions only. Lesson: a null tx is not always the bug — read why the null branch exists.
