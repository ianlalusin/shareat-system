import { config } from 'dotenv';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-434 TESTER - staff photo and signature. docs/tasks/434-staff-photo-and-signature.md, cases 1-22
 * (plus 13a-d, 15a/b, 17a). Bible row 353; DEF-668 (signature part).
 *
 * ## API CONTRACT these tests pin (the spec names the functions but not their shapes - BUILDER follows this)
 *
 * All exported from `@shareat/domain` (packages/domain/src/people/index.ts), all `(tx, actor, input)`:
 *   setStaffPhoto(tx, actor, { employmentId, contentType, bytes })        -> { fileId }
 *   removeStaffPhoto(tx, actor, { employmentId })
 *   setStaffSignature(tx, actor, { personId, contentType, bytes })        -> { fileId }
 *   removeStaffSignature(tx, actor, { personId })
 *   viewStaffSignatureUrl(tx, actor, { personId })                        -> { url, contentType }
 *   signatureForPrint(tx, actor, { personId })                            -> { bytes: Uint8Array, contentType }  (NO url)
 *   staffMediaView(tx, actor, { employmentId })  (the detail-page loader) -> { hasSignature: boolean,
 *        canViewSignature: boolean, photoFileId: string | null }   photoFileId is null unless the viewer holds
 *        enrol_staff at that store; the signature file id is NEVER in it.
 * Also: `readFileUrl(tx, actor, { fileId, expiresInSeconds })` keeps its shape and routes `staff_signature` through
 * the signature rule; `canReadFiles` never returns a signature id.
 * Audit: action `staff_photo.set|replaced|removed`, `staff_signature.set|replaced|removed|viewed|view_refused`;
 * for staff_signature.* the `entity_id` is the PERSON id. A refused view row is written in its own transaction.
 * "File created_at" in the spec = `stored_files.uploaded_at`.
 *
 * RED reasons expected before the build: the functions above do not exist; `persons.signature_file_id`,
 * the `staff_photo` / `staff_signature` purposes and the `view_staff_signature` capability do not exist.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../apps/erp/src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));

import { closeDb, employmentRepo, personsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { logger } from '@shareat/core/logger';
import * as domain from '@shareat/domain';
import {
  canReadFiles,
  inMemoryDriver,
  listRoster,
  readFileUrl,
  searchPersons,
  setStorageDriver,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from '../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { GET as filesRoute } from '../../apps/erp/src/app/files/[fileId]/route';

const sql = postgres(url, { max: 5 });
let driver = inMemoryDriver();
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const VIEW_CAP = 'view_staff_signature';

// A real 1x1 PNG.
const PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);
const pngCopy = () => PNG.slice();
const PNG_OTHER = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAABsm4skAAAADElEQVR42mP8z8AARAAGKAH+9ZtvTQAAAABJRU5ErkJggg==', 'base64'),
);

function jpegWithGps(): Uint8Array {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const payload = [...ascii('Exif\0'), 0, ...ascii('GPS 14.0865 121.1553')];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0xff, 0xd9]);
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** A refusal that is a REAL refusal: a missing function (TypeError) must not count. */
async function refused(p: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'expected a refusal, but the call succeeded').toBeDefined();
  expect(caught instanceof TypeError, `got a TypeError, not a refusal: ${(caught as Error)?.message}`).toBe(false);
  return caught as Error;
}

type Person = { id: string; actor: Actor };
async function mkPerson(orgId: string, name: string, role: string, storeIds: string[]): Promise<Person> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const s of storeIds) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return { id: p!.id, actor: { personId: p!.id, orgId } };
}

