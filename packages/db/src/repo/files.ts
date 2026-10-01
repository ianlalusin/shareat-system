/**
 * The only place SQL is written for stored files. T-141.
 *
 * ⛔ **No public-URL column exists to read**, and none should. A read is brokered per request; see
 * `packages/domain/src/files`.
 */
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { storedFiles, type FilePurpose } from '../../schema/stored-files';
import { recordGone } from './record-gone';

export interface StoredFileRow {
  id: string;
  orgId: string;
  storeId: string | null;
  purpose: FilePurpose;
  storagePath: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  linkedTo: string | null;
  uploadedBy: string;
  uploadedAt: Date;
}

export interface InsertFileInput {
  id: string;
  orgId: string;
  storeId: string | null;
  purpose: FilePurpose;
  storagePath: string;
  contentType: string;
  byteSize: number;
  checksum: string;
  uploadedBy: string;
}

export async function insertFile(tx: Tx, input: InsertFileInput): Promise<{ id: string }> {
  const [row] = await tx.insert(storedFiles).values(input).returning({ id: storedFiles.id });
  return row!;
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<StoredFileRow | undefined> {
  const [row] = await tx
    .select()
    .from(storedFiles)
    .where(and(eq(storedFiles.id, id), eq(storedFiles.orgId, orgId)))
    .limit(1);
  return row as StoredFileRow | undefined;
}

/** Several files of one org in a single read - for a screen that has to ask about each of a list's photos. */
export async function getByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<StoredFileRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(storedFiles)
    .where(and(eq(storedFiles.orgId, orgId), inArray(storedFiles.id, [...ids])));
  return rows as StoredFileRow[];
}

export async function linkFile(
  tx: Tx,
  orgId: string,
  id: string,
  linkedTo: string,
): Promise<void> {
  const updated = await tx
    .update(storedFiles)
    .set({ linkedTo })
    .where(and(eq(storedFiles.id, id), eq(storedFiles.orgId, orgId)))
    .returning({ id: storedFiles.id });
  if (updated.length === 0) {
    throw recordGone(`linkFile: file ${id} does not exist in org ${orgId}`, 'file');
  }
}

/**
 * ⭐ T-272/DEF-306 — the ONE definition of the orphan sweep's per-run candidate cap. Compared
 * against in `scheduler/index.ts` to detect when a run was capped rather than fully drained
 * (`candidates === ORPHAN_SWEEP_BATCH_LIMIT`); changing the limit here changes the comparison too,
 * so the two cannot silently drift apart the way a duplicated literal would.
 */
export const ORPHAN_SWEEP_BATCH_LIMIT = 500;

/**
 * Files nothing has claimed, older than `hours`, in ONE org.
 *
 * ⭐ T-272/DEF-299 — scoped per org since `scheduler_runs.org_id` is `NOT NULL` and cannot record a
 * global run. Mechanical: `stored_files.org_id` was already `NOT NULL`; this just filters on it.
 */
export async function listOrphans(
  tx: Tx,
  orgId: string,
  hours: number,
): Promise<{ id: string; storagePath: string }[]> {
  return tx
    .select({ id: storedFiles.id, storagePath: storedFiles.storagePath })
    .from(storedFiles)
    .where(
      and(
        eq(storedFiles.orgId, orgId),
        isNull(storedFiles.linkedTo),
        lt(storedFiles.uploadedAt, sql`now() - make_interval(hours => ${hours})`),
      ),
    )
    .orderBy(asc(storedFiles.uploadedAt))
    .limit(ORPHAN_SWEEP_BATCH_LIMIT);
}

/**
 * ⛔ Only ever called by the orphan sweep, for a file nothing points at.
 *
 * A file behind a POSTED expense is the evidence for a journal entry; the FK from
 * `expenses.receipt_file_id` is `ON DELETE restrict`, so the database refuses that deletion rather
 * than trusting this function's caller to remember.
 *
 * ⭐ **T-267/DEF-297 — returns whether it deleted a row, deliberately a `boolean` rather than
 * `updateTerms`'s throw-on-zero-rows convention** (`fixed-assets.ts:305-323`). There the row is
 * expected to exist; a miss is a bug. Here the sweep's own read (`listOrphans`) can go stale by the
 * time this runs — another request may `linkFile` the row in between — and that race is a normal,
 * expected outcome, not an error. The caller (`sweepOrphanedFiles`) needs to tell "deleted" from
 * "already claimed, leave it alone" without wrapping every delete in a try/catch for a case that
 * is not exceptional.
 *
 * ⭐ **T-272 — takes `orgId` even though `stored_files` carries FORCE RLS scoping this at the
 * database.** In production the app connects as `doadmin` with `rolbypassrls = t`, so RLS is not
 * enforced there today and the id-came-from-an-org-scoped-read three lines up would otherwise be
 * the ONLY thing keeping this delete inside the caller's org — one layer, where RULES §6 item 3 /
 * bible §15.11 require tenancy to be layered on purpose. Matches `getById`/`linkFile` above.
 */
export async function deleteFile(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const deleted = await tx
    .delete(storedFiles)
    .where(and(eq(storedFiles.id, id), eq(storedFiles.orgId, orgId), isNull(storedFiles.linkedTo)))
    .returning({ id: storedFiles.id });
  return deleted.length > 0;
}
