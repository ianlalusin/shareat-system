/**
 * T-609 (Ian, 19 Nov 2026) - ending an employment switches off ALL ERP and POS access.
 * docs/tasks/609-end-employment-revokes-all-access.md, tests 1-4, 6, 7 (test 5, the device sync, is
 * apps/erp/src/lib/pos-device/verifier-store.test.ts + apps/erp/tests/t526-snapshot-sync.test.ts).
 *
 * Fixtures come from the real flows (`bootstrapOrganization`, `createEmployment`, `createStore`), committed as the owner; reads are
 * the owner's, so a count is what COMMITTED. `endEmployment` runs under the real org principal. Mutants per case are named in the
 * comments and were run by hand: each one turns the named case red.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, systemTransaction, withOrgPrincipal, accessRepo } from '@shareat/db';
import { AuthenticationError, hashPin, pinLookupHash, setPin, signInWithFirebase, signInWithPin, type Actor } from '@shareat/auth';
import { bootstrapOrganization } from '../../src/organizations';
import { createStore } from '../../src/stores/service';
import { createEmployment, endEmployment, EmploymentError } from '../../src/people';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;

beforeEach(async () => {
  await sql`
    truncate table sessions, person_credentials, person_grants, person_roles,
      position_capability_defaults, employment_positions, employments, positions,
      person_store_scope, stock_locations, location_types, sales_channels, stores, persons,
      fiscal_periods, expense_categories, accounts, organizations
      restart identity cascade`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const INPUT = { code: 'T609', name: 'T609 Co', adminDisplayName: 'Admin', storeCode: 'MAIN', storeName: 'Main', pin: '135790' };

async function world(hint: string) {
  const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid(hint) }));
  const orgId = boot.orgId;
  const boss: Actor = { personId: boot.personId, orgId };
  const storeA = boot.storeId;
  const storeB = (await withOrgPrincipal(orgId, (tx) => createStore(tx, boss, { code: uid(`${hint}b`).slice(0, 10), name: 'Store B' }))).storeId;
  /** A person with a live PIN (org-wide, stamped store A) and a Firebase credential, optionally a role first (hire only adds `staff` when none). */
  const person = async (name: string, role?: 'manager' | 'admin') => {
    const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    const externalId = uid('fbuid');
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${personId}, 'firebase', null, ${externalId})`;
    const pin = String(860100 + ++pinSeq);
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${personId}, 'pin', ${storeA}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { personId, externalId, pin, actor: { personId, orgId } as Actor };
  };
  const hire = (personId: string, storeId: string, by: Actor = boss) =>
    withOrgPrincipal(orgId, (tx) => createEmployment(tx, by, { storeId, personId, employmentStatus: 'regular', startedOn: '2026-01-01' }));
  const end = (by: Actor, employmentId: string) =>
    withOrgPrincipal(orgId, (tx) => endEmployment(tx, by, { employmentId, endedOn: '2026-06-01', employmentStatus: 'terminated' }));
  const grant = (personId: string, grantName: string, atStoreId?: string) =>
    withOrgPrincipal(orgId, (tx) =>
      accessRepo.grantCapability(tx, atStoreId ? { personId, grantName, grantedBy: boot.personId, grantSource: 'grant', atStoreId } : { personId, grantName, grantedBy: boot.personId, grantSource: 'grant' }),
    );
  const manualScope = (personId: string, storeId: string) =>
    withOrgPrincipal(orgId, (tx) => accessRepo.grantStoreScope(tx, { personId, storeId, grantedBy: boot.personId, source: 'manual' }));
  const pinSession = (p: { pin: string }, storeId: string) => signInWithPin(null, { orgId, storeId, pin: p.pin });
  return { orgId, boss, boot, storeA, storeB, person, hire, end, grant, manualScope, pinSession };
}

const n = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n;
const activeGrants = (personId: string) => n(sql<{ n: number }[]>`select count(*)::int n from person_grants where person_id = ${personId} and revoked_at is null`);
const scopeRows = (personId: string, storeId?: string) =>
  n(storeId ? sql<{ n: number }[]>`select count(*)::int n from person_store_scope where person_id = ${personId} and store_id = ${storeId}` : sql<{ n: number }[]>`select count(*)::int n from person_store_scope where person_id = ${personId}`);
const activeRole = async (personId: string) =>
  (await sql<{ role: string }[]>`select role from person_roles where person_id = ${personId} and revoked_at is null`)[0]?.role;
const livePins = (personId: string) => n(sql<{ n: number }[]>`select count(*)::int n from person_credentials where person_id = ${personId} and kind = 'pin' and revoked_at is null`);
const liveSessions = (personId: string) => n(sql<{ n: number }[]>`select count(*)::int n from sessions where person_id = ${personId} and ended_at is null`);
const accessAudit = async (orgId: string) =>
  sql<{ after: Record<string, unknown>; store_id: string | null }[]>`select after, store_id from audit_log where org_id = ${orgId} and action = 'employment.access_revoked'`;

describe('1 - a cashier with one job: ending it switches everything off', () => {
  it('no grants, no scopes, role revoked, PIN revoked, sessions ended, PIN sign-in refused; one audit row lists the counts (test 6)', async () => {
    const w = await world('t609-1');
    const cashier = await w.person('Cashier');
    const emp = await w.hire(cashier.personId, w.storeA);
    await w.grant(cashier.personId, 'record_wastage'); // a manual extra, not from a position
    await w.manualScope(cashier.personId, w.storeA); // flips the hire's scope row to 'manual'
    await w.pinSession(cashier, w.storeA); // a live session to end
    expect(await liveSessions(cashier.personId)).toBe(1);
    expect(await activeGrants(cashier.personId), 'control: the grant is there before the end').toBeGreaterThan(0);

    await w.end(w.boss, emp.id);

    // Mutants: skip deleteStoreScopesForPerson (manual scope survives) / skip revokeActiveGrantsForPerson / skip revokeActiveRole /
    // skip the PIN loop / skip the forced session end - each leaves its own assertion below red.
    expect(await scopeRows(cashier.personId), 'scopes (the manual one too)').toBe(0);
    expect(await activeGrants(cashier.personId), 'grants').toBe(0);
    expect(await activeRole(cashier.personId), 'role').toBeUndefined();
    expect(await livePins(cashier.personId), 'PIN').toBe(0);
    expect(await liveSessions(cashier.personId), 'sessions').toBe(0);
    await expect(w.pinSession(cashier, w.storeA)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(signInWithFirebase(null, { verifiedUid: cashier.externalId }), 'the browser sign-in is refused too').rejects.toBeInstanceOf(AuthenticationError);

    const rows = await accessAudit(w.orgId);
    expect(rows, 'exactly one access_revoked row').toHaveLength(1);
    expect(rows[0]!.store_id).toBe(w.storeA);
    expect(rows[0]!.after).toMatchObject({ personId: cashier.personId, reach: 'everywhere', storeScopes: 1, roles: 1, pins: 1, sessions: 1 });
    expect(Number(rows[0]!.after.grants), 'the manual grant (position grants were already revoked by the T-289 step)').toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rows[0]!.after), 'counts only: no PIN material').not.toMatch(/hash|secret|\b86\d{4}\b/i);
  });
});

describe('2 - a two-store person ends the store A job', () => {
  it('store A is gone (manual scope and grant too); store B, the PIN and the role stay; sign-in works at B, is refused at A', async () => {
    const w = await world('t609-2');
    const p = await w.person('Two Stores');
    const empA = await w.hire(p.personId, w.storeA);
    await w.hire(p.personId, w.storeB);
    await w.manualScope(p.personId, w.storeA);
    await w.manualScope(p.personId, w.storeB);
    await w.grant(p.personId, 'record_wastage', w.storeA);
    await w.grant(p.personId, 'record_wastage', w.storeB);

    await w.end(w.boss, empA.id);

    // Mutants: take the whole-org branch for a non-last job (B's scope and the PIN vanish) / forget the store filter on the
    // manual scope or the grants (A's manual rows survive) - each is red here.
    expect(await scopeRows(p.personId, w.storeA), 'A scope (manual) gone').toBe(0);
    expect(await scopeRows(p.personId, w.storeB), 'B scope kept').toBe(1);
    expect(await n(sql<{ n: number }[]>`select count(*)::int n from person_grants where person_id = ${p.personId} and store_id = ${w.storeA} and revoked_at is null`), 'A grant gone').toBe(0);
    expect(await n(sql<{ n: number }[]>`select count(*)::int n from person_grants where person_id = ${p.personId} and store_id = ${w.storeB} and revoked_at is null`), 'B grant kept').toBe(1);
    expect(await activeRole(p.personId), 'role kept').toBe('staff');
    expect(await livePins(p.personId), 'PIN kept').toBe(1);
    await expect(w.pinSession(p, w.storeB), 'sign-in at B works').resolves.toBeDefined();
    await expect(w.pinSession(p, w.storeA), 'sign-in at A is refused').rejects.toBeInstanceOf(AuthenticationError);
    const [row] = await accessAudit(w.orgId);
    expect(row!.after).toMatchObject({ reach: 'this_store', roles: 0, pins: 0 });
  });
});

describe('3 - the last administrator who can sign in', () => {
  it('ending their job is refused with a plain sentence and NOTHING changes; with a second administrator who can sign in it goes through', async () => {
    const w = await world('t609-3');
    const target = w.boot.personId; // the founding admin, the only one holding a PIN
    const emp = await w.hire(target, w.storeA);
    // A second admin who has NO credential: holds the role, cannot sign in, so does not count (T-237/T-238).
    const second = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Second') returning id`)[0]!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${second}, ${w.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${second}, ${w.storeA}, 'fan_out')`;
    const secondActor: Actor = { personId: second, orgId: w.orgId };

    // Mutant: delete the hasOtherActiveAdminWhoCanSignIn call - the end goes through and the next block is red.
    await expect(w.end(secondActor, emp.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof EmploymentError && /only administrator who can sign in/.test(e.userReason ?? ''),
    );
    const [open] = await sql<{ ended_on: string | null }[]>`select ended_on from employments where id = ${emp.id}`;
    expect(open!.ended_on, 'the employment is still open').toBeNull();
    expect(await activeRole(target), 'role untouched').toBe('admin');
    expect(await livePins(target), 'PIN untouched').toBe(1);
    expect(await scopeRows(target), 'scopes untouched').toBeGreaterThan(0);
    expect(await accessAudit(w.orgId), 'no audit row for a refused end').toHaveLength(0);

    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash) values (${second}, 'pin', ${w.storeA}, ${await hashPin('860999')}, ${pinLookupHash(w.orgId, '860999')})`;
    await w.end(secondActor, emp.id);
    expect(await activeRole(target), 'control: with another administrator who can sign in, the end revokes the role').toBeUndefined();
  });
});

