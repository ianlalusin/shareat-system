import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-402 S1b, R8 / Invariant 24 (the runtime half): `authorize()` itself decides view_activity_log (store) and
 * view_activity_log_restricted (org), against real Postgres. The cells are pinned in ../t402-s1b-capability-cells.test.ts.
 * Every allowed leg has its refusal leg: staff x2, a manager of ANOTHER store, a manager on the restricted one.
 *
 * ## State at HEAD
 * Red: neither name is in the matrix, so `authorize` cannot decide them (a TypeError, not an AuthorizationError): the
 * "allowed" legs fail outright and every "refused" leg fails on the error CLASS (a TypeError is not an AuthorizationError).
 * Mutants: restricted given to manager -> "manager refused (restricted)" red; plain scoped org -> "manager of the other
 * store refused" red; staff cell true -> both staff legs red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Capability, type Role } from '@shareat/auth';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

const PLAIN = 'view_activity_log' as string as Capability;
const RESTRICTED = 'view_activity_log_restricted' as string as Capability;

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture() {
  const code = uid('t402cap');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${`Store ${n}`}) returning id`)[0]!.id;
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');
  const mkPerson = async (role: Role, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${role}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${s}, 'manual')`;
    return { personId: p!.id, orgId };
  };
  return {
    orgId,
    storeA,
    storeB,
    superAdmin: await mkPerson('super_admin', [storeA, storeB]),
    admin: await mkPerson('admin', [storeA, storeB]),
    managerA: await mkPerson('manager', [storeA]),
    staffA: await mkPerson('staff', [storeA]),
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

async function tryAuthorize(fx: Fx, who: { personId: string; orgId: string }, cap: Capability, storeId?: string): Promise<unknown> {
  try {
    await asPerson(fx.orgId, (tx) => authorize(tx, who, cap, storeId ? { storeId } : {}));
    return null;
  } catch (e) {
    return e;
  }
}

describe('T-402 R8 - view_activity_log (store scope)', () => {
  it('allowed: super admin, admin, and the manager AT THEIR OWN store', async () => {
    const fx = await fixture();
    expect(await tryAuthorize(fx, fx.superAdmin, PLAIN, fx.storeA), 'super_admin').toBeNull();
    expect(await tryAuthorize(fx, fx.admin, PLAIN, fx.storeA), 'admin at A').toBeNull();
    expect(await tryAuthorize(fx, fx.admin, PLAIN, fx.storeB), 'admin at B').toBeNull();
    expect(await tryAuthorize(fx, fx.managerA, PLAIN, fx.storeA), 'manager at own store').toBeNull();
  });

  it('refused (AuthorizationError): staff, and a manager at a store that is not theirs', async () => {
    const fx = await fixture();
    expect(await tryAuthorize(fx, fx.staffA, PLAIN, fx.storeA), 'staff').toBeInstanceOf(AuthorizationError);
    expect(await tryAuthorize(fx, fx.managerA, PLAIN, fx.storeB), 'manager of A reading B').toBeInstanceOf(AuthorizationError);
  });
});

describe('T-402 R8 - view_activity_log_restricted (org scope)', () => {
  it('allowed: super admin and admin', async () => {
    const fx = await fixture();
    expect(await tryAuthorize(fx, fx.superAdmin, RESTRICTED), 'super_admin').toBeNull();
    expect(await tryAuthorize(fx, fx.admin, RESTRICTED), 'admin').toBeNull();
  });

  it('refused (AuthorizationError): manager (even at their own store) and staff', async () => {
    const fx = await fixture();
    expect(await tryAuthorize(fx, fx.managerA, RESTRICTED), 'manager, org-level').toBeInstanceOf(AuthorizationError);
    expect(await tryAuthorize(fx, fx.managerA, RESTRICTED, fx.storeA), 'manager, at own store').toBeInstanceOf(AuthorizationError);
    expect(await tryAuthorize(fx, fx.staffA, RESTRICTED), 'staff').toBeInstanceOf(AuthorizationError);
  });
});
