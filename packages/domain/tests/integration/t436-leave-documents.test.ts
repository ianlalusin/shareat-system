import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-436 S6 - medical-certificate photos, row-353 guarded. Cases 27-31.
 *
 * API contract (additional to the header of `t436-leave.test.ts`):
 *   attachLeaveDocument {requestId, contentType, bytes} -> {fileId}   (purpose `leave_document`, linked_to = request id)
 *   openLeaveDocument   {requestId} -> {url}                          (the ONLY reader; 60 s link; audits viewed / view_refused)
 *   loadLeaveRequest / listLeave / leaveGrid / exportLeaveCsv expose `hasProof` (boolean) and NEVER the file id.
 *   New capability `view_leave_document` (store-scoped, position-grantable via person_grants).
 * Who may view: (a) pending - a manage_attendance holder at the store who is not the employee; once decided - only
 * the person who decided it, while still holding manage_attendance; (b) a `view_leave_document` holder; (c) admin/super.
 *
 * RED REASON today: no leave module; `leave_document` is not a file purpose and `view_leave_document` is not a capability.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`,
  );
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  approveLeave,
  attachLeaveDocument,
  exportLeaveCsv,
  FileNotFoundError,
  inMemoryDriver,
  leaveGrid,
  listLeave,
  loadLeaveRequest,
  openLeaveDocument,
  readFileUrl,
  requestLeave,
  setStorageDriver,
  uploadFile,
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

/** A structurally real JPEG carrying GPS in an EXIF segment (same shape as files.test.ts). */
function photoWithGps(): Uint8Array {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const payload = [...ascii('Exif\0'), 0, ...ascii('GPS 14.0865 121.1553')];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload,
    0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0xff, 0xd9]);
}

beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await sql.end();
  await closeDb();
});

const NOTE = 'DOCNOTE-private-qq81';

async function fixture(hint: string) {
  const code = uid(`d436-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${n}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');
  const mk = async (name: string, role: string, stores: string[], grant?: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    if (grant) await sql`insert into person_grants (person_id, grant_name) values (${p!.id}, ${grant})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin', [storeA, storeB]);
  const mgr1 = await mk('Manager 1', 'manager', [storeA]);
  const mgr2 = await mk('Manager 2', 'manager', [storeA]);
  const mgrB = await mk('Manager B', 'manager', [storeB]);
  const workerId = await mk('Worker', 'staff', [storeA]);
  const colleagueId = await mk('Colleague', 'staff', [storeA]);
  const payrollId = await mk('Payroll', 'staff', [storeA], 'view_leave_document');
  const superId = await mk('Super', 'super_admin', [storeA]);
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeA}, ${uid('sc')}, '2025-01-01', 'regular', ${adminId}) returning id`;
  const f = {
    orgId, storeA, storeB, workerId, employmentId: e!.id, mgr1Id: mgr1,
    admin: actor(orgId, adminId), mgr1: actor(orgId, mgr1), mgr2: actor(orgId, mgr2), mgrB: actor(orgId, mgrB),
    worker: actor(orgId, workerId), colleague: actor(orgId, colleagueId), payroll: actor(orgId, payrollId),
    superA: actor(orgId, superId),
  };
  const r = await asOrg(orgId, (tx) =>
    requestLeave(tx, f.worker, { employmentId: f.employmentId, leaveType: 'sick', note: NOTE, days: [{ date: '2026-03-02', kind: 'leave' }] } as never));
  return { ...f, requestId: r.requestId as string };
}
type F = Awaited<ReturnType<typeof fixture>>;

const attach = (f: F, who: Actor) =>
  asOrg(f.orgId, (tx) =>
    attachLeaveDocument(tx, who, { requestId: f.requestId, contentType: 'image/jpeg', bytes: photoWithGps() } as never)) as Promise<{ fileId: string }>;
const open = (f: F, who: Actor) =>
  asOrg(f.orgId, (tx) => openLeaveDocument(tx, who, { requestId: f.requestId } as never)) as Promise<{ url: string }>;
const decide = (f: F, who: Actor) => asOrg(f.orgId, (tx) => approveLeave(tx, who, { requestId: f.requestId } as never));
const load = (f: F, who: Actor) =>
  asOrg(f.orgId, (tx) => loadLeaveRequest(tx, who, { requestId: f.requestId } as never)).catch(() => null) as Promise<Record<string, unknown> | null>;
