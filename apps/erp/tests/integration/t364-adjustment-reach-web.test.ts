import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * T-364 S2 (DEF-497), web leg — `setStartAnchorAction` must not let a non-holder tell a real
 * `employmentId` apart from a fake one via the redirect `error`. `docs/tasks/364-def-496-497-
 * authorise-first.md` §S2, legs W1-W3. Harness copied from `t352-attendance-auth-before-parse.
 * test.ts`'s `dayFixture`/`dayFormData`/`adjustmentCountFor` (`:272-325`), `employmentId`
 * overridden per leg, plus a second store + `otherManager` for W2 (not in the T-352 harness).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null; sessionId: string } = { actor: null, sessionId: '' };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({ actor: ACTOR_HOLDER.actor!, sessionId: ACTOR_HOLDER.sessionId })),
}));
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { createEmployment, seedAttendanceConfig, seedCanonicalPositions, toShiftDay } from '@shareat/domain';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const errorOf = (to: string) => paramsOf(to).get('error');

const DAY = toShiftDay(new Date());

async function makeSession(personId: string, storeId: string): Promise<string> {
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [s] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('t')}, ${personId}, ${cred!.id}, 'pin', ${storeId}, now() + interval '12 hours') returning id`;
  return s!.id;
}

async function dayFixture(hint: string) {
  const code = uid(`t364w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string; code: string; name: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id, code, name`;
  const [store2] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(`${hint}-2`)}, ${`Store2 ${hint}`}) returning id`;
  const storeId = store!.id;

  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeId}, 'manual')`;
  const admin_ = actorOf(orgId, adminId);

  const [worker] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const employment = await asOrg(orgId, (tx) =>
    createEmployment(tx, admin_, { storeId, personId: worker!.id, employmentStatus: 'regular', startedOn: '2026-01-05' }),
  );
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }));

  const adminSessionId = await makeSession(adminId, storeId);

  // The non-holder. CAPABILITY-MATRIX: manage_attendance ✗ for staff.
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Floor Staff') returning id`;
  const staffId = staff!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staffId}, ${storeId}, 'manual')`;
  const staffSessionId = await makeSession(staffId, storeId);

  // W2 — a manager scoped ONLY to the second store.
  const [otherManager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Other-Store Manager') returning id`;
  const otherManagerId = otherManager!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${otherManagerId}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${otherManagerId}, ${store2!.id}, 'manual')`;
  const otherManagerSessionId = await makeSession(otherManagerId, store2!.id);

  return {
    orgId,
    storeId,
    storeName: store!.name,
    storeCode: store!.code,
    employment,
    admin: admin_,
    adminSessionId,
    staff: actorOf(orgId, staffId),
    staffSessionId,
    otherManager: actorOf(orgId, otherManagerId),
    otherManagerSessionId,
  };
}
type DayFixture = Awaited<ReturnType<typeof dayFixture>>;

/** Verbatim shape, t343-s5-5t-followups.test.ts:136-143 / t352's dayFormData. */
function dayFormData(f: DayFixture, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('dayId', f.employment.id);
  fd.set('employmentId', f.employment.id);
  fd.set('shiftDay', DAY);
  fd.set('chosenAnchorMinute', '60');
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

/** Verbatim shape, t343-s5-5t-followups.test.ts:145-151. */
async function adjustmentCountFor(f: DayFixture, kind: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from attendance_adjustments
    where employment_id = ${f.employment.id} and shift_day = ${DAY} and kind = ${kind}
      and superseded_by_adjustment_id is null`;
  return Number(row!.count);
}

const O = 'That employment does not exist, or it is not at a store where you manage attendance.';

describe('W1 — staff session, oracle pair', () => {
  it('real vs fake employmentId collapse to the same error, O', async () => {
    const f = await dayFixture('w1');
    ACTOR_HOLDER.actor = f.staff;
    ACTOR_HOLDER.sessionId = f.staffSessionId;
    const { setStartAnchorAction } = await import('../../src/app/attendance/[dayId]/actions');

    const toReal = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f)));
    const toFake = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f, { employmentId: randomUUID() })));
    expect(errorOf(toReal), `redirect URL was: ${toReal}`).toBe(O);
    expect(errorOf(toFake), `redirect URL was: ${toFake}`).toBe(O);
  });
});

describe('W2 — otherManager session, scoped-out holder', () => {
  // Split from the target assertion below (orchestrator RED-FIX, 2026-09-30) — see the domain
  // file's A2 for why. This positive control calls authorize() directly, independent of the web
  // action, so it stays green before and after the fix.
  it('positive control: authorize() itself still names the store', async () => {
    const f = await dayFixture('w2-control');
    let named = '';
    try {
      await asOrg(f.orgId, (tx) => authorize(tx, f.otherManager, 'manage_attendance', { storeId: f.storeId, orgId: f.orgId }));
      throw new Error('expected authorize() to reject for this fixture');
    } catch (err) {
      named = (err as { userMessage?: string; message: string }).userMessage ?? (err as Error).message;
    }
    expect(
      named.includes(f.storeName) || named.includes(f.storeCode),
      `expected the fixture store's name/code (${f.storeName}/${f.storeCode}) in: ${named}`,
    ).toBe(true);
  });

  it('as W1; O never names the store, and the real/fake pair collapse to O', async () => {
    const f = await dayFixture('w2');
    ACTOR_HOLDER.actor = f.otherManager;
    ACTOR_HOLDER.sessionId = f.otherManagerSessionId;
    const { setStartAnchorAction } = await import('../../src/app/attendance/[dayId]/actions');

    const toReal = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f)));
    const toFake = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f, { employmentId: randomUUID() })));
    expect(errorOf(toReal), `redirect URL was: ${toReal}`).toBe(O);
    expect(errorOf(toFake), `redirect URL was: ${toFake}`).toBe(O);
    // Mutant: the action/recordAdjustment redirects with authorize()'s store-naming sentence instead of O -> red.
    for (const to of [toReal, toFake]) {
      expect(errorOf(to) ?? '').not.toContain(f.storeName);
      expect(errorOf(to) ?? '').not.toContain(f.storeCode);
    }
  });
});

describe('W3 — positive control: admin session, real employment', () => {
  it('redirects with no error; the adjustment saves', async () => {
    const f = await dayFixture('w3');
    ACTOR_HOLDER.actor = f.admin;
    ACTOR_HOLDER.sessionId = f.adminSessionId;
    const { setStartAnchorAction } = await import('../../src/app/attendance/[dayId]/actions');

    const before = await adjustmentCountFor(f, 'start_anchor');
    const to = await expectRedirectTo(() => setStartAnchorAction(dayFormData(f)));
    expect(errorOf(to), `redirect URL was: ${to}`).toBeNull();
    expect(await adjustmentCountFor(f, 'start_anchor')).toBe(before + 1);
  });
});
