# T-289 · T-290 · T-291 — Position access defaults: the design

> Status: **DESIGN APPROVED BY IAN IN CONVERSATION, 2026-09-12; written spec awaiting his review.**
> Written by the planner (Fable, Ian typing directly), after `/research-evaluate-propose`. The
> proposal with the assessment, industry research and screen mockup is the artifact
> *Position Access Defaults* (claude.ai/code/artifact/7b00542d-d447-48f0-950b-cd111d0a451b).
> This file is the spec the three task docs are cut from. Bible §7, §13 rows 114, 115, 120, 188,
> 196; T-121 contract §1–5; T-154; CAPABILITY-MATRIX.md §C.2 are read and incorporated.

## 0. The one-paragraph version

An administrator sets, per **position** and per **store**, which capabilities every holder of that
job gets *in addition to* the role matrix. Each toggle writes one `position_capability_defaults`
row and materialises ordinary `person_grants` rows for every current holder, tagged
`grant_source = 'position'` with a `source_ref` back to the default. Hiring, changing positions,
ending an employment, retiring a position and switching a default off all call the same primitive:
**reconcile this person's position-sourced grants at this store**. `authorize()` does not change.
A position never enters the check path. This is bible row 120's pattern — *decide once, at the
moment a human is present, and store the answer* — applied to jobs.

## 1. Ian's decisions — 2026-09-12

| # | Question | Decision |
|---|---|---|
| 1 | Can a position also switch OFF a capability the role matrix grants? | **No. Additive only.** *"Position defaults sit on top of role matrix."* Subtractive defaults go to `CAPABILITY-GAPS.md` as a later decision — they need a deny axis and a bible amendment |
| 2 | Grain of a default | **Per (position, store).** Lipa's Cashier may differ from Malvar's. Canonical positions get a *"same for every store"* action that writes one row per store — a copy, never a link |
| 3 | Who operates the screen | **Whoever holds `grant_capability`** (admin and above). Not the literal `super_admin` role: T-121 A.3 rules super admin is break-glass, not Ian's everyday login |
| 4 | The administrator holds the position being toggled | **Skip their own row, name it in the banner.** Self-grant stays refused (bible §7 rule 5); the rest of the fan-out proceeds |
| 5 | An explicit per-person grant when positions change | **Survives.** Only `'position'`-sourced rows are ever swept. A hand-grant of a capability already held via position upgrades the row to `'grant'` — the existing provenance rank, one new entry |

## 2. What this is built on, and what it may not touch

**Exists and is reused unchanged:**
- `authorize()` (`packages/auth/src/authorize.ts:70-148`) — matrix column OR active grant row, store scope separately. ⛔ **Not in any task's file list.** An implementer who needs to touch it has found a spec defect and stops (§3.4a).
- `person_grants` (`packages/db/schema/access.ts:126-180`) — append-and-revoke, provenance, reason-on-revoke.
- `grantCapability` (`packages/db/src/repo/access.ts:433-461`) — idempotent, provenance rank only moves toward less-sweepable.
- `positions` / `employments` / `employment_positions` (`packages/db/schema/employment.ts`).
- The fan-out shape: `assignRole` materialising store scope (`packages/auth/src/roles.ts:136-147`) and `fanStoreScopeToAdmins` (`packages/domain/src/stores/service.ts:131-137`) — loop, idempotent insert, in the caller's transaction, return affected ids.

**The seam:** `setEmploymentPositions` (`packages/domain/src/people/index.ts:192`) is a plain delete-and-reinsert with no side effect. `createEmployment` (`:54`) and `endEmployment` (`:166`) likewise.

**Constraints this design obeys, by citation:**
1. Role and position stay separate vocabularies (T-121:35-37, T-154:36-40). A position carries a *default grant set*; it is never itself a permission and never a parameter to `authorize()`.
2. Three axes, fixed (T-121:78-84, bible row 114). No fourth.
3. Rows, never a bypass; append-and-revoke, never delete (T-121:264-268).
4. Every write path has a denial test (T-121:317-318).
5. Nothing anyone deletes may widen access (bible row 115). Retiring a position or switching a default off only ever *narrows*.
6. No new capability: `grant_capability` already means "may change who can do what" (T-154:167-176 — *it fits, so do not add one*).

