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
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
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
  },
  (t) => [
    uniqueIndex('person_store_scope_person_id_store_id_unique').on(t.personId, t.storeId),
    index('person_store_scope_person_id_idx').on(t.personId),
    index('person_store_scope_store_id_idx').on(t.storeId),
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
  },
  (t) => [
    index('person_grants_person_id_idx').on(t.personId),
    // At most one ACTIVE grant per (person, grant_name) — re-granting after a revocation
    // inserts a new row rather than un-revoking the old one, so each grant's own window
    // (granted_at .. revoked_at) stays exact.
    uniqueIndex('person_grants_active_person_grant_unique')
      .on(t.personId, t.grantName)
      .where(sql`${t.revokedAt} is null`),
  ],
);
