import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S2a (TESTER, 2026-11-03) - uploading a settlement statement through the real `uploadFile` path:
 * the new purpose `channel_settlement_file`, gated by `upload_settlement_files` (store scope; manager yes, staff no), stored as .csv / .zip.
 * docs/tasks/511-settlement-upload-s2-spec.md "File module (2a)" and "Capabilities and audit (2a)". Real Postgres via TEST_DATABASE_URL (a `_test` DB).
 *
 * RED today, for one reason: the purpose and the capability do not exist, so `uploadFile` refuses with "channel_settlement_file is not a known kind
 * of file" (and the migration's purpose CHECK does not allow the value). Nothing here truncates: every org is new.
 *
 * MUTANTS: purpose gated by another capability (record_ar_collection, manage_users); staff allowed; store scope ignored (manager of store A uploads to
 * store B); extension table missing csv / zip / x-zip-compressed; magic check skipped (a PNG named csv stored); cap not 3 MB; stored_files purpose CHECK
 * not widened.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver, uploadFile } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function person(orgId: string, storeId: string, name: string, role: string) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t511-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Lipa') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('B')}, 'Malvar') returning id`;
  const adminId = await person(orgId, a!.id, 'Admin', 'admin');
  const managerId = await person(orgId, a!.id, 'Manager', 'manager');
  const staffId = await person(orgId, a!.id, 'Staff', 'staff');
  return { orgId, storeA: a!.id, storeB: b!.id, admin: actor(orgId, adminId), manager: actor(orgId, managerId), staff: actor(orgId, staffId) };
}

const enc = (s: string) => new TextEncoder().encode(s);
const CSV = enc('Transaction ID,Net Sales,Amount\nA-1,6753.00,6807.00\n');
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x21, 0x00, 0x00, 0x00]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const MB = 1024 * 1024;
const PURPOSE = 'channel_settlement_file' as never; // the literal does not typecheck until the builder adds it to FILE_PURPOSES

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

describe('T-511 S2a - who may upload a settlement file (upload_settlement_files, store scope)', () => {
  it('a manager at the store uploads a CSV: stored as .csv under the purpose folder, with a stored_files row [kills: purpose unknown; wrong extension]', async () => {
    const f = await fixture('mgr-csv');
    const r = await asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'text/csv', bytes: CSV }));
    expect(r.storagePath).toMatch(new RegExp(`^orgs/${f.orgId}/stores/${f.storeA}/channel_settlement_file/[0-9a-f-]{36}\\.csv$`));
    const [row] = await sql<{ purpose: string; content_type: string; byte_size: string }[]>`select purpose, content_type, byte_size from stored_files where id = ${r.fileId}`;
    expect(row).toMatchObject({ purpose: 'channel_settlement_file', content_type: 'text/csv' });
    expect(Number(row!.byte_size)).toBe(CSV.length);
  });

  it('an admin may upload too [kills: gated to a role the admin lacks]', async () => {
    const f = await fixture('adm');
    const r = await asOrg(f.orgId, (tx) => uploadFile(tx, f.admin, { purpose: PURPOSE, storeId: f.storeA, contentType: 'text/csv', bytes: CSV }));
    expect(r.fileId).toBeTruthy();
  });

  it('staff is refused with AuthorizationError and nothing is stored [kills: staff allowed; a capability staff holds, e.g. record_wastage]', async () => {
    const f = await fixture('staff');
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.staff, { purpose: PURPOSE, storeId: f.storeA, contentType: 'text/csv', bytes: CSV }))).rejects.toBeInstanceOf(AuthorizationError);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from stored_files where org_id = ${f.orgId}`;
    expect(n!.n).toBe(0);
    expect(driver.files.size).toBe(0);
  });

  it('a manager scoped to store A is refused at store B (store scope, not org scope) [kills: scope org]', async () => {
    const f = await fixture('scope');
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeB, contentType: 'text/csv', bytes: CSV }))).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('T-511 S2a - what the purpose accepts', () => {
  it('Windows sends CSV as application/vnd.ms-excel: accepted and stored as .csv [kills: ms-excel missing from the type list; wrong extension]', async () => {
    const f = await fixture('excel');
    const r = await asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'application/vnd.ms-excel', bytes: CSV }));
    expect(r.storagePath).toMatch(/\.csv$/);
  });

  it('a zip is accepted as application/zip and as application/x-zip-compressed, both stored as .zip [kills: extension table missing zip; x-zip-compressed missing]', async () => {
    const f = await fixture('zip');
    for (const contentType of ['application/zip', 'application/x-zip-compressed']) {
      const r = await asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType, bytes: ZIP }));
      expect(r.storagePath, contentType).toMatch(/\.zip$/);
    }
  });

  it('a PNG renamed .csv (declared text/csv) is refused as not looking like its type; nothing stored [kills: magic check skipped]', async () => {
    const f = await fixture('png');
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'text/csv', bytes: PNG }))).rejects.toThrow(/does not look like/);
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from stored_files where org_id = ${f.orgId}`;
    expect(n!.n).toBe(0);
  });

  it('CSV text declared as a zip is refused [kills: zip accepted without its signature]', async () => {
    const f = await fixture('csvaszip');
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'application/zip', bytes: CSV }))).rejects.toThrow(/does not look like/);
  });

  it('an image or a pdf type is refused for this purpose by the type list [kills: a catch-all list]', async () => {
    const f = await fixture('types');
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'application/pdf', bytes: enc('%PDF-1.4\n') }))).rejects.toThrow(/not accepted/);
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'image/png', bytes: PNG }))).rejects.toThrow(/not accepted/);
  });

  it('the empty file is refused', async () => {
    const f = await fixture('empty');
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'text/csv', bytes: new Uint8Array(0) }))).rejects.toThrow(/empty/);
  });

  it('exactly 3 MB is accepted and 3 MB + 1 byte is refused by the purpose cap [kills: another cap; the 1 MB image cap wrongly applied to csv]', async () => {
    const f = await fixture('cap');
    const exact = new Uint8Array(3 * MB).fill(0x41);
    const r = await asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'text/csv', bytes: exact }));
    expect(r.byteSize).toBe(3 * MB);
    const over = new Uint8Array(3 * MB + 1).fill(0x41);
    await expect(asOrg(f.orgId, (tx) => uploadFile(tx, f.manager, { purpose: PURPOSE, storeId: f.storeA, contentType: 'text/csv', bytes: over }))).rejects.toThrow(/limit/);
  });
});
