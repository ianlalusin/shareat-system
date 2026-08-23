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

export const persons = pgTable('persons', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' }),
  displayName: text('display_name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

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
