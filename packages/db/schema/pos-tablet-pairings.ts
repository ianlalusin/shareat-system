/**
 * T-464 (migration 0214) - which browser is the store's paired POS tablet.
 * docs/tasks/464-pos-tablet-sign-in.md.
 *
 * A manager or admin pairs a tablet once. The server mints 32 random bytes, keeps only their sha256 here (`cookie_digest`), and the
 * tablet keeps the bytes in one httpOnly cookie. After that the sign-in screen asks only Employee ID + PIN. Revoking sets
 * `revoked_at`; nothing is ever deleted. ONE live pairing per store: pairing a new tablet revokes the old one in the same transaction.
 *
 * The pre-sign-in lookup (token hash -> live pairing) is the one lookup of bible row 382 on the auth door; it reads this table only.
 * Same-org composite FKs from birth (T-398), so this table is NOT in same-org-fk-exemptions.
 */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const posTabletPairings = pgTable(
  'pos_tablet_pairings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id').notNull(),
    /** What the manager called it ("Lipa counter"); shown on the sign-in screen and typed back to un-pair. */
    label: text('label').notNull(),
    /** keyed sha256 (hex) of the cookie's 32 random bytes. The bytes themselves are never stored. */
    cookieDigest: text('cookie_digest').notNull(),
    pairedBy: uuid('paired_by').notNull(),
    pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set on each successful tablet sign-in; a pairing unused for 30 days stops resolving. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** revoked_at and revoked_by are NULL together while the pairing is live. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    uniqueIndex('pos_tablet_pairings_cookie_digest_unique').on(t.cookieDigest),
    // NOTE: partial unique index, hand-added in migration 0214 - at most one LIVE pairing per store.
    uniqueIndex('pos_tablet_pairings_live_store_unique').on(t.storeId).where(sql`${t.revokedAt} is null`),
    index('pos_tablet_pairings_org_store_idx').on(t.orgId, t.storeId),
    check('pos_tablet_pairings_label_check', sql`length(btrim(${t.label})) > 0`),
    check('pos_tablet_pairings_revoked_shape_check', sql`(${t.revokedAt} is null) = (${t.revokedBy} is null)`),
    foreignKey({ columns: [t.orgId, t.storeId], foreignColumns: [stores.orgId, stores.id], name: 'pos_tablet_pairings_store_id_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.pairedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_tablet_pairings_paired_by_same_org_fk' }).onDelete('restrict'),
    foreignKey({ columns: [t.orgId, t.revokedBy], foreignColumns: [persons.orgId, persons.id], name: 'pos_tablet_pairings_revoked_by_same_org_fk' }).onDelete('restrict'),
  ],
);

export type PosTabletPairing = typeof posTabletPairings.$inferSelect;
