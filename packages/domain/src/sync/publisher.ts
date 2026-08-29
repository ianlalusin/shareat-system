/**
 * The Lane A relay: drain the outbox, publish the mirror. T-160.
 * `docs/tasks/160-lane-a-publisher.md`, bible §5.1.
 *
 * ⭐ **Transport-free.** This module knows nothing about Firestore. `packages/sync-firestore` is the
 * one place `firebase-admin` is imported for this lane, exactly as `packages/storage-firebase` is
 * for the bucket — *"domain code depends on the shape; exactly one package depends on the SDK"*.
 *
 * ⚠️ **Runs as a scheduled job, never in the request path.** A publish that fails must not fail the
 * business transaction that enqueued it — that would reintroduce the dual-write coupling the outbox
 * exists to remove (bible §15.4).
 */
import { sql } from 'drizzle-orm';
import { mirrorOutboxRepo, type OutboxRow, type Tx } from '@shareat/db';
import type { MirrorEntity } from '@shareat/db/schema';

/** One document to write, or tombstone, in the mirror. */
export interface MirrorDocument {
  /** `mirror/{storeId}/{collection}/{docId}` or `biometricMirror/...`. */
  path: string;
  /** ⛔ Undefined for a tombstone — the driver writes `{ deletedAt, srcVersion }` instead. */
  data?: Record<string, unknown>;
  srcVersion: string;
  deleted: boolean;
}

/** What a mirror transport must do. Faked in tests, which is the point of naming it here. */
export interface MirrorDriver {
  /**
   * Write these documents. ⭐ Must be idempotent and must not regress: a document already carrying
   * a `srcVersion` **greater than or equal** to the incoming one is left alone (§5.1: *"The
   * publisher writes only when `srcVersion` is newer"*).
   */
  publish(documents: readonly MirrorDocument[]): Promise<void>;
}

export interface DrainReport {
  seen: number;
  published: number;
  skipped: number;
  failed: number;
  byEntity: Record<string, number>;
}

/**
 * ⭐ **Config first, always.** Bible §5.3 marks hot-set item 3 *priority*, and landmine #15 is what
 * happens without it: *"a terminal keeps accepting a credential method an admin has just disabled
 * and the rejection surfaces only at sync time, as a silent dead letter."*
 *
 * A kill switch that arrives after the roster is a kill switch that did not work.
 */
const ENTITY_PRIORITY: Record<MirrorEntity, number> = {
  attendance_config: 0,
  // ⭐ Credentials rank ABOVE the roster, for the same reason the kill switch ranks above both: a
  // REVOKED badge that arrives after the roster is a badge that still punched. The roster tells a
  // terminal who exists; the credential tells it what may clock them in, and the second is the one
  // that lets somebody be paid.
  credential: 1,
  roster: 2,
  day_feed: 3,
};

/**
 * Drain a batch. Returns a report rather than a boolean — bible §11 rule 3: *"'It ran without
 * errors' is not evidence; the reconciliation report is."*
 */
export async function drainOutbox(
  tx: Tx,
  driver: MirrorDriver,
  options: { limit?: number } = {},
): Promise<DrainReport> {
  const limit = options.limit ?? 500;

  const rows = await mirrorOutboxRepo.claimUnpublished(tx, limit);

  const report: DrainReport = { seen: rows.length, published: 0, skipped: 0, failed: 0, byEntity: {} };
  if (rows.length === 0) return report;

  // ⚠️ Sorted by entity priority, then by id. Ordering by id alone would let a roster row enqueued
  // a millisecond earlier reach the terminal before the kill switch that should have preceded it.
  const ordered = [...rows].sort(
    (a, b) => ENTITY_PRIORITY[a.entity] - ENTITY_PRIORITY[b.entity] || Number(a.id) - Number(b.id),
  );

  for (const row of ordered) {
    try {
      // ⭐ The source is re-read HERE, at publish time — which is why the outbox carries no payload.
      // A queue that has fallen behind therefore publishes CURRENT truth rather than replaying a
      // stale snapshot. A mirror may be stale; it may not be wrong.
      const document = await buildDocument(tx, row);

      if (!document) {
        // The source row is gone and this was not a delete — nothing to publish and nothing wrong.
        await mirrorOutboxRepo.markPublished(tx, row.id);
        report.skipped++;
        continue;
      }

      await driver.publish([document]);
      await mirrorOutboxRepo.markPublished(tx, row.id);
      report.published++;
      report.byEntity[row.entity] = (report.byEntity[row.entity] ?? 0) + 1;
    } catch (error) {
      // ⛔ The row stays unpublished and is retried. §5.4 rule 5 — never silently dropped.
      await mirrorOutboxRepo.recordFailure(tx, row.id, String(error));
      report.failed++;
    }
  }

  return report;
}

