import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-398 S6a (TESTER) -- the franchisor capabilities against real Postgres. docs/tasks/398-s6/{S6-REFRESH s4,TESTS S6a,QUESTIONS QO-1/QO-3}.md.
 * Every matrix check mark has its refusal test (CAPABILITY-MATRIX.md rule): the ones that fire are asserted here with AuthorizationError.
 * CAPABILITY-MATRIX.md rows name THIS file as their "Denial" test (S6-REFRESH s4), so the file name is part of the contract.
 *
 *   view_franchise_sales       platform, super_admin ONLY by matrix; held by Ian as role admin + a person-level grant (K1, production shape)
 *   view_franchise_access_log  org, super/admin/manager yes, staff NO, ROLE ONLY (no grant can hand it to staff, QO-3)
 *
 * RED TODAY: `view_franchise_access_log` does not exist (C1/C2), and the domain functions viewFranchiseSales / viewFranchiseStock /
 * listFranchiseAccessLog do not exist (V3/V18). S6a adds the authorize shells (they authorize FIRST and may then throw "not built"), so the refusals
 * below must come from authorize(), never from "not built".
 *
 * MUTANTS: view_franchise_sales admin true -> V3; stock read skips authorize -> V18; matrix manager false or staff true -> C1;
 *   capability removed from ROLE_ONLY_CAPABILITIES -> C2; matrix is a real-Postgres authorize: person grant of view_franchise_sales ignored -> V21a.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, transaction, withActorPrincipal, type Tx } from '@shareat/db';
import { authorize, can, heldCapabilities, AuthorizationError, ROLE_ONLY_CAPABILITIES, type Capability, type Role } from '@shareat/auth';
import * as domain from '@shareat/domain';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const SALES = 'view_franchise_sales' as Capability;
const LOG = 'view_franchise_access_log' as Capability;

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
  const code = uid('t398s6a');
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
const tryAuthorize = async (o: { orgId: string }, personId: string, cap: Capability): Promise<unknown> => {
  try {
    await asPerson(o.orgId, (tx) => authorize(tx, { personId, orgId: o.orgId }, cap, {}));
    return null;
  } catch (e) {
    return e;
  }
};

type DomainFn = (tx: Tx, actor: { personId: string; orgId: string }, input: Record<string, unknown>) => Promise<unknown>;
function needDomain(name: string): DomainFn {
  const fn = (domain as unknown as Record<string, unknown>)[name];
  expect(typeof fn, `RED today: @shareat/domain does not export ${name} (S6a adds an authorize shell)`).toBe('function');
  return fn as DomainFn;
}
/** Run a domain function as `personId` of `o`; resolves to the error it threw, or null. */
async function tryDomain(name: string, o: { orgId: string }, personId: string, input: Record<string, unknown>): Promise<unknown> {
  const fn = needDomain(name);
  try {
    await asPerson(o.orgId, (tx) => fn(tx, { personId, orgId: o.orgId }, input));
    return null;
  } catch (e) {
    return e;
  }
}