const auditFor = (orgId: string, action: string, actorId?: string) =>
  sql<{ actor_person_id: string }[]>`
    select actor_person_id from audit_log where org_id = ${orgId} and action = ${action}
      ${actorId ? sql`and actor_person_id = ${actorId}` : sql``}`;
const secondsLeft = (u: string) => (Number(u.split('expires=')[1]) - Date.now()) / 1000;

// =====================================================================================

describe('T-436 case 27 - attaching a certificate', () => {
  it('a manager attaches: purpose leave_document, EXIF stripped, linked_to = the request', async () => {
    const f = await fixture('a27');
    const { fileId } = await attach(f, f.mgr1);
    const [row] = await sql<{ purpose: string; linked_to: string | null; storage_path: string; content_type: string }[]>`
      select purpose, linked_to, storage_path, content_type from stored_files where id = ${fileId}`;
    expect(row).toMatchObject({ purpose: 'leave_document', linked_to: f.requestId, content_type: 'image/jpeg' });
    const stored = driver.files.get(row!.storage_path)!;
    expect(String.fromCharCode(...stored)).not.toContain('GPS');
    expect(Array.from(stored.slice(-5))).toEqual([0x11, 0x22, 0x33, 0xff, 0xd9]);
  });

  it('a staff-role actor (the employee, a colleague) cannot attach, and cannot upload the purpose directly', async () => {
    const f = await fixture('a27s');
    await expect(attach(f, f.worker)).rejects.toThrow(AuthorizationError);
    await expect(attach(f, f.colleague)).rejects.toThrow(AuthorizationError);
    await expect(
      asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.colleague, { purpose: 'leave_document' as never, storeId: f.storeA, contentType: 'image/jpeg', bytes: photoWithGps() })),
    ).rejects.toThrow(AuthorizationError);
    await expect(attach(f, f.mgrB)).rejects.toThrow(AuthorizationError); // store B
  });

  it('a file linked to a request survives the orphan sweep (linked_to is set at upload)', async () => {
    const f = await fixture('a27l');
    const { fileId } = await attach(f, f.mgr1);
    const [row] = await sql<{ linked_to: string | null }[]>`select linked_to from stored_files where id = ${fileId}`;
    expect(row!.linked_to).not.toBeNull();
  });
});

// =====================================================================================

describe('T-436 case 28 - who may view, with a 60-second link and an audit row', () => {
  it('a pending request: the other store-A manager and an admin each get a 60 s link and a viewed row', async () => {
    const f = await fixture('v28p');
    await attach(f, f.mgr1);
    for (const who of [f.mgr2, f.admin]) {
      const { url: link } = await open(f, who);
      const left = secondsLeft(link);
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThanOrEqual(61); // mutant: the 300 s default
    }
    expect((await auditFor(f.orgId, 'leave_document.viewed', f.mgr2.personId)).length).toBe(1);
    expect((await auditFor(f.orgId, 'leave_document.viewed', f.admin.personId)).length).toBe(1);
  });

  it('after the decision: the deciding manager, a view_leave_document holder, an admin and a super_admin may view', async () => {
    const f = await fixture('v28d');
    await attach(f, f.mgr1);
    await decide(f, f.mgr1);
    for (const who of [f.mgr1, f.payroll, f.admin, f.superA]) {
      const { url: link } = await open(f, who);
      expect(secondsLeft(link)).toBeLessThanOrEqual(61);
      expect((await auditFor(f.orgId, 'leave_document.viewed', who.personId)).length).toBe(1);
    }
  });

  it('readFileUrl for this purpose is also capped at 60 s even when the caller asks for 300', async () => {
    const f = await fixture('v28r');
    const { fileId } = await attach(f, f.mgr1);
    await decide(f, f.mgr1);
    const { url: link } = await asOrg(f.orgId, (tx) => readFileUrl(tx, f.mgr1, { fileId, expiresInSeconds: 300 }));
    expect(secondsLeft(link)).toBeLessThanOrEqual(61);
  });
});

// =====================================================================================