/** Re-read the source and shape the document. Returns null when there is nothing to say. */
async function buildDocument(tx: Tx, row: OutboxRow): Promise<MirrorDocument | null> {
  const base = { srcVersion: row.srcVersion };

  if (row.entity === 'roster') {
    const path = `mirror/${row.storeId}/roster/${row.entityId}`;
    const found = (await tx.execute(sql`
      select e.id, e.staff_code as "staffCode", e.employment_status as "employmentStatus",
             p.display_name as "displayName", e.ended_on as "endedOn", p.is_active as "personActive",
             coalesce(
               (select pos.name from employment_positions ep
                 join positions pos on pos.id = ep.position_id
                where ep.employment_id = e.id and ep.is_primary limit 1), null) as "position"
      from employments e join persons p on p.id = e.person_id
      where e.id = ${row.entityId}::uuid`)) as unknown as Record<string, unknown>[];

    const employment = found[0];
    // ⛔ TOMBSTONE, never a hard delete. §5.1: "an offline device must be able to learn that a
    // record went away". A hard delete is invisible to a device that was offline when it happened —
    // it simply keeps the stale row forever.
    const gone =
      row.op === 'delete' ||
      !employment ||
      employment.endedOn !== null ||
      employment.personActive === false;
    if (gone) return { path, ...base, deleted: true };

    return {
      path,
      ...base,
      deleted: false,
      data: {
        employmentId: employment.id,
        staffCode: employment.staffCode,
        displayName: employment.displayName,
        position: employment.position,
        employmentStatus: employment.employmentStatus,
      },
    };
  }

  if (row.entity === 'attendance_config') {
    /**
     * ⚠️ **The one place the document id is NOT the source PK**, and it is deliberate. §5.1 says the
     * id *"is the Postgres primary key"*; here it is the fixed string `current`, because a terminal
     * must find *the config in force for my store* without knowing which config row that is — and
     * the rows are effective-dated, so the id changes on every policy change. The PK travels in the
     * body as `configId`, so nothing is lost.
     */
    const path = `mirror/${row.storeId}/config/current`;
    const found = (await tx.execute(sql`
      select id, required_hours_per_shift as "requiredHoursPerShift", half_day_hours as "halfDayHours",
             allowed_shift_start_hours as "allowedShiftStartHours", anchor_window_minutes as "anchorWindowMinutes",
             break_enabled as "breakEnabled", credential_nfc as "credentialNfc",
             credential_fingerprint as "credentialFingerprint", credential_face as "credentialFace"
      from store_attendance_config
      where store_id = ${row.storeId}::uuid and superseded_at is null`)) as unknown as Record<string, unknown>[];

    const config = found[0];
    if (!config) return null;
    return { path, ...base, deleted: false, data: { configId: config.id, ...config } };
  }

  // day_feed
  const path = `mirror/${row.storeId}/dayFeed/${row.entityId}`;
  const found = (await tx.execute(sql`
    select d.id, d.shift_day as "shiftDay", d.status, d.computed_minutes as "computedMinutes",
           d.anchor_minute as "anchorMinute", d.end_minute as "endMinute",
           e.staff_code as "staffCode", p.display_name as "displayName"
    from attendance_days d
      join employments e on e.id = d.employment_id
      join persons p on p.id = e.person_id
    where d.id = ${row.entityId}::uuid`)) as unknown as Record<string, unknown>[];

  const day = found[0];
  if (row.op === 'delete' || !day) return { path, ...base, deleted: true };
  return { path, ...base, deleted: false, data: day };
}
