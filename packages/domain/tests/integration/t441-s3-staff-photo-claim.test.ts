import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-441 S3 TESTER - staff photo through the shared upload control. docs/tasks/441-photo-upload-control.md section 5 "S3".
 *
 * ASSUMED CONTRACT:
 *   setStaffPhoto(tx, actor, { employmentId, fileId }) is accepted as well as { employmentId, contentType, bytes }.
 *   The fileId path runs the SAME gates first (employment exists, not self, enrol_staff at the store, not ended), then
 *   claims the upload with claimUpload (purpose staff_photo, store = the employment's store, linkTo = the employment id),
 *   sets employments.photo_file_id and audits staff_photo.set / staff_photo.replaced.
 *   Every claim refusal is claimUpload's one sentence ("That photo is no longer available - pick it again").
 *
 * RED reason before the build: setStaffPhoto does not read `fileId`, so it throws on the missing bytes instead of
 * linking the uploaded file.
 *
 * Mutants killed: M32 (self-claim allowed), M33 (store not checked), M34 (purpose not checked), M35 (claim leaves linked_to
 * null), M36 (second claim of one id succeeds), M37 (photo column not set), M38 (another person's upload accepted),
 * M39 (claim path skips the enrol_staff gate), M40 (claim path skips the ended-employment gate), M41 (bytes path broken).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
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

const JPEG = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xd9]);

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
type Person = { id: string; actor: Actor };
async function mkPerson(orgId: string, name: string, role: string, storeIds: string[]): Promise<Person> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of storeIds) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return { id: p!.id, actor: { personId: p!.id, orgId } };
}
async function mkEmployment(w: { orgId: string; admin: Person }, personId: string, storeId: string, endedOn: string | null = null): Promise<string> {
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
    values (${w.orgId}, ${storeId}, ${personId}, ${'SE-' + (100000 + Math.floor(Math.random() * 899999999))}, ${endedOn ? 'resigned' : 'regular'}, '2025-01-01', ${endedOn}) returning id`;
  await grantEverydayPositionAccess(sql, { orgId: w.orgId, storeId, employmentId: e!.id, personId, setBy: w.admin.id, capabilities: [] as never });
  return e!.id;
}

async function world() {
  const code = uid('t441s3');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Store A') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('B')}, 'Store B') returning id`;
  const A = a!.id, B = b!.id;
  const admin = await mkPerson(orgId, 'Admin Boss', 'admin', [A, B]);
  const w0 = { orgId, admin };
  const manager = await mkPerson(orgId, 'Manager A', 'manager', [A]);
  const manager2 = await mkPerson(orgId, 'Manager A Two', 'manager', [A]);
  const cook = await mkPerson(orgId, 'Maria Santos', 'staff', [A]);
  const cook2 = await mkPerson(orgId, 'Pedro Cruz', 'staff', [A]);
  const cashier = await mkPerson(orgId, 'Cashier Cora', 'staff', [A]);
  const gone = await mkPerson(orgId, 'Left Lito', 'staff', [A]);
  return {
    orgId, A, B, admin, manager, manager2, cook, cook2, cashier,
    cookEmp: await mkEmployment(w0, cook.id, A),
    cook2Emp: await mkEmployment(w0, cook2.id, A),
    managerEmp: await mkEmployment(w0, manager.id, A), // the manager's OWN employment (self-claim case)
    endedEmp: await mkEmployment(w0, gone.id, A, '2025-06-30'),
  };
}
type W = Awaited<ReturnType<typeof world>>;

