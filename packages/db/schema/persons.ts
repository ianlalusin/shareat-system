/**
 * persons + person_identities — the identity spine. docs/tasks/101-core-schema.md
 * Contract §4.
 *
 * `persons` is one row per human being, independent of how they authenticate.
 * `person_identities` is many-per-person: a phone number, an email, a firebase uid, a
 * staff number, a device hash. This retires DEF-009 — CUSTOMER alone had three
 * incompatible identity schemes (a hashed device id, a phone number used as the document
 * id, and a `d_`-prefixed game device id), plus staff identity in POS/ERP and a
 * `customers/{phone}` upsert from the Website. A phone number is a natural key that
 * changes; it is never a primary key here.
 *
 * Out of scope for T-101: roles and permissions. Identity answers *who you are*;
 * authorization ("what you may do") arrives with its own task (bible §7 rule 3).
 */
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';

export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    displayName: text('display_name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * ⭐ T-304 — explicit, not inferred. A shared-terminal Firebase credential (option (a),
     * `docs/tasks/304-two-layer-terminal-sign-in.md` §Q1) is attached to a `persons` row that is
     * not a human being, and every place that would otherwise treat it as one — a role grant, a
     * staff listing, a headcount — must read THIS column rather than a proxy like
     * `credential.storeId is not null`, which is an implicit rule two conventions away from being
     * wrong (the spec's own words).
     */
    kind: text('kind', { enum: ['person', 'terminal'] }).notNull().default('person'),
    /**
     * ⭐ T-190 (migration 0206) - government numbers. PERSONAL DATA: read only behind `run_payroll` / `enrol_staff`. A missing number
     * means that agency is NOT deducted for the person (Ian, 16 Oct). Digits only; the format CHECKs are hand-added in 0206.
     */
    sssNo: text('sss_no'),
    philhealthNo: text('philhealth_no'),
    pagibigNo: text('pagibig_no'),
    tin: text('tin'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('persons_kind_check', sql`${t.kind} in ('person', 'terminal')`),
    check('persons_sss_no_format_check', sql`${t.sssNo} is null or ${t.sssNo} ~ '^[0-9]{10}$'`),
    check('persons_philhealth_no_format_check', sql`${t.philhealthNo} is null or ${t.philhealthNo} ~ '^[0-9]{12}$'`),
    check('persons_pagibig_no_format_check', sql`${t.pagibigNo} is null or ${t.pagibigNo} ~ '^[0-9]{12}$'`),
    check('persons_tin_format_check', sql`${t.tin} is null or ${t.tin} ~ '^[0-9]{9,12}$'`),
    // NOTE: persons_org_id_id_unique UNIQUE (org_id, id) - hand-added in migration 0194 (T-398 S1 /
    // DEF-491), no Drizzle mirror here. Trivially true (id alone is already unique); it exists so
    // the 153 composite `(org_id, "<col>") REFERENCES persons (org_id, id)` same-org FKs declared
    // beside their own tables have a real unique target.
  ],
);

export const personIdentities = pgTable(
  'person_identities',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // ON DELETE CASCADE is deliberate here and only here (bible §4.2 rule 3): an identity
    // is genuinely part of its person, not an independent record.
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['firebase_uid', 'phone', 'email', 'staff_no', 'device_hash'],
    }).notNull(),
    value: text('value').notNull(),
    isVerified: boolean('is_verified').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('person_identities_person_id_idx').on(t.personId),
    check(
      'person_identities_kind_check',
      sql`${t.kind} in ('firebase_uid', 'phone', 'email', 'staff_no', 'device_hash')`,
    ),
    // NOTE: the identity-defining rule — UNIQUE (kind, lower(trim(value))) — is an
    // expression index Drizzle cannot express through this builder. It is hand-added in
    // the generated migration (Contract §8). Deliberately NO unique constraint on
    // (person_id, kind): a person may hold two phones.
  ],
);
