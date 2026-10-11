/**
 * mirror_outbox — the transactional outbox behind Lane A. T-181.
 * `docs/tasks/181-lane-a-publisher.md`, bible §5.1.
 *
 * ## The pattern, named before the design (bible §0.2)
 *
 * **Transactional outbox.** The row change and its publish intent commit in *one* transaction; a
 * relay drains the outbox afterwards. Bible §15.4 already forbids dual-write, and this is the
 * sanctioned way to keep that promise — a post-commit hook loses the publish when the process dies
 * between the two, and afterwards there is no way to tell that it did.
 *
 * ⭐ **Rows are enqueued by DATABASE TRIGGERS, not by service calls.** The outbox's guarantee is
 * *"the change and its intent commit together"*, and a trigger makes that true by construction for
 * every write path that will ever exist — including a backfill, a cron, or a module written in
 * November. Bible §12's standard is *"structurally impossible, not merely avoided by care"*, and a
 * service call that a future writer forgets is exactly care.
 *
 * ## ⛔ There is no payload column, deliberately
 *
 * The relay re-reads the source row at publish time. A queue that has fallen behind therefore
 * publishes **current** truth rather than replaying a stale snapshot. §5.1 permits a mirror to be
 * stale; it does not permit it to be **wrong**, and a stored payload is how those two come apart.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';

/**
 * The hot set is **closed** (bible §5.3). These are four of the six.
 *
 * ⛔ Adding one requires a bible amendment, and `credential` is the amendment: §13 row 164, on
 * Ian's *"add cardid, update bible"*, put the card id into hot-set item **2** (the credential
 * mirror, terminal-only) rather than item 1 (the roster, readable by any store member). A card is a
 * bearer credential, so on the roster every store member could read every badge and clock in as any
 * colleague — the placement is the whole decision, not a filing detail.
 *
 * ⚠️ `credential` is the ONLY entity that publishes outside `mirror/` — it goes to
 * `biometricMirror/{storeId}/credentials/{id}`, which T-159's ruleset guards with a separate match
 * block so that no OR can ever widen it to a human.
 */
export const MIRROR_ENTITIES = ['roster', 'attendance_config', 'day_feed', 'credential'] as const;
export type MirrorEntity = (typeof MIRROR_ENTITIES)[number];

export const MIRROR_OPS = ['upsert', 'delete'] as const;
export type MirrorOp = (typeof MIRROR_OPS)[number];

export const mirrorOutbox = pgTable(
  'mirror_outbox',
  {
    /**
     * ⭐ `bigserial`, not `uuidv7()` — the only table in this phase that is not a uuid. The relay
     * reads in **insertion order** and a monotonic integer is the cheapest possible watermark.
     */
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),

    entity: text('entity', { enum: MIRROR_ENTITIES }).notNull(),
    /** The Postgres PK. ⭐ §5.1: the Firestore document id *"is the Postgres primary key"*. */
    entityId: uuid('entity_id').notNull(),
    op: text('op', { enum: MIRROR_OPS }).notNull(),

    /**
     * ⭐ From ONE global sequence, never `updated_at`. Two rows updated in the same millisecond are
     * indistinguishable by timestamp, and clock skew between writers makes "newer" unanswerable.
     * A sequence is a total order by construction, which is what §5.1's *"the publisher writes only
     * when `srcVersion` is newer"* actually requires.
     */
    srcVersion: bigint('src_version', { mode: 'bigint' }).notNull(),

    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    /** The drain query, and the only one that matters. Unpublished first, in insertion order. */
    index('mirror_outbox_drain_idx').on(t.publishedAt, t.id),
    index('mirror_outbox_entity_idx').on(t.entity, t.entityId),
    check('mirror_outbox_entity_check', sql`${t.entity} in ('roster','attendance_config','day_feed','credential')`),
    check('mirror_outbox_op_check', sql`${t.op} in ('upsert','delete')`),
    check('mirror_outbox_attempts_check', sql`${t.attempts} >= 0`),
    // T-398 S1 / DEF-491, migration 0194 - same-org twins of the single-column persons/stores FKs
    // above: RLS checks only this row's own org_id and the FK check runs as the table owner, so a
    // cross-org person/store was accepted. They reference `persons_org_id_id_unique` /
    // `stores_org_id_id_unique` (hand-added in migration 0194, see schema/persons.ts, schema/stores.ts).
    foreignKey({
      columns: [t.orgId, t.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: 'mirror_outbox_store_id_same_org_fk',
    }).onDelete('restrict'),
  ],
);
