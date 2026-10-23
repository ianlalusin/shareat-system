import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-441 S4 TESTER - a leave certificate is opened from the Lightbox, one audited view per open, and only a viewer who passes
 * `decideLeaveDocumentRead` is ever handed the file id. docs/tasks/441-photo-upload-control.md section 5 "S4", audit A6, bible row 353.
 *
 * ASSUMED CONTRACT (the builder must match, or say so):
 *   apps/erp/src/app/attendance/leave/lib.ts exports  loadProofFileId(actor, requestId): Promise<string | null>
 *     - returns the newest certificate's file id ONLY when decideLeaveDocumentRead allows this viewer, else null
 *       (no certificate, no right, an unknown request all look the same: null);
 *     - DECIDES ONLY: it writes NO audit row (no leave_document.viewed, no view_refused) - the audited event is the GET /files/{id}
 *       the Lightbox makes when the person opens it;
 *     - a fault in the decision is null, never an exception that leaks.
 *   The existing page loaders (listLeave rows -> groupByRequest, loadRequestDetail, myLeave) keep exposing `hasProof` (a boolean)
 *   and NEVER the file id: their JSON never contains it.
 *   GET /files/[fileId] is the existing T-436/T-441 route: each call for a leave_document writes exactly ONE row for an
 *   authorised viewer (leave_document.viewed) and ONE leave_document.view_refused for a refused one (uniform 404).
 *
 * RED reason before the build: lib.ts has no loadProofFileId (every loadProofFileId test fails with "not a function").
 * The GET route tests pin the existing audit contract on the exact viewers S4 shows the button to; they may already be green.
 * Mutants killed are named in each title (S4-Vn).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const SESSION: { actor: { orgId: string; personId: string } | null } = { actor: null };
const resolved = () => ({
  actor: SESSION.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
});
vi.mock('../../src/lib/session', () => ({
  currentSession: vi.fn(async () => (SESSION.actor ? resolved() : null)),
  requireSession: vi.fn(async () => {
    if (!SESSION.actor) throw new Error('redirect:/sign-in');
    return resolved();
  }),
  requireActor: vi.fn(async () => {
    if (!SESSION.actor) throw new Error('redirect:/sign-in');
    return SESSION.actor;
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called - the routes must return their own responses');
  },
}));

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { approveLeave, attachLeaveDocument, inMemoryDriver, requestLeave, setStorageDriver } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let driver = inMemoryDriver();
beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
  SESSION.actor = null;
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

function jpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0, 0x11, 0x22, 0x33, 0xff, 0xd9]);
}

