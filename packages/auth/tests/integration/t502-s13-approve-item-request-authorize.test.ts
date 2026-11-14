import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-502 section 13 ruling A4 - authorize(approve_item_request) against real Postgres.
 *  - a person grant (any source) never confers it (role only);
 *  - a manager appointed where no admin exists (the adminless fallback) does not get it;
 *  - a super-admin holds it by role, with no grant rows.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, assignRole, authorize, can, heldCapabilities, type Capability, type Role } from '@shareat/auth';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const CAP = 'approve_item_request' as Capability;
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
  const code = uid('t502s13');
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
const tryAuthorize = async (o: { orgId: string }, personId: string): Promise<unknown> => {
  try {
    await asPerson(o.orgId, (tx) => authorize(tx, { personId, orgId: o.orgId }, CAP, {}));
    return null;
  } catch (e) {
    return e;
  }
};
const canDo = (o: { orgId: string }, personId: string) => asPerson(o.orgId, (tx) => can(tx, { personId, orgId: o.orgId }, CAP, {}));
const holds = (o: { orgId: string }, personId: string) =>
  asPerson(o.orgId, async (tx) => (await heldCapabilities(tx, { personId, orgId: o.orgId })).has(CAP));

describe('T-502 A4 - authorize(approve_item_request)', () => {
  it('admin and super_admin are allowed by role; manager and staff are refused with AuthorizationError', async () => {
    const o = await mkOrg();
    for (const role of ['admin', 'super_admin'] as const) {
      const id = await mkPerson(o, role);
      expect(await tryAuthorize(o, id), role).toBeNull();
      expect(await holds(o, id), `held by ${role}`).toBe(true);
    }
    for (const role of ['manager', 'staff'] as const) {
      const id = await mkPerson(o, role);
      expect(await tryAuthorize(o, id), role).toBeInstanceOf(AuthorizationError);
      expect(await canDo(o, id)).toBe(false);
    }
  });

  for (const source of ['grant', 'owner', 'elevation'] as const) {
    it(`a manager holding a live person_grants row (${source}) of it is still REFUSED by authorize(), can() and heldCapabilities()`, async () => {
      const o = await mkOrg();
      const id = await mkPerson(o, 'manager', [{ name: CAP, source }]);
      expect(await tryAuthorize(o, id), 'a grant must not confer a role-only capability').toBeInstanceOf(AuthorizationError);
      expect(await canDo(o, id)).toBe(false);
      expect(await holds(o, id)).toBe(false);
    });
  }

  it('a manager appointed where no admin exists gets the elevated grants (control) but NOT this capability', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, null);
    const result = await asPerson(o.orgId, (tx) => assignRole(tx, { personId: id, orgId: o.orgId, role: 'manager', grantedBy: null }));
    expect(result.elevatedGrants.length, 'control: the fallback still elevates something').toBeGreaterThan(0);
    expect(result.elevatedGrants as readonly string[]).not.toContain(CAP);
    const rows = await sql<{ grant_name: string }[]>`select grant_name from person_grants where person_id = ${id}`;
    expect(rows.map((r) => r.grant_name)).not.toContain(CAP);
    expect(await tryAuthorize(o, id), 'the stand-in manager is refused').toBeInstanceOf(AuthorizationError);
  });

  it('a super-admin in an org where they are the only administrator holds it by role, with no grant rows', async () => {
    const o = await mkOrg();
    const sa = await mkPerson(o, 'super_admin');
    expect(await tryAuthorize(o, sa)).toBeNull();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from person_grants where person_id = ${sa}`;
    expect(n!.n).toBe(0);
  });
});