describe('V3 / V18 -- Ian\'s own managers and staff cannot look at the franchisee: the DOMAIN functions authorize first', () => {
  it.each(['adminL', 'mgrL', 'staffL'] as const)('V3 viewFranchiseSales as %s (no view_franchise_sales grant): AuthorizationError. Mutant: matrix admin true', async (who) => {
    const l = await mkOrg();
    const pg = await mkOrg();
    const role: Role = who === 'adminL' ? 'admin' : who === 'mgrL' ? 'manager' : 'staff';
    const id = await mkPerson(l, role);
    const err = await tryDomain('viewFranchiseSales', l, id, { franchiseeOrgId: pg.orgId, from: '2026-11-02', to: '2026-11-08' });
    expect(err, `${who} must be refused`).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).capability).toBe(SALES);
  });

  it.each(['adminL', 'mgrL', 'staffL'] as const)('V18 viewFranchiseStock as %s: AuthorizationError. Mutant: the stock read skips authorize', async (who) => {
    const l = await mkOrg();
    const pg = await mkOrg();
    const role: Role = who === 'adminL' ? 'admin' : who === 'mgrL' ? 'manager' : 'staff';
    const id = await mkPerson(l, role);
    const err = await tryDomain('viewFranchiseStock', l, id, { franchiseeOrgId: pg.orgId });
    expect(err, `${who} must be refused`).toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).capability).toBe(SALES);
  });

  it('V3/V18 control: the SAME functions do not refuse Ian (admin role + person-level view_franchise_sales grant) at the authorize step -- anything they throw is not an AuthorizationError', async () => {
    const l = await mkOrg();
    const pg = await mkOrg();
    const ian = await mkPerson(l, 'admin', [{ name: 'view_franchise_sales', source: 'owner' }]);
    for (const [fn, input] of [['viewFranchiseSales', { franchiseeOrgId: pg.orgId, from: '2026-11-02', to: '2026-11-08' }], ['viewFranchiseStock', { franchiseeOrgId: pg.orgId }]] as const) {
      const err = await tryDomain(fn, l, ian, input);
      expect(err instanceof AuthorizationError, `${fn}: Ian must pass authorize (a later refusal is the database's: no agreement here)`).toBe(false);
    }
  });

  it('V21a (K1, TypeScript side) authorize(view_franchise_sales): super_admin ROLE allowed; admin + person grant (the production shape) allowed; admin without the grant refused; the grant revoked refused. Mutant: grants ignored for this capability', async () => {
    const o = await mkOrg();
    const superP = await mkPerson(o, 'super_admin');
    const ian = await mkPerson(o, 'admin', [{ name: 'view_franchise_sales', source: 'owner' }]);
    const plain = await mkPerson(o, 'admin');
    expect(await tryAuthorize(o, superP, SALES)).toBeNull();
    expect(await tryAuthorize(o, ian, SALES), 'admin + grant is how Ian is held in production').toBeNull();
    expect(await tryAuthorize(o, plain, SALES)).toBeInstanceOf(AuthorizationError);
    await sql`update person_grants set revoked_at = now(), revoke_reason = 'tester: revoked' where person_id = ${ian} and grant_name = 'view_franchise_sales'`;
    expect(await tryAuthorize(o, ian, SALES), 'a revoked grant confers nothing').toBeInstanceOf(AuthorizationError);
  });
});

