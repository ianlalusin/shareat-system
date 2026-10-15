import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-412 (Ian Q1 "a") - Staff issues a PIN to ANY administrator, so an administrator who signs in by email only can approve a
 * Tier P action. `issueAdminPinAction` (apps/erp/src/app/staff/actions.ts) is gated on `manage_users` (admin work): whoever can
 * set an administrator's PIN could otherwise approve in their place. The same rule closes the employment-page door:
 * `issuePinAction` on an employment whose person is an administrator now needs `manage_users` too.
 *
 * Real Postgres and the real auth underneath; only the session, Next's navigation helpers and the cookie jar are doubled.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { closeDb } from '@shareat/db';
import { verifyAdminApproval } from '@shareat/auth';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type ActionFn = (fd: FormData) => Promise<void>;
async function act(name: string, who: { personId: string; orgId: string }, fields: Record<string, string>) {
  const mod = (await import('../../src/app/staff/actions')) as unknown as Record<string, ActionFn>;
  const fn = mod[name];
  if (typeof fn !== 'function') throw new Error(`${name} is not exported from staff/actions`);
  resetJar();
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => fn(fd)));
}

async function fixture(hint: string) {
  const code = uid(`t412pin-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`;
  const storeId = st!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${storeId}, 'manual')`;
    return { personId: p!.id, orgId };
  };
  const admin = await mk('Admin', 'admin');
  const target = await mk('Email-only Admin', 'admin');
  const manager = await mk('Manager', 'manager');
  const staff = await mk('Staff', 'staff');
  return { orgId, storeId, admin, target, manager, staff };
}

const livePins = async (personId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from person_credentials where person_id = ${personId} and kind = 'pin' and revoked_at is null`)[0]!.n;

describe('issueAdminPinAction', () => {
  it('an administrator issues a PIN to another administrator who then approves with it', async () => {
    const f = await fixture('ok');
    const o = await act('issueAdminPinAction', f.admin, { personId: f.target.personId, storeId: f.storeId, pin: '482913' });
    expect(o.flash.error).toBeUndefined();
    expect(await livePins(f.target.personId)).toBe(1);
    expect(await verifyAdminApproval(null, { actor: f.manager, storeId: f.storeId, pin: '482913', capability: 'void_expense' })).toEqual({
      approverPersonId: f.target.personId,
    });
  });

  it('a manager cannot issue an administrator PIN (they could otherwise approve in the administrator’s place)', async () => {
    const f = await fixture('mgr');
    const o = await act('issueAdminPinAction', f.manager, { personId: f.target.personId, storeId: f.storeId, pin: '482913' });
    expect(o.flash.error, 'refused').toBeTruthy();
    expect(await livePins(f.target.personId)).toBe(0);
  });

  it('it only issues to an ACTIVE ADMINISTRATOR: a staff member is refused', async () => {
    const f = await fixture('staff');
    const o = await act('issueAdminPinAction', f.admin, { personId: f.staff.personId, storeId: f.storeId, pin: '482913' });
    expect(o.flash.error).toBe('That person is not an active administrator.');
    expect(await livePins(f.staff.personId)).toBe(0);
  });

  it('a malformed PIN is refused and nothing is issued', async () => {
    const f = await fixture('bad');
    const o = await act('issueAdminPinAction', f.admin, { personId: f.target.personId, storeId: f.storeId, pin: '12ab' });
    expect(o.flash.error).toBeTruthy();
    expect(await livePins(f.target.personId)).toBe(0);
  });
});

describe('issuePinAction on an employment whose person is an administrator', () => {
  async function employed(f: Awaited<ReturnType<typeof fixture>>, personId: string) {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${f.orgId}, ${f.storeId}, ${personId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
    return e!.id;
  }

  it('a manager holding enrol_staff cannot set an administrator’s PIN; an administrator can', async () => {
    const f = await fixture('emp');
    const employmentId = await employed(f, f.target.personId);
    const refused = await act('issuePinAction', f.manager, { employmentId, pin: '571936' });
    expect(refused.flash.error, 'the manager is refused').toBeTruthy();
    expect(await livePins(f.target.personId)).toBe(0);
    const ok = await act('issuePinAction', f.admin, { employmentId, pin: '571936' });
    expect(ok.flash.error).toBeUndefined();
    expect(await livePins(f.target.personId)).toBe(1);
  });

  it('a manager still issues an ordinary staff member’s PIN', async () => {
    const f = await fixture('emp2');
    const employmentId = await employed(f, f.staff.personId);
    const ok = await act('issuePinAction', f.manager, { employmentId, pin: '684027' });
    expect(ok.flash.error).toBeUndefined();
    expect(await livePins(f.staff.personId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// AUDIT ROUND M5 (orchestrator ruling): ONLY a super_admin may issue a PIN to a super_admin, through BOTH doors
// (issueAdminPinAction and issuePinAction). Otherwise an admin could choose a super_admin's PIN and approve in their place.
//   MS-1  drop the super_admin check in issueAdminPinAction  -> S1 red
//   MS-2  drop the super_admin check in issuePinAction       -> S2 red
// ---------------------------------------------------------------------------------------------------------------------
async function withSuper(hint: string) {
  const f = await fixture(hint);
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${f.storeId}, 'manual')`;
    return { personId: p!.id, orgId: f.orgId };
  };
  return { ...f, superA: await mk('Super A', 'super_admin'), superB: await mk('Super B', 'super_admin') };
}

describe('M5 issueAdminPinAction: a super_admin target needs a super_admin issuer', () => {
  it('S1: an ADMIN issuing to a super_admin is refused and nothing is issued (MS-1)', async () => {
    const f = await withSuper('s1');
    const o = await act('issueAdminPinAction', f.admin, { personId: f.superA.personId, storeId: f.storeId, pin: '482913' });
    expect(o.flash.error, 'refused').toBeTruthy();
    expect(await livePins(f.superA.personId)).toBe(0);
  });

  it('S1b (control): a super_admin issues to a super_admin; an admin still issues to an ordinary admin', async () => {
    const f = await withSuper('s1b');
    const ok = await act('issueAdminPinAction', f.superA, { personId: f.superB.personId, storeId: f.storeId, pin: '482913' });
    expect(ok.flash.error).toBeUndefined();
    expect(await livePins(f.superB.personId)).toBe(1);
    const ok2 = await act('issueAdminPinAction', f.admin, { personId: f.target.personId, storeId: f.storeId, pin: '571936' });
    expect(ok2.flash.error).toBeUndefined();
    expect(await livePins(f.target.personId)).toBe(1);
  });
});

describe('M5 issuePinAction on an employment whose person is a super_admin', () => {
  async function employed(f: Awaited<ReturnType<typeof withSuper>>, personId: string) {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${f.orgId}, ${f.storeId}, ${personId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
    return e!.id;
  }

  it('S2: an ADMIN setting a super_admin’s PIN is refused; a super_admin can (MS-2)', async () => {
    const f = await withSuper('s2');
    const employmentId = await employed(f, f.superA.personId);
    const refused = await act('issuePinAction', f.admin, { employmentId, pin: '684027' });
    expect(refused.flash.error, 'the admin is refused').toBeTruthy();
    expect(await livePins(f.superA.personId)).toBe(0);
    const ok = await act('issuePinAction', f.superB, { employmentId, pin: '684027' });
    expect(ok.flash.error).toBeUndefined();
    expect(await livePins(f.superA.personId)).toBe(1);
  });
});
