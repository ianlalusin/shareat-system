/**
 * person_roles + person_store_scope + person_grants — the three orthogonal access axes.
 * docs/tasks/121-roles-and-access.md Contract §1, bible rows 114, 115, 116.
 *
 * Three independent tables because the three axes ARE independent (bible row 114):
 *   1. Organization — whose books (RLS, T-120, already done).
 *   2. Store scope  — which branches within that org. Rows, never a bypass.
 *   3. Role + grants — what the person may do. A fixed role catalogue plus per-person
 *      overrides, never a database-driven permission engine (bible §16.4).
 *
 * `packages/auth` is the ONLY place that interprets these rows against the capability
 * matrix — this file only shapes the data, exactly like `persons.ts` says identity
 * answers who, and authorization ("what you may do") is a separate concern (bible §7.3).
 *
 * ## Why role and grant history is REVOKE, never DELETE or UPDATE-in-place
 *
 * `person_roles` and `person_grants` both carry `revoked_at` instead of being deleted or
 * overwritten. "Who could close a period on 3 March?" and "who was this org's admin when
 * that credit limit was set?" are exactly the questions an audit asks (CAPABILITY-MATRIX.md
 * §B: "person_grants is append-and-revoke, never delete... grants are exactly what an audit
 * asks about"). A DELETE loses the answer forever; an UPDATE loses it the moment the next
 * change overwrites it. At most one ACTIVE (revoked_at IS NULL) row exists per
 * (person, org) for a role and per (person, grant_name) for a grant — changing either
 * revokes the old row and inserts a new one, so history is a sequence of rows, not a
 * mutated cell.
 *
 * `person_store_scope` deliberately does NOT carry this — CAPABILITY-MATRIX.md frames it
 * as "rows, never a bypass. 'All' = every row": the audit question it answers ("who can
 * see Davao?") is answered by which rows exist RIGHT NOW, and removing access is an
 * ordinary delete, not a revocable grant. Widening it to full history was considered and
 * rejected here: rewrite it here, not by hand, if that later proves wrong.
 *
 * ## `grant_name` carries NO check constraint, deliberately
 *
 * The whole point of `person_grants` (CAPABILITY-MATRIX.md "Grants as columns do not
 * scale") is that adding a grant is one enum value in code and one row — never a
 * migration. A CHECK enumerating all 38 capabilities here would recreate exactly the
 * thing this table exists to avoid. The closed union lives in `@shareat/auth`'s
 * `Capability` type; `packages/db` does not, and must not, know its members — see
 * ADR-004 / the workspace dependency direction (`@shareat/auth` depends on `@shareat/db`,
 * never the reverse).
 */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { positionCapabilityDefaults } from './position-capability-defaults';
import { stores } from './stores';

// -------------------------------------------------------------------------------------
// Axis 3a — role. One of a closed, four-value catalogue (CAPABILITY-MATRIX.md §A.1):
// super_admin (Ian, platform, break-glass) > admin (org-wide, one required per org) >
// manager (named stores; a franchise's OWNER) > staff (their store).
// -------------------------------------------------------------------------------------

