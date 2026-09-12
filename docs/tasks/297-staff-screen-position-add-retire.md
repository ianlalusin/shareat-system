# T-297 — a store's own positions are added and retired from the staff screen, by an admin only

> **Status: SPEC WRITTEN by the planner (Fable, Ian typing directly), 2026-09-12 — approved shape,
> NOT built.** Ian's ruling, verbatim: *"yes i want also in staff screen gated to admin only. only
> admin can add retire a position."* Written at wrap-up time so the thinking survives the ritual;
> the build is the first slice of the next cycle. Build is Sonnet-able; no plan-mode spec is owed
> beyond this file.

## What Ian asked, and what already exists

- **Adding** a store position from the staff screen **already exists**: `apps/erp/src/app/staff/page.tsx:142-154` renders an *"Add a position"* form posting to `upsertStorePositionAction` (`apps/erp/src/app/staff/actions.ts:213-224`), which calls `upsertStorePosition` (`packages/domain/src/people/index.ts:213`). ⛔ **Its gate is `manage_store_settings`**, which is `manager: true` in the matrix (`packages/auth/src/capabilities.ts:724`). So today a manager can add a position. **That is what Ian's ruling changes.**
- **Retiring** a store position exists only on `/admin/access-defaults` (T-290): `retireStorePosition` (`packages/domain/src/people/position-defaults.ts`) gated on `grant_capability` (`admin: true, manager: false`, `:715`). It revokes the position's default rows, reconciles every holder, and sets `positions.is_active = false`. **Ian wants the same control on the staff screen.**
- The staff page establishes the actor with `requireSession('/staff')` (`page.tsx:24`), not `requirePageAccess` — `/staff` is not in `ROUTE_CAPABILITY` and must stay reachable by managers (rosters, hiring). Only the two position controls are admin-only.

## The gate — one capability for both verbs, and it already exists

**`manage_stores`** — `{ super_admin: true, admin: true, manager: false, staff: false }`
(`capabilities.ts:714`), org-scoped. A store's own position vocabulary is part of the store's
structure, which is what `manage_stores` already governs; T-154's rule — *it fits, so do not add
one* — applies. Both `upsertStorePosition` and `retireStorePosition` move onto it, so "add" and
"retire" are one decision with one word, and the screen can ask one question to decide what to
render.

⚠️ **"Admin only" means admin, super-admin, AND a manager in an organisation that has no
administrator** (bible rows 115, 196): `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` is derived as
admin-yes / manager-no, so `manage_stores` is already in it and an adminless org's manager can add
and retire positions. That is intended and is not a leak; it ends the moment an administrator
arrives (row 188). If Ian wants the adminless manager excluded too, that is a different and harder
question (a carve-out in a derived set, which row 196 says is what drifts) — **stop and put it to
him rather than derive it.**

⛔ **Why not leave retire on `grant_capability`:** retiring is a store-structure act that happens to
narrow access; the access narrowing is already justified by *"nothing anyone deletes may widen"*
(row 115). Gating it on the grants word would let a `grant_capability` holder who is not allowed to
touch store structure retire a position, and would make the two verbs answer to two words.

## Files this task may touch

1. `packages/domain/src/people/index.ts` — `upsertStorePosition`: `manage_store_settings` → `manage_stores`; its doc comment names T-297 and the reason.
2. `packages/domain/src/people/position-defaults.ts` — `retireStorePosition`: `grant_capability` → `manage_stores`; doc comment likewise. Nothing else in that file.
3. `apps/erp/src/app/staff/lib.ts` — one read: `canManagePositions(actor): Promise<boolean>` = `heldCapabilities(tx, actor).has('manage_stores')` under `withOrgPrincipal` (`heldCapabilities` is `packages/auth/src/authorize.ts:179`, T-288, exported from `@shareat/auth`).
4. `apps/erp/src/app/staff/actions.ts` — `retireStorePositionAction(formData)` in the shape of `upsertStorePositionAction` (`:213-224`): `requireActor('/staff')`, `withOrgPrincipal`, call the domain, `backToRoster` with `ok`/`error`. ⛔ Thin adapter; no `authorize()` composed here — the domain owns the gate (DEF-223's rule, this file's own header `:8`).
5. `apps/erp/src/app/staff/page.tsx` — the *"This store's positions"* section (`:125-155`): each non-canonical chip gains a **Retire** control; the *"Add a position"* form and every Retire control render **only when `canManagePositions` is true**; when it is false the section shows the list and one line: *"Only an administrator can add or retire a position."*
6. `apps/erp/tests/staff-lib.test.ts` — **only if** a pure decision is extracted worth pinning (the render predicate is a boolean from one read; a test that mocks the read proves nothing — prefer none, and say so).
7. `packages/domain/tests/integration/employment.test.ts` — `upsertStorePosition`'s existing cases (`:272-280`) keep passing as admin; **add** `it('a manager may not add a store position — manage_stores denied')`.
8. `packages/domain/tests/integration/position-defaults.test.ts` — the retire cases (`:360-380`) keep passing as admin; **add** `it('a manager may not retire a store position — manage_stores denied')` and **change** the denial in §T-int 11 from *no `grant_capability`* to *no `manage_stores`* for the retire path only (the toggle path keeps `grant_capability`).
9. `docs/decisions/CAPABILITY-MATRIX.md` — one sentence in §E: *"Adding or retiring a store's own position is `manage_stores` (T-297); retiring also revokes the position's defaults, which narrows only."*
10. `docs/tasks/297-staff-screen-position-add-retire.md` — this file.