async function mkEmployment(w: { orgId: string; admin: Person }, personId: string, storeId: string, startedOn = '2025-01-01', caps: string[] = []): Promise<string> {
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${w.orgId}, ${storeId}, ${personId}, ${uid('SC')}, 'regular', ${startedOn}) returning id`;
  await grantEverydayPositionAccess(sql, { orgId: w.orgId, storeId, employmentId: e!.id, personId, setBy: w.admin.id, capabilities: caps as never });
  return e!.id;
}

async function world() {
  const code = uid('t434');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Store A') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('B')}, 'Store B') returning id`;
  const A = a!.id, B = b!.id;
  const admin = await mkPerson(orgId, 'Admin Boss', 'admin', [A, B]);
  const w = { orgId, A, B, admin };
  const managerA = await mkPerson(orgId, 'Manager A', 'manager', [A]);
  const managerA2 = await mkPerson(orgId, 'Manager A Two', 'manager', [A]);
  const managerB = await mkPerson(orgId, 'Manager B', 'manager', [B]);
  const cook = await mkPerson(orgId, 'Maria Santos', 'staff', [A]);
  const cashier = await mkPerson(orgId, 'Cashier Cora', 'staff', [A]);
  const clerk = await mkPerson(orgId, 'Payroll Clerk', 'staff', [A]);
  const clerkB = await mkPerson(orgId, 'Payroll Clerk B', 'staff', [B]);
  const cookEmp = await mkEmployment(w, cook.id, A);
  await mkEmployment(w, cashier.id, A);
  await mkEmployment(w, clerk.id, A, '2025-01-01', [VIEW_CAP]);
  await mkEmployment(w, clerkB.id, B, '2025-01-01', [VIEW_CAP]);
  const managerAEmp = await mkEmployment(w, managerA.id, A); // for the self-service case
  return { ...w, managerA, managerA2, managerB, cook, cashier, clerk, clerkB, cookEmp, managerAEmp };
}
type W = Awaited<ReturnType<typeof world>>;

const dm = domain as unknown as Record<string, (...a: unknown[]) => Promise<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const setSig = (w: W, who: Person, personId: string, bytes: Uint8Array = pngCopy(), contentType = 'image/png') =>
  asOrg(w.orgId, (tx) => dm.setStaffSignature!(tx, who.actor, { personId, contentType, bytes }));
const removeSig = (w: W, who: Person, personId: string) => asOrg(w.orgId, (tx) => dm.removeStaffSignature!(tx, who.actor, { personId }));
const viewSig = (w: W, who: Person, personId: string) => asOrg(w.orgId, (tx) => dm.viewStaffSignatureUrl!(tx, who.actor, { personId }));
const setPhoto = (w: W, who: Person, employmentId: string, bytes: Uint8Array = jpegWithGps(), contentType = 'image/jpeg') =>
  asOrg(w.orgId, (tx) => dm.setStaffPhoto!(tx, who.actor, { employmentId, contentType, bytes }));
const removePhoto = (w: W, who: Person, employmentId: string) => asOrg(w.orgId, (tx) => dm.removeStaffPhoto!(tx, who.actor, { employmentId }));
const readUrl = (w: W, who: Person, fileId: string, expiresInSeconds?: number) =>
  asOrg(w.orgId, (tx) => readFileUrl(tx, who.actor, { fileId, ...(expiresInSeconds ? { expiresInSeconds } : {}) }));
const mediaView = (w: W, who: Person, employmentId: string) => asOrg(w.orgId, (tx) => dm.staffMediaView!(tx, who.actor, { employmentId }));

const sigFileOf = async (personId: string) => (await sql<{ signature_file_id: string | null }[]>`select signature_file_id from persons where id = ${personId}`)[0]!.signature_file_id;
const photoFileOf = async (empId: string) => (await sql<{ photo_file_id: string | null }[]>`select photo_file_id from employments where id = ${empId}`)[0]!.photo_file_id;
const fileRow = async (id: string) => (await sql<{ id: string; purpose: string; storage_path: string; linked_to: string | null; uploaded_by: string }[]>`select id, purpose, storage_path, linked_to, uploaded_by from stored_files where id = ${id}`)[0];
const auditRows = (orgId: string, action: string) =>
  sql<{ action: string; entity: string; entity_id: string; actor_person_id: string | null; occurred_at: Date; before: unknown; after: unknown }[]>`
    select action, entity, entity_id, actor_person_id, occurred_at, before, after from audit_log where org_id = ${orgId} and action = ${action} order by occurred_at`;

