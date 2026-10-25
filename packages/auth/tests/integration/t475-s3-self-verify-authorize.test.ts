import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-475 S3 - authorize(verify_own_supplier_invoice) against real Postgres. docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md
 * 5.1 + "Ian's answers" Q3=A (NOT grantable: role only, a person grant never confers it) and Q4=A (a stand-in manager does not get it).
 * Every matrix check mark has its refusal test (CAPABILITY-MATRIX.md rule): manager and staff are REFUSED here, with AuthorizationError.
 *
 * TESTER file. RED today: the capability is not in the matrix, so `CAPABILITY_MATRIX[cap][role]` is a TypeError, not an
 * AuthorizationError - every "refused" leg fails on the error class, every "allowed" leg fails outright.
 *
 * Mutants: manager:true in the matrix -> M1 red. authorize() honours a person grant for it (a grantable capability) -> G legs red.
 * the derived elevated set left as is -> S1 red. A staff-OK cell -> M2 red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { assignRole, authorize, can, heldCapabilities, AuthorizationError, type Capability, type Role } from '@shareat/auth';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const CAP = 'verify_own_supplier_invoice' as string as Capability;

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
  const code = uid('t475s3a');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org!.id}, ${uid('st')}, 'Lipa') returning id`;
  return { orgId: org!.id, storeId: store!.id };
}
async function mkPerson(o: { orgId: string; storeId: string }, role: Role | null, grants: { name: string; source: 'grant' | 'owner' | 'elevation' }[] = []) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o.orgId}, ${role ?? 'no role'}) returning id`;
  if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${o.orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${o.storeId})`;
  for (const g of grants) await sql`insert into person_grants (person_id, grant_name, grant_source) values (${p!.id}, ${g.name}, ${g.source})`;
  return p!.id;
}

/** Resolves to the error `authorize` threw, or null when it allowed. No storeId on purpose: the capability is org-scoped. */
async function tryAuthorize(o: { orgId: string }, personId: string): Promise<unknown> {
  try {
    await asPerson(o.orgId, (tx) => authorize(tx, { personId, orgId: o.orgId }, CAP, {}));
    return null;
  } catch (e) {
    return e;
  }
}
const canDo = (o: { orgId: string }, personId: string) => asPerson(o.orgId, (tx) => can(tx, { personId, orgId: o.orgId }, CAP, {}));
const holds = (o: { orgId: string }, personId: string) =>
  asPerson(o.orgId, async (tx) => (await heldCapabilities(tx, { personId, orgId: o.orgId })).has(CAP));

describe('T-475 S3 - authorize(verify_own_supplier_invoice): the matrix', () => {
  it('admin and super_admin are allowed (positive controls). Mutant: cell false', async () => {
    const o = await mkOrg();
    for (const role of ['admin', 'super_admin'] as const) {
      const id = await mkPerson(o, role);
      expect(await tryAuthorize(o, id), `${role} must be allowed`).toBeNull();
      expect(await canDo(o, id), `can() for ${role}`).toBe(true);
      expect(await holds(o, id), `heldCapabilities for ${role}`).toBe(true);
    }
  });

  it('M1/M2: a manager and a staff member are each REFUSED with AuthorizationError (the check marks fire). Mutant: manager or staff true', async () => {
    const o = await mkOrg();
    for (const role of ['manager', 'staff'] as const) {
      const id = await mkPerson(o, role);
      const err = await tryAuthorize(o, id);
      expect(err, `${role} must be refused`).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).capability).toBe(CAP);
      expect(await canDo(o, id), `can() for ${role}`).toBe(false);
      expect(await holds(o, id), `heldCapabilities for ${role}`).toBe(false);
    }
  });

  it('a person with no active role is refused (not a fallback to staff)', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, null);
    expect(await tryAuthorize(o, id)).toBeInstanceOf(AuthorizationError);
  });

  it('another orgs admin is refused here (org axis). Mutant: org check skipped', async () => {
    const a = await mkOrg();
    const b = await mkOrg();
    const adminB = await mkPerson(b, 'admin');
    let err: unknown = null;
    try {
      await asPerson(b.orgId, (tx) => authorize(tx, { personId: adminB, orgId: b.orgId }, CAP, { orgId: a.orgId }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthorizationError);
  });
});

describe('T-475 S3 - Q3=A: a person grant never confers it', () => {
  for (const source of ['grant', 'owner', 'elevation'] as const) {
    it(`G (${source}): a manager holding a live person_grants row of the capability is REFUSED by authorize(), can() and heldCapabilities(). Mutant: authorize honours the grant`, async () => {
      const o = await mkOrg();
      const id = await mkPerson(o, 'manager', [{ name: 'verify_own_supplier_invoice', source }]);
      expect(await tryAuthorize(o, id), 'a grant must not confer a non-grantable capability').toBeInstanceOf(AuthorizationError);
      expect(await canDo(o, id)).toBe(false);
      expect(await holds(o, id)).toBe(false);
    });
  }

  it('G control: the same manager with a grant of an ordinary capability IS allowed it (grants still work; only this one is role-only)', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, 'manager', [{ name: 'manage_fixed_assets', source: 'grant' }]);
    await expect(asPerson(o.orgId, (tx) => authorize(tx, { personId: id, orgId: o.orgId }, 'manage_fixed_assets' as Capability, {}))).resolves.toBeUndefined();
  });
});

describe('T-475 S3 - Q4=A: a stand-in manager of an admin-less org does not get it', () => {
  it('S1: a manager appointed where no admin exists gets the elevated grants (control: manage_users) but NOT this capability. Mutant: the derived set unchanged', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, null);
    const result = await asPerson(o.orgId, (tx) => assignRole(tx, { personId: id, orgId: o.orgId, role: 'manager', grantedBy: null }));
    expect(result.elevatedGrants.length, 'control: the fallback still elevates something').toBeGreaterThan(0);
    expect(result.elevatedGrants as readonly string[]).toContain('manage_users');
    expect(result.elevatedGrants as readonly string[]).not.toContain(CAP);
    const rows = await sql<{ grant_name: string }[]>`select grant_name from person_grants where person_id = ${id}`;
    expect(rows.map((r) => r.grant_name)).not.toContain(CAP);
    expect(await tryAuthorize(o, id), 'the stand-in manager is refused').toBeInstanceOf(AuthorizationError);
    expect(await canDo(o, id)).toBe(false);
  });

  it('S2 control: an org admin holds it by role (no grant rows)', async () => {
    const o = await mkOrg();
    const admin = await mkPerson(o, 'admin');
    expect(await tryAuthorize(o, admin)).toBeNull();
    const rows = await sql<{ n: string }[]>`select count(*)::text as n from person_grants where person_id = ${admin}`;
    expect(Number(rows[0]!.n), 'held by role: no grant rows').toBe(0);
  });
});