describe('C1 -- view_franchise_access_log: manager and admin hold it by role, staff do not (the owner of the franchise reads who looked)', () => {
  it('admin, super_admin and manager are allowed; staff is REFUSED with AuthorizationError(capability). Mutant: matrix manager false / staff true', async () => {
    const o = await mkOrg();
    for (const role of ['super_admin', 'admin', 'manager'] as const) {
      const id = await mkPerson(o, role);
      expect(await tryAuthorize(o, id, LOG), `${role} must be allowed (RED today: capability absent)`).toBeNull();
      expect(await asPerson(o.orgId, (tx) => can(tx, { personId: id, orgId: o.orgId }, LOG, {})), `can() for ${role}`).toBe(true);
      expect(await asPerson(o.orgId, async (tx) => (await heldCapabilities(tx, { personId: id, orgId: o.orgId })).has(LOG)), `heldCapabilities for ${role}`).toBe(true);
    }
    const staff = await mkPerson(o, 'staff');
    const err = await tryAuthorize(o, staff, LOG);
    expect(err, 'staff must be refused').toBeInstanceOf(AuthorizationError);
    expect((err as AuthorizationError).capability).toBe(LOG);
    expect(await asPerson(o.orgId, (tx) => can(tx, { personId: staff, orgId: o.orgId }, LOG, {}))).toBe(false);
  });

  it('listFranchiseAccessLog as staffPG: AuthorizationError (the domain authorizes first); a person with no role is refused too. Mutant: the list skips authorize', async () => {
    const pg = await mkOrg();
    const staff = await mkPerson(pg, 'staff');
    const none = await mkPerson(pg, null);
    for (const id of [staff, none]) {
      const err = await tryDomain('listFranchiseAccessLog', pg, id, {});
      expect(err).toBeInstanceOf(AuthorizationError);
      expect((err as AuthorizationError).capability).toBe(LOG);
    }
  });

  it('another org\'s manager is refused here (org axis). Mutant: org check skipped', async () => {
    const a = await mkOrg();
    const b = await mkOrg();
    const mgrB = await mkPerson(b, 'manager');
    let err: unknown = null;
    try {
      await asPerson(b.orgId, (tx) => authorize(tx, { personId: mgrB, orgId: b.orgId }, LOG, { orgId: a.orgId }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthorizationError);
  });
});

describe('C2 -- QO-3: view_franchise_access_log is ROLE ONLY: a person-level grant never confers it', () => {
  it('the capability is a member of ROLE_ONLY_CAPABILITIES (no screen offers it as a grant). Mutant: removed from the set', () => {
    expect([...ROLE_ONLY_CAPABILITIES], 'RED today: not role-only').toContain(LOG);
  });

  for (const source of ['grant', 'owner', 'elevation'] as const) {
    it(`C2 (${source}): staffPG holding a live person_grants row of view_franchise_access_log is still REFUSED by authorize(), can() and heldCapabilities(). Mutant: authorize honours the grant`, async () => {
      const o = await mkOrg();
      const id = await mkPerson(o, 'staff', [{ name: 'view_franchise_access_log', source }]);
      expect(await tryAuthorize(o, id, LOG), 'a grant must not confer a role-only capability').toBeInstanceOf(AuthorizationError);
      expect(await asPerson(o.orgId, (tx) => can(tx, { personId: id, orgId: o.orgId }, LOG, {}))).toBe(false);
      expect(await asPerson(o.orgId, async (tx) => (await heldCapabilities(tx, { personId: id, orgId: o.orgId })).has(LOG))).toBe(false);
    });
  }

  it('C2 control: the same staff member with an ordinary grant (manage_fixed_assets) IS allowed it (grants still work; only this one is role-only)', async () => {
    const o = await mkOrg();
    const id = await mkPerson(o, 'staff', [{ name: 'manage_fixed_assets', source: 'grant' }]);
    expect(await tryAuthorize(o, id, 'manage_fixed_assets' as Capability)).toBeNull();
  });
});

describe('S6 audit -- A3 the domain refuses an actor who is not the person the principal was opened with', () => {
  it.each(['viewFranchiseSales', 'viewFranchiseStock', 'listFranchiseAccessLog', 'listFranchisees'] as const)('%s: actor.personId != the withActorPrincipal person throws before the database, and no log row is written. Kills: actor and principal allowed to diverge', async (name) => {
    const fn = needDomain(name);
    const l = await mkOrg();
    const pg = await mkOrg();
    const superP = await mkPerson(l, 'super_admin'); // passes authorize as the ACTOR
    const other = await mkPerson(l, 'staff'); // the person the transaction was really opened with
    const logs = async () => (await sql<{ n: number }[]>`select count(*)::int n from franchise_access_log`)[0]!.n;
    const before = await logs();
    let err: unknown = null;
    try {
      await withActorPrincipal(l.orgId, other, (tx) => fn(tx, { personId: superP, orgId: l.orgId }, { franchiseeOrgId: pg.orgId, from: '2026-11-02', to: '2026-11-03' }));
    } catch (e) {
      err = e;
    }
    expect(err, 'a mismatch must throw').not.toBeNull();
    expect((err as { code?: string }).code, `must not be a database error: ${(err as Error)?.message}`).toBeUndefined();
    expect(await logs()).toBe(before);
  });
});