beforeAll(async () => {
  await sql`truncate table stored_files, audit_log, person_grants, person_store_scope, person_roles, employments, persons, stores, organizations restart identity cascade`;
});
beforeEach(() => { driver = inMemoryDriver(); setStorageDriver(driver); ACTOR_HOLDER.actor = null; });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { setStorageDriver(null); await closeDb(); await sql.end({ timeout: 5 }); });

// ---------------------------------------------------------------- photo (1, 2, 3, 7, 17, 17a)
describe('photo: set, replace, remove', () => {
  it('1. a manager sets a photo at their own store: column set, purpose staff_photo, audit staff_photo.set', async () => {
    const w = await world();
    const r = await setPhoto(w, w.managerA, w.cookEmp);
    expect(await photoFileOf(w.cookEmp)).toBe(r.fileId);
    expect((await fileRow(r.fileId))!.purpose).toBe('staff_photo');
    const rows = await auditRows(w.orgId, 'staff_photo.set');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(w.managerA.id);
  });

  it('2. replacing keeps the old file row and audits staff_photo.replaced', async () => {
    const w = await world();
    const first = await setPhoto(w, w.managerA, w.cookEmp);
    const second = await setPhoto(w, w.managerA, w.cookEmp);
    expect(second.fileId).not.toBe(first.fileId);
    expect(await photoFileOf(w.cookEmp)).toBe(second.fileId);
    expect(await fileRow(first.fileId)).toBeDefined();
    expect(await auditRows(w.orgId, 'staff_photo.replaced')).toHaveLength(1);
  });

  it('3. removing nulls the column and audits staff_photo.removed', async () => {
    const w = await world();
    await setPhoto(w, w.managerA, w.cookEmp);
    await removePhoto(w, w.managerA, w.cookEmp);
    expect(await photoFileOf(w.cookEmp)).toBeNull();
    expect(await auditRows(w.orgId, 'staff_photo.removed')).toHaveLength(1);
  });

  it('7. the stored photo bytes carry no EXIF GPS', async () => {
    const w = await world();
    const r = await setPhoto(w, w.managerA, w.cookEmp);
    const row = await fileRow(r.fileId);
    const stored = driver.files.get(row!.storage_path)!;
    expect(stored).toBeDefined();
    expect(String.fromCharCode(...stored)).not.toContain('GPS');
  });

  it('17. photo visibility unchanged: enrol_staff at the file\'s store sees it, another store does not', async () => {
    const w = await world();
    const r = await setPhoto(w, w.managerA, w.cookEmp);
    expect((await asOrg(w.orgId, (tx) => canReadFiles(tx, w.managerA2.actor, [r.fileId]))).has(r.fileId)).toBe(true);
    expect((await asOrg(w.orgId, (tx) => canReadFiles(tx, w.managerB.actor, [r.fileId]))).has(r.fileId)).toBe(false);
    expect((await asOrg(w.orgId, (tx) => canReadFiles(tx, w.cashier.actor, [r.fileId]))).has(r.fileId)).toBe(false);
    await refused(readUrl(w, w.managerB, r.fileId));
    expect((await readUrl(w, w.managerA2, r.fileId)).url).toBeTruthy();
  });

  it('17a. the detail loader returns no photo file id to a viewer without enrol_staff at that store', async () => {
    const w = await world();
    const r = await setPhoto(w, w.managerA, w.cookEmp);
    expect(typeof dm.staffMediaView).toBe('function');
    const mine = await mediaView(w, w.managerA2, w.cookEmp);
    expect(mine.photoFileId).toBe(r.fileId); // positive control: the right viewer does get it
    for (const viewer of [w.cashier, w.managerB, w.clerk]) {
      const v = await asOrg(w.orgId, (tx) => dm.staffMediaView!(tx, viewer.actor, { employmentId: w.cookEmp })).catch((e: unknown) => {
        if (e instanceof TypeError) throw e;
        return null; // a refusal is also "no file id"
      });
      expect(JSON.stringify(v ?? {})).not.toContain(r.fileId);
      expect(v?.photoFileId ?? null).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- signature set (4, 5, 6, 8, 9, 10)
describe('signature: set / refuse', () => {
  it('4. a manager sets a signature PNG: persons.signature_file_id set, purpose staff_signature, audited', async () => {
    const w = await world();
    const r = await setSig(w, w.managerA, w.cook.id);
    expect(await sigFileOf(w.cook.id)).toBe(r.fileId);
    const row = await fileRow(r.fileId);
    expect(row!.purpose).toBe('staff_signature');
    expect(row!.uploaded_by).toBe(w.managerA.id);
    expect(row!.linked_to).toBe(w.cook.id);
    expect(driver.files.get(row!.storage_path)).toBeDefined();
    expect(await photoFileOf(w.cookEmp)).toBeNull(); // not stored on the employment
    const rows = await auditRows(w.orgId, 'staff_signature.set');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(w.cook.id);
    expect(rows[0]!.actor_person_id).toBe(w.managerA.id);
  });

  it('4b. replace and remove audit and keep the old file row, both stay linked to the person', async () => {
    const w = await world();
    const first = await setSig(w, w.managerA, w.cook.id);
    const second = await setSig(w, w.managerA, w.cook.id, PNG_OTHER.slice());
    expect(await fileRow(first.fileId)).toBeDefined();
    expect((await fileRow(first.fileId))!.linked_to).toBe(w.cook.id);
    expect(await auditRows(w.orgId, 'staff_signature.replaced')).toHaveLength(1);
    await removeSig(w, w.managerA, w.cook.id);
    expect(await sigFileOf(w.cook.id)).toBeNull();
    expect(await fileRow(second.fileId)).toBeDefined();
    expect(await auditRows(w.orgId, 'staff_signature.removed')).toHaveLength(1);
  });

  it('5a. a jpeg signature is refused and nothing is stored', async () => {
    const w = await world();
    await refused(setSig(w, w.managerA, w.cook.id, jpegWithGps(), 'image/jpeg'));
    expect(await sigFileOf(w.cook.id)).toBeNull();
    const [n] = await sql<{ n: string }[]>`select count(*)::text n from stored_files where org_id = ${w.orgId} and purpose = 'staff_signature'`;
    expect(Number(n!.n)).toBe(0);
  });

  it('5b. a PNG over 1 MB is refused', async () => {
    const w = await world();
    const big = new Uint8Array(1024 * 1024 + 10);
    big.set(PNG, 0);
    await refused(setSig(w, w.managerA, w.cook.id, big));
    expect(await sigFileOf(w.cook.id)).toBeNull();
  });

  it('6. a data: string anywhere in the signature input is refused, and no column holds a data URL', async () => {
    const w = await world();
    const dataUrl = 'data:image/png;base64,' + Buffer.from(PNG).toString('base64');
    await refused(setSig(w, w.managerA, w.cook.id, dataUrl as unknown as Uint8Array)); // string where bytes belong
    await refused(setSig(w, w.managerA, w.cook.id, new TextEncoder().encode(dataUrl))); // the text as "bytes"
    await refused(setSig(w, w.managerA, w.cook.id, pngCopy(), dataUrl)); // as the content type
    expect(await sigFileOf(w.cook.id)).toBeNull();
    await setSig(w, w.managerA, w.cook.id); // positive control: a real PNG is accepted
    const [p] = await sql<{ n: string }[]>`select count(*)::text n from persons p where p.org_id = ${w.orgId} and p::text like '%data:%'`;
    const [s] = await sql<{ n: string }[]>`select count(*)::text n from stored_files f where f.org_id = ${w.orgId} and f::text like '%data:%'`;
    expect(Number(p!.n) + Number(s!.n)).toBe(0);
  });

  it('8. a staff-role actor cannot upload or remove a photo or a signature', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    await setPhoto(w, w.managerA, w.cookEmp);
    for (const who of [w.cashier, w.clerk]) {
      await refused(setSig(w, who, w.cook.id));
      await refused(removeSig(w, who, w.cook.id));
      await refused(setPhoto(w, who, w.cookEmp));
      await refused(removePhoto(w, who, w.cookEmp));
    }
    expect(await sigFileOf(w.cook.id)).toBe(sig.fileId);
    expect(await photoFileOf(w.cookEmp)).not.toBeNull();
  });

  it('9. a manager of store B cannot change a store-A-only person', async () => {
    const w = await world();
    await refused(setSig(w, w.managerB, w.cook.id));
    await refused(setPhoto(w, w.managerB, w.cookEmp));
    const sig = await setSig(w, w.managerA, w.cook.id);
    await refused(removeSig(w, w.managerB, w.cook.id));
    expect(await sigFileOf(w.cook.id)).toBe(sig.fileId);
  });

  it('10. a manager cannot upload their own signature, even holding enrol_staff', async () => {
    const w = await world();
    await refused(setSig(w, w.managerA, w.managerA.id));
    expect(await sigFileOf(w.managerA.id)).toBeNull();
    // positive control: a different manager can do it for them
    await setSig(w, w.managerA2, w.managerA.id);
    expect(await sigFileOf(w.managerA.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------- viewing (11, 12, 13*, 14, 15*, 16, 21)
describe('signature: who can view', () => {
  it('11. admin and a view_staff_signature holder get a short-lived URL, each view audited', async () => {
    const w = await world();
    await setSig(w, w.managerA, w.cook.id);
    const before = Date.now();
    const a = await viewSig(w, w.admin, w.cook.id);
    const c = await viewSig(w, w.clerk, w.cook.id);
    expect(a.url).toMatch(/expires=\d+/);
    expect(c.url).toMatch(/expires=\d+/);
    const rows = await auditRows(w.orgId, 'staff_signature.viewed');
    expect(rows.map((r) => r.actor_person_id).sort()).toEqual([w.admin.id, w.clerk.id].sort());
    for (const r of rows) {
      expect(r.entity_id).toBe(w.cook.id);
      expect(Math.abs(r.occurred_at.getTime() - before)).toBeLessThan(60_000);
    }
  });

  it('12. staff, another store\'s manager and a cashier learn only "Signature on file": no id, no link, no detail in the refusal', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    const path = (await fileRow(sig.fileId))!.storage_path;
    expect(typeof dm.staffMediaView).toBe('function');
    for (const viewer of [w.cook, w.managerB, w.cashier]) {
      // managerB cannot see the employment at all under some designs; the loader may refuse or return the safe shape.
      const v = await asOrg(w.orgId, (tx) => dm.staffMediaView!(tx, viewer.actor, { employmentId: w.cookEmp })).catch((e: unknown) => {
        if (e instanceof TypeError) throw e;
        return null;
      });
      if (v) {
        expect(v.hasSignature).toBe(true);
        expect(v.canViewSignature).toBe(false);
        expect(JSON.stringify(v)).not.toContain(sig.fileId);
        expect(JSON.stringify(v)).not.toContain(path);
        expect(Object.keys(v).join(',')).not.toMatch(/signatureFileId|signature_file_id/);
      }
      const err = await refused(viewSig(w, viewer, w.cook.id));
      const text = `${err.message} ${(err as AuthorizationError).userMessage ?? ''}`;
      expect(text).not.toContain(sig.fileId);
      expect(text).not.toContain('orgs/');
      expect(text).not.toContain('Maria Santos');
    }
    // positive control: the admin's loader view says canViewSignature true, still without the id
    const adminView = await mediaView(w, w.admin, w.cookEmp);
    expect(adminView.hasSignature).toBe(true);
    expect(adminView.canViewSignature).toBe(true);
    expect(JSON.stringify(adminView)).not.toContain(sig.fileId);
  });

  it('13. the uploader (enrol_staff, employed-at-A since before the upload) can view the current signature, audited; not after the employment ends', async () => {
    const w = await world();
    await setSig(w, w.managerA, w.cook.id);
    expect((await viewSig(w, w.managerA, w.cook.id)).url).toBeTruthy();
    const rows = await auditRows(w.orgId, 'staff_signature.viewed');
    expect(rows.some((r) => r.actor_person_id === w.managerA.id)).toBe(true);
    await sql`update employments set ended_on = '2025-06-01', employment_status = 'resigned' where id = ${w.cookEmp}`;
    await refused(viewSig(w, w.managerA, w.cook.id));
    // admin can still view a person with no open employment; the clerk (grant only at A, no open job) cannot
    expect((await viewSig(w, w.admin, w.cook.id)).url).toBeTruthy();
    await refused(viewSig(w, w.clerk, w.cook.id));
  });

  it('13a. a store-B manager who hires store-A\'s cook AFTER the upload cannot read the signature', async () => {
    const w = await world();
    await setSig(w, w.managerA, w.cook.id);
    await mkEmployment(w, w.cook.id, w.B, new Date().toISOString().slice(0, 10)); // hired at B today, after the upload
    await refused(viewSig(w, w.managerB, w.cook.id));
    // and not through the file id either
    const fileId = (await sigFileOf(w.cook.id))!;
    await refused(readUrl(w, w.managerB, fileId));
  });

  it('13b. a second store-A enrol_staff holder who is NOT the uploader is refused on /files/<id>; canReadFiles never returns a signature id', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    await refused(readUrl(w, w.managerA2, sig.fileId));
    for (const who of [w.managerA2, w.managerA, w.admin, w.clerk]) {
      const allowed = await asOrg(w.orgId, (tx) => canReadFiles(tx, who.actor, [sig.fileId]));
      expect(allowed.has(sig.fileId)).toBe(false);
    }
    ACTOR_HOLDER.actor = w.managerA2.actor;
    const blocked = await filesRoute(new Request('http://x/files/' + sig.fileId), { params: Promise.resolve({ fileId: sig.fileId }) });
    expect(blocked.status).toBe(404);
    ACTOR_HOLDER.actor = w.managerA.actor; // positive control: the uploader gets through
    const ok = await filesRoute(new Request('http://x/files/' + sig.fileId), { params: Promise.resolve({ fileId: sig.fileId }) });
    expect(ok.status).toBe(302);
    ACTOR_HOLDER.actor = w.admin.actor;
    expect((await filesRoute(new Request('http://x'), { params: Promise.resolve({ fileId: sig.fileId }) })).status).toBe(302);
  });

  it('13c. after the uploader replaces the signature they cannot open the OLD file; a view_staff_signature holder can', async () => {
    const w = await world();
    const oldSig = await setSig(w, w.managerA, w.cook.id);
    const newSig = await setSig(w, w.managerA, w.cook.id, PNG_OTHER.slice());
    await refused(readUrl(w, w.managerA, oldSig.fileId));
    expect((await readUrl(w, w.clerk, oldSig.fileId)).url).toBeTruthy();
    expect((await readUrl(w, w.managerA, newSig.fileId)).url).toBeTruthy(); // current file: uploader still allowed
    // removed signature: uploader refused, holder allowed
    await removeSig(w, w.managerA, w.cook.id);
    await refused(readUrl(w, w.managerA, newSig.fileId));
    expect((await readUrl(w, w.admin, newSig.fileId)).url).toBeTruthy();
  });

  it('13d. view_staff_signature at ANY store of an open job is enough; a person with no open employment is admin/super only', async () => {
    const w = await world();
    await setSig(w, w.managerA, w.cook.id);
    await refused(viewSig(w, w.clerkB, w.cook.id)); // clerkB's grant is at B; the cook has no job at B yet
    await mkEmployment(w, w.cook.id, w.B, '2025-02-01'); // second open job at B
    expect((await viewSig(w, w.clerkB, w.cook.id)).url).toBeTruthy();
    // both jobs end: nobody but admin/super
    await sql`update employments set ended_on = '2025-06-01', employment_status = 'resigned' where person_id = ${w.cook.id}`;
    await refused(viewSig(w, w.clerkB, w.cook.id));
    await refused(viewSig(w, w.clerk, w.cook.id));
    expect((await viewSig(w, w.admin, w.cook.id)).url).toBeTruthy();
  });

  it('14. staff lists and loaders carry no signature field or signature file id', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    await setPhoto(w, w.managerA, w.cookEmp);
    const outputs = await asOrg(w.orgId, async (tx) => ({
      roster: await listRoster(tx, { storeId: w.A }),
      search: await searchPersons(tx, w.admin.actor, { query: 'Maria' }),
      access: await personsRepo.listWithAccessForOrg(tx, w.orgId),
      photos: await employmentRepo.photoFileIds(tx, [w.cookEmp]),
    }));
    const json = JSON.stringify(outputs, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v));
    expect(json).toContain('Maria Santos'); // positive control: the loaders did return the person
    expect(json).not.toContain(sig.fileId);
    expect(json).not.toMatch(/signature/i);
  });

  it('15a. an unauthorised readFileUrl for a signature throws AND a staff_signature.view_refused row survives the rollback', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    await refused(readUrl(w, w.managerA2, sig.fileId)); // the enclosing transaction rolled back
    const rows = await auditRows(w.orgId, 'staff_signature.view_refused');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(w.managerA2.id);
    expect(rows[0]!.entity_id).toBe(w.cook.id);
    expect(await auditRows(w.orgId, 'staff_signature.viewed')).toHaveLength(0);
    // same through the person-keyed function
    await refused(viewSig(w, w.cashier, w.cook.id));
    expect(await auditRows(w.orgId, 'staff_signature.view_refused')).toHaveLength(2);
  });

  it('15b. every minted signature link has a matching viewed row', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    await readUrl(w, w.admin, sig.fileId);
    await viewSig(w, w.admin, w.cook.id);
    await viewSig(w, w.clerk, w.cook.id);
    await readUrl(w, w.managerA, sig.fileId); // uploader, current file
    const rows = await auditRows(w.orgId, 'staff_signature.viewed');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.entity_id === w.cook.id)).toBe(true);
  });

  it('16. the signature URL, path and file id are never logged', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    const path = (await fileRow(sig.fileId))!.storage_path;
    const calls: string[] = [];
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      const fn = (logger as unknown as Record<string, unknown>)[level];
      if (typeof fn === 'function') vi.spyOn(logger as never, level as never).mockImplementation(((...a: unknown[]) => { calls.push(JSON.stringify(a, (_k, v) => (v instanceof Error ? { n: v.name, m: v.message } : v))); }) as never);
    }
    const minted = await viewSig(w, w.admin, w.cook.id);
    await refused(viewSig(w, w.cashier, w.cook.id));
    await refused(readUrl(w, w.managerA2, sig.fileId));
    const all = calls.join('\n');
    expect(all).not.toContain(minted.url);
    expect(all).not.toContain('memory://');
    expect(all).not.toContain(path);
    expect(all).not.toContain(sig.fileId);
  });

  it('21. the signature link lives 60 s even if the caller asks for 300; a photo link keeps the longer default', async () => {
    const w = await world();
    const sig = await setSig(w, w.managerA, w.cook.id);
    const photo = await setPhoto(w, w.managerA, w.cookEmp);
    const expiry = (u: string) => Number(/expires=(\d+)/.exec(u)![1]) - Date.now();
    const s300 = await readUrl(w, w.admin, sig.fileId, 300);
    expect(expiry(s300.url)).toBeLessThanOrEqual(61_000);
    expect(expiry((await viewSig(w, w.admin, w.cook.id)).url)).toBeLessThanOrEqual(61_000);
    expect(expiry((await readUrl(w, w.managerA2, photo.fileId)).url)).toBeGreaterThan(120_000);
  });
});

