# T-341: DEF-414 — a position grant authorises only at the store whose default produced it

**Status:** DONE 2026-09-25 — built per spec + Amendments R1–R3 (three audit rounds + independent code-reviewer). Full integration 153 files / 3088 passed; §9.4 smoketested on 9008 (forged session; screens only). Migration `0159`.
**Closes:** DEF-414 (`docs/DEFECTS-REGISTER.md:621`) and a same-root sibling found by the planner (§2.2; the
orchestrator registers it).
**Model:** Sonnet, both roles. TESTER writes first and records red; BUILDER second; paths disjoint (§6).

---

## 1. Goal (bible §1.2d)
1. **v1 at source.** Authority came from a position held **at that store**: `gateBranchActor` resolves positions
   per store (`resolveLocalPositions(branchStoreId, …)`, ERP-rebuild `src/lib/financial/commissary/order-helpers.ts:244`,
   `:265`); a v1 local user belongs to one store (`src/types/local-user.ts:3`). A Cook at A / Cashier at B was a
   cashier only at B.
2. **Goal:** a job at one store grants that job's access at that store, and nowhere else.
3. **v2 today.** Defaults are per (position, **store**) (`packages/db/schema/position-capability-defaults.ts`), but
   the `person_grants` row they produce has no store (`packages/db/schema/access.ts:146`); the active-row unique
   index is (person, grant_name) (`access.ts:202`); `authorize()` accepts any active grant
   (`packages/auth/src/authorize.ts:104-105`); axis 2 only checks that *some* scope row exists at the target store (`:108-122`).
4. **v2 bar.** A store-scoped capability from a position is honoured only at the store whose default justified it.
   Every access justified today is preserved (bible row 211). No self-grant (bible §7 rule 5). Grants still written
   on job change, never derived at check time (bible row 115).

## 2. Evidence still open (static read, 2026-09-25)
### 2.1 DEF-414 — the leak
Hired Cashier at B and Cook at A. `createEmployment` scopes both stores (T-336, `packages/domain/src/people/index.ts:143-155`).
`reconcilePositionGrants` at B writes `record_sale` with no store. `authorize(record_sale, {storeId: A})`: axis 3b
`personHasActiveGrant(person, 'record_sale')` true (`packages/db/src/repo/access.ts:674`); axis 2 scope at A exists →
**the Cook rings sales at A.**