export const personRoles = pgTable(
  'person_roles',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    role: text('role', { enum: ['super_admin', 'admin', 'manager', 'staff'] }).notNull(),
    // Who assigned this role. Nullable only for the very first seeded row (there is no
    // grantor before the system has one admin) — bible row 116's authority chain
    // (super-admin assigns admin; that admin sets managers; nothing assigns itself) is
    // enforced by the SERVICE layer that calls this table, not by a NOT NULL here.
    grantedBy: uuid('granted_by').references(() => persons.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('person_roles_person_id_idx').on(t.personId),
    index('person_roles_org_id_idx').on(t.orgId),
    // At most one ACTIVE role per (person, org). Changing a person's role revokes this
    // row and inserts a new one — never an UPDATE of `role` in place, so "what was their
    // role in March" stays answerable.
    uniqueIndex('person_roles_active_person_org_unique')
      .on(t.personId, t.orgId)
      .where(sql`${t.revokedAt} is null`),
    check('person_roles_role_check', sql`${t.role} in ('super_admin', 'admin', 'manager', 'staff')`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.grantedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'person_roles_granted_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'person_roles_person_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

// -------------------------------------------------------------------------------------
// Axis 2 — store scope. Rows, never a bypass (CAPABILITY-MATRIX.md, bible row 114). To
// grant every store, insert a row for every store that exists TODAY — there is
// deliberately no NULL/"all" sentinel, because a sentinel is exactly the invisible
// bypass this table replaces. A store added to the org later needs an explicit new row
// for anyone whose access should extend to it; nothing widens automatically (the same
// "nothing anyone adds elsewhere may silently change access" rule CAPABILITY-MATRIX.md
// §B applies to grants).
// -------------------------------------------------------------------------------------

export const personStoreScope = pgTable(
  'person_store_scope',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by').references(() => persons.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * T-336 SCOPE LIFECYCLE fix (auditor finding 1, 2026-09-24; migration 0156). WHY this row
     * exists, not just that it does — `employment` is the only source `endEmployment` may ever
     * delete, and only when no other open employment remains at that store: without it, ending a
     * hire's employment could not be told apart from an admin's deliberate grant or the
     * new-admin/new-store fan-out, so a terminated cashier kept sign-in (the bug this closes).
     *
     * ⭐ Priority on conflict, enforced in `accessRepo.grantStoreScope`, never here:
     * `manual` > `fan_out` > `employment`. A `manual` grant always wins, including over an
     * `employment` row. A `fan_out` upgrades an existing `employment` row (a hire later promoted
     * to admin/manager keeps their scope after the employment ends) but never downgrades an
     * existing `manual` or `fan_out` row. `employment` never overwrites anything.
     *
     * `default('manual')` — ~147 raw inserts across `scripts/dev-seed.ts` and test fixtures predate
     * this column and never will pass `source`; only `createEmployment` writes `'employment'`, so
     * every caller that has no opinion is, by construction, the same shape as a manual grant.
     */
    source: text('source', { enum: ['employment', 'manual', 'fan_out'] }).notNull().default('manual'),
  },
  (t) => [
    uniqueIndex('person_store_scope_person_id_store_id_unique').on(t.personId, t.storeId),
    index('person_store_scope_person_id_idx').on(t.personId),
    index('person_store_scope_store_id_idx').on(t.storeId),
    check('person_store_scope_source_check', sql`${t.source} in ('employment', 'manual', 'fan_out')`),
  ],
);

// -------------------------------------------------------------------------------------
// Axis 3b — per-person capability overrides, additive to the role matrix. This is the
// grant-time fallback's storage (bible rows 115, 116; CAPABILITY-MATRIX.md §B/§B.1):
// creating a manager in an org with no admin inserts rows here for the elevated
// capability set, evaluated ONCE at appointment and never re-derived at check time.
// Also the general mechanism behind `grant_capability` — an admin handing one extra
// capability to one person without changing their role.
// -------------------------------------------------------------------------------------

export const personGrants = pgTable(
  'person_grants',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    // A `Capability` value (packages/auth). Deliberately NOT a DB check constraint — see
    // this file's top comment.
    grantName: text('grant_name').notNull(),
    grantedBy: uuid('granted_by').references(() => persons.id, { onDelete: 'restrict' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * T-248 / DEF-237, migration 0140. WHERE this row came from — `'elevation'` (the automatic
     * grant-time fallback, bible row 115, OR `elevateManager`'s manual "explicit tick", bible
     * row 116 — the same reason to exist, so the same eligibility to lapse), `'owner'`
     * (`createFirstAdmin`'s founding-person equivalence grant — never eligible, that person
     * already holds `admin` themselves), or `'grant'` (an ordinary deliberate hand-grant via
     * `grantCapabilityAsActor`).
     *
     * ⛔ NULL for every row written before this column existed, deliberately, not backfilled by
     * inference — see the migration's own comment. NULL is never `'elevation'`, so it is simply
     * never eligible for T-248's revocation; no special-case exclusion needed anywhere that reads
     * this column.
     *
     * T-289, migration 0146 — a fourth value, `'position'`: this row was materialised by
     * `reconcilePositionGrants` from an active `position_capability_defaults` row (`sourceRef`
     * below). Ranked between `'elevation'` and `'grant'`/`'owner'` (`packages/db/src/repo/
     * access.ts`'s `GRANT_SOURCE_RANK`) — a hand-grant is never demoted to sweepable by a later
     * reconcile, and a position default supersedes a mere elevation stand-in.
     */
    grantSource: text('grant_source'),
    /**
     * T-289, migration 0146. The `position_capability_defaults` row that justifies this grant —
     * **required** when `grantSource = 'position'`, **may** survive as history on a `'grant'` row
     * (a hand-grant upgrading a position row keeps the ref, §C3/§C5 transition 1: it says how the
     * row first came to exist), and **never** set for any other source, including NULL
     * (`person_grants_position_source_ref_check` below uses `IS DISTINCT FROM` so a NULL source
     * cannot slip a stray ref past a null-blind equality). ⛔ `packages/db` still does not know
     * `@shareat/auth`'s members — this column names no capability, only which DEFAULT ROW acted.
     */
    sourceRef: uuid('source_ref').references(() => positionCapabilityDefaults.id, { onDelete: 'restrict' }),
    /**
     * T-341 / DEF-414, migration 0159. Which store a `'position'`-sourced grant is honoured at —
     * the store `sourceRef`'s default belongs to, ALWAYS set for `grant_source = 'position'`. A
     * raw insert that omits it is filled by a hand-added trigger (migration 0159 —
     * `packages/db/migrations/README.md` §3: what Drizzle cannot express, a trigger cannot be
     * declared here).
     *
     * T-349 / DEF-456, migration 0165. MAY also be set for `grant_source = 'grant'` — a capability
     * held in their own right, at the position row's own store it was made from
     * (`packages/db/src/repo/access.ts`'s store-grant branch sets it; never a trigger). NEVER set
     * for any other source — `'elevation'`, `'owner'` and NULL always carry `store_id IS NULL`
     * (`person_grants_store_shape_check` below).
     *
     * ⛔ A position-sourced row, a store-scoped grant row and a person-level row (`storeId IS
     * NULL`) now COEXIST for the same `(personId, grantName)` — no branch of `grantCapability`
     * ever rewrites another's rows. Before 0159 there was exactly one active slot per
     * `(personId, grantName)`; DEF-414 is that a store-scoped position grant authorised at every
     * store the person had SCOPE at, not only the store whose default produced it. DEF-456 is the
     * same shape one level up: a hand-grant made from a store-scoped position row had nowhere to
     * carry that store before 0165, so it authorised at every store too.
     */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    /**
     * WHY this grant was revoked — T-248 / DEF-237, migration 0140, the same shape as
     * `person_credentials.revokeReason` (`schema/sessions.ts`, T-239 / DEF-229). Pairs with
     * `revokedAt`; this table has never carried a `revokedBy` (unlike `person_credentials`) and
     * this migration does not add one — a WHO column is its own decision, not folded in here.
     */
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    index('person_grants_person_id_idx').on(t.personId),
    index('person_grants_store_id_idx').on(t.storeId),
    // T-341, migration 0159. One (person, grant_name) active slot became two: a PERSON-LEVEL slot
    // (storeId IS NULL — elevation/owner/grant/NULL-source) and a PER-STORE slot (storeId IS NOT
    // NULL — 'position' only), replacing the single `person_grants_active_person_grant_unique`
    // this table carried through migration 0140. See this column's own comment for why.
    uniqueIndex('person_grants_active_person_level_unique')
      .on(t.personId, t.grantName)
      .where(sql`${t.revokedAt} is null and ${t.storeId} is null`),
    // T-349 / DEF-456, migration 0165 — split by source: a 'position' row and a 'grant' row
    // (a hold in their own right, at the position row's own store) each get their own active
    // slot at the same store, and neither collides with the other.
    uniqueIndex('person_grants_active_position_store_unique')
      .on(t.personId, t.grantName, t.storeId)
      .where(sql`${t.revokedAt} is null and ${t.storeId} is not null and ${t.grantSource} = 'position'`),
    uniqueIndex('person_grants_active_grant_store_unique')
      .on(t.personId, t.grantName, t.storeId)
      .where(sql`${t.revokedAt} is null and ${t.storeId} is not null and ${t.grantSource} = 'grant'`),
    index('person_grants_source_ref_idx').on(t.sourceRef),
    check(
      'person_grants_source_check',
      sql`${t.grantSource} is null or ${t.grantSource} in ('elevation', 'position', 'owner', 'grant')`,
    ),
    /**
     * T-289, migration 0146 (planner-ruled shape, plan §11.1). Three admitted shapes, nothing
     * else: a `'position'` row ALWAYS carries a ref; a `'grant'` row MAY (history of an upgrade);
     * every other source — `'elevation'`, `'owner'`, and NULL — carries none. `IS DISTINCT FROM`
     * is load-bearing: a NULL `grant_source` is *distinct from* `'position'`, so the right-hand
     * branch applies and demands a null ref — a naive `<> 'position'` is null-blind and would let
     * a NULL-source row carry a stray ref through undetected.
     */
    check(
      'person_grants_position_source_ref_check',
      sql`(${t.grantSource} = 'position' and ${t.sourceRef} is not null)
          or (${t.grantSource} is distinct from 'position'
              and (${t.sourceRef} is null or ${t.grantSource} = 'grant'))`,
    ),
    // ⛔ NULL-BLIND TRAP, avoided on purpose (DEF-229's own lesson, T-239): a CHECK passes when
    // its expression is NULL, so the naive `revoked_at is not null and btrim(revoke_reason) <> ''`
    // admits a revoked row with a MISSING reason. The explicit `is not null` term is load-bearing.
    check(
      'person_grants_revoke_check',
      sql`(${t.revokedAt} is null and ${t.revokeReason} is null)
          or (${t.revokedAt} is not null and ${t.revokeReason} is not null
              and btrim(${t.revokeReason}) <> '')`,
    ),
    // T-341, migration 0159; replaced by T-349 / DEF-456, migration 0165. Every row's shape, from
    // here on: a 'position' row ALWAYS carries a store; a 'grant' row MAY (a hold in their own
    // right, at the position row's own store — T-349); every other source NEVER does.
    // `IS NOT DISTINCT FROM` / `IS DISTINCT FROM` throughout — the 0159 version used a bare `=`
    // on its first branch, which is NULL (not FALSE) for a NULL grant_source with a store set, and
    // a CHECK accepts a NULL result. No NULL-source row has ever carried a store (live data,
    // 2026-09-27), but the hole was real; 0165 closes it.
    check(
      'person_grants_store_shape_check',
      sql`(${t.grantSource} is not distinct from 'position' and ${t.storeId} is not null)
          or (${t.grantSource} is not distinct from 'grant')
          or (${t.grantSource} is distinct from 'position' and ${t.grantSource} is distinct from 'grant' and ${t.storeId} is null)`,
    ),
    // T-341, migration 0159. A position row's store must be the store its OWN default belongs to
    // — MATCH SIMPLE (Drizzle's default, unwritten): a 'grant' row that keeps a history ref but no
    // store (storeId NULL) skips this FK entirely; the single-column FK on sourceRef above still
    // requires that history ref to exist. `position_capability_defaults_id_store_unique`
    // (`schema/position-capability-defaults.ts` — hand-added in migration 0159, no Drizzle mirror,
    // same as `stock_locations_id_store_id_key`) is what this composite FK references.
    foreignKey({
      columns: [t.sourceRef, t.storeId],
      foreignColumns: [positionCapabilityDefaults.id, positionCapabilityDefaults.storeId],
      name: 'person_grants_source_ref_store_fk',
    }).onDelete('restrict'),
  ],
);
