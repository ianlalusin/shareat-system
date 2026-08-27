/**
 * The only place SQL is written for stored files. T-141.
 *
 * ⛔ **No public-URL column exists to read**, and none should. A read is brokered per request; see
 * `packages/domain/src/files`.
 */
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { storedFiles, type FilePurpose } from '../../schema/stored-files';

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
    throw new Error(`linkFile: file ${id} does not exist in org ${orgId}`);
  }
}

/**
 * Files nothing has claimed, older than `hours`.
 *
 * ⚠️ Deliberately NOT org-scoped — the sweep runs as the `system` principal across every org, the
 * same way T-140's month-end run does.
 */
export async function listOrphans(
  tx: Tx,
  hours: number,
): Promise<{ id: string; storagePath: string }[]> {
  return tx
    .select({ id: storedFiles.id, storagePath: storedFiles.storagePath })
    .from(storedFiles)
    .where(
      and(
        isNull(storedFiles.linkedTo),
        lt(storedFiles.uploadedAt, sql`now() - make_interval(hours => ${hours})`),
      ),
    )
    .orderBy(asc(storedFiles.uploadedAt))
    .limit(500);
}

/**
 * ⛔ Only ever called by the orphan sweep, for a file nothing points at.
 *
 * A file behind a POSTED expense is the evidence for a journal entry; the FK from
 * `expenses.receipt_file_id` is `ON DELETE restrict`, so the database refuses that deletion rather
 * than trusting this function's caller to remember.
 */
export async function deleteFile(tx: Tx, id: string): Promise<void> {
  await tx.delete(storedFiles).where(and(eq(storedFiles.id, id), isNull(storedFiles.linkedTo)));
}