### 2.2 Sibling — wrongful revocation (not in the register; same root)
Cashier at A and B, `record_sale` on at both. Hire at A first (ref → A's default). `createEmployment` at B calls
`grantCapability` rank `position` over stored `position`: equal ranks, row not rewritten, ref stays A
(`access.ts:586-600`; `position-defaults.ts:263-282`). `endEmployment` at A reconciles at A (`people/index.ts:253`);
`heldPositionGrantsForPersonAtStore(A)` finds the row (`packages/db/src/repo/position-defaults.ts:204-229`) and
**revokes it** → still a Cashier at B, can no longer ring a sale there. T-289 cases 7/8 miss it (different
capability per store, `packages/domain/tests/integration/position-defaults.test.ts:300-357`).

## 3. Technical choice (planner), and the production heads-up
Register options: (1) a store dimension on position-sourced grants; (2) an axis-2 check that the grant's source
position is held at the target store.
- Option 2 via stored `source_ref`: refuses the §2.2 person at one of two Cashier stores (one active row per
  person/capability) and keeps §2.2's revocation.
- Option 2 via live derivation: breaks bible row 115 and the self-grant refusal (reconcile skips the actor's own rows,
  `position-defaults.ts:215-219`).
- **Option 1 chosen**: keeps both rulings, fixes §2.1 and §2.2 together.

⚠️ **Heads-up (production behaviour):** a staff member an admin scoped BY HAND to a store where they have no
employment (e.g. cover at another branch) loses their position's everyday capabilities at that store. That is
DEF-414's intent and v1's behaviour; the remedy is recording an employment at the second store. §8's read-only
cutover count measures how many people this affects.

## 4. Design
### 4.1 Migration `<slot>_t341_person_grants_store.sql`, hand-authored (ADR-012 §5; `packages/db/migrations/README.md`)
In order:
1. `ALTER TABLE person_grants ADD COLUMN store_id uuid REFERENCES stores(id) ON DELETE RESTRICT;` + index.
2. `ALTER TABLE position_capability_defaults ADD CONSTRAINT position_capability_defaults_id_store_unique UNIQUE (id, store_id);`
3. Backfill: `UPDATE person_grants g SET store_id = d.store_id FROM position_capability_defaults d WHERE g.grant_source = 'position' AND d.id = g.source_ref;` (active and revoked).
4. Drop `person_grants_active_person_grant_unique`; replace with
   `person_grants_active_person_level_unique` (person_id, grant_name) `WHERE revoked_at IS NULL AND store_id IS NULL` and
   `person_grants_active_position_store_unique` (person_id, grant_name, store_id) `WHERE revoked_at IS NULL AND store_id IS NOT NULL`.
5. **Materialise rows the old index suppressed** (only access justified today): insert a `'position'` row for
   (P, C, S) when P has an open employment at S (`ended_on IS NULL`) holding a position with an **active** default at
   S for C, P already holds an **active** `'position'` row for C at a different store, and no active (P, C, S) row
   exists. `source_ref` = lowest-id matching default at S; `granted_by` copied from P's existing active row for C;
   `DISTINCT ON (person, capability, store)`. Header: the only data this migration creates, and why.
6. `CHECK person_grants_store_shape_check`:
   `(grant_source = 'position' AND store_id IS NOT NULL) OR (grant_source IS DISTINCT FROM 'position' AND store_id IS NULL)`.
7. Composite FK `(source_ref, store_id) → position_capability_defaults(id, store_id) ON DELETE RESTRICT` (MATCH SIMPLE:
   a `'grant'` row with a history ref and null store is skipped; its single-column FK still applies).
8. **Fill trigger, not correcting:** `BEFORE INSERT OR UPDATE OF grant_source, source_ref` — if
   `grant_source = 'position'` and `store_id IS NULL`, set it from the default; never overwrite a supplied value
   (mismatch → 23503 via 7; non-position with a store → 23514 via 6). Why: 22 fixture importers
   (`_fixtures/staff-everyday-access.ts`) and raw writers (`t336-auto-staff-role-on-hire.test.ts:100`) insert position
   rows with no store; the DB derives it (RULES §6.3).
Mirror column, indexes, CHECK and FK in `packages/db/schema/access.ts`; the trigger lives in the migration, named in a schema comment.

### 4.2 Repository `packages/db/src/repo/access.ts`
- `GrantRow` gains `storeId: string | null`; `grantsForPerson` selects it.
- `grantCapability` — position arm: find active (person, name, `'position'`, `store_id` = the store of
  `input.sourceRef`'s default, by subquery); return it if present (idempotent; transition 4 unchanged), else insert;
  no rank logic. Non-position arm: only `store_id IS NULL` rows; existing rank upgrade unchanged.
  ⛔ A position call never rewrites a person-level row, and a hand-grant never rewrites a position row: they **coexist**.
- `personHasActiveGrant(tx, personId, grantName, atStoreId?: string)`: with `atStoreId`, match
  `store_id IS NULL OR store_id = atStoreId`; omitted = any active row (today's semantics, org-scoped checks and
  `roles.ts:214`). The three existing callers compile unchanged.

### 4.3 `packages/auth/src/authorize.ts` — axis 3b only
`personHasActiveGrant(tx, actor.personId, capability, scope === 'store' ? ctx.storeId : undefined)`. A store-scoped
call with no `storeId` still hits axis 2's "is store-scoped but no storeId was given" — order and messages unchanged.
Update the header's axis 2/3 paragraphs. `heldCapabilities` NOT changed (deliberately store-agnostic, `:150-165`).

### 4.4 `packages/domain/src/people/position-defaults.ts` — `reconcilePositionGrants`
- `existingActive` (`:263`) = this person's active `'position'` rows **at `input.storeId`**.
- `granted` = no active position row for that capability at this store beforehand.
- Drop the `grantSourceRank` comparison (`:272`, `:280`); keep `GRANT_SOURCE_RANK` (pinned by
  `tests/unit/position-defaults-offerable.test.ts`).
- Steps skip-self / wanted / held / revoke unchanged (`held` already per store via the default's `store_id`).
T-289 §C5 transitions: 1 (position→grant), 2 (grant→position), 3 (elevation→position) now **coexist** instead of
upgrading (elevation still swept when an admin arrives); 4 unchanged. User-visible: org-scoped capabilities
unchanged; store-scoped only the DEF-414 narrowing.

## 5. Tests (TESTER, against current `main`, raw red)
New `packages/domain/tests/integration/t341-position-grants-per-store.test.ts` — copy `asOrg`/`fixture`/`hireStaff`/
`setDefault` from `position-defaults.test.ts:54-163`; set every default via `setPositionDefault`; every decision via
real `authorize()`; never hand-insert a grant.

| # | Case | Assertion (positive / ⛔ NEGATIVE) | Expected red |
|---|---|---|---|
| P1 | DEF-414: Cashier default `record_sale` at B, Cook default `record_wastage` at A; hire P Cashier at B, then Cook at A | `record_sale@B` resolves. ⛔ `record_sale@A` rejects `AuthorizationError` `/may not 'record_sale'/` (not `/no store scope/`). Control: `record_wastage@A` resolves | `promise resolved "undefined" instead of rejecting` |
| P2 | §2.2: `record_sale` on at A and B; hire P Cashier at A then B; manual scope at A (`accessRepo.grantStoreScope`, `source:'manual'`); end A employment | `record_sale@B` resolves. ⛔ `@A` rejects `/may not 'record_sale'/` (scope survives, so the refusal is the grant's store) | `AuthorizationError: … may not 'record_sale'` on the B assertion |
| P3 | Cashier at A and B, `record_sale` on at both | active `'position'` rows for `record_sale` sorted by store `toEqual [A, B]`; each row's store = its `source_ref` default's store. ⛔ no active null-store row for P | array length 1 (assert via the `source_ref` join until the column exists) |
| P4 | P3 then `setPositionDefault(Cashier, A, record_sale, off)` | B resolves. ⛔ A rejects `/may not/`; P keeps scope at A | red on one store — record which |
| P5 | guard: Cook at A with scope A+B gets `grantCapabilityAsActor(record_sale)` | resolves at A and B. ⛔ after `revokeGrantById`, A rejects `/may not/` | none — record green |
| P6 | guard: Cashier default `manage_items` at B; P Cashier at B | `authorize(manage_items,{})` resolves. ⛔ a Cook-only person at A without it rejects `/may not 'manage_items'/` | none |
| P7 | guard (matrix invariant 6): Cashier at B with `record_sale`; `accessRepo.revokeStoreScope` at B | ⛔ rejects `/no store scope/` | none |
| P8 | self-skip: admin gives themselves a Cashier employment at A with `record_sale` on | admin gains no `'position'` row (assert rows). ⛔ another hire in the same path does | none |

Amend `packages/domain/tests/integration/position-defaults.test.ts`:
- Case 3 (`:205-232`): after the hand-grant, two active rows — the original `'position'` (same id) and a new `'grant'`
  (null store). After toggle-off the position row is revoked, the grant row survives, `adjust_inventory@A` resolves.
  Title → "coexists with". Red: `expected 'position' to be 'grant'`.
- Case 12 (`:480-546`): after `setPositionDefault`, one active `'elevation'` + one active `'position'` (store = storeId)
  for `manage_users`; admin arrives → elevation revoked, position active, `authorize(manage_users,{})` resolves; after
  toggle-off it rejects. Keep all user-visible assertions.

New `packages/db/tests/integration/t341-person-grants-store-migration.test.ts` — scratch DB, the
`position-access-backfill.test.ts` technique (apply everything before this migration's `when`, seed, apply the real
folder). Seed: **P** open Cashier at A and B, `record_sale` defaulted at both, one active row ref A (pre-fix shape);
**Q** Cashier at B only, manual scope at A, one row (ref B); **R** Cashier at A and B, B default revoked; **E** Cashier
at A (open) and B (ended); one `'grant'` row with a history `source_ref`; one null-source row.

| # | Assertion (positive / ⛔ NEGATIVE) |
|---|---|
| M1 | P's original row has `store_id = A` (same id); a new active B row exists with the original's `granted_by` |
| M2 | ⛔ Q has no A row (leak not materialised); ⛔ R no B row; ⛔ E no B row |
| M3 | the `'grant'` history row and the null-source row have `store_id IS NULL` |
| M4 | raw position insert without store is filled; ⛔ mismatched store → 23503; ⛔ `'grant'` with store → 23514; ⛔ second active position row same (person, cap, store) → 23505; same (person, cap) other store succeeds; ⛔ second active person-level row → 23505 |

Red: locate-migration fails `expected 1 migration tagged t341, found 0`.

## 6. Paths (disjoint)
**TESTER:** the two new test files; `position-defaults.test.ts` (cases 3 and 12 only); ⚠️
`packages/db/tests/integration/position-access-backfill.test.ts` ONLY if it goes red (its header claims no later
migration touches its tables — now false; fix that sentence and affected expectations; leave the frozen 21-name list).
**BUILDER:** the migration + `meta/_journal.json` (+ snapshot per README); `packages/db/schema/access.ts`;
`packages/db/src/repo/access.ts`; `packages/domain/src/people/position-defaults.ts`; `packages/auth/src/authorize.ts`.
⛔ Do not touch: `CAPABILITY_MATRIX`, `CAPABILITY_SCOPE`, `heldCapabilities`, `GRANT_SOURCE_RANK`,
`heldPositionGrantsForPersonAtStore`, `wantedDefaultsForPersonAtStore`, `apps/erp/src/**`,
`_fixtures/staff-everyday-access.ts`, any applied migration, the bible, `CAPABILITY-MATRIX.md`, the register
(orchestrator stamps it).

## 7. Invariants
1. A position-sourced store-scoped capability is honoured only at its default's store (`CAPABILITY-MATRIX.md` preamble;
   bible row 114). P1, P2, P4.
2. Axis 2 checked separately and always (matrix rule 4; `authorize.ts:108-122`). P7.
3. Every ✅ has its ✗. P1–P6, M1.
4. No justified access lost; only unjustified removed (bible row 211). M1, M2.
5. Applied on job change, never derived at check time (row 115); self-grant refusal holds (§7 rule 5). P8.
6. DB enforces the shape (CHECK, composite FK, partial uniques, fill trigger; RULES §6.3). M4.
7. Tenancy unchanged: `person_grants` RLS via `persons` (`packages/db/src/rls/registry.ts:275-278`); repo filters unchanged (§15.11).
8. Org-scoped and person-level grants behave as before. P5, P6.

## 8. Out of scope
- Position defaults for org-scoped capabilities (stay org-wide).
- `heldCapabilities` / menus (the action is still refused).
- `persons.activeGrantCount` and T-291's "N inherited" now count one row per store — accepted.
- Revoking auto-`staff` on leaving (T-336 residual). Trimming production's `0152` rows.
- **Cutover count (read-only, orchestrator):** distinct people with an active position grant for a store-scoped
  capability at a store where they have scope but no open employment holding a position that defaults it.

## 9. Done when
P1–P8, M1–M4 seen red for the stated reason (or recorded green as guards) and passing; cases 3/12 amended and green;
typecheck + unit clean; **full** integration green (at risk: `position-defaults`, `position-access-backfill`, `t336-*`,
`t335-*`, `authorize.test.ts`, `roles.test.ts`, every importer of `staff-everyday-access.ts`); build green with 9008
stopped; §9.4 on 9008 — Cashier at store 1 / Cook at store 2 submits a sales day at 1 and is refused at 2;
`/admin/users/[id]` shows "via Cashier at store 1" only; screenshots. Orchestrator stamps DEF-414 FIXED and registers
§2.2 as its own DEF, fixed by the same commit. Planner after merge: bible §13 row + `CAPABILITY-MATRIX.md` §E
"Provenance rank" amendment.

**Planner uncertainties:** `position-access-backfill.test.ts` counts may move; whether T-276's 0157 touches
`person_grants` unchecked; the fill trigger's read of `position_capability_defaults` under RLS on the system-role
path unconfirmed (P8 + full suite decide).

## Amendment R1 — independent Opus auth review (2026-09-25), binding
Verdict was CHANGES: no path widens access; two data shapes would LOSE justified access.
1. **Upgraded rows (HIGH).** `access.ts:554` ranks a NULL source 0, so `:594` rewrote NULL-source (pre-0140, maybe
   hand-grants) and `'elevation'` rows to `'position'` when a default arrived; step 3 would pin them to one store.
   Detect: `grant_source='position' AND g.granted_at < d.set_at`. **Orchestrator ruling (no owner question — it
   changes nobody's access versus today, bible row 211):** for each such row, insert a person-level twin
   (`store_id NULL`) carrying the row's ORIGINAL pre-upgrade source (`'elevation'` if the person is not an admin-role
   holder and an elevation is inferable, else NULL-source), before step 3 pins the position row. Access after =
   access before. Seed this in M1/M2 (one ex-NULL, one ex-elevation) and assert the twin exists and both stores resolve.
2. **Already-hit §2.2 victims (HIGH).** Widen step 5: also materialise (P, C, S) when wanted at S (open employment,
   active default) and no active row exists, but a REVOKED `'position'` row for C exists at another store. Seed one in
   M1/M2. Add the remaining unrepairable shape to the §8 cutover count.
3. **Heads-up and §4.4 wording (MED).** §3's remedy list gains "or a hand-grant (person-level, all scoped stores)".
   §4.4 must state: under coexist, revoking a hand-grant no longer removes access at a store where a position
   justifies it; and `result.granted` may include capabilities already held by hand-grant, changing the "affected"
   count at `position-defaults.ts:427` — the tester pins the new count.
4. **Fill trigger under forced RLS (MED).** RLS is forced (`0011_row_level_security.sql:82,88`); defaults are
   org-scoped (`registry.ts:743`). The trigger raises its OWN named error (`person_grants: no visible default for
   source_ref …`) when it cannot see the default, rather than leaving a NULL for the CHECK. M4 runs its raw inserts
   as the APP role with the org set (and one case with no org set → the named error), never only as superuser.
5. **Tests (LOW).** Amended case 3 also asserts `@B` rejects after the hand-grant is revoked (where no position
   justifies B). M1/M2 cover items 1 and 2.
6. **`is_active` (LOW).** One rule: only ACTIVE positions justify a grant — step 5 and the item-1/2 repairs filter
   `p.is_active` like 0152 (`0152_t318_position_access_defaults_backfill.sql:211`). If `wantedDefaultsForPersonAtStore`
   does not, record it as a separate DEF; do not change it here.

## Amendment R2 — first-build audit (2026-09-25, orchestrator), binding
The auditor and an independent code-reviewer both found that the first build of 0159 WIDENED access:
- step 5 materialisation ignored `employment_positions`, which re-created the DEF-414 leak;
- revoked rows counted as evidence;
- step 5 twinned revoked rows as active.
Fixes, all binding:
1. Materialisation joins the person's held ACTIVE positions (`d.position_id = ep.position_id`, `p.is_active`).
2. Evidence is an active row, or a revoked row in the §2.2 shape: the person still holds, at `g.store_id`, the row's position with an active default.
3. Twins are made from active rows only, and copy `granted_at`.
4. The `authorize.ts` header is updated.
**Ruling:** an elevation or NULL-source row granted AFTER its default's `set_at` and later upgraded is NOT twinned. Twinning it could preserve the leak for position-born rows. It goes into the §8 cutover count instead.

## Amendment R3 — re-audit (2026-09-25, orchestrator), binding; supersedes R1 item 2 and R2 item 2
The auditor showed that the revoked-evidence branch was inverted. The real §2.2 victim loses its A employment through `endEmployment`, or its A default through toggle-off, so it fails the branch. The only shape that passes is a DELIBERATE admin revocation, and materialising that widens access.
**Ruling:** drop the revoked branch entirely. Step 5 evidence is an ACTIVE `'position'` row at another store only.
Already-hit §2.2 victims are people wanted at S today with no active row. They lack that access today, so leaving them alone loses nothing (bible row 211). They go into the §8 cutover count, listed by name for a hand remedy.
Tests:
- Victim22 is seeded with an ENDED A employment and asserts NO B row.
- A deliberate-revocation case also asserts no B row.
