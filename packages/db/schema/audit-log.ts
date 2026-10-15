/**
 * audit_log — docs/tasks/101-core-schema.md Contract §7, extended by T-402 (docs/tasks/402-activity-log.md).
 *
 * Append-only (bible §4.2 rule 9): no `updated_at`, rows are never edited. `source`
 * names the four front-ends plus the system callers — the first place this schema admits
 * it serves more than the ERP.
 *
 * T-350 S3 / DEF-169 — org-scoped since migration 0167, which is this table's FIRST writer
 * (`packages/domain/src/channel-settlements/index.ts`'s `setChannelPayoutDestination`, via
 * `auditLogRepo.append`). Before 0167 it had an `org_id`-less shape and was `system_only` in
 * `rls/registry.ts` — RLS enabled with no staff policy at all, so no tenant could ever read it.
 *
 * T-402 S1a — PARTITIONED since migration 0197 (hand-authored; drizzle cannot express partitioning):
 * `PARTITION BY LIST (retention_class)`, each class sub-partitioned `BY RANGE (recorded_at)` per Manila
 * calendar year, no DEFAULT partition. The primary key therefore carries both partition keys.
 * `recorded_at` (server time) is the partition key, never `occurred_at`. Category, sensitivity, severity and
 * retention_class come from the event catalogue (S1b), never from a call site; the CHECKs below bind them.
 * Two side tables live beside it: `audit_log_event_keys` (R10) and `authz_denial_counts` (R9).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';
import { stores } from './stores';

export const auditLog = pgTable(
  'audit_log',
  {
    // NOTE: PARTITION BY LIST (retention_class) -> RANGE (recorded_at), the two policies (SELECT + INSERT, the
    // latter DEF-183-shaped on actor_person_id), the append-only trigger (ENABLE ALWAYS on the parent and every
    // partition), the per-partition REVOKE ALL / FORCE RLS and every CHECK below are hand-added in migrations
    // 0167 and 0197 (ADR-012 §5 item 3).
    id: uuid('id').notNull().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // R1/R14: the store the act belongs to; NULL for an org-level entry. Same-org composite FK in 0197.
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    // Nullable ONLY so a system/cron action can be recorded. A user-initiated action
    // without an actor is a defect, not a valid state — enforced at the service layer,
    // not here (this table has no way to distinguish "system" from "forgot to pass one").
    actorPersonId: uuid('actor_person_id').references(() => persons.id, {
      onDelete: 'restrict',
    }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    source: text('source', {
      enum: [
        'web',
        'pos',
        'customer',
        'website',
        'apk',
        'kiosk',
        'cron',
        'ingestor',
        'etl',
      ],
    }).notNull(),
    category: text('category', {
      enum: ['security', 'order', 'money', 'menu_price', 'stock', 'staff', 'settings', 'data', 'customer'],
    }).notNull(),
    sensitivity: text('sensitivity', { enum: ['critical', 'high', 'normal', 'low'] }).notNull(),
    // RFC 5424 severity bound to sensitivity by a table CHECK: critical 2, high 4, normal 5, low 6.
    severity: smallint('severity').notNull(),
    retentionClass: text('retention_class', { enum: ['r10y', 'r2y'] }).notNull(),
    // When it happened (device time for a replayed offline event).
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    // When the server wrote it: the partition key.
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    // Server-attested terminal (T-304); NULL for a non-terminal write. No FK: a device is not a person and
    // there is no device table yet (POS v2 adds it).
    deviceId: uuid('device_id'),
    // R10: the live session that uploaded an offline event, apart from the actor who did it.
    uploadedByPersonId: uuid('uploaded_by_person_id').references(() => persons.id, { onDelete: 'restrict' }),
    // R10: offline idempotency key (the unique lives in audit_log_event_keys; a UNIQUE here would have to
    // include the partition keys).
    eventKey: text('event_key'),
    redactedKeys: text('redacted_keys').array().notNull().default(sql`'{}'`),
    clockSuspect: boolean('clock_suspect').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.retentionClass, t.recordedAt], name: 'audit_log_pkey' }),
    index('audit_log_entity_entity_id_idx').on(t.entity, t.entityId),
    index('audit_log_org_occurred_idx').on(t.orgId, t.occurredAt.desc(), t.id.desc()),
    index('audit_log_org_store_occurred_idx').on(t.orgId, t.storeId, t.occurredAt.desc()),
    index('audit_log_org_actor_occurred_idx').on(t.orgId, t.actorPersonId, t.occurredAt.desc()),
    index('audit_log_org_sensitive_idx')
      .on(t.orgId, t.occurredAt.desc())
      .where(sql`${t.sensitivity} in ('critical', 'high')`),
    index('audit_log_org_clock_suspect_idx').on(t.orgId, t.occurredAt).where(sql`${t.clockSuspect}`),
    check(
      'audit_log_source_check',
      sql`${t.source} in ('web', 'pos', 'customer', 'website', 'apk', 'kiosk', 'cron', 'ingestor', 'etl')`,
    ),
    check(
      'audit_log_category_check',
      sql`${t.category} in ('security', 'order', 'money', 'menu_price', 'stock', 'staff', 'settings', 'data', 'customer')`,
    ),
    check('audit_log_sensitivity_check', sql`${t.sensitivity} in ('critical', 'high', 'normal', 'low')`),
    check(
      'audit_log_severity_check',
      sql`(${t.sensitivity}, ${t.severity}) in (('critical', 2), ('high', 4), ('normal', 5), ('low', 6))`,
    ),
    check('audit_log_retention_class_check', sql`${t.retentionClass} in ('r10y', 'r2y')`),
    // R7: the database enforces the class too, so no writer bug can file money into the 2-year class.
    check(
      'audit_log_retention_by_sensitivity_check',
      sql`${t.retentionClass} = 'r10y' or (${t.sensitivity} = 'low' and ${t.category} not in ('money', 'order', 'menu_price', 'customer'))`,
    ),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.actorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'audit_log_actor_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'audit_log_store_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.uploadedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'audit_log_uploaded_by_person_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * R10 — one row per offline event key, so a replayed upload returns the first row instead of inserting a second.
 * A separate table because a UNIQUE on a partitioned table must include the partition keys, so `(org_id,
 * event_key)` cannot be unique on `audit_log` itself (bible §4.2 rule 10 wants a UNIQUE). A key lives exactly
 * as long as its log row: `r10y` keys are never pruned; S5 deletes an `r2y` year's keys, per org, BEFORE
 * dropping that year's partition (the composite FK refuses the drop otherwise).
 * NOTE: RLS (ENABLE + FORCE), the SELECT / INSERT / DELETE org policies, the grants and the FK are hand-added in
 * migration 0197.
 */
