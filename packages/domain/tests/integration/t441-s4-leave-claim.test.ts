import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-441 S4 TESTER - a leave certificate arrives through the shared upload control.
 * docs/tasks/441-photo-upload-control.md section 5 "S4", sections 3 and 4, audit A1/A2.
 *
 * ASSUMED CONTRACT (the builder must match, or say so):
 *   attachLeaveDocument(tx, actor, { requestId, fileId }) -> { fileId }  (the claim path) alongside the existing
 *   { requestId, contentType, bytes } path. The claim path:
 *     - authorizes manage_attendance at the request's store FIRST (same as the bytes path) and refuses a cancelled / rejected request
 *       with the same LEAVE_DOCUMENT_REFUSED refusal;
 *     - then calls claimUpload(tx, actor, { fileId, purpose: 'leave_document', storeId: request.storeId, linkTo: request.id }),
 *       so a wrong store / wrong purpose / someone else's file / already-linked file is the claim's one "no longer available" refusal;
 *     - never re-uploads (no new stored_files row, no new bytes in the driver).
 *   The bytes path keeps working unchanged (the no-JS fallback is resolved to a fileId by the action, but the old input stays valid).
 *
 * RED reason before the build: attachLeaveDocument does not read `fileId`; with no bytes it throws a TypeError / uploads nothing.
 * Mutants killed are named in each title (S4-Mn).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  attachLeaveDocument,
  cancelLeave,
  inMemoryDriver,
  rejectLeave,
  requestLeave,
  setStorageDriver,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let driver = inMemoryDriver();
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await sql.end();
  await closeDb();
});

function jpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0xff, 0xd9]);
}

async function fixture(hint: string) {
  const code = uid(`s4c-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${n}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin', [storeA, storeB]);
  const mgr1 = await mk('Manager 1', 'manager', [storeA, storeB]);
  const mgr2 = await mk('Manager 2', 'manager', [storeA]);
  const mgrB = await mk('Manager B', 'manager', [storeB]);
  const workerId = await mk('Worker', 'staff', [storeA]);
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeA}, ${uid('sc')}, '2025-01-01', 'regular', ${adminId}) returning id`;
  const f = {
    orgId, storeA, storeB, employmentId: e!.id,
    admin: actor(orgId, adminId), mgr1: actor(orgId, mgr1), mgr2: actor(orgId, mgr2), mgrB: actor(orgId, mgrB), worker: actor(orgId, workerId),
  };
  const newRequest = async (date: string) => {
    const r = await asOrg(orgId, (tx) =>
      requestLeave(tx, f.worker, { employmentId: f.employmentId, leaveType: 'sick', note: 'n', days: [{ date, kind: 'leave' }] } as never));
    return (r as { requestId: string }).requestId;
  };
  return { ...f, requestId: await newRequest('2026-03-02'), newRequest };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** An unlinked upload row whose bytes really are in the driver (what POST /files/upload leaves behind). */
async function upload(f: F, o: { by: string; purpose?: string; storeId?: string | null; ageHours?: number; linkedTo?: string | null }) {
  const purpose = o.purpose ?? 'leave_document';
  const storeId = o.storeId === undefined ? f.storeA : o.storeId;
  const path = `orgs/${f.orgId}/${storeId ? `stores/${storeId}/` : ''}${purpose}/${crypto.randomUUID()}.jpg`;
  await driver.put({ path, bytes: jpeg(), contentType: 'image/jpeg' } as never);
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by, linked_to, uploaded_at)
    values (${f.orgId}, ${storeId}, ${purpose}, ${path}, 'image/jpeg', ${jpeg().length}, ${uid('sum')}, ${o.by}, ${o.linkedTo ?? null},
            now() - make_interval(hours => ${o.ageHours ?? 0}))
    returning id`;
  return row!.id;
}
const linkedTo = async (id: string) => (await sql<{ linked_to: string | null }[]>`select linked_to from stored_files where id = ${id}`)[0]?.linked_to ?? null;
const fileRows = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from stored_files where org_id = ${orgId}`)[0]!.n);
const attachFile = (f: F, who: Actor, fileId: string, requestId = f.requestId) =>
  asOrg(f.orgId, (tx) => attachLeaveDocument(tx, who, { requestId, fileId } as never)) as Promise<{ fileId: string }>;
const attachBytes = (f: F, who: Actor) =>
  asOrg(f.orgId, (tx) => attachLeaveDocument(tx, who, { requestId: f.requestId, contentType: 'image/jpeg', bytes: jpeg() } as never)) as Promise<{ fileId: string }>;
