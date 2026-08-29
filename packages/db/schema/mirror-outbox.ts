/**
 * mirror_outbox — the transactional outbox behind Lane A. T-160.
 * `docs/tasks/160-lane-a-publisher.md`, bible §5.1.
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
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { stores } from './stores';

/**
 * The hot set is **closed** (bible §5.3). These are the three of six this task publishes.
 *
 * ⛔ Adding a fourth requires a bible amendment, and one is already pending: a **card id** is not in
 * hot-set item 1, and D1 makes card the only browser-viable offline mode. Until Ian amends §5.3 the
 * offline card path stays blocked — that is the phase's critical path, not a footnote.
 */
export const MIRROR_ENTITIES = ['roster', 'attendance_config', 'day_feed'] as const;
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
    check('mirror_outbox_entity_check', sql`${t.entity} in ('roster','attendance_config','day_feed')`),
    check('mirror_outbox_op_check', sql`${t.op} in ('upsert','delete')`),
    check('mirror_outbox_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
