/**
 * clock_terminals — a device that authenticates as ITSELF. T-159.
 * `docs/tasks/159-firestore-rules-and-device-identity.md`, bible §5.3.
 *
 * ## ⛔ There is no secret column here, and that is the design
 *
 * Bible §5.3, non-negotiable: *"the biometric mirror is readable **only by a provisioned device
 * identity**… Device identities authenticate with a server-issued credential, and that credential
 * is **not** plaintext in `localStorage`."*
 *
 * v1 stores `{id, secret}` in the clear in `localStorage` (`offline-clock-device.ts:31-51`). That
 * is a bearer credential for **every enrolled staffer's fingerprint template at that store**,
 * readable by anything that can run a line of JavaScript in that origin.
 *
 * ⭐ **The fix is not encryption, it is delegation.** The device signs in to Firebase Auth once with
 * a one-time custom token; from then on the *SDK* holds the refresh material in its own storage and
 * rotates the short-lived ID token itself. There is no long-lived secret of ours on the device to
 * leak, and revocation is a server-side act rather than a hope.
 *
 * ⚠️ If a reviewer ever finds a `secret` column on this table, the design has been misread.
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/** `terminal:{clockTerminals.id}` — deterministic, so re-provisioning cannot orphan an auth user. */
export const terminalFirebaseUid = (terminalId: string) => `terminal:${terminalId}`;

export const clockTerminals = pgTable(
  'clock_terminals',
  {
    /**
     * ⭐ **This id IS the `deviceId` claim** carried in the device's Firebase token and written on
     * every inbox event. One identifier end to end — no mapping table, and nothing to get out of
     * step between the token, the event and the row.
     */
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The one store this terminal may ever read. Scope is a column, not a claim we re-derive. */
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    /** What a manager recognises it by — "Counter tablet". */
    label: text('label').notNull(),

    firebaseUid: text('firebase_uid').notNull(),

    provisionedBy: uuid('provisioned_by').references(() => persons.id, { onDelete: 'restrict' }),
    provisionedAt: timestamp('provisioned_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * ⚠️ NULL until the device completes its FIRST sign-in, and the distinction is operational.
     * T-153 finding 3: a device **cannot begin authenticating offline**. A terminal provisioned and
     * carried out of signal before it has ever signed in has no identity and cannot write a single
     * punch — so "provisioned" and "ready" are different states and the screen must say which.
     */
    activatedAt: timestamp('activated_at', { withTimezone: true }),

    /** Stamped by the ingestor. A terminal silent for a day is an operational signal (T-162). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => persons.id, { onDelete: 'restrict' }),
    revokeReason: text('revoke_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('clock_terminals_firebase_uid_unique').on(t.firebaseUid),
    index('clock_terminals_store_id_idx').on(t.storeId),
    index('clock_terminals_org_id_idx').on(t.orgId),
    /** The health query (T-162): live terminals, oldest-seen first. */
    index('clock_terminals_last_seen_idx').on(t.storeId, t.lastSeenAt),

    /** Revocation is a triple or none of it — a revoked row nobody can explain is not an audit trail. */
    check(
      'clock_terminals_revoked_triple_check',
      sql`(${t.revokedAt} is null and ${t.revokedBy} is null and ${t.revokeReason} is null)
          or (${t.revokedAt} is not null and ${t.revokedBy} is not null and ${t.revokeReason} is not null)`,
    ),
    check('clock_terminals_label_not_blank_check', sql`length(trim(${t.label})) > 0`),
  ],
);