describe('4 - a manager with a role and an employment', () => {
  it('the role is revoked and sign-in (PIN and browser) is refused', async () => {
    const w = await world('t609-4');
    const m = await w.person('Manager', 'manager');
    const emp = await w.hire(m.personId, w.storeA);
    expect(await activeRole(m.personId)).toBe('manager');
    await w.end(w.boss, emp.id);
    // Mutant: skip revokeActiveRole - the role survives and this is red (the manager leg of personMaySignInToOrg needs "no employment ever").
    expect(await activeRole(m.personId)).toBeUndefined();
    await expect(w.pinSession(m, w.storeA)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(signInWithFirebase(null, { verifiedUid: m.externalId })).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('a manager may not strip an administrator by ending their job (rank, DEF-234); an administrator may', async () => {
    const w = await world('t609-4r');
    const adminT = await w.person('Other Admin', 'admin');
    const adminEmp = await w.hire(adminT.personId, w.storeA);
    const mgr = await w.person('Mgr', 'manager');
    await w.hire(mgr.personId, w.storeA);
    // Mutant: delete the rank check - the manager's end goes through and this is red.
    await expect(w.end(mgr.actor, adminEmp.id)).rejects.toSatisfy((e: unknown) => e instanceof EmploymentError && /at least as senior/.test(e.userReason ?? ''));
    expect(await activeRole(adminT.personId)).toBe('admin');
    await w.end(w.boss, adminEmp.id);
    expect(await activeRole(adminT.personId), 'control: an admin may').toBeUndefined();
  });
});

describe('7 - re-hire switches access back on, except manual extras and the PIN', () => {
  it('position grants, the staff role and the employment scope return; the manual grant does not; the PIN must be set again', async () => {
    const w = await world('t609-7');
    const [cashier] = await sql<{ id: string }[]>`select id from positions where org_id = ${w.orgId} and name = 'Cashier'`;
    const p = await w.person('Rehired');
    const hireCashier = () =>
      withOrgPrincipal(w.orgId, (tx) => createEmployment(tx, w.boss, { storeId: w.storeA, personId: p.personId, employmentStatus: 'regular', startedOn: '2026-01-01', positionIds: [cashier!.id], primaryPositionId: cashier!.id }));
    const emp = await hireCashier();
    await w.grant(p.personId, 'record_wastage');
    const positionGrants = await n(sql<{ n: number }[]>`select count(*)::int n from person_grants where person_id = ${p.personId} and revoked_at is null and grant_source = 'position'`);
    expect(positionGrants, 'control: a cashier hire carries position grants').toBeGreaterThan(0);

    await w.end(w.boss, emp.id);
    expect(await activeGrants(p.personId)).toBe(0);

    await hireCashier();
    expect(await activeRole(p.personId), 'staff role back').toBe('staff');
    expect(await scopeRows(p.personId, w.storeA), 'employment scope back').toBe(1);
    expect(await n(sql<{ n: number }[]>`select count(*)::int n from person_grants where person_id = ${p.personId} and revoked_at is null and grant_source = 'position'`), 'position grants back').toBe(positionGrants);
    expect(await n(sql<{ n: number }[]>`select count(*)::int n from person_grants where person_id = ${p.personId} and revoked_at is null and grant_source = 'grant'`), 'the manual extra is NOT back').toBe(0);
    await expect(w.pinSession(p, w.storeA), 'the old PIN is dead').rejects.toBeInstanceOf(AuthenticationError);
    await setPin(null, { orgId: w.orgId, personId: p.personId, storeId: w.storeA, pin: '860777' });
    await expect(w.pinSession({ pin: '860777' }, w.storeA), 'a newly set PIN works').resolves.toBeDefined();
  });
});
