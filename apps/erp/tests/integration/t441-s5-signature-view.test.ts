import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-441 S5 TESTER - behavioural proofs for the signature shell. docs/tasks/441-photo-upload-control.md audit A6 + A10, bible row 353.
 *
 *  1. staffMediaView hands signatureFileId ONLY to a viewer allowed to open the signature (canViewSignature); a viewer with store
 *     scope but no right learns hasSignature and nothing else. Mutant S5a: the id returned to every viewer.
 *  2. Each GET /files/{signatureFileId} (fresh ?open=n, a repeated identical URL, no query) writes exactly ONE
 *     staff_signature.viewed row. Mutant: the lightbox open is served from a cache / the audit skipped for ?open=.
 *  3. A refused GET is the uniform 404, never a Location, writes staff_signature.view_refused and never .viewed.
 *     NOTE (observed, by design in files/signature.ts): a repeated refusal by the same viewer for the same person within 60 s
 *     is NOT written again (hasRecentSignatureRefusal), so two refused GETs leave ONE refusal row.
 *
 * RED reasons before the build: (1) the result has no signatureFileId key, so the admin's id check fails. (2)/(3) already hold for
 * the existing route and domain; they are here as the regression net the shell now depends on (no earlier test covered a signature
 * through /files/{id}: t441-files-upload-route covers the leave certificate only).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const SESSION: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  currentSession: vi.fn(async () => null),
  requireSession: vi.fn(async () => {
    throw new Error('redirect:/sign-in');
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
import { inMemoryDriver, removeStaffSignature, setStaffSignature, setStorageDriver, staffMediaView } from '@shareat/domain';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
beforeEach(() => {
  setStorageDriver(inMemoryDriver());
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
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

async function fixture() {
  const code = uid('t441s5');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'S') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const workerId = await mk('Worker', 'staff');
  const colleagueId = await mk('Colleague', 'staff');
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${uid('sc')}, '2025-01-01', 'regular', ${adminId}) returning id`;
  const admin = actor(orgId, adminId);
  const saved = await asOrg(orgId, (tx) => setStaffSignature(tx, admin, { personId: workerId, contentType: 'image/png', bytes: png() }));
  return { orgId, employmentId: e!.id, workerId, admin, colleague: actor(orgId, colleagueId), fileId: saved.fileId };
}

const audit = async (orgId: string, action: string, by: string) =>
  (await sql`select 1 from audit_log where org_id = ${orgId} and action = ${action} and actor_person_id = ${by}`).length;
async function get(who: Actor, fileId: string, query: string): Promise<Response> {
  SESSION.actor = who;
  const { GET } = await import('../../src/app/files/[fileId]/route');
  return GET(new Request(`http://localhost:9008/files/${fileId}${query}`), { params: Promise.resolve({ fileId }) } as never);
}

describe('S5a - staffMediaView hands the signature file id only to a viewer who may open it (row 353)', () => {
  it('an admin gets the current file id with canViewSignature true', async () => {
    const f = await fixture();
    const m = (await asOrg(f.orgId, (tx) => staffMediaView(tx, f.admin, { employmentId: f.employmentId }))) as Record<string, unknown>;
    expect(m['hasSignature']).toBe(true);
    expect(m['canViewSignature']).toBe(true);
    expect(m['signatureFileId']).toBe(f.fileId);
  });

  it('a colleague WITH store scope but no right learns hasSignature only: no id, in the object or anywhere in its JSON', async () => {
    const f = await fixture();
    const m = (await asOrg(f.orgId, (tx) => staffMediaView(tx, f.colleague, { employmentId: f.employmentId }))) as Record<string, unknown>;
    expect(m['hasSignature']).toBe(true);
    expect(m['canViewSignature']).toBe(false);
    expect(m['signatureFileId'] ?? null).toBeNull();
    expect(JSON.stringify(m)).not.toContain(f.fileId);
  });

  it('no signature on file: nobody gets an id, including the admin', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => removeStaffSignature(tx, f.admin, { personId: f.workerId }));
    const m = (await asOrg(f.orgId, (tx) => staffMediaView(tx, f.admin, { employmentId: f.employmentId }))) as Record<string, unknown>;
    expect(m['hasSignature']).toBe(false);
    expect(m['signatureFileId'] ?? null).toBeNull();
  });
});

describe('A6 - each GET /files/{signatureFileId} is one audited view; a refused GET is a uniform 404 with a refusal row', () => {
  it('every open (fresh ?open=n, a repeated identical URL, no query) writes its own staff_signature.viewed row and answers a no-store redirect', async () => {
    const f = await fixture();
    for (const q of ['?open=1', '?open=2', '?open=2', '']) {
      const res = await get(f.admin, f.fileId, q);
      expect(res.status, q).toBe(302);
      expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
      expect(res.headers.get('location') ?? '').not.toBe('');
    }
    expect(await audit(f.orgId, 'staff_signature.viewed', f.admin.personId)).toBe(4);
    expect(await audit(f.orgId, 'staff_signature.view_refused', f.admin.personId)).toBe(0);
  });

  it('a colleague without the right gets the uniform 404 (no Location) and a view_refused row, never a viewed one', async () => {
    const f = await fixture();
    for (const q of ['?open=1', '?open=2']) {
      const res = await get(f.colleague, f.fileId, q);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
    // a repeat refusal by the same viewer for the same person inside 60 s is deduplicated by design (hasRecentSignatureRefusal)
    expect(await audit(f.orgId, 'staff_signature.view_refused', f.colleague.personId)).toBe(1);
    expect(await audit(f.orgId, 'staff_signature.viewed', f.colleague.personId)).toBe(0);
  });
});
