# T-222 — Store creation and management (`/admin/stores`)

> **Status**: specced 2026-09-06. Phase 7's other half, deferred by Ian on 2026-09-05 and
> recorded as **`PROJECT_BIBLE.md` §13 row 174** — *store creation is its own task, not half of
> user/role management, because screen location is not a unit of work; what backs a screen is.*
> **Not yet implemented.** No `createStore`-shaped function exists anywhere in the codebase today.
>
> ⛔ **This is not a form.** A store row is the smallest part of creating a store. Everything
> below exists because a store that is merely *inserted* is a store nobody can sign into, sell
> from, or see.

## Why this exists, and what v1 already learned

`scripts/dev-seed.ts` opens with the tell: *"Migrations create 93 accounts and (via whatever put
them there) an org and its stores."* **Nobody knows how a store gets created, because nothing
creates one.** The four dev stores were inserted by hand.

v1 has the feature, and — unusually — v1 also has the **scar tissue**. Its own
`store-provision.actions.ts` header:

> *"Creating a store only writes `stores/{id}`. Seeds were kicked off from the client
> fire-and-forget — a failure was `console.error`'d while the UI still said **"Store Created"** —
> and every store-scoped settings doc was created lazily on first page visit or never at all."*

⭐ **Read that as a requirement, not as design** (RULES §1.2b). The *need* it proves: a store is a
fan-out across many tables, the fan-out can partially fail, and a partial failure is invisible at
the moment it happens and expensive later. v1's answer was `provisionStoreAction` plus an 11-item
readiness registry splitting steps into `auto` (a defined default exists) and `manual` (*"it
encodes a real business fact — which bank, which sales channels — and a default there would be a
guess wearing the costume of a decision"*).

**That split is correct and v2 adopts it. v1's *mechanism* is not, and v2 can do better for one
concrete reason: Firestore has no multi-document transaction across those writes, and Postgres
does.** v1 had to run each seed separately and report each individually because it could not do
otherwise. v2 makes the entire `auto` half **atomic** — so the half-provisioned store, the state
v1 kept landing in, cannot exist. Only the genuinely `manual` half remains a checklist.

*(§1.2d step 4: the bar is more correct, more effective — not merely not-flawed.)*

### Counting the live data first (§1.2d step 3)

**7 stores exist across the whole business, ever** (`docs/discovery/22-pos-build-assessment.md`
§, `26-reporting-dashboards-and-insights.md`). Store creation is therefore a **handful of
lifetime uses, each with high consequence and a long tail** — a store created wrong is not noticed
for days and presents as a different bug each time.

⭐ **That is the sizing decision, stated as a number rather than an adjective**: do not build a
slick high-throughput creation flow. Build a careful one that cannot leave a store half-made, and
spend the effort on *making the remaining gaps legible* rather than on the form.

## Goal

An admin can open a branch and have it work — or see exactly what is still missing and where to
fix it — without anyone hand-writing SQL, and without a store ever existing in a state where the
failure looks like a permissions bug.

## Scope — files this task may create or modify

| File | Change |
|---|---|
| `docs/decisions/CAPABILITY-MATRIX.md` | **new capability `manage_stores`** (org-scoped) |
| `packages/auth/src/capabilities.ts` | declare `manage_stores` + its matrix row |
| `packages/db/src/repo/stores.ts` | `listForOrg`, `getById`, `insertStore`, `updateStore`, `setActive` |
| `packages/db/src/repo/access.ts` | `activeAdminPersonIds(tx, orgId)` — for the §C.2 fan-out |
| `packages/domain/src/stores/service.ts` | **new** — `createStore`, `updateStore`, `deactivateStore`, `reactivateStore`, `storeReadiness` |
| `packages/db/migrations/NNNN_t222_*.sql` | ⭐ **expected: NONE.** Every constraint this task relies on already exists — `stores_org_id_code_unique`, `stores_pooling_requires_ceiling_check`, `stores_unremitted_ceiling_positive_check`, and T-160's `stock_locations_single_room_guard` trigger. **If the implementer finds themselves writing a migration, that is a signal the design assumed a rule the schema does not carry — report it (RULES §3.4a) rather than adding one quietly.** If one is needed, claim the next `idx` **and a matching `when`** in `meta/_journal.json`; Drizzle silently skips an entry whose timestamp does not track its index |
| `apps/erp/src/app/admin/stores/page.tsx` | list |
| `apps/erp/src/app/admin/stores/[id]/page.tsx` | detail + readiness checklist |
| `apps/erp/src/app/admin/stores/actions.ts` | server actions |
| `apps/erp/src/components/nav.tsx` | "Setup" group gains *Stores* (DEF-181's group, added by T-219) |
| tests | `packages/domain/tests/integration/stores.test.ts` (new) |

⛔ **Out of scope**: `packages/auth/src/roles.ts`, anything under `packages/domain/src/findings/`,
and the POS/CUSTOMER apps. A new store's POS mapping is T-177's surface, not this one.

## Contract

### 1. `manage_stores` — a new capability, org-scoped

No store capability exists today; `manage_locations` is **store**-scoped and governs *rooms inside*
a store, which is a different question from *whether the store exists*.

| Capability | Scope | super_admin | admin | manager | staff |
|---|---|---|---|---|---|
| `manage_stores` | `org` | ✅ | ✅ | ✗ | ✗ |

**Manager is ✗ deliberately.** Opening or closing a branch is an org-structural act with money
consequences (it fans access rows and creates a cash-custody policy), and it is the same bar as
`manage_users`. ⚠️ **Per CAPABILITY-MATRIX's own rule, every ✅ needs a test proving the ✗ fires** —
a manager attempting `createStore` must be refused, with its own named test.

### 2. `createStore` — ONE transaction, everything with a defined default

```
createStore(tx, actor, { code, name, timezone?, stockModel?, remittanceCadence?, unremittedCeiling? })
```

In a single transaction, in this order:

1. `authorize(tx, actor, 'manage_stores')` — first statement, no exceptions (bible §7 rule 1).
2. Insert the `stores` row.
3. **Create its default room** — `stock_locations`, via T-160's existing
   `createLocation` (`packages/domain/src/stock-locations/service.ts:193`), reused rather than
   reimplemented. A `single_room` store may hold exactly one non-Receiving active room and a
   trigger enforces it; a store with **zero** rooms holds no stock at all.
4. **⭐ Fan `person_store_scope` rows out to every active admin in the org** — CAPABILITY-MATRIX
   §C.2's second half, verbatim: *"a store created later appears in nobody's scope, so creating a
   store must add scope rows for that org's existing admins — otherwise a new branch is invisible
   to the person who just opened it, and the failure looks like a permissions bug rather than a
   missing row."*

⚠️ **Step 4 is the one that will be forgotten, and DEF-180 is the proof.** §C.2's *first* half was
decided on 2026-08-25 and simply never written into `assignRole`; it went unnoticed for two weeks
only because nothing called the function. **This is the same ADR, the same paragraph, the other
half.** It gets its own test, named after §C.2, or it will happen twice.

**All-or-nothing.** If the room insert or the fan-out fails, the store row goes with it. That is
the whole improvement over v1, which could not roll back and therefore had to report per-step.

### 3. The cash-custody constraint — surfaced, never re-implemented

`stores_pooling_requires_ceiling_check` is `remittance_cadence = 'daily' OR unremitted_ceiling IS
NOT NULL`, with `stores_unremitted_ceiling_positive_check` alongside it. Row 129's failure is the
**combination** — a long cadence with an unbounded pile of cash.

⛔ **Do not add a TypeScript copy of that rule.** `storesRepo.setCashPolicy` already establishes
the precedent in its own comment: *"the database, not this function, is what makes the unsafe
combination impossible… there is deliberately no second copy of that rule here — bible §6.3."*

**What this task adds instead** is translation, not validation: catch `23514`, read
`error.constraint_name`, and map the two store constraints to a sentence a human can act on
("A store that pools cash must name the ceiling that bounds it"). The mapping is keyed on the
**constraint name**, so if the constraint is ever renamed the mapping fails loudly rather than
silently falling through to a generic error.

⚠️ The form may of course *disable* the save button client-side for a missing ceiling — that is
help, not enforcement, and the server must still rely on the database (bible §2 rule 7: no
client-side-only authorization, and the same reasoning applies to invariants).

### 4. Readiness — DERIVED, never stored

The checklist on a store's page is **computed on read from the live tables**. Nothing about
readiness is persisted.

⭐ **This is bible row 123's lesson applied, and it is not a style preference.** v1's OIL layer
stored `state` per finding key, so resolving one suppressed tomorrow's recompute *while the
condition still held* — the symptom hidden with the cause intact. v2's rule: **a finding is
derived; only an acknowledgement is stored.** A stored "store is ready" flag is exactly the same
defect: someone ticks it, the sales channel is later deleted, and the store reports ready forever.

| Check | Satisfaction | Why |
|---|---|---|
| Store row, code unique in org | auto | `stores_org_id_code_unique` |
| Cash-custody policy coherent | auto | the DB check; cannot be otherwise |
| Default room exists | auto | created in step 3 |
| Every active admin scoped | auto | created in step 4 — **re-derived, so a later drift shows** |
| **≥1 sales channel** | **manual** | a business fact. Without one a sales day has nowhere to land, and DEF-059's resolution is that an unresolvable channel **blocks** rather than silently defaulting |
| **≥1 PIN issued at this store** | **manual, and the sharpest one** | see §5 |
| Payment accounts reachable | manual | which bank / e-wallet is a business fact |
| Attendance config | auto-with-defaults | every column is NOT NULL with v1's default, so "unset" cannot exist — **verify during implementation** that a store with no row reads defaults rather than throwing |

### 5. ⚠️ Nobody can sign in at a brand-new store — and v1 offers no guidance here

`setPin(tx, { personId, storeId, pin })` hashes the PIN with `pinLookupHash(storeId, pin)`. **A
credential belongs to a (person, store) pair.** A new store therefore has **zero** credentials, and
the sign-in page's store picker will happily list it — so the first person to try reports *"my PIN
stopped working"*, which is the least informative possible symptom of a correct system.

**v1 cannot advise here**: it authenticated by Firebase identity with an "acting as" picker, so
this failure mode did not exist. This is a v2-only consequence of T-138's store-scoped PIN, which
is otherwise a clear improvement.

**Resolution**: the readiness checklist carries *"No one can sign in at this store yet"* as a
**blocking** item linking to PIN issuance. ⛔ `createStore` does **not** auto-issue a PIN — a
credential is a security decision, and a generated-and-displayed default PIN is the kind of
convenience that ends up in a screenshot. ⚠️ `setPin` has no `authorize()` call of its own
(a standing trap in the handoff), so the checklist's link must lead to T-217's gated issuance
path, never to a new ungated caller.

### 6. Deactivate, never delete

A store accumulates journal entries, attendance and stock. `stores.isActive` already exists.
**Deletion is not offered at all** — T-160 set this precedent for rooms (*"a room with history is
deactivated, never deleted"*, and v1's admin-only DELETE has no v2 counterpart).

⭐ **Reactivation must re-fan the scope rows, and this is a real bug waiting to happen.** T-219's
own smoketest observed appointing an admin reporting *"granted store scope for 3 store(s) — 3, not
4, because one store is inactive."* So admins appointed while a store is inactive have **no scope
row** for it. Reactivate that store and it is invisible to them — §C.2's failure a third time, in a
third costume. `reactivateStore` therefore runs the same fan-out as `createStore`, and shares its
implementation rather than copying it.

### 7. Routes and nav

- `/admin/stores` — list: code, name, active, cadence, room count, **readiness summary**.
- `/admin/stores/[id]` — detail: identity, cash-custody policy, the readiness checklist,
  deactivate/reactivate.
- Nav: the **Setup** group T-219 introduced for DEF-181 gains *Stores*. ⚠️ DEF-181 was precisely a
  screen that shipped linked from nowhere — do not repeat it in the task that cites it.
- Layout follows the house details-page pattern (`mx-auto`, two-column), and is checked at **390**
  as well as 1280.

## Invariants

1. A manager is refused `createStore` (`AuthorizationError`), and a staff member is too.
2. A created store has **exactly one** active non-Receiving room.
3. After `createStore`, **every active admin of that org has a `person_store_scope` row** for it.
4. A non-daily cadence with no ceiling is **refused by the database**, and the action reports the
   sentence rather than a raw `23514`.
5. A duplicate `code` within one org is refused; the same code in a **different** org is allowed.
6. Every write in `createStore` rolls back together — a forced failure in the fan-out leaves **no**
   store row behind.
7. Readiness is recomputed from live tables: delete the sales channel and the check goes red again.
8. `deactivateStore` never deletes; history remains queryable.
9. `reactivateStore` re-fans scope to admins appointed while it was inactive.
10. A store created in org A is invisible to org B (RLS — free, but asserted once here).

## Tests

`packages/domain/tests/integration/stores.test.ts`, against real Postgres, each watched fail
first. Invariant 3 and invariant 9 are the two that matter most — they are §C.2's two halves, and
DEF-180 is what happens when an ADR is trusted to enforce itself.

⭐ **Invariant 6 needs a deliberate injected failure**, not a happy path — the atomicity claim is
the design's whole advantage over v1, and an untested rollback is a claim of coverage with nothing
executable behind it (DEF-175/176/180/182/187's shape).

## Out of scope — with reasons

| Not doing | Why |
|---|---|
| Auto-issuing a PIN at creation | A credential is a security decision (§5) |
| Seeding sales channels / payment accounts | Business facts. v1's line is right: a default here is *"a guess wearing the costume of a decision"* |
| POS mapping for the new store | T-177's surface |
| Org creation | A different tenancy question; no org has been created since T-120 |
| Backfilling the 4 hand-inserted dev stores | They are already correct; a migration to "fix" them would change nothing |

## Open questions — for Ian

1. **Should a store's `code` be editable after creation?** It is user-facing and appears on
   documents. **Recommendation: no** — rename freely, but the code is the stable handle.
2. **Should `deactivateStore` refuse while the store has an open sales day or unremitted cash?**
   **Recommendation: yes, refuse and say which** — the same shape as T-160's location-deactivation
   guard, and deactivating a store holding uncounted cash loses the custody trail.
3. **Does a manager need a read-only view of `/admin/stores`?** They already see their own stores
   everywhere else. **Recommendation: no page for now** — add it if asked for twice.

## Done when

typecheck clean · every test watched fail first, then green · `npm run test:integration` green on
an isolated lane DB · `npm run build` exit 0 with the dev server stopped · **smoketested on 9008:
a store created end-to-end, its readiness checklist read, and a manager's refusal seen as a real
sentence** · CAPABILITY-MATRIX updated with `manage_stores` and its ✗ test named · self-reviewed
line by line · committed with a message explaining *why* · **`npm run toc` if `PROJECT_BIBLE.md`
gains a row** · `FOR IAN` block naming the three open questions.