// ---------------------------------------------------------------- 18 print, 20 capability, 22 audit payloads
describe('print path, capability matrix, audit payloads', () => {
  it('18. signatureForPrint is gated and audited exactly like a view, and returns bytes not a URL', async () => {
    const w = await world();
    await setSig(w, w.managerA, w.cook.id);
    const out = await asOrg(w.orgId, (tx) => dm.signatureForPrint!(tx, w.admin.actor, { personId: w.cook.id }));
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.bytes as Uint8Array)).toEqual(Array.from(PNG)); // the PNG came back (stripping may not alter this 1x1)
    expect(out.contentType).toBe('image/png');
    expect(JSON.stringify(Object.keys(out))).not.toMatch(/url/i);
    const viewed = await auditRows(w.orgId, 'staff_signature.viewed');
    expect(viewed.some((r) => r.actor_person_id === w.admin.id && r.entity_id === w.cook.id)).toBe(true);
    await refused(asOrg(w.orgId, (tx) => dm.signatureForPrint!(tx, w.managerA2.actor, { personId: w.cook.id })));
    await refused(asOrg(w.orgId, (tx) => dm.signatureForPrint!(tx, w.cashier.actor, { personId: w.cook.id })));
    expect((await auditRows(w.orgId, 'staff_signature.view_refused')).length).toBe(2);
  });

  it('20. view_staff_signature: manager and staff refused, admin allowed without a grant, a position grant gives view but not run_payroll', async () => {
    const w = await world();
    const cap = VIEW_CAP as never;
    await refused(asOrg(w.orgId, (tx) => authorize(tx, w.managerA.actor, cap, { storeId: w.A })));
    await refused(asOrg(w.orgId, (tx) => authorize(tx, w.cashier.actor, cap, { storeId: w.A })));
    await asOrg(w.orgId, (tx) => authorize(tx, w.admin.actor, cap, { storeId: w.A }));
    await asOrg(w.orgId, (tx) => authorize(tx, w.clerk.actor, cap, { storeId: w.A }));
    const err = await refused(asOrg(w.orgId, (tx) => authorize(tx, w.clerk.actor, 'run_payroll', { storeId: w.A })));
    expect(err).toBeInstanceOf(AuthorizationError);
    // the grant is store-scoped: clerk (grant at A) is refused at B
    await refused(asOrg(w.orgId, (tx) => authorize(tx, w.clerk.actor, cap, { storeId: w.B })));
  });

  it('22. no staff_signature.* audit payload holds a signature file id, storage path, URL or full checksum', async () => {
    const w = await world();
    const first = await setSig(w, w.managerA, w.cook.id);
    const second = await setSig(w, w.managerA, w.cook.id, PNG_OTHER.slice());
    await viewSig(w, w.admin, w.cook.id);
    await readUrl(w, w.clerk, first.fileId);
    await refused(viewSig(w, w.cashier, w.cook.id));
    await asOrg(w.orgId, (tx) => dm.signatureForPrint!(tx, w.admin.actor, { personId: w.cook.id }));
    await removeSig(w, w.managerA, w.cook.id);
    const rows = await sql<{ action: string; before: unknown; after: unknown; entity_id: string }[]>`
      select action, before, after, entity_id from audit_log where org_id = ${w.orgId} and action like 'staff_signature.%'`;
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['set', 'replaced', 'removed', 'viewed', 'view_refused']) expect(actions.has(`staff_signature.${a}`)).toBe(true);
    const paths = (await sql<{ storage_path: string; checksum: string }[]>`select storage_path, checksum from stored_files where org_id = ${w.orgId} and purpose = 'staff_signature'`);
    for (const r of rows) {
      const payload = JSON.stringify({ before: r.before, after: r.after });
      expect(payload).not.toContain(first.fileId);
      expect(payload).not.toContain(second.fileId);
      expect(payload).not.toContain('orgs/');
      expect(payload).not.toMatch(/memory:|https?:/);
      expect(payload).not.toMatch(/[0-9a-f]{64}/i);
      for (const p of paths) { expect(payload).not.toContain(p.storage_path); expect(payload).not.toContain(p.checksum); }
      expect((payload.match(UUID_G) ?? []).filter((u) => u !== w.cook.id)).toEqual([]); // at most the person
      expect(r.entity_id).toBe(w.cook.id);
    }
  });
});
