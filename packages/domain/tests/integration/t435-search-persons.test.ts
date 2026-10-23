import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-435 case 30 (TESTER) - searchPersons answers only about people the searcher is allowed to know about.
 * Spec: docs/tasks/435-personal-data-access-gates.md, design 8 and case 30 (M30: the repo search without the store filter). Bible row 353.
 *
 * The hire screen's person search passes on `enrol_staff` at ANY one store and then returned every person in the organisation, so a
 * manager of one branch could read the names of every other branch's staff. The rule pinned here:
 *   - an actor who covers the whole organisation (admin of every active store) gets every match;
 *   - anyone else gets a person only if the person has an employment (ANY status, ended included) at a store where the actor holds
 *     enrol_staff, OR has no employment anywhere (a person who exists but was never hired is exactly who the hire flow searches for).
 *
 * Fixture (one org, two stores S1/S2): M1 = manager scoped to S1 only; A = admin scoped to S1 and S2.
 *   V   works S1                  W   works BOTH S1 and S2           ENDED1  resigned at S1 only
 *   Q   works S2 only             R   resigned at S2 only            U       no employment at all
 * Every name carries one shared token so a single query matches all six; a second query pins a single person ("Q").
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { searchPersons } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const letters = () => Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8).padEnd(8, 'x');

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture() {
  const token = `tok${letters()}`;
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${token}`}, ${uid('o')}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, ${n}) returning id`;
    return s!.id;
  };
  const s1 = await mkStore('Store One');
  const s2 = await mkStore('Store Two');
  const mkPerson = async (name: string, role: string | null, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const a = await mkPerson('Aaa Admin', 'admin', [s1, s2]);
  const m1 = await mkPerson('Mmm Manager', 'manager', [s1]);
  const employ = async (personId: string, storeId: string, status = 'regular', endedOn: string | null = null) => {
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on, created_by)
      values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, ${status}, '2025-01-01', ${endedOn}, ${a})`;
  };
  const names = { v: `${token} Vera`, w: `${token} Wanda`, ended1: `${token} Endedone`, q: `${token} Qasim`, r: `${token} Rosa`, u: `${token} Unhired` };
  const v = await mkPerson(names.v, null, []);
  const w = await mkPerson(names.w, null, []);
  const ended1 = await mkPerson(names.ended1, null, []);
  const q = await mkPerson(names.q, null, []);
  const r = await mkPerson(names.r, null, []);
  await mkPerson(names.u, null, []);
  // Q's contact details: they must never reach a searcher who does not hold Q's branch. (kind+value is unique across runs: salt it.)
  const phone = `0917${Math.floor(1000000 + Math.random() * 8999999)}`;
  const email = `${token}@example.test`;
  await sql`insert into person_identities (person_id, kind, value) values (${q}, 'phone', ${phone})`;
  await sql`insert into person_identities (person_id, kind, value) values (${q}, 'email', ${email})`;
  await employ(v, s1);
  await employ(w, s1);
  await employ(w, s2);
  await employ(ended1, s1, 'resigned', '2025-12-31');
  await employ(q, s2);
  await employ(r, s2, 'resigned', '2025-12-31');
  const actor = (id: string): Actor => ({ personId: id, orgId });
  return { orgId, token, names, phone, email, qId: q, rId: r, A: actor(a), M1: actor(m1) };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

const namesOf = (rows: { displayName: string }[]) => rows.map((r) => r.displayName).sort();

describe('T-435 case 30 - searchPersons is scoped to the searcher (M30)', () => {
  it('Ian 16 Oct: searchPersons(M1, "Qasim") returns Q as NAME + BRANCH ONLY - no phone, email or any other personal field', async () => {
    const f = await fixture();
    const rows = (await asOrg(f.orgId, (tx) => searchPersons(tx, f.M1, { query: 'Qasim' }))) as unknown as Record<string, unknown>[];
    expect(rows.length, 'Q can still be found, so a hire does not duplicate the person').toBe(1);
    const hit = rows[0]!;
    const allowed = new Set(['id', 'personId', 'displayName', 'name', 'branch', 'branches', 'branchNames', 'stores']);
    expect(Object.keys(hit).filter((k) => !allowed.has(k)), 'fields beyond personId / name / branch(es)').toEqual([]);
    expect(String(hit['personId'] ?? hit['id']), 'carries the person id').toBe(f.qId);
    expect(String(hit['name'] ?? hit['displayName'])).toBe(f.names.q);
    const text = JSON.stringify(hit);
    expect(text, 'names the branch').toContain('Store Two');
    expect(text).not.toContain(f.phone);
    expect(text).not.toContain(f.email);
    expect(text).not.toMatch(/phone|email|birth|address/i);
  });

  it('searchPersons(A, "Qasim") returns Q: an admin who covers the whole organisation sees every match', async () => {
    const f = await fixture();
    const rows = await asOrg(f.orgId, (tx) => searchPersons(tx, f.A, { query: 'Qasim' }));
    expect(namesOf(rows)).toContain(f.names.q);
  });

  it('an unemployed person matches for M1 (the hire flow searches for exactly this person)', async () => {
    const f = await fixture();
    const rows = await asOrg(f.orgId, (tx) => searchPersons(tx, f.M1, { query: 'Unhired' }));
    expect(namesOf(rows)).toEqual([f.names.u]);
  });

  it('M1 over the whole token: own-store people (V, W, the ended one) and the unhired U as today; Q and R (S2 only) as name+branch only', async () => {
    const f = await fixture();
    const rows = (await asOrg(f.orgId, (tx) => searchPersons(tx, f.M1, { query: f.token }))) as unknown as Record<string, unknown>[];
    const nameOf = (r: Record<string, unknown>) => String(r['name'] ?? r['displayName']);
    expect(rows.map(nameOf).sort()).toEqual(Object.values(f.names).sort());
    for (const r of rows.filter((x) => [f.names.q, f.names.r].includes(nameOf(x)))) {
      expect(JSON.stringify(r), 'other-branch hit leaks contact').not.toMatch(/phone|email|0917|example\.test/i);
      expect(JSON.stringify(r)).toContain('Store Two');
    }
    for (const r of rows.filter((x) => [f.names.v, f.names.w].includes(nameOf(x)))) {
      expect(r['displayName'] ?? r['name'], 'own-store people are shown as today').toBeTruthy();
    }
  });

  it('A gets all six', async () => {
    const f = await fixture();
    const rows = await asOrg(f.orgId, (tx) => searchPersons(tx, f.A, { query: f.token }));
    expect(namesOf(rows)).toEqual(Object.values(f.names).sort());
  });

  it('the refusal for someone without enrol_staff anywhere is unchanged (a cashier)', async () => {
    const f = await fixture();
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Cash Ier') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
    const [s] = await sql<{ id: string }[]>`select id from stores where org_id = ${f.orgId} order by name limit 1`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s!.id})`;
    await expect(asOrg(f.orgId, (tx) => searchPersons(tx, { personId: p!.id, orgId: f.orgId }, { query: f.token }))).rejects.toThrow(/enrol_staff/);
  });
});
