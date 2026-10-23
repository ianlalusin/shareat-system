import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-395 S2, test 17 - `reopenPinSignIn(tx, actor, storeId)`. docs/tasks/395-pin-sign-in-throttle.md R5, R6, I9.
 *
 * TESTER, not BUILDER. State is seeded by SQL straight into `pin_attempt_throttle` (stopped_at set, tier-1 counters
 * non-zero) so this file does not depend on the sign-in path. Every decision goes through the real `authorize()`.
 *
 * ## State at HEAD (read this before judging the red)
 * `reopenPinSignIn` is not exported from `@shareat/auth`, so at HEAD every call is `TypeError: reopenPinSignIn is not a
 * function`. The sentinel `X0` fails by name on `typeof reopenPinSignIn`. The JUDGING assertions, which only bite once the
 * function exists, are: the allowed legs' row/audit assertions, and the refused legs' `AuthorizationError` class check
 * (a TypeError is NOT an AuthorizationError, so a refused leg cannot go green on the missing export).
 *
 * ## Mutants
 *  - `authorize` removed: X2 (staff) and X3 (other-store manager) and X6 (other org) go red (the reopen happens).
 *  - `authorize` without `{ storeId }`: X3 goes red (the other-store manager passes an org-level check, or the check
 *    cannot tell the stores apart).
 *  - audit row not written / written twice / on a no-op: X1, X4, X5 (exactly one row, none on a no-op).
 *  - counters not zeroed or `reopened_by` not set: X1.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, RefusalError, type Tx } from '@shareat/db';
import * as auth from '@shareat/auth';
import { AuthorizationError, type Role } from '@shareat/auth';

type Reopen = (tx: Tx, actor: { personId: string; orgId: string }, storeId: string) => Promise<{ reopened: boolean }>;
const reopenPinSignIn = (auth as unknown as { reopenPinSignIn?: Reopen }).reopenPinSignIn as Reopen;

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
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

