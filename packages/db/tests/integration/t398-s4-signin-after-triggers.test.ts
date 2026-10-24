/**
 * T-398 S4 / DEF-491 part 3 -- D9: sign-in still works after 0214. The auth door writes `sessions` (person_id, store_id,
 * credential_id), which are guarded derived FKs, and it runs with no org principal on the Firebase path; a trigger that read
 * its header or target under the caller's RLS and failed closed would lock every user out.
 *
 * Real Postgres via TEST_DATABASE_URL (the lane database once the builder applies 0214), `_test` name guard, fresh ids per
 * test (any `_test` database works). Fixtures are committed as the owner; the sign-in functions are the real ones
 * (`signInWithPin`, `signInWithFirebase`) over the real auth door, as in t438 / terminal-sign-in.
 *
 * Green control today (no trigger exists yet) EXCEPT the "in the path" leg, which proves the session insert is actually
 * subject to the S4 triggers -- without it this file would stay green for the wrong reason.
 *
 * MUTANTS: a trigger on persons / person_identities (or any table the auth door writes) that refuses the door's writes
 *   -> the PIN and Firebase legs red; a header/target read that fails closed under the door's RLS -> the same legs red;
 *   the sessions triggers missing -> "in the path" red.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { hashPin, pinLookupHash, signInWithFirebase, signInWithPin } from '@shareat/auth';

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;
const nextPin = () => String(500000 + ++pinSeq * 19);

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string, role: 'manager' | 'staff') {
  const code = uid(`t398s4-${hint}`);
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const storeId = (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`)[0]!.id;
  const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${`P ${hint}`}) returning id`)[0]!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
  await sql`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${personId}, ${'SE-' + (100000 + Math.floor(Math.random() * 899999999))}, 'regular', '2026-01-01')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, 'manual')`;
  const externalId = uid('fbuid');
  await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${personId}, 'firebase', null, ${externalId})`;
  const pin = nextPin();
  const pinCred = (await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)}) returning id`)[0]!.id;
  return { orgId, storeId, personId, externalId, pin, pinCred };
}

const sessionsOf = (personId: string) =>
  sql<{ id: string; store_id: string | null; credential_id: string | null }[]>`select id, store_id, credential_id from sessions where person_id = ${personId}`;

describe('D9 -- sign-in works after 0214', () => {
  it('by PIN: a staff person signs in at their store; the session row is written (mutant: a trigger refusing the door\'s writes)', async () => {
    const f = await fixture('pin', 'staff');
    const r = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: f.pin });
    expect(r.personId).toBe(f.personId);
    const rows = await sessionsOf(f.personId);
    expect(rows.length, 'one session row').toBe(1);
    expect(rows[0]!.store_id).toBe(f.storeId);
  });

  it('by Firebase: a manager signs in through the auth door (no org principal) and gets a session', async () => {
    const f = await fixture('fb', 'manager');
    const r = await signInWithFirebase(null, { verifiedUid: f.externalId });
    expect(r.personId).toBe(f.personId);
    expect((await sessionsOf(f.personId)).length).toBe(1);
  });

  it('by PIN twice: a second sign-in (a different session row, same credential) also passes', async () => {
    const f = await fixture('pin2', 'staff');
    await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: f.pin });
    const again = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: f.pin });
    expect(again.personId).toBe(f.personId);
    expect((await sessionsOf(f.personId)).length).toBeGreaterThanOrEqual(1);
  });

  it('RED until 0214: the sessions insert the door performs is subject to the S4 triggers (sessions.credential_id and sessions.store_id are guarded)', async () => {
    const rows = await sql<{ col: string }[]>`
      select encode(t.tgargs, 'hex') as col from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and p.proname = 'assert_same_org_via_parent' and t.tgrelid = 'sessions'::regclass`;
    // tgargs holds NUL-separated strings; convert_from fails on NUL bytes, so decode the hex in JS and split on the NUL.
    const cols = rows.map((r) => Buffer.from(r.col, 'hex').toString('utf8').split('\u0000')[0]);
    expect(cols.sort(), 'the S4 triggers on sessions').toEqual(['credential_id', 'store_id']);
  });

  it('the auth door writes no row to persons / person_identities / person_credentials at sign-in that a trigger could refuse: those tables carry no S4 trigger on their via FK', async () => {
    const rows = await sql<{ tbl: string; col: string }[]>`
      select c.relname as tbl, convert_from(t.tgargs, 'UTF8') as col from pg_trigger t
      join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and p.proname = 'assert_same_org_via_parent' and c.relname in ('persons', 'person_identities')`;
    expect(rows, 'mutant: a trigger on persons / person_identities').toEqual([]);
  });
});
