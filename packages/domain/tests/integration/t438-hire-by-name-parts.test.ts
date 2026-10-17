/**
 * T-438 S2a + S2b - hire a person by last/first/middle name, find them by any part, rename them.
 * Spec: docs/tasks/438-hire-name-parts-and-staff-pin-only.md (N2, N4, N5, N6, N7; S2b). Cases H1-H7, R1-R3.
 * RED on a 0206-era tree: `createPerson` takes only `{ displayName }` (it throws "A person needs a name." for a `name` object),
 * `renamePerson` is not exported, and the parts columns do not exist. Every fixture runs on any `_test` DB; every case builds its
 * own organisation, so no truncate and no shared state.
 *
 * Assumed shapes (spec): createPerson(tx, actor, { storeId, name: { lastName, firstName, middleName? }, sameNameConfirmed? });
 * renamePerson(tx, actor, { employmentId, lastName, firstName, middleName? }); both exported from the people barrel.
 * The H3 audit row is located by entity id and `after.sameNameConfirmed`, not by an action name the spec does not give.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as people from '../../src/people';
import { createPerson, searchPersons } from '../../src/people';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

interface Fx {
  orgId: string;
  storeId: string;
  adminActor: Actor;
}
async function fixture(): Promise<Fx> {
  // bootstrapOrganization is single-org per database, so each case builds its own org by hand (as t435-search-persons does).
  const code = uid('T438');
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Main') returning id`;
  const [a] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${a!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${a!.id}, ${s!.id})`;
  return { orgId, storeId: s!.id, adminActor: { personId: a!.id, orgId } };
}
const legacy = async (orgId: string, name: string, kind = 'person') => {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${name}, ${kind}) returning id`;
  return p!.id;
};
const row = async (id: string) => {
  const [r] = await sql<{ display_name: string; last_name: string | null; first_name: string | null; middle_name: string | null; kind: string }[]>`
    select display_name, last_name, first_name, middle_name, kind from persons where id = ${id}`;
  return r!;
};
const countPersons = async (orgId: string) => Number((await sql`select count(*)::int as n from persons where org_id = ${orgId}`)[0]!['n']);
const hire = (fx: Fx, actor: Actor, input: Record<string, unknown>) =>
  withOrgPrincipal(fx.orgId, (tx) => (createPerson as unknown as (t: unknown, a: Actor, i: unknown) => Promise<{ id: string; displayName: string }>)(tx, actor, { storeId: fx.storeId, ...input }));
const asStaffOnly = async (fx: Fx): Promise<Actor> => {
  const id = await legacy(fx.orgId, 'Plain Staff');
  await sql`insert into person_roles (person_id, org_id, role) values (${id}, ${fx.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${id}, ${fx.storeId})`;
  return { personId: id, orgId: fx.orgId };
};

describe('T-438 H1 - createPerson with parts stores the parts and derives "Last, First M."', () => {
  it('Santos / Maria / clara -> row has the three parts and display_name "Santos, Maria C."', async () => {
    // Kills: parts dropped; displayName not derived (e.g. stored as the raw first name).
    const fx = await fixture();
    const p = await hire(fx, fx.adminActor, { name: { lastName: 'Santos', firstName: 'Maria', middleName: 'clara' } });
    expect(p.displayName).toBe('Santos, Maria C.');
    expect(await row(p.id)).toMatchObject({ display_name: 'Santos, Maria C.', last_name: 'Santos', first_name: 'Maria', middle_name: 'clara', kind: 'person' });
  });
  it('H1b: untrimmed and blank-middle input is normalised; a blank middle is NULL, never the empty string', async () => {
    // Kills: no trim/collapse before storing; '' stored for a blank middle.
    const fx = await fixture();
    const p = await hire(fx, fx.adminActor, { name: { lastName: '  Dela   Cruz ', firstName: ' Juan   Miguel', middleName: '   ' } });
    expect(await row(p.id)).toMatchObject({ display_name: 'Dela Cruz, Juan Miguel', last_name: 'Dela Cruz', first_name: 'Juan Miguel', middle_name: null });
  });
});

describe('T-438 H2/H3 - the duplicate-name guard and its "different person" override (N4)', () => {
  it('H2: a legacy "Maria Santos" blocks typed Santos / Maria with the N4 sentence, and nothing is written', async () => {
    // Kills: guard compares raw strings (legacy "Maria Santos" vs "Santos, Maria"); guard skipped for legacy NULL-parts rows.
    const fx = await fixture();
    await legacy(fx.orgId, 'Maria Santos');
    const before = await countPersons(fx.orgId);
    const err = await hire(fx, fx.adminActor, { name: { lastName: 'Santos', firstName: 'Maria' } }).then(() => null, (e: Error) => e);
    expect(err, 'must refuse').not.toBeNull();
    const text = `${(err as { userReason?: string }).userReason ?? ''} ${err!.message}`;
    expect(text).toMatch(/is already in the system/);
    expect(text).toContain('Maria Santos');
    expect(text).toMatch(/different person with the same name/);
    expect(await countPersons(fx.orgId), 'no row written').toBe(before);
  });
  it('H2b: a new-style "Santos, Maria C." also blocks a typed Santos / Maria (initial does not count)', async () => {
    const fx = await fixture();
    await hire(fx, fx.adminActor, { name: { lastName: 'Santos', firstName: 'Maria', middleName: 'Clara' } });
    await expect(hire(fx, fx.adminActor, { name: { lastName: 'santos', firstName: 'MARIA' } })).rejects.toThrow(/already in the system|different person/);
  });
  it('H3: sameNameConfirmed lets the create through, and the audit row records sameNameConfirmed: true', async () => {
    // Kills: no override; override accepted but unrecorded.
    const fx = await fixture();
    await legacy(fx.orgId, 'Maria Santos');
    const p = await hire(fx, fx.adminActor, { name: { lastName: 'Santos', firstName: 'Maria' }, sameNameConfirmed: true });
    expect(await row(p.id)).toMatchObject({ display_name: 'Santos, Maria', last_name: 'Santos' });
    const audit = await sql`select action, after from audit_log where org_id = ${fx.orgId} and entity_id = ${p.id} and (after->>'sameNameConfirmed') = 'true'`;
    expect(audit.length, 'an audit row for the new person carries sameNameConfirmed: true').toBeGreaterThanOrEqual(1);
  });
  it('H4: a same-name TERMINAL, and a same-name person in ANOTHER org, are not matches', async () => {
    // Kills: guard without the kind = person filter; guard without the org filter.
    const fx = await fixture();
    await legacy(fx.orgId, 'Maria Santos', 'terminal');
    const other = await fixture();
    await legacy(other.orgId, 'Maria Santos');
    const p = await hire(fx, fx.adminActor, { name: { lastName: 'Santos', firstName: 'Maria' } });
    expect((await row(p.id)).display_name).toBe('Santos, Maria');
  });
  it('H5: the single-string form {displayName} (master-data load) ignores the guard and leaves the parts NULL', async () => {
    // Kills: N4 applied to the single-name path, which would break the v1 load.
    const fx = await fixture();
    await legacy(fx.orgId, 'Maria Santos');
    const p = await hire(fx, fx.adminActor, { displayName: 'Maria Santos' });
    expect(await row(p.id)).toMatchObject({ display_name: 'Maria Santos', last_name: null, first_name: null, middle_name: null });
  });
});

describe('T-438 H6 - search matches every word against any part, in any order (N7)', () => {
  it('"maria santos", "santos maria", "clara" find Santos, Maria C.; "maria pedro" does not', async () => {
    // Kills: OR across words instead of AND; middle_name not searched; order-sensitive match.
    const fx = await fixture();
    const target = await hire(fx, fx.adminActor, { name: { lastName: 'Santos', firstName: 'Maria', middleName: 'Clara' } });
    await legacy(fx.orgId, 'Pedro Penduko');
    const find = async (q: string) =>
      (await withOrgPrincipal(fx.orgId, (tx) => searchPersons(tx, fx.adminActor, { query: q }))).map((r) => r.id);
    expect(await find('maria santos')).toContain(target.id);
    expect(await find('santos maria')).toContain(target.id);
    expect(await find('clara')).toContain(target.id);
    expect(await find('maria pedro'), 'AND, not OR: Pedro matches one word, Maria another, nobody both').not.toContain(target.id);
    expect(await find('maria pedro')).toHaveLength(0);
  });
});

describe('T-438 H7 - hiring still needs enrol_staff at the store', () => {
  it('a staff-role actor is refused and nothing is written', async () => {
    // Kills: authorize dropped in the refactor to the union input.
    const fx = await fixture();
    const staff = await asStaffOnly(fx);
    const before = await countPersons(fx.orgId);
    await expect(hire(fx, staff, { name: { lastName: 'Reyes', firstName: 'Ana' } })).rejects.toThrow(/enrol_staff|not authori[sz]ed/i);
    expect(await countPersons(fx.orgId)).toBe(before);
  });
});

describe('T-438 S2b - renamePerson', () => {
  const renamePerson = (people as unknown as Record<string, unknown>)['renamePerson'] as
    | ((tx: unknown, actor: Actor, input: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  const rename = (fx: Fx, actor: Actor, input: Record<string, unknown>) => {
    if (!renamePerson) throw new Error('renamePerson is not exported from @shareat/domain people (S2b not built yet)');
    return withOrgPrincipal(fx.orgId, (tx) => renamePerson(tx, actor, input));
  };
  // Employment rows go in by SQL: createEmployment needs the canonical positions seeded, which is not what is under test here.
  const employed = async (fx: Fx, name: string) => {
    const personId = await legacy(fx.orgId, name);
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
      values (${fx.orgId}, ${fx.storeId}, ${personId}, ${uid('SE')}, 'probationary', '2026-10-01', ${fx.adminActor.personId}) returning id`;
    return { personId, employmentId: e!.id };
  };

  it('R1: renaming a NULL-parts person sets the parts, rewrites display_name, stamps updated_at, and audits displayName before/after only', async () => {
    // Kills: display_name not rewritten; audit leaks other columns; updated_at not stamped.
    const fx = await fixture();
    const { personId, employmentId } = await employed(fx, 'Maria Dela Cruz Santos');
    await rename(fx, fx.adminActor, { employmentId, lastName: 'Dela Cruz Santos', firstName: 'Maria', middleName: 'lopez' });
    const r = await row(personId);
    expect(r).toMatchObject({ display_name: 'Dela Cruz Santos, Maria L.', last_name: 'Dela Cruz Santos', first_name: 'Maria', middle_name: 'lopez' });
    const [u] = await sql<{ updated_at: Date | null }[]>`select updated_at from persons where id = ${personId}`;
    expect(u!.updated_at).not.toBeNull();
    const audit = await sql<{ before: Record<string, unknown>; after: Record<string, unknown> }[]>`
      select before, after from audit_log where org_id = ${fx.orgId} and action = 'person.renamed' and entity_id = ${personId}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before).toEqual({ displayName: 'Maria Dela Cruz Santos' });
    expect(audit[0]!.after).toEqual({ displayName: 'Dela Cruz Santos, Maria L.' });
  });

  it('R2: an actor holding enrol_staff only at ANOTHER store is refused, and the name is unchanged', async () => {
    // Kills: authorize against the wrong store (or the actor's own store / org-wide).
    const fx = await fixture();
    const { personId, employmentId } = await employed(fx, 'Maria Santos');
    const [s2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${fx.orgId}, ${uid('S2')}, 'Second') returning id`;
    const otherAdmin = await legacy(fx.orgId, 'Other Branch Admin');
    await sql`insert into person_roles (person_id, org_id, role) values (${otherAdmin}, ${fx.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${otherAdmin}, ${s2!.id})`;
    await expect(rename(fx, { personId: otherAdmin, orgId: fx.orgId }, { employmentId, lastName: 'Reyes', firstName: 'Ana' })).rejects.toThrow(/enrol_staff|not authori[sz]ed/i);
    expect((await row(personId)).display_name).toBe('Maria Santos');
  });

  it('R3: renaming to a name another person already has is allowed (N4 does not run on rename)', async () => {
    // Kills: the duplicate guard wrongly applied to rename.
    const fx = await fixture();
    await legacy(fx.orgId, 'Maria Santos');
    const { personId, employmentId } = await employed(fx, 'Mariah Santoz');
    await rename(fx, fx.adminActor, { employmentId, lastName: 'Santos', firstName: 'Maria' });
    expect((await row(personId)).display_name).toBe('Santos, Maria');
  });

  it('R4: a terminal person cannot be renamed', async () => {
    const fx = await fixture();
    const termId = await legacy(fx.orgId, 'Terminal - Main', 'terminal');
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
      values (${fx.orgId}, ${fx.storeId}, ${termId}, ${uid('SE')}, 'regular', '2026-10-01', ${fx.adminActor.personId}) returning id`;
    await expect(rename(fx, fx.adminActor, { employmentId: e!.id, lastName: 'Santos', firstName: 'Maria' })).rejects.toThrow();
    expect((await row(termId)).display_name).toBe('Terminal - Main');
  });
});
