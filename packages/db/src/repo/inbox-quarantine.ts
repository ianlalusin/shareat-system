/**
 * The only place SQL is written for the inbox quarantine. T-182 (writes), T-183 (reads).
 *
 * ⚠️ T-182 wrote these statements inline in `packages/domain/src/sync/ingestor.ts`. The bible is
 * unambiguous — *"Repositories (lib/db/repo/) <- the ONLY place SQL is written"* — so they moved
 * here when T-183 needed to read the same table. The ingestor's own tests did not change, which is
 * the evidence the move was behaviour-free.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  inboxQuarantine,
  type QuarantineReason,
  type QuarantineResolution,
} from '../../schema/inbox-quarantine';

export interface InboxQuarantineRow {
  id: string;
  orgId: string;
  storeId: string | null;
  clientPunchId: string;
  deviceId: string | null;
  rawEvent: unknown;
  reasonCode: QuarantineReason;
  reasonDetail: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  attempts: number;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolution: QuarantineResolution | null;
  resolutionReason: string | null;
}

/**
 * Insert, or bump an existing row.
 *
 * ⭐ Keyed on `clientPunchId`, so a device that keeps re-sending a doomed event produces ONE row
 * with a rising `attempts` rather than a growing pile — and the same key is what lets it heal.
 *
 * ⚠️ `where inbox_quarantine.resolved_at is null` is doing real work: a row a manager already
 * DISCARDED is never re-opened by another delivery of the same event.
 */
export async function upsertQuarantine(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string | null;
    clientPunchId: string;
    deviceId: string | null;
    rawEvent: unknown;
    reasonCode: QuarantineReason;
    reasonDetail: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into inbox_quarantine (org_id, store_id, client_punch_id, device_id, raw_event, reason_code, reason_detail)
    values (${input.orgId}::uuid, ${input.storeId}::uuid, ${input.clientPunchId},
            ${input.deviceId}::uuid, ${JSON.stringify(input.rawEvent)}::jsonb,
            ${input.reasonCode}, ${input.reasonDetail})
    on conflict (client_punch_id) do update
      set attempts = inbox_quarantine.attempts + 1,
          last_seen_at = now(),
          reason_code = excluded.reason_code,
          reason_detail = excluded.reason_detail
      where inbox_quarantine.resolved_at is null`);
}

/**
 * ⭐ The heal. Returns true when a previously stuck event just came through **with no human
 * action** — `resolved_by` stays null precisely because nobody decided it.
 */
export async function resolveIngested(tx: Tx, clientPunchId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`
    update inbox_quarantine
    set resolved_at = now(), resolution = 'ingested', resolved_by = null
    where client_punch_id = ${clientPunchId} and resolved_at is null
    returning id`)) as unknown as { id: string }[];
  return rows.length > 0;
}

export async function getQuarantine(tx: Tx, id: string): Promise<InboxQuarantineRow | undefined> {
  const [row] = await tx.select().from(inboxQuarantine).where(eq(inboxQuarantine.id, id)).limit(1);
  return row as InboxQuarantineRow | undefined;
}

/**
 * ⛔ The guard behind T-183 invariant 4. A discarded event that the device re-delivers must not
 * quietly resurrect as a punch — a manager already decided, with a reason, and the next ingest run
 * is not the place to overturn it.
 */
export async function findDiscarded(
  tx: Tx,
  clientPunchId: string,
): Promise<InboxQuarantineRow | undefined> {
  const [row] = await tx
    .select()
    .from(inboxQuarantine)
    .where(
      and(
        eq(inboxQuarantine.clientPunchId, clientPunchId),
        eq(inboxQuarantine.resolution, 'discarded'),
      ),
    )
    .limit(1);
  return row as InboxQuarantineRow | undefined;
}

/** Open rows for one store, oldest first — the order a manager should work them in. */
export async function listOpenForStore(tx: Tx, storeId: string): Promise<InboxQuarantineRow[]> {
  const rows = await tx
    .select()
    .from(inboxQuarantine)
    .where(and(eq(inboxQuarantine.storeId, storeId), isNull(inboxQuarantine.resolvedAt)))
    .orderBy(asc(inboxQuarantine.firstSeenAt));
  return rows as InboxQuarantineRow[];
}

/**
 * Open rows that name NO store, org-wide.
 *
 * ⚠️ An `unknown_device` or `malformed` event has no store to file it under — the ingestor could
 * not resolve one, which is *why* it is quarantined. Without this query those rows would be
 * invisible on a per-store screen, and an invisible quarantine is exactly the dead letter this
 * table exists to end (landmine #14).
 */
export async function listOpenUnattributed(tx: Tx): Promise<InboxQuarantineRow[]> {
  const rows = await tx
    .select()
    .from(inboxQuarantine)
    .where(and(isNull(inboxQuarantine.storeId), isNull(inboxQuarantine.resolvedAt)))
    .orderBy(asc(inboxQuarantine.firstSeenAt));
  return rows as InboxQuarantineRow[];
}

export interface ReasonCount {
  reasonCode: QuarantineReason;
  count: number;
}

/** Open rows grouped by reason. `storeId: null` counts the unattributed ones. */
export async function countOpenByReason(tx: Tx, storeId: string | null): Promise<ReasonCount[]> {
  const rows = (await tx.execute(sql`
    select reason_code as "reasonCode", count(*)::int as count
    from inbox_quarantine
    where resolved_at is null
      and ${storeId === null ? sql`store_id is null` : sql`store_id = ${storeId}::uuid`}
    group by reason_code
    order by count desc, reason_code`)) as unknown as ReasonCount[];
  return rows;
}

export async function oldestOpenAt(tx: Tx, storeId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ firstSeenAt: inboxQuarantine.firstSeenAt })
    .from(inboxQuarantine)
    .where(and(eq(inboxQuarantine.storeId, storeId), isNull(inboxQuarantine.resolvedAt)))
    .orderBy(asc(inboxQuarantine.firstSeenAt))
    .limit(1);
  return row?.firstSeenAt ?? null;
}

/**
 * ⭐ How many stuck events came back **on their own** since `since` — resolved as `ingested` with
 * no resolver. This is the number that tells a manager the lane is self-healing rather than merely
 * quiet, and it is the one statistic v1's dead letter could never have produced.
 */
export async function countHealedSince(tx: Tx, storeId: string, since: Date): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as count
    from inbox_quarantine
    where store_id = ${storeId}::uuid
      and resolution = 'ingested'
      and resolved_by is null
      and resolved_at >= ${since.toISOString()}::timestamptz`)) as unknown as { count: number }[];
  return rows[0]?.count ?? 0;
}