async function mkOrg(hint: string) {
  const code = uid(`t395r-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const mkStore = async (n: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${`Store ${n}`}) returning id`)[0]!.id;
  const mkPerson = async (name: string, role: Role, storeId: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${storeId}, 'manual')`;
    return { personId: p!.id, orgId };
  };
  return { orgId, mkStore, mkPerson };
}

/** One org, two stores; store A is STOPPED with tier-1 counters set; store B is stopped too (to prove cross-store reach). */
async function fixture(hint: string) {
  const o = await mkOrg(hint);
  const storeA = await o.mkStore(`${hint}A`);
  const storeB = await o.mkStore(`${hint}B`);
  const manager = await o.mkPerson(`${hint} Manager`, 'manager', storeA);
  const admin = await o.mkPerson(`${hint} Admin`, 'admin', storeA);
  const superAdmin = await o.mkPerson(`${hint} Super`, 'super_admin', storeA);
  const staff = await o.mkPerson(`${hint} Staff`, 'staff', storeA);
  const otherManager = await o.mkPerson(`${hint} Other-store Manager`, 'manager', storeB);
  for (const s of [storeA, storeB]) await stop(o.orgId, s);
  return { orgId: o.orgId, storeA, storeB, manager, admin, superAdmin, staff, otherManager };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

async function stop(orgId: string, storeId: string) {
  await sql`
    insert into pin_attempt_throttle (org_id, store_id, fail_count, window_started_at, locked_until, stopped_at)
    values (${orgId}, ${storeId}, 7, now() - interval '30 seconds', now() + interval '90 seconds', now() - interval '1 hour')
    on conflict (store_id) where staff_code is null do update set fail_count = 7, window_started_at = now() - interval '30 seconds',
      locked_until = now() + interval '90 seconds', stopped_at = now() - interval '1 hour', reopened_at = null, reopened_by = null`;
}
const row = async (storeId: string) =>
  (
    await sql<
      { stopped_at: Date | null; reopened_at: Date | null; reopened_by: string | null; fail_count: number; locked_until: Date | null; window_started_at: Date | null }[]
    >`select stopped_at, reopened_at, reopened_by, fail_count, locked_until, window_started_at from pin_attempt_throttle where store_id = ${storeId}`
  )[0]!;
const audits = (orgId: string, storeId: string) =>
  sql<{ actor_person_id: string; action: string; entity: string; entity_id: string; before: Record<string, unknown>; after: Record<string, unknown>; source: string }[]>`
    select actor_person_id, action, entity, entity_id, before, after, source from audit_log
    where org_id = ${orgId} and action = 'reopen_pin_sign_in' and entity_id = ${storeId}`;

async function tryReopen(orgId: string, actor: { personId: string; orgId: string }, storeId: string): Promise<{ result?: { reopened: boolean }; error?: unknown }> {
  try {
    return { result: await asOrg(orgId, (tx) => reopenPinSignIn(tx, actor, storeId)) };
  } catch (error) {
    return { error };
  }
}
async function expectUnchanged(fx: Fx, storeId: string) {
  const r = await row(storeId);
  expect(r.stopped_at, 'a refused reopen leaves the store stopped').not.toBeNull();
  expect(r.reopened_at).toBeNull();
  expect(r.reopened_by).toBeNull();
  expect(r.fail_count).toBe(7);
  expect(await audits(fx.orgId, storeId), 'a refused reopen writes no audit row').toHaveLength(0);
}

describe('T-395 S2 test 17 - reopenPinSignIn', () => {
  it('X0 (sentinel): reopenPinSignIn is exported from @shareat/auth', () => {
    expect(typeof reopenPinSignIn, 'reopenPinSignIn must be a function exported by packages/auth/src/index.ts').toBe('function');
  });

  it('X1: a manager at the store reopens it; one audit row; reopened_by set; tier-1 counters zeroed', async () => {
    const fx = await fixture('x1');
    const before = await row(fx.storeA);
    const { result, error } = await tryReopen(fx.orgId, fx.manager, fx.storeA);
    expect(error, 'X1: the manager must be allowed').toBeUndefined();
    expect(result).toEqual({ reopened: true });
    const r = await row(fx.storeA);
    expect(r.stopped_at).toBeNull();
    expect(r.reopened_at).not.toBeNull();
    expect(r.reopened_by).toBe(fx.manager.personId);
    expect(r.fail_count).toBe(0);
    expect(r.locked_until).toBeNull();
    expect(r.window_started_at).toBeNull();
    const a = await audits(fx.orgId, fx.storeA);
    expect(a, 'exactly one audit row').toHaveLength(1);
    expect(a[0]!.actor_person_id).toBe(fx.manager.personId);
    expect(a[0]!.entity).toBe('store');
    expect(a[0]!.source).toBe('web');
    expect(a[0]!.before).toHaveProperty('stoppedAt');
    expect(a[0]!.after).toHaveProperty('reopenedAt');
    expect(new Date(a[0]!.after.reopenedAt as string).getTime(), "audit after.reopenedAt is the row's reopened_at, one clock").toBe(r.reopened_at!.getTime());
    expect(new Date(a[0]!.before.stoppedAt as string).getTime(), 'before.stoppedAt is the stop being reopened').toBe(before.stopped_at!.getTime());
    // Reaching another store is not part of this call.
    expect((await row(fx.storeB)).stopped_at, "the other store's stop is untouched").not.toBeNull();
  });

  it('X1b: an admin and a super_admin (enrol_staff holders) may reopen too', async () => {
    for (const who of ['admin', 'superAdmin'] as const) {
      const fx = await fixture(`x1b-${who}`);
      const { result, error } = await tryReopen(fx.orgId, fx[who], fx.storeA);
      expect(error, `X1b: ${who} must be allowed`).toBeUndefined();
      expect(result).toEqual({ reopened: true });
      expect((await row(fx.storeA)).stopped_at).toBeNull();
      expect(await audits(fx.orgId, fx.storeA)).toHaveLength(1);
    }
  });

  it('X2 (negative): staff is refused with AuthorizationError; nothing changes', async () => {
    const fx = await fixture('x2');
    const { result, error } = await tryReopen(fx.orgId, fx.staff, fx.storeA);
    expect(result, 'staff must not reopen').toBeUndefined();
    expect(error, 'X2: the refusal must be an AuthorizationError (enrol_staff is not held)').toBeInstanceOf(AuthorizationError);
    await expectUnchanged(fx, fx.storeA);
  });

  it('X3 (negative): a manager scoped to ANOTHER store is refused for this store; nothing changes', async () => {
    const fx = await fixture('x3');
    const { result, error } = await tryReopen(fx.orgId, fx.otherManager, fx.storeA);
    expect(result, 'a manager of store B must not reopen store A').toBeUndefined();
    expect(error, 'X3: the refusal must be an AuthorizationError (enrol_staff is store-scoped)').toBeInstanceOf(AuthorizationError);
    await expectUnchanged(fx, fx.storeA);
    // ... and the same manager CAN reopen their own store (the capability is held, only the reach is wrong).
    const own = await tryReopen(fx.orgId, fx.otherManager, fx.storeB);
    expect(own.error, 'X3 control: the other-store manager reopens their own store').toBeUndefined();
    expect(own.result).toEqual({ reopened: true });
  });

  it('X4: reopening a store that is not stopped is a no-op: { reopened: false }, no audit row, reopened_at untouched', async () => {
    const fx = await fixture('x4');
    await sql`update pin_attempt_throttle set stopped_at = null where store_id = ${fx.storeA}`;
    const { result, error } = await tryReopen(fx.orgId, fx.manager, fx.storeA);
    expect(error, 'X4: an allowed actor on a store that is not stopped is not an error').toBeUndefined();
    expect(result).toEqual({ reopened: false });
    expect(await audits(fx.orgId, fx.storeA), 'a no-op writes no audit row (I9)').toHaveLength(0);
    const r = await row(fx.storeA);
    expect(r.reopened_at).toBeNull();
    expect(r.reopened_by).toBeNull();
    expect(r.fail_count, 'a no-op does not zero tier 1').toBe(7);
  });

  it('X5: a second reopen right after the first is a no-op (one audit row in total)', async () => {
    const fx = await fixture('x5');
    expect((await tryReopen(fx.orgId, fx.manager, fx.storeA)).result).toEqual({ reopened: true });
    expect((await tryReopen(fx.orgId, fx.admin, fx.storeA)).result).toEqual({ reopened: false });
    const a = await audits(fx.orgId, fx.storeA);
    expect(a).toHaveLength(1);
    expect((await row(fx.storeA)).reopened_by, 'the first reopener stays on the row').toBe(fx.manager.personId);
  });

  it("X6 (negative): a manager of ANOTHER ORG cannot reopen this org's store", async () => {
    const fx = await fixture('x6');
    const o2 = await mkOrg('x6-other');
    const s2 = await o2.mkStore('x6-other-store');
    const stranger = await o2.mkPerson('Stranger Manager', 'manager', s2);
    const { result, error } = await tryReopen(o2.orgId, stranger, fx.storeA);
    expect(result?.reopened ?? false, 'a stranger must never reopen another org store').toBe(false);
    expect(error, "X6: authorize refuses another org's store with an AuthorizationError").toBeInstanceOf(AuthorizationError);
    await expectUnchanged(fx, fx.storeA);
  });

  it('X7: a non-uuid storeId is a RefusalError in plain words, not a Postgres error', async () => {
    const fx = await fixture('x7');
    const { result, error } = await tryReopen(fx.orgId, fx.manager, 'not-a-uuid');
    expect(result, 'nothing reopened').toBeUndefined();
    expect(error, 'X7: must be a RefusalError').toBeInstanceOf(RefusalError);
    expect((error as Error).message).not.toMatch(/invalid input syntax|uuid/i);
    await expectUnchanged(fx, fx.storeA);
  });
});
