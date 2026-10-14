import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * T-402 S3 (R15, C6) - `applyPurge` requires `auditDump`: the dump `dumpAuditLog` took of `audit_log` just before the purge.
 * Tests that run the real purge take it here, from the database they are about to purge. TESTER-owned.
 * Needs the PG18 client tools: `PG_BIN_DIR`, else the Windows default.
 */
const PG_WIN = 'C:/Program Files/PostgreSQL/18/bin';
export const pgBinDir: string | undefined = process.env.PG_BIN_DIR ?? (process.platform === 'win32' && existsSync(PG_WIN) ? PG_WIN : undefined);
if (pgBinDir && !process.env.PG_BIN_DIR) process.env.PG_BIN_DIR = pgBinDir;

/** A fresh, not-yet-existing dump directory (the dump function creates it, 0700). Also what `--dump-dir` is given. */
export function freshDumpDir(label = 'purge'): string {
  return join(mkdtempSync(join(tmpdir(), `t402s3-${label}-`)), 'dumps');
}

export interface AuditDump {
  path: string;
  sha256: string;
  bytes: number;
  rowCount: number;
}

/** Dump `audit_log` of the database at `databaseUrl` now; pass the result as `applyPurge`'s `auditDump`. */
export async function auditDumpFor(databaseUrl: string, asOf = '2027-01-01'): Promise<AuditDump> {
  const m = (await import('../../packages/db/src/cutover/purge')) as unknown as {
    dumpAuditLog: (o: { databaseUrl: string; dir: string; asOf: string; pgBinDir?: string }) => Promise<AuditDump>;
  };
  return m.dumpAuditLog({ databaseUrl, dir: freshDumpDir(), asOf, ...(pgBinDir ? { pgBinDir } : {}) });
}
