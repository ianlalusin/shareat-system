import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-391 S6 - `canAt(tx, personId, capability, storeId)` in packages/auth: a NON-THROWING yes/no that shares authorize()'s decision.
 * Pinned: canAt(...) === (authorize(tx, { orgId: the store's org, personId }, capability, { storeId }) does not throw), across a matrix.
 * A foreign-org store id and a nonexistent store id answer false and never throw; after a false answer the same tx is still usable.
 * Real Postgres, own orgs (no truncate), so it can share a database with other files.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import { authorize, canAt, AuthorizationError, type Capability } from '@shareat/auth';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** One transaction with the staff principal of `orgId` applied (the RLS context a real call runs under). */
async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let orgA: string;
let orgB: string;
let s1: string;
let s2: string;
let sB: string;
const who: Record<string, string> = {};

async function person(name: string, role: string | null, stores: string[], revoked = false): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA}, ${name}) returning id`;
  if (role) {
    await sql`insert into person_roles (person_id, org_id, role, revoked_at) values (${p!.id}, ${orgA}, ${role}, ${revoked ? new Date() : null})`;
  }
  for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  return p!.id;
}

beforeAll(async () => {
  const mkOrg = async (hint: string) => {
    const code = uid(`canat-${hint}`);
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${o!.id}, ${uid('ST')}, 'Store') returning id`;
    return { orgId: o!.id, storeId: st!.id };
  };
  const a = await mkOrg('a');
  const b = await mkOrg('b');
  orgA = a.orgId;
  orgB = b.orgId;
  s1 = a.storeId;
  sB = b.storeId;
  const [st2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgA}, ${uid('ST')}, 'Store 2') returning id`;
  s2 = st2!.id;

  who.admin = await person('Admin', 'admin', [s1]);
  who.manager = await person('Manager S1', 'manager', [s1]);
  who.managerNoScope = await person('Manager no scope', 'manager', []);
  who.managerRevoked = await person('Manager revoked', 'manager', [s1], true);
  who.staff = await person('Staff', 'staff', [s1]);
  who.superAdmin = await person('Super', 'super_admin', [s1]);
  who.noRole = await person('No role', null, [s1]);
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** The reference answer: does authorize() let this person through at this store? */
async function authorizeSays(tx: Tx, personId: string, cap: Capability, storeId: string): Promise<boolean> {
  try {
    await authorize(tx, { orgId: orgA, personId }, cap, { storeId });
    return true;
  } catch (err) {
    if (err instanceof AuthorizationError) return false;
    throw err;
  }
}

const CAPS: [string, Capability][] = [
  ['store-scoped', 'create_expense'],
  ['org-scoped', 'manage_users'],
  ['org-scoped (close_period: a manager also needs org-wide scope)', 'close_period'],
  ['platform', 'cross_org_access'],
];
const PEOPLE = ['admin', 'manager', 'managerNoScope', 'managerRevoked', 'staff', 'superAdmin', 'noRole'];

describe('T-391 S6 canAt - agrees with authorize() everywhere', () => {
  for (const [label, cap] of CAPS) {
    for (const p of PEOPLE) {
      for (const [storeLabel, getStore] of [
        ['in-scope store', () => s1],
        ['other store of the org', () => s2],
      ] as [string, () => string][]) {
        it(`${label} ${cap} - ${p} at ${storeLabel}: canAt === authorize passes. Killing mutant: a second, hand-copied decision`, async () => {
          await asOrg(orgA, async (tx) => {
            const expected = await authorizeSays(tx, who[p]!, cap, getStore());
            expect(await canAt(tx, who[p]!, cap, getStore())).toBe(expected);
          });
        });
      }
    }
  }

  it('the matrix is not vacuous: a manager with scope may create_expense at S1 but not at S2; staff and a revoked manager may not; an admin may; a platform cap is super_admin only', async () => {
    await asOrg(orgA, async (tx) => {
      expect(await canAt(tx, who.manager!, 'create_expense', s1)).toBe(true);
      expect(await canAt(tx, who.manager!, 'create_expense', s2)).toBe(false);
      expect(await canAt(tx, who.managerNoScope!, 'create_expense', s1)).toBe(false);
      expect(await canAt(tx, who.managerRevoked!, 'create_expense', s1)).toBe(false);
      expect(await canAt(tx, who.noRole!, 'create_expense', s1)).toBe(false);
      expect(await canAt(tx, who.staff!, 'create_expense', s1)).toBe(false);
      expect(await canAt(tx, who.admin!, 'create_expense', s1)).toBe(true);
      expect(await canAt(tx, who.manager!, 'manage_users', s1)).toBe(false); // admin-only org cap
      expect(await canAt(tx, who.admin!, 'manage_users', s1)).toBe(true);
      expect(await canAt(tx, who.admin!, 'cross_org_access', s1)).toBe(false);
      expect(await canAt(tx, who.superAdmin!, 'cross_org_access', s1)).toBe(true);
    });
  });
});

describe('T-391 S6 canAt - bad stores answer false, never throw, and leave the tx usable', () => {
  it('a store of ANOTHER org is false (no throw), and the same tx still answers a select', async () => {
    await asOrg(orgA, async (tx) => {
      expect(await canAt(tx, who.admin!, 'create_expense', sB)).toBe(false);
      expect(await canAt(tx, who.superAdmin!, 'cross_org_access', sB)).toBe(false);
      const rows = await tx.execute(dsql`select 1 as ok`);
      expect(rows).toBeDefined();
      expect(await canAt(tx, who.admin!, 'create_expense', s1)).toBe(true); // and the next real answer is still right
    });
  });

  it('a nonexistent store id is false (no throw), and the same tx still answers a select', async () => {
    await asOrg(orgA, async (tx) => {
      expect(await canAt(tx, who.admin!, 'create_expense', '00000000-0000-4000-8000-000000000000')).toBe(false);
      const rows = await tx.execute(dsql`select 1 as ok`);
      expect(rows).toBeDefined();
    });
  });

  it('after a FALSE answer for a person with no active role (a refusal path that does lookups) the tx is still usable', async () => {
    await asOrg(orgA, async (tx) => {
      expect(await canAt(tx, who.noRole!, 'create_expense', s1)).toBe(false);
      expect(await canAt(tx, who.managerRevoked!, 'create_expense', s1)).toBe(false);
      const rows = await tx.execute(dsql`select count(*)::int as n from stores`);
      expect(rows).toBeDefined();
      expect(await canAt(tx, who.manager!, 'create_expense', s1)).toBe(true);
    });
  });
});
