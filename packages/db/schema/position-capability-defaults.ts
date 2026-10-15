/**
 * position_capability_defaults — per (position, store) capability defaults, additive to the
 * role matrix. T-289. `docs/tasks/289-position-access-defaults-spine.md` §C1;
 * `docs/plans/289-position-access-defaults-plan.md` §3.1.
 *
 * An administrator decides, once, that every holder of a job gets a capability in addition to
 * whatever the role matrix already grants — bible row 120's pattern ("decide once, at the
 * moment a human is present, and store the answer") applied to jobs. Each row here IS that
 * decision. `reconcilePositionGrants` (`packages/domain/src/people/position-defaults.ts`) is
 * what turns it into ordinary `person_grants` rows, tagged `grant_source = 'position'` with
 * `source_ref` pointing back at the row that justifies it.
 *
 * ## `capability` carries NO CHECK constraint, deliberately
 *
 * Same reasoning as `person_grants.grant_name` — see `access.ts`'s own top comment: a CHECK
 * enumerating every capability here would recreate exactly the thing that column's absence
 * exists to avoid, and `packages/db` must not know `@shareat/auth`'s members (ADR-004 — the
 * workspace dependency runs `@shareat/auth` -> `@shareat/db`, never the reverse).
 *
 * ## `store_id` is NOT NULL even for a canonical (org-wide) position
 *
 * Plan §1 decision 2: a default is per (position, store), always — "same for every store" is an
 * action that writes N rows, never a link that makes them implicitly agree. Lipa's Cashier may
 * default a capability Malvar's Cashier does not.
 *
 * ## `revoked_by` exists here although `person_grants` has none
 *
 * `person_grants`'s own migration (0140) notes a WHO column is its own decision, not folded in
 * silently. This table is new, so that decision is made now — for THIS table only (T-289 §C1.3).
 * Do not backport `revoked_by` onto `person_grants` from this precedent.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid, foreignKey } from 'drizzle-orm/pg-core';
import { positions } from './employment';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const positionCapabilityDefaults = pgTable(
  'position_capability_defaults',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    /** A `Capability` value (`@shareat/auth`). Deliberately NOT a DB check constraint — see this
     *  file's top comment. */
    capability: text('capability').notNull(),
    setBy: uuid('set_by')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => persons.id, { onDelete: 'restrict' }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    index('position_capability_defaults_store_id_idx').on(t.storeId),
    index('position_capability_defaults_position_id_idx').on(t.positionId),
    // At most one ACTIVE default per (position, store, capability) — re-toggling after a
    // revocation inserts a NEW row, so each default's own window (set_at .. revoked_at) stays
    // exact, the same shape `person_grants_active_person_grant_unique` uses.
    uniqueIndex('position_capability_defaults_active_unique')
      .on(t.positionId, t.storeId, t.capability)
      .where(sql`${t.revokedAt} is null`),
    // ⛔ NULL-BLIND TRAP, avoided on purpose — copied verbatim from `person_grants_revoke_check`
    // (`access.ts`) and extended to the third column this table adds (`revoked_by`): a CHECK
    // passes when its expression evaluates to NULL, so the naive spelling admits a revoked row
    // with a missing reason or a missing revoker. The explicit `IS NOT NULL` terms are
    // load-bearing (0140's own header explains the trap; this is a copy, not a re-derivation).
    check(
      'position_capability_defaults_revoke_check',
      sql`(${t.revokedAt} is null and ${t.revokedBy} is null and ${t.revokeReason} is null)
          or (${t.revokedAt} is not null and ${t.revokedBy} is not null
              and ${t.revokeReason} is not null and btrim(${t.revokeReason}) <> '')`,
    ),
    // NOTE: store-invented positions may only default at their OWN store —
    // `positions.store_id IS NULL OR positions.store_id = store_id` — a cross-table rule
    // Drizzle's builder cannot express and Postgres cannot either without a trigger, the same
    // limit `employment.ts:132-135` documents for its own cross-table rule. Enforced in the
    // DOMAIN (`setPositionDefault`, packages/domain/src/people/position-defaults.ts) and proven
    // by integration test, not by a CHECK here.,
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.revokedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'position_capability_defaults_revoked_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.setBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'position_capability_defaults_set_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'position_capability_defaults_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