/** Most recently resolved first — the audit tail under the open list. */
export async function listResolvedForStore(
  tx: Tx,
  storeId: string,
  limit: number,
): Promise<InboxQuarantineRow[]> {
  const rows = await tx
    .select()
    .from(inboxQuarantine)
    .where(and(eq(inboxQuarantine.storeId, storeId), isNotNull(inboxQuarantine.resolvedAt)))
    .orderBy(desc(inboxQuarantine.resolvedAt))
    .limit(limit);
  return rows as InboxQuarantineRow[];
}

/**
 * ⛔ Never a delete. The row survives forever, naming who discarded it and why — the
 * `inbox_quarantine_discard_attribution_check` constraint refuses either half on its own.
 *
 * ⚠️ `isNull(resolvedAt)` in the WHERE is the double-submit guard: two managers pressing Discard on
 * the same row produce one resolution, not a silent overwrite of the first one's reason.
 */
export async function markDiscarded(
  tx: Tx,
  input: { id: string; by: string; reason: string },
): Promise<InboxQuarantineRow | undefined> {
  const [row] = await tx
    .update(inboxQuarantine)
    .set({
      resolvedAt: new Date(),
      resolvedBy: input.by,
      resolution: 'discarded',
      resolutionReason: input.reason,
    })
    .where(and(eq(inboxQuarantine.id, input.id), isNull(inboxQuarantine.resolvedAt)))
    .returning();
  return row as InboxQuarantineRow | undefined;
}
