import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-338 - store readiness gains a non-blocking `manager` check.
 * `docs/tasks/338-store-readiness-manager-warning.md`, cases M1-M9 (R1, R2).
 *
 * RED on HEAD for M1-M6 and M8 (no `manager` check exists). M9 is a pin: green on HEAD for the five
 * existing keys. M7 is a pin if RLS already hides the other org's person (see its title).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import { createStore, storeReadiness } from '@shareat/domain';
import * as storesRepo from '../../../db/src/repo/stores';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

interface OrgFixture {
  orgId: string;
  adminId: string;
  admin: Actor;
}

async function person(orgId: string, name: string, role: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  return p!.id;
}

/** One org, one admin, no store yet. */
async function orgFixture(hint: string): Promise<OrgFixture> {
  const code = uid(`t338-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const adminId = await person(orgId, 'Admin', 'admin');
  return { orgId, adminId, admin: actor(orgId, adminId) };
}

async function makeStore(f: OrgFixture): Promise<string> {
  const result = await withOrgPrincipal(f.orgId, (tx) =>
    createStore(tx, f.admin, { code: uid('S'), name: 'Store' } as Parameters<typeof createStore>[2]),
  );
  return result.storeId;
}

async function scope(personId: string, storeId: string): Promise<void> {
  await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
}

/** DEF-491 (0214): the database refuses a scope row whose person and store are in different orgs, so M7's
 *  deliberate cross-org plant skips FKs and triggers (session_replication_role = replica). */
async function scopeForeign(personId: string, storeId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
  });
}

async function checks(f: OrgFixture, storeId: string) {
  return withOrgPrincipal(f.orgId, async (tx) => {
    const store = await storesRepo.getById(tx, f.orgId, storeId);
    return storeReadiness(tx, f.admin, store!);
  });
}

async function managerCheck(f: OrgFixture, storeId: string) {
  const c = (await checks(f, storeId)).find((x) => x.key === 'manager');
  // Red on HEAD: the check does not exist. Fail with a sentence, not a TypeError on `undefined.ok`.
  expect(c, 'storeReadiness must return a check with key "manager"').toBeDefined();
  // `toBeDefined` throws when undefined, so `c` is defined here.
  return c as NonNullable<typeof c>;
}

describe('T-338 - the `manager` readiness check', () => {
  it(
    'M1: a fresh store with admins only -> manager check is not ok, non-blocking, manual, with the Users remedy. ' +
      'Mutants: blocking:true -> red; remedy dropped -> red',
    async () => {
      const f = await orgFixture('m1');
      const storeId = await makeStore(f);
      const c = await managerCheck(f, storeId);
      expect(c.ok).toBe(false);
      expect(c.blocking).toBe(false);
      expect(c.kind).toBe('manual');
      expect(c.label).toBe('A manager is assigned');
      expect(c.detail.startsWith('No manager assigned to this store')).toBe(true);
      expect(c.remedy).toEqual({ href: '/admin/users', label: 'Assign a manager in Users and roles →' });
    },
    60_000,
  );

  it(
    'M2: P holds manager and a scope row for the store -> ok, "Managed by P." Mutant: repo function returns [] always -> red',
    async () => {
      const f = await orgFixture('m2');
      const storeId = await makeStore(f);
      const p = await person(f.orgId, 'Ana Cruz', 'manager');
      await scope(p, storeId);
      const c = await managerCheck(f, storeId);
      expect(c.ok).toBe(true);
      expect(c.detail).toBe('Managed by Ana Cruz.');
    },
    60_000,
  );

  it(
    'M3: admins do not count - the fanned-out admin and a second admin with a manual scope row leave it not ok. ' +
      'Mutant: role in (manager, admin) -> red',
    async () => {
      const f = await orgFixture('m3');
      const storeId = await makeStore(f); // fan-out scopes the first admin here
      const admin2 = await person(f.orgId, 'Second Admin', 'admin');
      await scope(admin2, storeId);
      const c = await managerCheck(f, storeId);
      expect(c.ok).toBe(false);
    },
    60_000,
  );

  it(
    'M4: scope is per store - manager scoped at B only -> A not ok, B ok. Mutant: drop the ps.store_id condition -> A red',
    async () => {
      const f = await orgFixture('m4');
      const a = await makeStore(f);
      const b = await makeStore(f);
      const p = await person(f.orgId, 'Ana Cruz', 'manager');
      await scope(p, b);
      expect((await managerCheck(f, a)).ok).toBe(false);
      expect((await managerCheck(f, b)).ok).toBe(true);
    },
    60_000,
  );

  it(
    'M5: a revoked manager role does not count (P now holds staff, scope row kept). Mutant: drop revoked_at is null -> red',
    async () => {
      const f = await orgFixture('m5');
      const storeId = await makeStore(f);
      const p = await person(f.orgId, 'Ana Cruz', 'manager');
      await scope(p, storeId);
      await sql`update person_roles set revoked_at = now() where person_id = ${p} and role = 'manager'`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p}, ${f.orgId}, 'staff')`;
      expect((await managerCheck(f, storeId)).ok).toBe(false);
    },
    60_000,
  );

  it(
    'M6: an inactive person does not count. Mutant: drop p.is_active -> red',
    async () => {
      const f = await orgFixture('m6');
      const storeId = await makeStore(f);
      const p = await person(f.orgId, 'Ana Cruz', 'manager');
      await scope(p, storeId);
      await sql`update persons set is_active = false where id = ${p}`;
      expect((await managerCheck(f, storeId)).ok).toBe(false);
    },
    60_000,
  );

  it(
    "M7: a manager of org B with a scope row on org A's store (inserted as superuser) does not clear org A's check. " +
      'Mutant: drop r.org_id = $org -> red, UNLESS RLS already hides that person (then this is a pin, not a killer)',
    async () => {
      const f = await orgFixture('m7a');
      const other = await orgFixture('m7b');
      const storeId = await makeStore(f);
      const p = await person(other.orgId, 'Other Org Manager', 'manager');
      await scopeForeign(p, storeId);
      expect((await managerCheck(f, storeId)).ok).toBe(false);
    },
    60_000,
  );

  it(
    'M8: names in name order - "Ben Reyes" inserted before "Ana Cruz" -> "Managed by Ana Cruz, Ben Reyes." Mutant: no order by -> red',
    async () => {
      const f = await orgFixture('m8');
      const storeId = await makeStore(f);
      const ben = await person(f.orgId, 'Ben Reyes', 'manager');
      const ana = await person(f.orgId, 'Ana Cruz', 'manager');
      await scope(ben, storeId);
      await scope(ana, storeId);
      const c = await managerCheck(f, storeId);
      expect(c.ok).toBe(true);
      expect(c.detail).toBe('Managed by Ana Cruz, Ben Reyes.');
    },
    60_000,
  );

  it(
    'M9 (pin): the other five keys keep their blocking values. Green on HEAD',
    async () => {
      const f = await orgFixture('m9');
      const storeId = await makeStore(f);
      const all = await checks(f, storeId);
      const blockingOf = (key: string) => all.find((c) => c.key === key)?.blocking;
      expect(blockingOf('room')).toBe(true);
      expect(blockingOf('adminScope')).toBe(true);
      expect(blockingOf('salesChannel')).toBe(true);
      expect(blockingOf('signIn')).toBe(true);
      expect(blockingOf('openingDate')).toBe(false);
    },
    60_000,
  );
});