/** An unlinked upload row whose bytes really are in the driver. */
async function upload(w: { orgId: string }, o: { by: string; purpose?: string; storeId: string | null }): Promise<string> {
  const purpose = o.purpose ?? 'staff_photo';
  const path = `orgs/${w.orgId}/${o.storeId ? `stores/${o.storeId}/` : ''}${purpose}/${crypto.randomUUID()}.jpg`;
  await driver.put({ path, bytes: JPEG(), contentType: 'image/jpeg' } as never);
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${w.orgId}, ${o.storeId}, ${purpose}, ${path}, 'image/jpeg', 10, ${uid('sum')}, ${o.by}) returning id`;
  return row!.id;
}
const linkedTo = async (id: string) => (await sql<{ linked_to: string | null }[]>`select linked_to from stored_files where id = ${id}`)[0]?.linked_to ?? null;
const photoOf = async (empId: string) => (await sql<{ photo_file_id: string | null }[]>`select photo_file_id from employments where id = ${empId}`)[0]!.photo_file_id;
const auditCount = async (orgId: string, action: string, entityId: string) =>
  (await sql`select 1 from audit_log where org_id = ${orgId} and action = ${action} and entity_id = ${entityId}`).length;

const setPhoto = (w: W, who: Person, input: Record<string, unknown>) =>
  asOrg(w.orgId, (tx) => (domain as unknown as Record<string, (...a: unknown[]) => Promise<{ fileId: string }>>)['setStaffPhoto']!(tx, who.actor, input));
const claimPhoto = (w: W, who: Person, employmentId: string, fileId: string) => setPhoto(w, who, { employmentId, fileId });

async function refused(p: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'expected a refusal, but the call succeeded').toBeDefined();
  expect(caught instanceof TypeError, `got a TypeError, not a refusal: ${(caught as Error)?.message}`).toBe(false);
  return caught as Error;
}
async function claimRefused(p: Promise<unknown>) {
  const err = await refused(p);
  expect(err, `expected a RefusalError, got ${err.name}: ${err.message}`).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toMatch(/no longer available/i);
}

describe('a valid fileId claim', () => {
  it('M35/M37 links the file to the employment, sets the photo column, returns the id and audits staff_photo.set', async () => {
    const w = await world();
    const f = await upload(w, { by: w.manager.id, storeId: w.A });
    const r = await claimPhoto(w, w.manager, w.cookEmp, f);
    expect(r.fileId).toBe(f);
    expect(await linkedTo(f)).toBe(w.cookEmp);
    expect(await photoOf(w.cookEmp)).toBe(f);
    expect(await auditCount(w.orgId, 'staff_photo.set', w.cookEmp)).toBe(1);
  });

  it('replacing through a claim keeps the old file row linked and audits staff_photo.replaced', async () => {
    const w = await world();
    const first = await upload(w, { by: w.manager.id, storeId: w.A });
    const second = await upload(w, { by: w.manager.id, storeId: w.A });
    await claimPhoto(w, w.manager, w.cookEmp, first);
    await claimPhoto(w, w.manager, w.cookEmp, second);
    expect(await photoOf(w.cookEmp)).toBe(second);
    expect(await linkedTo(first)).toBe(w.cookEmp);
    expect(await linkedTo(second)).toBe(w.cookEmp);
    expect(await auditCount(w.orgId, 'staff_photo.replaced', w.cookEmp)).toBe(1);
  });

  it('M41 the old { contentType, bytes } input (no JavaScript) still works and links', async () => {
    const w = await world();
    const r = await setPhoto(w, w.manager, { employmentId: w.cookEmp, contentType: 'image/jpeg', bytes: JPEG() });
    expect(await photoOf(w.cookEmp)).toBe(r.fileId);
    expect(await linkedTo(r.fileId)).toBe(w.cookEmp);
  });
});

describe('the claim path refuses what claimUpload refuses, and changes nothing', () => {
  it('M33 a file uploaded for another store is refused', async () => {
    const w = await world();
    const f = await upload(w, { by: w.manager.id, storeId: w.B });
    await claimRefused(claimPhoto(w, w.manager, w.cookEmp, f));
    expect(await linkedTo(f)).toBeNull();
    expect(await photoOf(w.cookEmp)).toBeNull();
  });

  it('M33 a store-less upload is refused too (the photo is filed under the employment store)', async () => {
    const w = await world();
    const f = await upload(w, { by: w.manager.id, storeId: null });
    await claimRefused(claimPhoto(w, w.manager, w.cookEmp, f));
    expect(await photoOf(w.cookEmp)).toBeNull();
  });

  it('M34 a file of another purpose is refused', async () => {
    const w = await world();
    const receipt = await upload(w, { by: w.manager.id, storeId: w.A, purpose: 'receipt_photo' });
    const leave = await upload(w, { by: w.manager.id, storeId: w.A, purpose: 'leave_document' });
    await claimRefused(claimPhoto(w, w.manager, w.cookEmp, receipt));
    await claimRefused(claimPhoto(w, w.manager, w.cookEmp, leave));
    expect(await linkedTo(receipt)).toBeNull();
    expect(await linkedTo(leave)).toBeNull();
    expect(await photoOf(w.cookEmp)).toBeNull();
  });

  it('M38 a file another person uploaded is refused', async () => {
    const w = await world();
    const f = await upload(w, { by: w.manager2.id, storeId: w.A });
    await claimRefused(claimPhoto(w, w.manager, w.cookEmp, f));
    expect(await linkedTo(f)).toBeNull();
  });

  it('M36 a second claim of the same fileId is refused and the first stays', async () => {
    const w = await world();
    const f = await upload(w, { by: w.manager.id, storeId: w.A });
    await claimPhoto(w, w.manager, w.cookEmp, f);
    await claimRefused(claimPhoto(w, w.manager, w.cook2Emp, f));
    expect(await linkedTo(f)).toBe(w.cookEmp);
    expect(await photoOf(w.cook2Emp)).toBeNull();
    expect(await photoOf(w.cookEmp)).toBe(f);
  });

  it('a malformed or unknown fileId is refused with the same sentence', async () => {
    const w = await world();
    await claimRefused(claimPhoto(w, w.manager, w.cookEmp, 'not-a-uuid'));
    await claimRefused(claimPhoto(w, w.manager, w.cookEmp, crypto.randomUUID()));
  });
});

describe('the claim path keeps the setStaffPhoto gates', () => {
  it('M32 an enrol_staff holder cannot claim a photo onto their OWN employment', async () => {
    const w = await world();
    const f = await upload(w, { by: w.manager.id, storeId: w.A });
    const err = await refused(claimPhoto(w, w.manager, w.managerEmp, f));
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await linkedTo(f)).toBeNull();
    expect(await photoOf(w.managerEmp)).toBeNull();
    // the same file is still claimable onto someone else's employment afterwards
    await claimPhoto(w, w.manager, w.cookEmp, f);
    expect(await linkedTo(f)).toBe(w.cookEmp);
  });

  it('M39 a person without enrol_staff at the store cannot claim (file untouched)', async () => {
    const w = await world();
    const f = await upload(w, { by: w.cashier.id, storeId: w.A });
    const err = await refused(claimPhoto(w, w.cashier, w.cookEmp, f));
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await linkedTo(f)).toBeNull();
    expect(await photoOf(w.cookEmp)).toBeNull();
  });

  it('M40 an ended employment cannot take a claimed photo', async () => {
    const w = await world();
    const f = await upload(w, { by: w.manager.id, storeId: w.A });
    await refused(claimPhoto(w, w.manager, w.endedEmp, f));
    expect(await linkedTo(f)).toBeNull();
    expect(await photoOf(w.endedEmp)).toBeNull();
  });
});