## 3. Data

### 3.1 New table — `position_capability_defaults`

```
id             uuid pk default uuidv7()
org_id         uuid not null → organizations (restrict)
position_id    uuid not null → positions (restrict)
store_id       uuid not null → stores (restrict)
capability     text not null            -- a Capability value; NO CHECK, same reasoning as person_grants.grant_name
set_by         uuid not null → persons (restrict)
set_at         timestamptz not null default now()
revoked_at     timestamptz
revoked_by     uuid → persons (restrict)
revoke_reason  text

unique  (position_id, store_id, capability) where revoked_at is null        -- partial, one ACTIVE default per cell
check   position_capability_defaults_revoke_check — the null-blind-safe pair check, copied verbatim
        from person_grants_revoke_check (revoked_at, revoked_by, revoke_reason all null, or all set and reason non-blank)
index   (store_id), (position_id)
```

- **Store-invented positions reach only their own store.** Enforced in the domain (`positions.store_id is null OR positions.store_id = store_id`) with a comprehensible message, and by a trigger-free CHECK where Drizzle can express it — it cannot (cross-table), so it is domain-enforced and integration-tested. State this in the schema comment.
- `store_id` is **not null** even for canonical positions (decision 2). "Same for every store" is N rows.
- RLS: `org_column`, standard `app_current_org()` isolation policy. Registry entry `scope: 'org_column'`. Classification `keep` — access configuration, like `person_grants`.
- `revoked_by` exists here although `person_grants` has none: this table is new, so the WHO column is decided now rather than left for a later migration (0140's own note says a WHO column is its own decision — this is that decision, for this table only).

### 3.2 `person_grants` — two changes

1. `grant_source` gains the value `'position'`. The CHECK `person_grants_source_check` is dropped and re-added with the four values. Drizzle: extend the `check()`.
2. New column `source_ref uuid null → position_capability_defaults (restrict)`. Index on it. CHECK **as amended in §11.1**: `(grant_source = 'position' AND source_ref IS NOT NULL) OR (grant_source IS DISTINCT FROM 'position' AND (source_ref IS NULL OR grant_source = 'grant'))` — a position row always has a ref, a grant row may (history of an upgrade, §3.3), nothing else ever does, and a NULL source is handled by `IS DISTINCT FROM` rather than falling through a null-blind equality.

### 3.3 The provenance rank — one new entry, one new rule

`GRANT_SOURCE_RANK` (`packages/db/src/repo/access.ts:404-408`) becomes:

```
elevation: 0   position: 1   grant: 2   owner: 2      (null ranks as 0, unchanged)
```

The existing invariant stands: the idempotent branch of `grantCapability` rewrites `grant_source` only when the incoming rank is strictly higher. Consequences, each of which is a test:
- Stored `'position'`, incoming `'grant'` → becomes `'grant'`; `source_ref` is **kept** (it is history: how the row first came to exist). The position sweep matches on `grant_source = 'position'`, so this row is now immune to it. **This is decision 5.**
- Stored `'grant'` or `'owner'`, incoming `'position'` → unchanged. A hand-grant is never demoted to sweepable.
- Stored `'elevation'` (or null), incoming `'position'` → becomes `'position'` and `source_ref` is written. The admin-arrival sweep (row 188, `WHERE grant_source = 'elevation'`) no longer catches it, which is correct: the position default independently justifies it.
- Stored `'position'`, incoming `'position'` with a *different* `source_ref` → unchanged. One active row, one ref; see §4.1 for why that is safe.

⚠️ **Accepted consequence, recorded so it is not rediscovered as a bug:** an elevated manager (adminless org, row 115) who also holds a floor position whose default covers one of their elevated capabilities has that row re-tagged `'position'`. If that default is later switched off while the org is still adminless, the capability is revoked with the position, and the manager needs `elevateManager`'s explicit tick to get it back. A manager holding a floor position in an adminless organisation is the rare case; the alternative (a rank that lets elevation win) would let the admin-arrival sweep remove a capability a position still justifies, which is worse.

## 4. Behaviour — one primitive, five callers

### 4.1 The primitive: `reconcilePositionGrants(tx, actor, { personId, storeId })`

Lives in `packages/domain/src/people/position-defaults.ts` (new). Steps, all in the caller's transaction:

1. `wanted` = the set of **active** `position_capability_defaults` rows for `storeId` whose `position_id` is among the positions of this person's **open** employment at `storeId`. Empty if there is no open employment there.
2. `held` = this person's active `person_grants` rows with `grant_source = 'position'` whose `source_ref` belongs to a default row (active or revoked) of `storeId`.
3. **Revoke** every row in `held` whose `source_ref` is not in `wanted`'s ids, with `revoke_reason` = `"Position default no longer applies: <position> at <store>"`. ⚠️ The reason must be non-blank or `person_grants_revoke_check` refuses it.
4. **Grant** every capability in `wanted` this person does not actively hold, via `accessRepo.grantCapability` with `grantSource: 'position'`, `sourceRef: <default id>`, `grantedBy: actor.personId`. Idempotent per §3.3.
5. **Skip self:** if `personId === actor.personId`, do nothing and return `{ skippedSelf: true }`. The caller reports it (decision 4).
6. Return `{ granted: Capability[], revoked: Capability[], skippedSelf: boolean }`.

**Why one active row, one ref, is safe (the "two positions justify one capability" case):** Cashier and Inventory Staff at Lipa both default `adjust_inventory`; Maria holds both. Her row's ref points at whichever default reconciled first. Switching the Cashier default off → the toggle action revokes rows with that ref (step 3 of §4.2) *and then reconciles every affected holder*; Maria's reconcile finds `adjust_inventory` in `wanted` via Inventory Staff and re-grants it as a **new** row with the Inventory Staff ref. Her window of not holding it is inside one transaction, invisible. "Who could do this in March" reads both rows and sees continuity. No reference counting, no multi-ref column.

**Authority note, stated because it is the one place a lower authority causes grant rows:** `reconcilePositionGrants` does not call `authorize()` itself. The *decision* was authorised at toggle time by a `grant_capability` holder; a hire by an `enrol_staff` holder merely *applies* it. This is the same relationship as `assignRole` writing elevation grants after one `manage_users` check. The primitive is therefore exported only to the five callers below and `tests/unit/domain-actions-have-callers.test.ts`-style closure is added: a unit test that lists the permitted importers.

### 4.2 The five callers

| Moment | Where | What happens |
|---|---|---|
| **Toggle on** | `setPositionDefault(tx, actor, { positionId, storeId, capability, on: true })` — new, in `position-defaults.ts` | `authorize(grant_capability, {})` · store in org · position is canonical or belongs to this store · capability is offerable (§4.3) · insert the default row (idempotent on the active partial unique) · **reconcile every person with an open employment at the store holding the position** · return `{ affected, skippedSelf }` |
| **Toggle off** | same function, `on: false` | `authorize(grant_capability, {})` · revoke the default row (`revoked_by`, reason = `"Switched off by <actor>"` or the actor's typed reason) · reconcile the same population · return counts |
| **Hire** | `createEmployment` (`people/index.ts:54`), after `replaceEmploymentPositions` | reconcile `{ personId, storeId }` |
| **Positions changed** | `setEmploymentPositions` (`:192`), after `replaceEmploymentPositions` | reconcile `{ personId, storeId }` |
| **Employment ended** | `endEmployment` (`:166`), after `closeEmployment` | reconcile — `wanted` is empty because there is no open employment, so every position row for that store is revoked; other stores untouched |
| **Position retired** | ⚠️ **No retire path exists in the domain today** (`upsertStorePosition` only creates; `positions.is_active` has no writer). T-289 adds `retireStorePosition` alongside, which revokes the position's default rows (reason `"Position retired"`) and reconciles holders. Canonical positions cannot be retired (T-154) | narrows only |

"Same for every store" (decision 2) is `setPositionDefault` called once per active store in one transaction, all or nothing (T-283's rule: partial success is refused, and the error names the store that refused).

"Copy defaults from store X" is: for each active default at X whose position is canonical, `setPositionDefault(…, on: true)` at the target store, in one transaction. Store-invented positions do not copy — they belong to X.

### 4.3 What a position may never default (enforced in the domain, not only hidden)

- `SUPER_ADMIN_ONLY_CAPABILITIES` (`capabilities.ts:840`, derived, currently 4).
- Every capability whose `CAPABILITY_SCOPE` is `'platform'`.
- `close_period` — its manager cell is conditional on org-wide scope, which is data about the person, not the job.
- Every capability the `staff` role already holds in the matrix is **shown as inherited and not toggleable** (decision 1). ⚠️ Shown, not hidden: the screen's job is to make "what can a Cashier do here" readable in one place, and hiding the 21 staff-matrix rows would make it lie by omission.

A unit test pins `OFFERABLE_TO_POSITIONS` as `CAPABILITIES − SUPER_ADMIN_ONLY − platform − {close_period}`, derived, not hand-listed, with the same "argue each new member" note the elevated set carries (bible row 196).

## 5. Screens

### 5.1 `/admin/access-defaults` (T-290)

Server component + server actions + `redirect('?ok=…')`, the `admin/users` pattern. Store selector from the actor's own scope. Positions across (canonical six, then this store's own), capabilities down, grouped by `CAPABILITY_SCOPE` exactly as T-283's `GrantPicker` groups them, each cell a full-width touch row (the sales-channels radio idiom, not reinvented). Column header carries the holder count. Save is **one transaction per submission**; the banner reads *"Applied to 7 people. Your own row was skipped — ask another administrator."* Actions: *Same for every store* (canonical rows only), *Copy defaults from…*.

Gate: `authorize(grant_capability, {})` at every action; the page read is ungated like `admin/users/lib.ts` (writes are the control, DEF-064's rule about ledger reads does not apply to a config screen — state this in `lib.ts`'s header so the next reader does not "fix" it).

### 5.2 The person page (T-291)

A `'position'` row renders *"via Cashier at Lipa"* and offers **no revoke control** here — the link goes to the defaults screen or to the employment's positions. Granting the same capability by hand upgrades provenance to `'grant'` and the banner says *"Already held via Cashier at Lipa — now held in their own right."* Sequenced **after T-283 lands**: same file.

## 6. Scope — in, and deliberately out

**In:** §3, §4, §5; classification + RLS registration; migration 0146; the tests in §7; the bookkeeping in §8.

**Out, each with its reason:**
- Subtractive defaults — needs a deny axis and a planner amendment (decision 1). → CAPABILITY-GAPS.
- Editing the role matrix at runtime — T-121 rejects a database-driven engine.
- Defaults reaching store scope — scope is its own axis; a job saying *where* you may act is the conflation T-121 warns against.
- Org-level rows that cascade into store rows — override semantics rot; a copy is a decision, a link is a deferred one.
- Backfilling on first ship — there are no defaults yet; the first toggle is the backfill.
- POS's own staff `role` field — a `CROSS-APP-MAP` seam for the POS re-platform.
- A new capability to gate the screen — `grant_capability` fits.
- Position history on `employment_positions` — the grants' own windows already answer "who could do X in March"; when a person held which job is Phase 4/5's question and not changed here.

## 7. Tests — every one names its denial

**Unit (`tests/unit/`)**
- `OFFERABLE_TO_POSITIONS` is derived and excludes exactly the three sets in §4.3.
- `GRANT_SOURCE_RANK` ordering pinned; the four transitions in §3.3 asserted on `grantCapability`'s idempotent branch (this is unit-testable against the branch's logic; the row-level effect is integration).
- The `reconcilePositionGrants` importer list is closed.
- `capability-matrix.test.ts` row count **unchanged** (no new capability). If it moved, the spec was violated.

**Integration (`packages/domain/tests/integration/position-defaults.test.ts`, run via `it.mjs <lane db> <file>`, never `test:integration`)** — fixture: one org, two stores, canonical positions seeded, one store-invented position at store A, an admin, a manager with `enrol_staff` at A only, four staff.
1. Toggle on reaches every open-employment holder at that store and nobody at the other store.
2. Toggle off revokes only `'position'` rows with that ref; a `'grant'` row for the same capability survives.
3. Hand-grant over a `'position'` row → provenance `'grant'`, ref kept; toggle off leaves it.
4. Hire into a position with defaults → grants appear; hire by the `enrol_staff` manager (not a `grant_capability` holder) still applies them.
5. Cashier→Cook swaps the sets; Cashier+Cook keeps the union.
6. Two positions defaulting one capability: switching one off leaves the capability held via the other, as a new row.
7. Ending the employment at A revokes A's rows and not B's.
8. Same person, same position at both stores: each store's rows independent.
9. Retiring the store-invented position revokes its rows; canonical cannot be retired.
10. Actor holding the position: skipped, reported, everyone else written.
11. **Denials:** no `grant_capability` → `AuthorizationError`; store outside org → refused; store-invented position targeted at another store → refused; super-admin-only, platform, `close_period`, and a staff-matrix capability → refused **at the domain**, not only absent from the screen.
12. Elevated manager (adminless org) holding a position whose default covers an elevated capability: row becomes `'position'`; admin arrival does not sweep it; default off revokes it (the §3.3 accepted consequence, pinned so it is a decision not a surprise).
13. Migration 0146 applies to an empty database and to a database with pre-0146 `person_grants` rows (the `source_ref` CHECK must accept `null` + non-position sources).

**Smoketest on 9008** (T-290, T-291): toggle, see the banner, open a holder's page, see *via Cashier at Lipa*.

## 8. Bookkeeping that ships with the work

- **Bible §13 row 198** (planner-only, on spec approval; version → 3.16): *"Position access defaults are materialised `person_grants` rows with provenance `'position'` and a `source_ref`, reconciled at the five moments a human is present (toggle on/off, hire, positions changed, employment ended, position retired). A position never enters `authorize()` and can only ADD to the role matrix, never subtract — Ian, 2026-09-12. The provenance rank gains `position` between `elevation` and `grant`, so a hand-grant is never demoted and an elevation is superseded, not swept, when a position justifies it. Reversible: drop the callers and the rows stay as history; the check path never knew."*
- `docs/CAPABILITY-GAPS.md`: subtractive position defaults, unowned, with the deny-axis cost.
- `docs/DEFECTS-REGISTER.md` §A (v1, reported, unverified): `Slicer` position vs `isSlicer` flag, two mechanisms under one word (`ERP-rebuild/src/types/index.ts:736` vs `src/types/position.ts:73`); `Dishwasher` canonical and gate-less with no comment, unlike `Server` (`position.ts:58-64`).
- `docs/CROSS-APP-MAP.md`: POS carries its own `role` on staff (admin, manager, kitchen, server) plus `isPlatformAdmin` — a seam for the POS re-platform.
- `docs/decisions/CAPABILITY-MATRIX.md`: a new §E, four paragraphs, pointing here — the matrix document is where the next person adding a capability will look for "may a position default this?"

## 9. The three tasks

| Task | Title | Files | Done when |
|---|---|---|---|
| **T-289** | The spine: table, provenance, primitive, six callers | `packages/db/schema/access.ts` · `packages/db/schema/employment.ts` (comment only) · `packages/db/schema/position-capability-defaults.ts` (new) · `packages/db/migrations/0146_t289_position_capability_defaults.sql` · `packages/db/migrations/meta/_journal.json` (idx 146, when 1798687907084) · `packages/db/src/cutover/classification.ts` · `packages/db/src/rls/registry.ts` · `packages/db/src/repo/access.ts` · `packages/db/src/repo/position-defaults.ts` (new) · `packages/domain/src/people/index.ts` · `packages/domain/src/people/position-defaults.ts` (new) · `packages/domain/tests/integration/position-defaults.test.ts` (new) · `tests/unit/position-defaults-offerable.test.ts` (new) · `tests/unit/position-defaults-callers.test.ts` (new) | typecheck · unit · integration on a lane DB · 0146 applied to a scratch DB · matrix row count unchanged · `authorize.ts` untouched (`git diff --stat` proves it) |
| **T-290** | The screen | `apps/erp/src/app/admin/access-defaults/{page,actions,lib}.tsx` (new) · nav registration · `tests/unit/nav-route-reachability.test.ts` fixture · `apps/erp/tests/touch-target-baseline.json` if the sweep demands it | typecheck · unit · smoketest on 9008 · build with the dev server stopped |
| **T-291** | Inherited vs override on the person page | `apps/erp/src/app/admin/users/[personId]/page.tsx` · `apps/erp/src/app/admin/users/lib.ts` | after T-283 lands · typecheck · unit · smoketest |

Each spec is written **in plan mode** (Opus specifies, Sonnet builds — CLAUDE.md, 2026-09-09) and cites this file rather than restating it.

## 11. Amendments after the Opus spec review — planner rulings, 2026-09-12

The spec-writer (Opus, writing T-289/290/291 from this plan) reported five defects in it. Each is
ruled here; the sections above are amended inline where the ruling changes a rule, and the task
docs carry the same rulings. Recorded rather than silently fixed, per §3.4a: a planner's plan is a
hypothesis too.

1. **§3.2 vs §3.3 — the `source_ref` CHECK refused the row §3.3 required.** The equality CHECK made
   "ref kept on upgrade to `'grant'`" unrepresentable. **Ruled: keep the ref, relax the CHECK** to the
   three-shape form now in §3.2, using `IS DISTINCT FROM` so the spec-writer's second finding (the
   equality was null-blind on the left) is closed in the same stroke. History wins over a symmetric
   constraint; the sweep never reads the ref, so immunity is unaffected.
