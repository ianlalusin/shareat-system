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
