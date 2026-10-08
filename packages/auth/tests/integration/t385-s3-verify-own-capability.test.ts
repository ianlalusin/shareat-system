import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-385 S3, the runtime half of the capability - `docs/tasks/385-verify-only-after-submit.md` S3 (Ian 2026-10-09,
 * t385-q1 = a): `verify_own_sales_day` is super_admin only. A super-admin may verify a day they submitted themselves;
 * nobody else may. The matrix cells and the document row are proven in `tests/unit/capability-matrix.test.ts`; this file
 * proves `authorize()` itself against real Postgres, the same shape as T-382's `unlink_store_from_pos` test.
 *
 * The six "owner" grants are the five super-admin-only capabilities of 2026-10-08 plus the new one: an admin who holds
 * all six authorizes exactly what super_admin authorizes (the equivalence `createFirstAdmin` materialises and 0188's
 * backfill extends to existing owners).
 *
 * ## State at HEAD
 * Red: `verify_own_sales_day` is not in the matrix, so `authorize` cannot decide it (a TypeError, not an
 * `AuthorizationError`): every "refused" leg fails on the error class and the "allowed" legs fail outright.
 * Mutant: `admin: true` in the matrix row -> the "admin refused" leg is red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Capability, type Role } from '@shareat/auth';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const CAP = 'verify_own_sales_day' as string as Capability;
const FIVE = ['approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos'];

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

async function mkOrg() {
  const code = uid('t385s3a');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org!.id}, ${uid('st')}, 'Lipa') returning id`;
  return { orgId: org!.id, storeId: store!.id };
}
async function mkPerson(o: { orgId: string; storeId: string }, role: Role, grants: string[] = []) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o.orgId}, ${role}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${o.orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${o.storeId})`;
  for (const g of grants) await sql`insert into person_grants (person_id, grant_name, grant_source) values (${p!.id}, ${g}, 'owner')`;
  return p!.id;
}

/** Resolves to the error `authorize` threw, or null when it allowed. */
async function tryAuthorize(o: { orgId: string; storeId: string }, personId: string): Promise<unknown> {
  try {
    await asPerson(o.orgId, (tx) => authorize(tx, { personId, orgId: o.orgId }, CAP, { storeId: o.storeId }));
    return null;
  } catch (e) {
    return e;
  }
}

describe('T-385 S3 - authorize(verify_own_sales_day)', () => {
  it('super_admin is allowed', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, 'super_admin');
    expect(await tryAuthorize(o, id), 'super_admin must be allowed').toBeNull();
  });

  it('an admin without the grant, a manager and a staff member are each refused with AuthorizationError (not any other error)', async () => {
    const o = await mkOrg();
    for (const role of ['admin', 'manager', 'staff'] as const) {
      const id = await mkPerson(o, role);
      const err = await tryAuthorize(o, id);
      expect(err, `${role} must be refused`).toBeInstanceOf(AuthorizationError);
    }
  });

  it('an admin holding the five old owner grants but NOT the sixth is still refused (the grant is what allows it)', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, 'admin', FIVE);
    expect(await tryAuthorize(o, id)).toBeInstanceOf(AuthorizationError);
  });

  it('an admin plus all six owner grants is allowed (the equivalence with super_admin)', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, 'admin', [...FIVE, 'verify_own_sales_day']);
    expect(await tryAuthorize(o, id), 'admin + the six grants must be allowed').toBeNull();
  });
});