2. **T-289's file list could not typecheck.** Widening `GrantSource` breaks the exhaustive
   `grantSourceLabel` switch in `apps/erp/src/app/admin/users/lib.ts`, a T-291 file. **Ruled:** T-289
   adds exactly one `case 'position'` arm to that file (file 18 in its list); webapps-f7 confirmed
   T-283 does not touch `lib.ts`. T-291 refines the label.
3. **§4.3 four exclusions vs §7 three.** **Ruled: two checks**, as the spec-writer resolved it —
   `OFFERABLE_TO_POSITIONS` derived from the three sets (what may be toggled), and a separate domain
   refusal of staff-matrix capabilities (what must not become a row). Folding the fourth into the
   constant would leave the screen nothing to render as inherited.
4. **`tests/unit/domain-actions-have-callers.test.ts` missing from T-289's list.** Accepted; added
   (three exemption rows, two of which T-290 deletes).
5. **T-291's list short by two.** Accepted: `apps/erp/tests/admin-users-lib.test.ts` and the
   `describeSources` read, which T-289 provides in `packages/db` so T-291 never reaches into it.

Minor, taken as corrected in the specs: `GRANT_SOURCE_RANK` is at `access.ts:403-407`; there is no
nav-route-reachability fixture to edit for T-290; §4.2 has six moments and five call sites.

## 10. What is still unmeasured, and does not block

The utilisation figure — active `person_grants` with `grant_source = 'grant'` in production grouped by `grant_name`, and open employments per position per store — lives on erp2.shareat.net and was not readable from here. It sizes the *payoff*, not the design. Whoever next has production read access should take the two counts and append them to this section; if manual grants are near zero, T-290's polish (copy-from-store, same-for-every-store) is the part to defer, not the spine.