export const auditLogEventKeys = pgTable(
  'audit_log_event_keys',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    eventKey: text('event_key').notNull(),
    // SHA-256 (hex) of the canonical JSON (RFC 8785) of {action, entityId, storeId, occurredAt, before, after}.
    payloadSha256: text('payload_sha256').notNull(),
    auditLogId: uuid('audit_log_id').notNull(),
    retentionClass: text('retention_class', { enum: ['r10y', 'r2y'] }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.eventKey], name: 'audit_log_event_keys_pkey' }),
    index('audit_log_event_keys_retention_idx').on(t.orgId, t.retentionClass, t.recordedAt),
    index('audit_log_event_keys_audit_log_idx').on(t.auditLogId, t.retentionClass, t.recordedAt),
    check('audit_log_event_keys_sha256_check', sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check('audit_log_event_keys_retention_class_check', sql`${t.retentionClass} in ('r10y', 'r2y')`),
    // Composite FK to audit_log (id, retention_class, recorded_at) - hand-added in 0197 (the target is partitioned).
  ],
);

/**
 * R9 — hourly counters of aggregated `authorize()` denials. Not the log and not append-only: the app role may
 * UPDATE (increment) and DELETE (the roll-up deletes a rolled bucket). `store_id` is NULL for an org-scoped
 * capability, so the natural key is a UNIQUE ... NULLS NOT DISTINCT index (the increment's ON CONFLICT target).
 * NOTE: RLS (ENABLE + FORCE), one org policy per granted command, the grants and the NULLS NOT DISTINCT unique
 * index are hand-added in migration 0197.
 */
export const authzDenialCounts = pgTable(
  'authz_denial_counts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actorPersonId: uuid('actor_person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    capability: text('capability').notNull(),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'restrict' }),
    hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(1),
  },
  (t) => [
    // NULLS NOT DISTINCT is hand-added in 0197 (drizzle's index builder cannot express it).
    uniqueIndex('authz_denial_counts_key_idx').on(t.orgId, t.actorPersonId, t.capability, t.storeId, t.hourBucket),
    index('authz_denial_counts_bucket_idx').on(t.orgId, t.hourBucket),
    check('authz_denial_counts_count_check', sql`${t.count} > 0`),
    foreignKey({
      columns: [t.orgId, t.actorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'authz_denial_counts_actor_person_id_same_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'authz_denial_counts_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
