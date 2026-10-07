import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-382 S1, A1 (the runtime half) - `docs/tasks/382-pos-store-unlink.md` R6: `unlink_store_from_pos`, org scope,
 * super_admin only. The matrix cells and the document row are proven in `tests/unit/capability-matrix.test.ts`
 * (A1, A3); this file proves `authorize()` itself, against real Postgres.
 *
 * The five "owner" grants are the four super-admin-only capabilities of 2026-09-08 plus the new one: an admin who
 * holds all five authorizes exactly what super_admin authorizes (the equivalence `createFirstAdmin` materialises,
 * and which 0187's backfill extends to existing owners).
 *
 * ## State at HEAD
 * Red: `unlink_store_from_pos` is not in the matrix, so `authorize` cannot decide it (a TypeError, not an
 * `AuthorizationError`) and every "refused" leg fails on the error class; the "allowed" legs fail outright.
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

const CAP = 'unlink_store_from_pos' as string as Capability;
const FOUR = ['approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales'];

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
  const code = uid('t382s1a');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return org!.id;
}
async function mkPerson(orgId: string, role: Role, grants: string[] = []) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${role}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  for (const g of grants) await sql`insert into person_grants (person_id, grant_name, grant_source) values (${p!.id}, ${g}, 'owner')`;
  return p!.id;
}

/** Resolves to the error `authorize` threw, or null when it allowed. */
async function tryAuthorize(orgId: string, personId: string): Promise<unknown> {
  try {
    await asPerson(orgId, (tx) => authorize(tx, { personId, orgId }, CAP, {}));
    return null;
  } catch (e) {
    return e;
  }
}

describe('T-382 A1 - authorize(unlink_store_from_pos)', () => {
  it('super_admin is allowed', async () => {
    const orgId = await mkOrg();
    const id = await mkPerson(orgId, 'super_admin');
    expect(await tryAuthorize(orgId, id), 'super_admin must be allowed').toBeNull();
  });

  it('an admin without the grant, a manager and a staff member are each refused with AuthorizationError (not any other error)', async () => {
    const orgId = await mkOrg();
    for (const role of ['admin', 'manager', 'staff'] as const) {
      const id = await mkPerson(orgId, role);
      const err = await tryAuthorize(orgId, id);
      expect(err, `${role} must be refused`).toBeInstanceOf(AuthorizationError);
    }
  });

  it('an admin holding the four old owner grants but NOT the fifth is still refused (the grant is what allows it)', async () => {
    const orgId = await mkOrg();
    const id = await mkPerson(orgId, 'admin', FOUR);
    expect(await tryAuthorize(orgId, id)).toBeInstanceOf(AuthorizationError);
  });

  it('an admin plus all five owner grants is allowed (the equivalence with super_admin)', async () => {
    const orgId = await mkOrg();
    const id = await mkPerson(orgId, 'admin', [...FOUR, 'unlink_store_from_pos']);
    expect(await tryAuthorize(orgId, id), 'admin + the five grants must be allowed').toBeNull();
  });
});
