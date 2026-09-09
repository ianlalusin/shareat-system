import { config } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-219 — `personsRepo.listWithAccessForOrg`, the read behind `/admin/users`, against a real
 * PostgreSQL (bible §9 rule 3).
 *
 * ⭐ **The state this read exists to make visible is "no role".** `authorize.ts` treats a
 * person with no active role as a hard denial — deliberately (*"an unconfigured person is
 * authorized for NOTHING, not 'staff by default'"*) — and nothing in the hire flow assigns
 * one. So since T-217 shipped PIN issuance, a hired person can sign in and then do nothing at
 * all, and no screen anywhere said so. A null role here is a first-class value, not an
 * absence, and these tests pin it as such.
 *
 * The counts are asserted rather than the rows because the list page shows totals and the
 * detail page shows the rows; a count that is secretly a fetch-and-length would pass the same
 * assertions, so `list-page-does-not-n-plus-one` is covered by the shape of the repo function
 * (one statement) rather than by a test that cannot see query counts.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { personsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 5 });

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

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`persons-${hint}`);
  const [row] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return row!.id;
}

async function insertStore(orgId: string, hint: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  return row!.id;
}

async function insertPerson(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  return row!.id;
}

beforeAll(async () => {
  await sql`truncate table person_grants, person_store_scope, person_roles, persons, stores, organizations restart identity cascade`;
});

describe('personsRepo.listWithAccessForOrg', () => {
  it('reports a person with NO active role as role null — the state that means "can do nothing"', async () => {
    const org = await insertOrg('norole');
    const person = await insertPerson(org, 'Fresh Hire');

    const rows = await asPerson(org, (tx) => personsRepo.listWithAccessForOrg(tx, org));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(person);
    expect(rows[0]!.displayName).toBe('Fresh Hire');
    expect(rows[0]!.role).toBeNull();
    expect(rows[0]!.storeScopeCount).toBe(0);
    expect(rows[0]!.activeGrantCount).toBe(0);
  });

  it('reports the active role, and ignores a revoked one', async () => {
    const org = await insertOrg('revoked');
    const person = await insertPerson(org, 'Changed Role');
    await sql`insert into person_roles (person_id, org_id, role, revoked_at) values (${person}, ${org}, 'admin', now())`;
    await sql`insert into person_roles (person_id, org_id, role) values (${person}, ${org}, 'manager')`;

    const rows = await asPerson(org, (tx) => personsRepo.listWithAccessForOrg(tx, org));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('manager');
    expect(rows[0]!.grantedAt).toBeInstanceOf(Date);
  });

  it('counts store scope rows and ACTIVE grants only', async () => {
    const org = await insertOrg('counts');
    const s1 = await insertStore(org, 's1');
    const s2 = await insertStore(org, 's2');
    const person = await insertPerson(org, 'Scoped');
    await sql`insert into person_roles (person_id, org_id, role) values (${person}, ${org}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${person}, ${s1}), (${person}, ${s2})`;
    await sql`insert into person_grants (person_id, grant_name) values (${person}, 'close_period')`;
    // T-248 / DEF-237, migration 0140: `person_grants_revoke_check` refuses a revoked row with no
    // reason, so this fixture must state one. It is a revoked row purely so the count below has
    // something to exclude — the reason says exactly that rather than inventing a story.
    await sql`insert into person_grants (person_id, grant_name, revoked_at, revoke_reason) values (${person}, 'manage_users', now(), 'fixture — a revoked grant the active count must exclude')`;

    const rows = await asPerson(org, (tx) => personsRepo.listWithAccessForOrg(tx, org));

    expect(rows[0]!.storeScopeCount).toBe(2);
    expect(rows[0]!.activeGrantCount).toBe(1);
  });

  it('orders by display name', async () => {
    const org = await insertOrg('order');
    await insertPerson(org, 'Zoe');
    await insertPerson(org, 'Alice');
    await insertPerson(org, 'Mia');

    const rows = await asPerson(org, (tx) => personsRepo.listWithAccessForOrg(tx, org));

    expect(rows.map((r) => r.displayName)).toEqual(['Alice', 'Mia', 'Zoe']);
  });

  it('returns one row per person — a second revoked role does not duplicate them', async () => {
    const org = await insertOrg('dupe');
    const person = await insertPerson(org, 'Much Changed');
    await sql`insert into person_roles (person_id, org_id, role, revoked_at) values (${person}, ${org}, 'staff', now())`;
    await sql`insert into person_roles (person_id, org_id, role, revoked_at) values (${person}, ${org}, 'manager', now())`;
    await sql`insert into person_roles (person_id, org_id, role) values (${person}, ${org}, 'admin')`;

    const rows = await asPerson(org, (tx) => personsRepo.listWithAccessForOrg(tx, org));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('admin');
  });

  it('never returns another org\'s persons', async () => {
    const orgA = await insertOrg('iso-a');
    const orgB = await insertOrg('iso-b');
    await insertPerson(orgA, 'Ours');
    await insertPerson(orgB, 'Theirs');

    const rows = await asPerson(orgA, (tx) => personsRepo.listWithAccessForOrg(tx, orgA));

    expect(rows.map((r) => r.displayName)).toEqual(['Ours']);
  });
});