⛔ **Not in the list:** `packages/auth/src/authorize.ts`, `packages/auth/src/capabilities.ts` (no new capability, no cell change — `manage_stores`'s cells are already what Ian asked for), `apps/erp/src/app/admin/access-defaults/**` (T-290's retire control stays and keeps working, now under the same word), `apps/erp/src/lib/route-capability.ts` (`/staff` is not page-gated and must not become so).

## Contract

1. `upsertStorePosition` and `retireStorePosition` both `authorize(tx, actor, 'manage_stores', {})` as their first statement. A manager in an org with an active administrator is refused with the existing `AuthorizationError` sentence; the action maps it to *"Only an administrator can add or retire a position."*
2. Retire from the staff screen behaves exactly as from `/admin/access-defaults`: canonical positions refused with the existing message; the position's active default rows revoked with reason `"Position retired"`; every open-employment holder reconciled; `is_active = false`; the chip disappears from the list on redirect. ⛔ **No second implementation** — one domain function, two callers.
3. **Presentation follows the gate but is not the gate** (DEF-051, bible row 199): the controls are hidden from a non-holder AND the server refuses a crafted POST. The smoketest proves both halves — the hidden control and the refused URL — because the hidden half alone is the checkbox-not-a-control failure this project has shipped before.
4. A retired position's historical employments still reference it (T-154: retire, never delete); the roster's position column keeps showing it for people who held it, and the hire/edit position pickers (which read `listPositions`, already `is_active = true` only) stop offering it.
5. The banner after retire reads *"Position retired. Its defaults were revoked and every holder reconciled."* — the same sentence T-290 uses, because it is the same act.

## Invariants

1. ⛔ `authorize.ts` and `capabilities.ts` untouched; `tests/unit/capability-matrix.test.ts` row count stays 96.
2. ⛔ One capability for both verbs. If review wants add and retire on different words, that is a matrix decision for Ian, not a spec tweak.
3. ⛔ `/staff` stays manager-reachable. Only the two controls are admin-only.
4. ⚠️ The T-290 screen's Retire control is **not** edited; it inherits the gate change through the domain and its own integration case must stay green under the new word.
5. ⚠️ Touch targets: the new Retire control is a real button clearing the 24px floor from the first draft (DEF-322 — three new pages introduced sub-24px controls in one day; do not be the fourth). Baseline file untouched.

## Tests — write first, watch the right one fail

- Integration (lane DB via `it.mjs shareat_test_lanec`, never `test:integration`): the two new manager denials above go red first for the right reason (they pass today because the manager holds `manage_store_settings` / because retire checks `grant_capability`), then green after the gate change; the existing admin cases stay green.
- Unit: none new unless a pure decision appears (file 6).
- Smoketest on 9008, **port coordination with system32-85 first, enumerated free**: (1) as Dev Admin, `/staff?store=<Lipa>` shows the add form and a Retire button on the store-invented position; add "Barista", see it in the list and in the hire picker; retire it, see the banner and the chip gone, and `positions.is_active = false` in the DB; (2) as Dev Manager, the section shows the list and *"Only an administrator can add or retire a position."* with no form and no Retire; a crafted POST to `retireStorePositionAction` is refused with the sentence; (3) 390px and 1280px screenshots.

## Out of scope

- Renaming or un-retiring a position (T-154: canonical are immutable; a retired store position stays retired — un-retire is a new decision).
- Excluding the adminless-org manager (row 196 — Ian's call, see above).
- Any change to `/admin/access-defaults`.
- Position history on `employment_positions`.

## Definition of done

typecheck clean · unit suite no new failures beyond the shared-tree photograph · the two new integration denials red-then-green on `shareat_test_lanec` and every existing `employment.test.ts` / `position-defaults.test.ts` case green · smoketest as above with both halves of contract 3 proven · self-reviewed · committed by explicit paths after a line-by-line foreign-hunk check of every shared file · report ends with a `FOR IAN` block.

See `docs/plans/289-position-access-defaults-plan.md` §4.2 (retire), `docs/tasks/154-positions-and-employments.md` (the taxonomy), `docs/tasks/290-access-defaults-screen.md` (the other caller), bible rows 115, 188, 196, 198, 199.
