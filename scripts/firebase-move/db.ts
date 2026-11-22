/**
 * T-625 - the two read-only reads the move scripts need, on the system connection.
 *
 * Why `systemTransaction`: `person_credentials` and `stored_files` carry FORCE ROW LEVEL SECURITY, so a bare
 * transaction sees nothing. These scripts run once, by a person, across every organisation, and never write -
 * the same shape as scripts/backfill-file-links.ts. Reads only: no insert, update or delete exists in this file.
 *
 * Needs SYSTEM_DATABASE_URL (otherwise the connection falls back to the RLS-enforcing role and every read is
 * empty; the callers also refuse an empty result, so that failure is loud rather than a green "0").
 */
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { schema, systemTransaction } from '@shareat/db';
import { MoveArgError, type FileItem } from './lib';

export function requireSystemUrl(): void {
  if (!process.env.SYSTEM_DATABASE_URL?.trim()) {
    throw new MoveArgError('SYSTEM_DATABASE_URL is not set. Set it in .env.local to the same value as DATABASE_URL, then run again. Nothing was read.');
  }
}

/** Firebase uids of live (not revoked) `firebase` credentials: email accounts and clock/store terminals. */
export async function readLiveFirebaseUids(): Promise<string[]> {
  const rows = await systemTransaction((tx) =>
    tx
      .select({ uid: schema.personCredentials.externalId })
      .from(schema.personCredentials)
      .where(
        and(
          eq(schema.personCredentials.kind, 'firebase'),
          isNull(schema.personCredentials.revokedAt),
          isNotNull(schema.personCredentials.externalId),
        ),
      )
      .orderBy(asc(schema.personCredentials.id)),
  );
  return [...new Set(rows.map((r) => r.uid).filter((u): u is string => typeof u === 'string' && u !== ''))];
}

export async function readStoredFiles(): Promise<FileItem[]> {
  return systemTransaction((tx) =>
    tx
      .select({
        id: schema.storedFiles.id,
        path: schema.storedFiles.storagePath,
        purpose: schema.storedFiles.purpose,
        byteSize: schema.storedFiles.byteSize,
      })
      .from(schema.storedFiles)
      .orderBy(asc(schema.storedFiles.id)),
  );
}