async function fixture(hint: string) {
  const code = uid(`s4v-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
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
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeA}, ${'SE-' + (100000 + Math.floor(Math.random() * 899999999))}, '2025-01-01', 'regular', ${adminId}) returning id`;
  const f = {
    orgId, storeA, storeB, employmentId: e!.id,
    admin: actor(orgId, adminId), mgr1: actor(orgId, mgr1), mgr2: actor(orgId, mgr2), mgrB: actor(orgId, mgrB),
    worker: actor(orgId, workerId), colleague: actor(orgId, colleagueId), payroll: actor(orgId, payrollId),
  };
  const r = await asOrg(orgId, (tx) =>
    requestLeave(tx, f.worker, { employmentId: e!.id, leaveType: 'sick', note: 'NOTE-s4', days: [{ date: '2026-03-02', kind: 'leave' }] } as never));
  const requestId = (r as { requestId: string }).requestId;
  const att = (await asOrg(orgId, (tx) =>
    attachLeaveDocument(tx, f.mgr1, { requestId, contentType: 'image/jpeg', bytes: jpeg() } as never))) as { fileId: string };
  return { ...f, requestId, fileId: att.fileId };
}
type F = Awaited<ReturnType<typeof fixture>>;

const auditCount = async (orgId: string, action?: string, by?: string) =>
  (await sql`select 1 from audit_log where org_id = ${orgId}
    ${action ? sql`and action like ${action}` : sql``} ${by ? sql`and actor_person_id = ${by}` : sql``}`).length;
const leaveAudit = (orgId: string) => auditCount(orgId, 'leave_document.%');

async function loader() {
  const mod = (await import('../../src/app/attendance/leave/lib')) as unknown as Record<string, unknown>;
  const fn = mod['loadProofFileId'];
  if (typeof fn !== 'function') throw new Error('loadProofFileId is not exported from apps/erp/src/app/attendance/leave/lib.ts yet');
  return fn as (actor: Actor, requestId: string) => Promise<string | null>;
}
async function get(who: Actor, fileId: string, query = ''): Promise<Response> {
  SESSION.actor = who;
  const { GET } = await import('../../src/app/files/[fileId]/route');
  return GET(new Request(`http://localhost:9008/files/${fileId}${query}`), { params: Promise.resolve({ fileId }) } as never);
}

describe('S4 loader - an unauthorised viewer is handed NO file id (so the page renders no View)', () => {
  it.each([
    ['the employee', (f: F) => f.worker],
    ['a colleague', (f: F) => f.colleague],
    ['a manager of another store', (f: F) => f.mgrB],
  ])('S4-V1 %s gets null, even though the certificate exists', async (_n, who) => {
    const f = await fixture('deny');
    const load = await loader();
    expect(await load(who(f), f.requestId)).toBeNull();
  });

  it('S4-V2 once the request is decided, a second store manager (not the decider) gets null; the decider still gets the id', async () => {
    const f = await fixture('decided');
    await asOrg(f.orgId, (tx) => approveLeave(tx, f.mgr1, { requestId: f.requestId }));
    const load = await loader();
    expect(await load(f.mgr2, f.requestId), 'not the decider').toBeNull();
    expect(await load(f.mgr1, f.requestId), 'the decider').toBe(f.fileId);
  });

  it('S4-V3 no certificate on the request, or an unknown request, is null for everyone (never an exception)', async () => {
    const f = await fixture('none');
    const bare = await asOrg(f.orgId, (tx) =>
      requestLeave(tx, f.worker, { employmentId: f.employmentId, leaveType: 'sick', note: 'x', days: [{ date: '2026-03-09', kind: 'leave' }] } as never));
    const load = await loader();
    expect(await load(f.admin, (bare as { requestId: string }).requestId), 'no certificate').toBeNull();
    expect(await load(f.admin, crypto.randomUUID())).toBeNull();
    expect(await load(f.admin, 'not-a-uuid')).toBeNull();
  });
});

describe('S4 loader - an authorised viewer gets the id, and loading writes NO audit row', () => {
  it.each([
    ['a manager while pending', (f: F) => f.mgr2],
    ['a view_leave_document holder', (f: F) => f.payroll],
    ['an admin', (f: F) => f.admin],
  ])('S4-V4 %s gets the file id', async (_n, who) => {
    const f = await fixture('allow');
    const load = await loader();
    expect(await load(who(f), f.requestId)).toBe(f.fileId);
  });

  it('S4-V5 the loader DECIDES ONLY: loading for allowed and refused viewers, many times, adds no leave_document.* audit row', async () => {
    const f = await fixture('noaudit');
    const load = await loader();
    const before = await leaveAudit(f.orgId);
    for (const who of [f.admin, f.mgr2, f.payroll, f.worker, f.colleague, f.mgrB]) {
      await load(who, f.requestId);
      await load(who, f.requestId);
    }
    expect(await leaveAudit(f.orgId), 'a load must not write viewed / view_refused rows').toBe(before);
  });

  it('S4-V6 the id never travels in the existing page data: loadRequestDetail and the store list JSON do not contain it', async () => {
    const f = await fixture('nojson');
    const lib = (await import('../../src/app/attendance/leave/lib')) as unknown as {
      loadRequestDetail: (a: Actor, id: string) => Promise<unknown>;
      loadStoreLeave: (a: Actor, i: { storeId: string; from: string; to: string }) => Promise<unknown>;
      loadMine: (a: Actor) => Promise<unknown>;
    };
    const detail = JSON.stringify(await lib.loadRequestDetail(f.mgr2, f.requestId));
    const list = JSON.stringify(await lib.loadStoreLeave(f.mgr2, { storeId: f.storeA, from: '2026-03-01', to: '2026-03-31' }));
    const mine = JSON.stringify(await lib.loadMine(f.worker));
    for (const [name, json] of [['detail', detail], ['list', list], ['mine', mine]] as const) {
      expect(json, `${name} leaked the file id`).not.toContain(f.fileId);
    }
    expect(detail).toContain('"hasProof":true');
  });
});

describe('S4 view - GET /files/{id}: one audited row per open', () => {
  it('S4-V7 for an authorised viewer each GET writes EXACTLY one leave_document.viewed (a fresh ?open=n, the same URL again, and no query alike)', async () => {
    const f = await fixture('viewed');
    const before = await auditCount(f.orgId, 'leave_document.viewed', f.admin.personId);
    for (const [i, q] of ['?open=1', '?open=2', '?open=2', ''].entries()) {
      const res = await get(f.admin, f.fileId, q);
      expect(res.status, q).toBe(302);
      expect(await auditCount(f.orgId, 'leave_document.viewed', f.admin.personId), `after GET #${i + 1}`).toBe(before + i + 1);
    }
    expect(await auditCount(f.orgId, 'leave_document.view_refused')).toBe(0);
  });

  it('S4-V8 a refused GET (colleague, employee, other-store manager) is the uniform 404 and writes view_refused, never viewed', async () => {
    const f = await fixture('refused');
    for (const who of [f.colleague, f.worker, f.mgrB]) {
      const res = await get(who, f.fileId, '?open=1');
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
      expect(await auditCount(f.orgId, 'leave_document.view_refused', who.personId), who.personId).toBe(1);
      expect(await auditCount(f.orgId, 'leave_document.viewed', who.personId)).toBe(0);
    }
  });

  it('S4-V9 the loader and the GET agree: whoever the loader hands an id to is exactly who the route lets open it', async () => {
    const f = await fixture('agree');
    const load = await loader();
    for (const who of [f.admin, f.mgr2, f.payroll, f.worker, f.colleague, f.mgrB]) {
      const id = await load(who, f.requestId);
      const res = await get(who, f.fileId, '?open=1');
      expect(id !== null, who.personId).toBe(res.status === 302);
    }
  });
});
