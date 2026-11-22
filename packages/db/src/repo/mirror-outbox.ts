/**
 * The only place SQL is written for the Lane A outbox. T-181 (drain), T-183 (health).
 *
 * ⚠️ Like `inbox-quarantine.ts`, these statements began inline in
 * `packages/domain/src/sync/publisher.ts` and moved here when a second caller needed the table.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';
import type { MirrorEntity, MirrorOp } from '../../schema/mirror-outbox';

export interface OutboxRow {
  id: string;
  orgId: string;
  storeId: string;
  entity: MirrorEntity;
  entityId: string;
  op: MirrorOp;
  srcVersion: string;
}

/**
 * The drain query, and the only one that matters: unpublished first, in insertion order.
 *
 * ⭐ `for update skip locked` is what lets two relays run at once without publishing the same row
 * twice — the standard transactional-outbox claim, and the reason the id is a monotonic integer
 * rather than a uuid.
 */
export async function claimUnpublished(tx: Tx, limit: number): Promise<OutboxRow[]> {
  return (await tx.execute(sql`
    select id::text as id, org_id as "orgId", store_id as "storeId",
           entity, entity_id as "entityId", op, src_version::text as "srcVersion"
    from mirror_outbox
    where published_at is null
    order by id
    limit ${limit}
    for update skip locked`)) as unknown as OutboxRow[];
}

export async function markPublished(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`update mirror_outbox set published_at = now() where id = ${id}::bigint`);
}

/** ⛔ The row stays unpublished and is retried. Bible §5.4 rule 5 — never silently dropped. */
export async function recordFailure(tx: Tx, id: string, error: string): Promise<void> {
  await tx.execute(sql`
    update mirror_outbox
    set attempts = attempts + 1, last_error = ${error.slice(0, 500)}
    where id = ${id}::bigint`);
}

export interface OutboxLag {
  /** When the oldest still-unpublished row was enqueued, or null when the queue is drained. */
  oldestEnqueuedAt: Date | null;
  pending: number;
  /** ⚠️ The most-retried pending row's error, which is usually the reason the queue is stuck. */
  worstAttempts: number;
  lastError: string | null;
}

/**
 * ⭐ The lag is measured from `enqueued_at`, not from a count. A queue of 4,000 rows drained a
 * second ago is healthy; a queue of ONE row enqueued at breakfast is not — and a count alone
 * cannot tell those apart.
 */
export async function outboxLag(tx: Tx, storeId: string): Promise<OutboxLag> {
  const rows = (await tx.execute(sql`
    select min(enqueued_at) as "oldestEnqueuedAt",
           count(*)::int as pending,
           coalesce(max(attempts), 0)::int as "worstAttempts"
    from mirror_outbox
    where store_id = ${storeId}::uuid and published_at is null`)) as unknown as {
    oldestEnqueuedAt: Date | null;
    pending: number;
    worstAttempts: number;
  }[];
  const agg = rows[0] ?? { oldestEnqueuedAt: null, pending: 0, worstAttempts: 0 };

  const errs = (await tx.execute(sql`
    select last_error as "lastError"
    from mirror_outbox
    where store_id = ${storeId}::uuid and published_at is null and last_error is not null
    order by attempts desc, id
    limit 1`)) as unknown as { lastError: string | null }[];

  return {
    oldestEnqueuedAt: agg.oldestEnqueuedAt ? new Date(agg.oldestEnqueuedAt) : null,
    pending: agg.pending,
    worstAttempts: agg.worstAttempts,
    lastError: errs[0]?.lastError ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// T-625: re-seeding the mirror into an EMPTY Firestore. The relay only publishes what is queued, so a new project needs one
// fresh row per entity the mirror shows TODAY. "Live" is the inverse of publisher.buildDocument's tombstone tests: a live
// roster row is an employment that has not ended whose person is active; a live credential is not revoked; the live config
// is the unsuperseded one per store. Historic day_feed rows and tombstones are absent on purpose: a new Firestore has
// nothing to delete.
// ---------------------------------------------------------------------------------------------
const LIVE_ENTITIES = sql`
  select 'roster'::text as entity, e.id as entity_id, e.org_id, e.store_id
    from employments e join persons p on p.id = e.person_id
    where e.ended_on is null and p.is_active
  union all
  select 'credential'::text, c.id, c.org_id, c.store_id
    from attendance_credentials c where c.revoked_at is null
  union all
  select 'attendance_config'::text, s.id, s.org_id, s.store_id
    from store_attendance_config s where s.superseded_at is null`;

export interface LiveCoverage {
  entity: MirrorEntity;
  live: number;
  /** Live entities with no outbox row at all (a hole: the trigger never fired for them). */
  noRow: number;
  /** Live entities with no UNPUBLISHED row (what a re-seed would enqueue). */
  noPending: number;
}

/** Read-only. Counts per entity across every org; no ids. */
export async function liveCoverage(tx: Tx): Promise<LiveCoverage[]> {
  return (await tx.execute(sql`
    with live as (${LIVE_ENTITIES})
    select l.entity,
      count(*)::int as live,
      (count(*) filter (where not exists (
        select 1 from mirror_outbox o where o.entity = l.entity and o.entity_id = l.entity_id)))::int as "noRow",
      (count(*) filter (where not exists (
        select 1 from mirror_outbox o
        where o.entity = l.entity and o.entity_id = l.entity_id and o.published_at is null)))::int as "noPending"
    from live l group by l.entity order by l.entity`)) as unknown as LiveCoverage[];
}

/**
 * Enqueue ONE upsert row per live entity that has no unpublished row yet (a second run adds nothing). Same insert as the
 * `mirror_enqueue` trigger: a fresh nextval of mirror_version_seq. Returns rows added per entity.
 */
export async function enqueueLiveEntities(tx: Tx): Promise<Record<string, number>> {
  const rows = (await tx.execute(sql`
    with live as (${LIVE_ENTITIES}),
    ins as (
      insert into mirror_outbox (org_id, store_id, entity, entity_id, op, src_version)
      select l.org_id, l.store_id, l.entity, l.entity_id, 'upsert', nextval('mirror_version_seq')
      from live l
      where not exists (
        select 1 from mirror_outbox o
        where o.entity = l.entity and o.entity_id = l.entity_id and o.published_at is null)
      returning entity)
    select entity, count(*)::int as n from ins group by entity`)) as unknown as { entity: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.entity, r.n]));
}

/** Unpublished rows per org (the relay drains each org separately). */
export async function pendingPerOrg(tx: Tx): Promise<number[]> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n from mirror_outbox where published_at is null group by org_id`)) as unknown as { n: number }[];
  return rows.map((r) => r.n);
}
