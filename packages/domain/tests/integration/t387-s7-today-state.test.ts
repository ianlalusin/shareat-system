import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-387 S7 - the live roster state. `todayStateFor(tx, actor, storeId)` answers, per active employment at one
 * store, whether they are on the clock, on break, or off, from TODAY's open `attendance_days` row and the latest
 * punch intent (`break_start` -> break).
 *
 * PINNED SHAPE: `Record<employmentId, { state: 'on' | 'break' | 'off'; since?: Date }>`, one key for EVERY active
 * employment at the store (off included, `since` absent when off). `since` = occurredAt of the punch that began the
 * state: the day's first `in` for on, the latest `break_start` for break.
 * PINNED GATE (consistent with attendanceRoster): `authorize(tx, actor, 'manage_attendance', { storeId })`, so a
 * viewer without the capability for that store is REFUSED with AuthorizationError. The page catches it and draws no
 * chips. CAPABILITY-MATRIX: manage_attendance is store scoped, super/admin/manager yes, staff no.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  adjudicateDay,
  createEmployment,
  recordPunch,
  seedAttendanceConfig,
  seedCanonicalPositions,
  todayStateFor,
  toShiftDay,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
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

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function newStore(orgId: string, hint: string): Promise<string> {
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );
  return store!.id;
}

async function scopedPerson(orgId: string, storeId: string, name: string, role: 'admin' | 'manager' | 'staff') {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`update person_roles set revoked_at = now() where person_id = ${p!.id} and org_id = ${orgId} and revoked_at is null`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${storeId}, 'manual') on conflict (person_id, store_id) do nothing`;
  return p!.id;
}

async function fixture(hint: string) {
  const code = uid(`ts-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const storeA = await newStore(orgId, `${hint}a`);
  const storeB = await newStore(orgId, `${hint}b`);

  const adminId = await scopedPerson(orgId, storeA, 'Admin', 'admin');
  await sql`insert into person_store_scope (person_id, store_id, source) values (${adminId}, ${storeB}, 'manual') on conflict (person_id, store_id) do nothing`;
  const admin = actor(orgId, adminId);
  const managerA = actor(orgId, await scopedPerson(orgId, storeA, 'Manager A', 'manager'));
  const staffA = actor(orgId, await scopedPerson(orgId, storeA, 'Staff A', 'staff'));

  async function hire(storeId: string, name: string) {
    const [w] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    return asOrg(orgId, (tx) =>
      createEmployment(tx, admin, { storeId, personId: w!.id, employmentStatus: 'regular', startedOn: '2026-01-05' }),
    );
  }
  const on = await hire(storeA, 'Ana On');
  const brk = await hire(storeA, 'Ben Break');
  const off = await hire(storeA, 'Cia Off');
  const done = await hire(storeA, 'Dan Done');
  const otherStore = await hire(storeB, 'Eve Elsewhere');
  return { orgId, storeA, storeB, admin, managerA, staffA, on, brk, off, done, otherStore };
}
type F = Awaited<ReturnType<typeof fixture>>;

const today = () => toShiftDay(new Date());
const punch = (f: F, employmentId: string, at: Date, intent: 'in' | 'out' | 'break_start' | 'break_end') =>
  asOrg(f.orgId, (tx) =>
    recordPunch(tx, {
      clientPunchId: uid('cp'),
      employmentId,
      occurredAt: at,
      method: 'qr',
      assertedIntent: intent,
      source: 'online',
    }),
  );
const settle = (f: F, employmentId: string) =>
  asOrg(f.orgId, (tx) => adjudicateDay(tx, { employmentId, shiftDay: today() }));
const stateFor = (f: F, who: Actor, storeId: string) =>
  asOrg(f.orgId, (tx) => todayStateFor(tx, who, storeId));

async function seedStates(f: F) {
  await punch(f, f.on.id, minsAgo(40), 'in');
  await settle(f, f.on.id);
  await punch(f, f.brk.id, minsAgo(50), 'in');
  await punch(f, f.brk.id, minsAgo(10), 'break_start');
  await settle(f, f.brk.id);
  // Dan clocked in and out already today: his day is no longer open.
  await punch(f, f.done.id, minsAgo(60), 'in');
  await punch(f, f.done.id, minsAgo(30), 'out');
  await settle(f, f.done.id);
  // Cia has no punches at all.
}

describe('T-387 S7 - todayStateFor', () => {
  it('on, break and off come from the open day and the latest punch intent', async () => {
    const f = await fixture('states');
    await seedStates(f);
    const s = await stateFor(f, f.admin, f.storeA);
    expect(s[f.on.id]!.state).toBe('on');
    expect(s[f.brk.id]!.state).toBe('break');
    expect(s[f.off.id]!.state).toBe('off');
    // Clocked out already: the day is not open, so off.
    expect(s[f.done.id]!.state).toBe('off');
  });

  it('every active employment of the store has a key, and `since` is the punch that began the state', async () => {
    const f = await fixture('since');
    await seedStates(f);
    const s = await stateFor(f, f.admin, f.storeA);
    expect(Object.keys(s).sort()).toEqual([f.on.id, f.brk.id, f.off.id, f.done.id].sort());
    expect(s[f.on.id]!.since).toBeInstanceOf(Date);
    expect(Math.abs(s[f.on.id]!.since!.getTime() - minsAgo(40).getTime())).toBeLessThan(60_000);
    expect(Math.abs(s[f.brk.id]!.since!.getTime() - minsAgo(10).getTime())).toBeLessThan(60_000);
    expect(s[f.off.id]!.since).toBeUndefined();
  });

  it('break_end puts the person back to on (the LATEST intent decides)', async () => {
    const f = await fixture('breakend');
    await punch(f, f.brk.id, minsAgo(50), 'in');
    await punch(f, f.brk.id, minsAgo(20), 'break_start');
    await punch(f, f.brk.id, minsAgo(5), 'break_end');
    await settle(f, f.brk.id);
    expect((await stateFor(f, f.admin, f.storeA))[f.brk.id]!.state).toBe('on');
  });

  it('a manager scoped to the store reads it (positive control for the gate tests)', async () => {
    const f = await fixture('mgrok');
    await seedStates(f);
    const s = await stateFor(f, f.managerA, f.storeA);
    expect(s[f.on.id]!.state).toBe('on');
  });

  it('GATE x: a store-A manager asking for store B is REFUSED, and learns nothing', async () => {
    const f = await fixture('mgrb');
    await seedStates(f);
    await punch(f, f.otherStore.id, minsAgo(30), 'in');
    await settle(f, f.otherStore.id);
    await expect(stateFor(f, f.managerA, f.storeB)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('GATE x: a person WITHOUT manage_attendance (staff role) is REFUSED even at their own store', async () => {
    const f = await fixture('staffno');
    await seedStates(f);
    await expect(stateFor(f, f.staffA, f.storeA)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('never returns another store\'s people: store A state has no store-B employment', async () => {
    const f = await fixture('scope');
    await punch(f, f.otherStore.id, minsAgo(30), 'in');
    await settle(f, f.otherStore.id);
    const s = await stateFor(f, f.admin, f.storeA);
    expect(s[f.otherStore.id]).toBeUndefined();
  });
});