describe('T-436 case 29 - everyone else sees only "proof attached"', () => {
  it('colleague, store-B manager, the employee and (after the decision) the other store-A manager: hasProof true, no id, no link', async () => {
    const f = await fixture('v29');
    const { fileId } = await attach(f, f.mgr1);
    await decide(f, f.mgr1);
    for (const who of [f.colleague, f.mgrB, f.worker, f.mgr2]) {
      const r = await load(f, who);
      if (r) {
        expect(r.hasProof, 'hasProof').toBe(true);
        const blob = JSON.stringify(r);
        expect(blob).not.toContain(fileId);
        expect(blob).not.toMatch(/memory:\/\//);
        expect(blob).not.toMatch(/orgs\//);
      }
      await expect(open(f, who)).rejects.toThrow();
    }
  });

  it('the second manager COULD view while it was pending - the decision is what narrows it', async () => {
    const f = await fixture('v29b');
    await attach(f, f.mgr1);
    await open(f, f.mgr2); // pending: allowed
    await decide(f, f.mgr1);
    await expect(open(f, f.mgr2)).rejects.toThrow();
  });
});

// =====================================================================================

describe('T-436 case 30 - a guessed /files/<id> is the same 404 as a missing id', () => {
  it('an unauthorised viewer gets FileNotFoundError, identical in wording to a missing id, and a view_refused row survives the rollback', async () => {
    const f = await fixture('v30');
    const { fileId } = await attach(f, f.mgr1);
    await decide(f, f.mgr1);
    const probe = async (id: string) => {
      try {
        await asOrg(f.orgId, (tx) => readFileUrl(tx, f.mgr2, { fileId: id }));
      } catch (e) {
        return e as Error & { userMessage?: string };
      }
      throw new Error('expected a refusal');
    };
    const guessed = await probe(fileId);
    const missing = await probe('0190a000-0000-7000-8000-000000000000');
    expect(guessed).toBeInstanceOf(FileNotFoundError); // NOT AuthorizationError, which would confirm the file exists
    expect(missing).toBeInstanceOf(FileNotFoundError);
    const norm = (e: { message: string; userMessage?: string }, id: string) =>
      `${e.message} ${e.userMessage ?? ''}`.split(id).join('<id>');
    expect(norm(guessed, fileId)).toBe(norm(missing, '0190a000-0000-7000-8000-000000000000'));

    // the refusal's own transaction rolled back, but the attempt is on the record
    const refusedRows = await auditFor(f.orgId, 'leave_document.view_refused', f.mgr2.personId);
    expect(refusedRows.length).toBeGreaterThanOrEqual(1);
  });

  it('the note-only manage_attendance read path (canReadFiles) does not open it either', async () => {
    const f = await fixture('v30c');
    const { fileId } = await attach(f, f.mgr1);
    await decide(f, f.mgr1);
    await expect(asOrg(f.orgId, (tx) => readFileUrl(tx, f.colleague, { fileId }))).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(asOrg(f.orgId, (tx) => readFileUrl(tx, f.mgrB, { fileId }))).rejects.toBeInstanceOf(FileNotFoundError);
  });
});

// =====================================================================================

describe('T-436 case 31 - no proof file id, path or URL in grids, lists, exports or audit', () => {
  it('none of them carries the id, the storage path or a link', async () => {
    const f = await fixture('v31');
    const { fileId } = await attach(f, f.mgr1);
    await decide(f, f.mgr1);
    await open(f, f.mgr1); // writes a viewed row
    await open(f, f.admin);
    const [sf] = await sql<{ storage_path: string }[]>`select storage_path from stored_files where id = ${fileId}`;
    const range = { storeId: f.storeA, from: '2026-03-01', to: '2026-03-31' };
    const outputs = [
      JSON.stringify(await asOrg(f.orgId, (tx) => listLeave(tx, f.mgr1, range as never))),
      JSON.stringify(await asOrg(f.orgId, (tx) => leaveGrid(tx, f.mgr1, range as never))),
      String(await asOrg(f.orgId, (tx) => exportLeaveCsv(tx, f.mgr1, range as never))),
      JSON.stringify(
        await sql`select before::text as b, after::text as a, entity_id from audit_log where org_id = ${f.orgId}`,
      ),
    ];
    for (const out of outputs) {
      expect(out).not.toContain(fileId);
      expect(out).not.toContain(sf!.storage_path);
      expect(out).not.toMatch(/memory:\/\//);
    }
    // and "proof attached" IS shown to the people allowed to see the row at all
    const list = (await asOrg(f.orgId, (tx) => listLeave(tx, f.mgr1, range as never))) as { hasProof?: boolean }[];
    expect(list.some((r) => r.hasProof === true)).toBe(true);
  });
});
