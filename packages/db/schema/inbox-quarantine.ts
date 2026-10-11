/**
 * inbox_quarantine — an event that could not be ingested, and can still be recovered. T-182.
 * `docs/tasks/182-lane-b-ingestor.md`, bible §5.4 rule 5.
 *
 * ## The failure this table exists to end
 *
 * Landmine #14, from discovery 05 §6, about v1:
 *
 * > *"**no admin/manager UI was found anywhere in the app that reads dead-lettered punches** out of
 * > a device's IndexedDB, inspects them, or lets a manager manually re-file the underlying
 * > attendance session. Recovery today appears to be entirely informal."*
 *
 * ⭐ **In v2 the event lives in Firestore, not in a private device store**, so it is never
 * unreachable — which is what makes a real quarantine possible at all rather than a dead letter
 * with better manners. §5.4 rule 5: *"If an event cannot be ingested, it is **quarantined and
 * surfaced**, never dropped."*
 *
 * ## ⭐ A quarantine HEALS; a dead letter does not
 *
 * `clientPunchId` is UNIQUE, so re-delivery updates the same row rather than piling up. An event
 * quarantined as `unknown_credential` at 09:00 ingests cleanly at 09:05 once the staffer is
 * enrolled — **with no human action at all**. That is the whole point of the design, and it is why
 * this is a quarantine rather than a bin.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { clockTerminals } from './clock-terminals';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

/**
 * A closed set, because a screen has to render each one as a sentence a manager can act on (T-183).
 *
 * ⚠️ **`too_old` is deliberately absent.** v1 rejects a punch past 72 hours and dead-letters it;
 * plan §5 D3 dissolved that — the event is reachable in Firestore, so ingest always accepts and
 * T-157 raises `late_event_arrival` for a manager to confirm. **Ingest is not where a business
 * judgement is made** (bible §5.1: events are raw facts; Postgres adjudicates).
 */
export const QUARANTINE_REASONS = [
  'malformed',
  'unknown_device',
  'revoked_device',
  'unknown_credential',
  'method_disabled',
  'store_mismatch',
  'future_timestamp',
  'internal_error',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

/** ⛔ Never a silent delete. A discarded event keeps its row and names who discarded it. */
export const QUARANTINE_RESOLUTIONS = ['ingested', 'discarded'] as const;
export type QuarantineResolution = (typeof QUARANTINE_RESOLUTIONS)[number];

export const inboxQuarantine = pgTable(
  'inbox_quarantine',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** ⚠️ Nullable: a `store_mismatch` event is quarantined precisely because we cannot trust the
     *  store it claims, so the terminal's own store is used and the claim stays in `rawEvent`. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),

    /** ⭐ The same key the punch would have used, so a re-delivery UPDATES rather than piles up. */
    clientPunchId: text('client_punch_id').notNull(),

    /** Nullable: an `unknown_device` event names a terminal we cannot resolve. */
    deviceId: uuid('device_id').references(() => clockTerminals.id, { onDelete: 'restrict' }),

    /**
     * ⛔ The event **exactly as received**, uninterpreted. Bible §11 rule 5: *"Dirty data is
     * surfaced, not silently coerced."* This is the one `jsonb` column in the phase and it earns
     * it — by definition we failed to parse this shape, so storing our reading of it would store
     * the mistake instead of the evidence.
     */
    rawEvent: jsonb('raw_event').notNull(),

    reasonCode: text('reason_code', { enum: QUARANTINE_REASONS }).notNull(),
    /** Prose for a human. The code is for the database. */
    reasonDetail: text('reason_detail'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(1),

    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => persons.id, { onDelete: 'restrict' }),
    resolution: text('resolution', { enum: QUARANTINE_RESOLUTIONS }),
    resolutionReason: text('resolution_reason'),
  },
  (t) => [
    uniqueIndex('inbox_quarantine_client_punch_id_unique').on(t.clientPunchId),
    /** The screen's query: unresolved, oldest first. */
    index('inbox_quarantine_open_idx').on(t.storeId, t.resolvedAt, t.firstSeenAt),
    index('inbox_quarantine_reason_idx').on(t.reasonCode),

    check('inbox_quarantine_reason_check', sql`${t.reasonCode} in ('malformed','unknown_device','revoked_device','unknown_credential','method_disabled','store_mismatch','future_timestamp','internal_error')`),
    check('inbox_quarantine_resolution_check', sql`${t.resolution} is null or ${t.resolution} in ('ingested','discarded')`),
    check('inbox_quarantine_resolved_pair_check', sql`(${t.resolvedAt} is null) = (${t.resolution} is null)`),
    /**
     * ⭐ `resolvedBy` is nullable ON PURPOSE, and only for `ingested`. A quarantine that **heals**
     * has no person behind it — the staffer got enrolled, the event was re-delivered, and it went
     * through on its own. Demanding an attributor would force a sentinel person into the audit
     * trail and make an automatic recovery read as somebody's decision.
     */
    check('inbox_quarantine_resolver_check', sql`${t.resolvedBy} is null or ${t.resolvedAt} is not null`),
    /** ⛔ DISCARDING is the one action that loses a real shift: it needs both a human and a reason. */
    check(
      'inbox_quarantine_discard_attribution_check',
      sql`${t.resolution} is distinct from 'discarded'
          or (${t.resolvedBy} is not null and ${t.resolutionReason} is not null)`,
    ),
    check('inbox_quarantine_attempts_check', sql`${t.attempts} >= 1`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.resolvedBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'inbox_quarantine_resolved_by_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'inbox_quarantine_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