const refusal = async (p: Promise<unknown>): Promise<RefusalError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof RefusalError) return err;
    throw new Error(`expected a RefusalError but got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  throw new Error('expected a refusal, but the attach succeeded');
};

describe('S4 - the claim path links an already-uploaded certificate to the request', () => {
  it('S4-M1 claim path: linked_to = the request, the same file id comes back, nothing is uploaded a second time', async () => {
    const f = await fixture('ok');
    const id = await upload(f, { by: f.mgr1.personId });
    const rowsBefore = await fileRows(f.orgId);
    const bytesBefore = driver.files.size;
    const out = await attachFile(f, f.mgr1, id);
    expect(out.fileId).toBe(id);
    expect(await linkedTo(id)).toBe(f.requestId);
    expect(await fileRows(f.orgId), 'S4-M2 the claim path must not insert a second stored_files row').toBe(rowsBefore);
    expect(driver.files.size, 'S4-M2 the claim path must not write the bytes again').toBe(bytesBefore);
  });

  it('S4-M3 the claim path still authorizes manage_attendance first: the employee, and a manager of another store, are refused and link nothing', async () => {
    const f = await fixture('auth');
    const id = await upload(f, { by: f.worker.personId });
    await expect(attachFile(f, f.worker, id)).rejects.toThrow(AuthorizationError);
    const idB = await upload(f, { by: f.mgrB.personId });
    await expect(attachFile(f, f.mgrB, idB)).rejects.toThrow(AuthorizationError); // storeB manager, request is store A
    expect(await linkedTo(id)).toBeNull();
    expect(await linkedTo(idB)).toBeNull();
  });

  it('S4-M4 a manager cannot claim a file a different person uploaded', async () => {
    const f = await fixture('mine');
    const theirs = await upload(f, { by: f.mgr2.personId });
    const err = await refusal(attachFile(f, f.mgr1, theirs));
    expect(err.userMessage).toMatch(/no longer available/i);
    expect(await linkedTo(theirs)).toBeNull();
  });

  it('S4-M5 a file already linked elsewhere (or to another request) cannot be claimed again', async () => {
    const f = await fixture('taken');
    const other = await f.newRequest('2026-03-03');
    const taken = await upload(f, { by: f.mgr1.personId });
    await attachFile(f, f.mgr1, taken, other);
    expect(await linkedTo(taken)).toBe(other);
    const err = await refusal(attachFile(f, f.mgr1, taken)); // now asked for f.requestId
    expect(err.userMessage).toMatch(/no longer available/i);
    expect(await linkedTo(taken), 'the first claim must stay').toBe(other);
  });
});

describe('S4 - refusals leave the file unlinked', () => {
  it.each(['cancelled', 'rejected'] as const)('S4-M6 / S4-M7 a request that is %s refuses the certificate (LEAVE_DOCUMENT_REFUSED) and the file stays unlinked', async (kind) => {
    const f = await fixture(kind);
    const id = await upload(f, { by: f.mgr1.personId });
    if (kind === 'cancelled') await asOrg(f.orgId, (tx) => cancelLeave(tx, f.worker, { requestId: f.requestId }));
    else await asOrg(f.orgId, (tx) => rejectLeave(tx, f.mgr1, { requestId: f.requestId }));
    const err = await refusal(attachFile(f, f.mgr1, id));
    expect((err as { code?: string }).code ?? err.message).toMatch(/LEAVE_DOCUMENT_REFUSED|cancelled or rejected/);
    expect(await linkedTo(id)).toBeNull();
  });

  it('S4-M8 store mismatch: a certificate uploaded for store B cannot be attached to a store A request', async () => {
    const f = await fixture('store');
    const id = await upload(f, { by: f.mgr1.personId, storeId: f.storeB });
    const err = await refusal(attachFile(f, f.mgr1, id));
    expect(err.userMessage).toMatch(/no longer available/i);
    expect(await linkedTo(id)).toBeNull();
  });

  it('S4-M9 another purpose: a receipt_photo upload (same store, same uploader) cannot be attached as a certificate', async () => {
    const f = await fixture('purpose');
    const id = await upload(f, { by: f.mgr1.personId, purpose: 'receipt_photo' });
    const err = await refusal(attachFile(f, f.mgr1, id));
    expect(err.userMessage).toMatch(/no longer available/i);
    expect(await linkedTo(id)).toBeNull();
  });

  it('S4-M10 an upload older than 24 h, an unknown id and a malformed id are the same one refusal', async () => {
    const f = await fixture('stale');
    const old = await upload(f, { by: f.mgr1.personId, ageHours: 25 });
    const msgs: string[] = [];
    for (const id of [old, crypto.randomUUID(), 'not-a-uuid']) msgs.push((await refusal(attachFile(f, f.mgr1, id))).userMessage);
    expect(msgs.every((m) => /no longer available/i.test(m))).toBe(true);
    expect(new Set(msgs).size).toBe(1);
    expect(await linkedTo(old)).toBeNull();
  });

  it('S4-M11 an unknown request is refused before any claim; the posted file is untouched', async () => {
    const f = await fixture('norequest');
    const id = await upload(f, { by: f.mgr1.personId });
    await expect(attachFile(f, f.mgr1, id, crypto.randomUUID())).rejects.toThrow();
    expect(await linkedTo(id)).toBeNull();
  });
});

describe('S4 - the existing bytes path is unchanged', () => {
  it('S4-M12 bytes in: uploaded as leave_document for the request store and linked to the request', async () => {
    const f = await fixture('bytes');
    const { fileId } = await attachBytes(f, f.mgr1);
    const [row] = await sql<{ purpose: string; linked_to: string | null; store_id: string }[]>`
      select purpose, linked_to, store_id from stored_files where id = ${fileId}`;
    expect(row).toMatchObject({ purpose: 'leave_document', linked_to: f.requestId, store_id: f.storeA });
  });

  it('S4-M13 bytes path: the employee is still refused, and a cancelled request still refuses', async () => {
    const f = await fixture('bytes2');
    await expect(attachBytes(f, f.worker)).rejects.toThrow(AuthorizationError);
    await asOrg(f.orgId, (tx) => cancelLeave(tx, f.worker, { requestId: f.requestId }));
    await refusal(attachBytes(f, f.mgr1));
  });
});
