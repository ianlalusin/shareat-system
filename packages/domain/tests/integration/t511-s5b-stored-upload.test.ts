import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S5b (TESTER, 2026-11-05) - `readStoredUpload`: the day detail re-reads the ORIGINAL file from storage (the order lists are not kept in the staging tables).
 * docs/tasks/511-settlement-upload-s5-spec.md "S5b" (stored-file re-read as in ingest.ts, moved to `stored-upload.ts`); design Component K.
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/stored-upload.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT (tester's choices; the builder must meet these or ask BOSS to change the tests):
 *  U1  `readStoredUpload(tx, orgId, uploadId): Promise<StoredUpload | null>` exported from `stored-upload.ts` (the ingest's private `readFile` moved there; ingest imports it).
 *      StoredUpload is the ingest's own parsed shape: { kind: 'foodpanda_invoice' | 'grab_transactions' | 'grab_transfers', platform, code, periodFrom, periodTo, invoiceNumber,
 *      ordersRead, loanRowsRead, otherRowsRead, transactions?: GrabTransactionsFile, transfers?: GrabTransfersFile, foodpanda?: FoodpandaInvoice } re-read with the SAME readers.
 *  U2  null (never a throw, never a leak) for an upload id that does not exist, belongs to another org, or whose stored file is gone from storage. An unreadable file raises
 *      the reader's own refusal (a typed sentence), as the reader would on upload.
 *  U3  Nothing is written: no row, no stored file, no audit entry.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { readStoredUpload } from '../../src/settlement-intake/stored-upload';
import { readGrabTransactions } from '../../src/settlement-intake/grab-transactions';
import { readGrabTransfers } from '../../src/settlement-intake/grab-transfers';
import { readFpFixture } from '../unit/t511-s4-helpers';
import { asOrg, fixture, upload, world3, type World3 } from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 5 });
let driver = inMemoryDriver();
beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, w.managerA, { bytes: f.bytes, contentType: f.contentType }));
const read = (orgId: string, uploadId: string) => asOrg(orgId, (tx) => readStoredUpload(tx, orgId, uploadId));
const count = async (table: string, orgId: string): Promise<number> => (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where org_id = ${orgId}`)[0]!.n;

describe('T-511 S5b readStoredUpload', () => {
  it('a Grab Transactions upload re-reads to the same rows as the original file; the Transfers upload likewise [kills: a different reader; a truncated copy]', async () => {
    const w = await world3(sql, 'stored-grab');
    const tx = await ingest(w, upload('grab-lipa-oct-transactions.csv'));
    const tr = await ingest(w, upload('grab-lipa-oct-transfers.csv'));
    const a = (await read(w.orgId, tx.uploadId))!;
    expect(a.kind).toBe('grab_transactions');
    expect(a.platform).toBe('grab');
    expect(a.transactions!.rows).toEqual(readGrabTransactions(fixture('grab-lipa-oct-transactions.csv')).rows);
    const b = (await read(w.orgId, tr.uploadId))!;
    expect(b.kind).toBe('grab_transfers');
    expect(b.transfers!.rows).toEqual(readGrabTransfers(fixture('grab-lipa-oct-transfers.csv')).rows);
  });

  it('a Foodpanda upload re-reads to the same invoice as the original zip [kills: the workbook not re-read from the stored zip]', async () => {
    const w = await world3(sql, 'stored-fp');
    const r = await ingest(w, { bytes: upload('foodpanda-lipa-oct5-34col.zip').bytes, contentType: 'application/zip' });
    const got = (await read(w.orgId, r.uploadId))!;
    expect(got.kind).toBe('foodpanda_invoice');
    expect(got.foodpanda).toEqual(await readFpFixture('foodpanda-lipa-oct5-34col.zip'));
  });

  it('an unknown id, another org\'s upload and a stored file that is gone all give null [kills: a throw, or another org\'s file]', async () => {
    const w = await world3(sql, 'stored-null');
    const other = await world3(sql, 'stored-null-other');
    const r = await ingest(w, upload('grab-lipa-oct-transfers.csv'));
    expect(await read(w.orgId, '00000000-0000-4000-8000-0000000000ff')).toBeNull();
    expect(await read(other.orgId, r.uploadId)).toBeNull();
    driver.files.clear();
    expect(await read(w.orgId, r.uploadId)).toBeNull();
  });

  it('writes nothing: the row counts of the staging tables, the stored files and the audit log are the same after a read [kills: a read with side effects]', async () => {
    const w = await world3(sql, 'stored-readonly');
    const r = await ingest(w, upload('grab-lipa-oct-transfers.csv'));
    const before = [await count('settlement_uploads', w.orgId), await count('stored_files', w.orgId), await count('audit_log', w.orgId)];
    await read(w.orgId, r.uploadId);
    expect([await count('settlement_uploads', w.orgId), await count('stored_files', w.orgId), await count('audit_log', w.orgId)]).toEqual(before);
  });
});
