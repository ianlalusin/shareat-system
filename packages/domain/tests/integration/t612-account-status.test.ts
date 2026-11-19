/**
 * T-612 (Ian, 19 Nov 2026) - every person has an ACCOUNT STATUS (pending / active / suspended / ended).
 * docs/tasks/612-staff-account-status.md, tests 1-6, 8, 9 (test 7, the backfill, is packages/db/tests/integration/t612-account-status-migration.test.ts;
 * the POS snapshot half of test 3 is t612-pos-snapshot.test.ts).
 *
 * Fixtures come from the real flows (`bootstrapOrganization`, `createPerson` + `createEmployment`, `createStore`); people made by raw SQL get the
 * column default 'active' (as every pre-0268 writer does). Everything runs under the real org principal. Mutants per case are named in the comments
 * and were run by hand: each one turns the named case red.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, systemTransaction, withOrgPrincipal, accessRepo, sessionsRepo, storeReadinessRepo } from '@shareat/db';
import { AuthenticationError, AuthorizationError, authorize, hashPin, newSessionToken, pinLookupHash, sessionTokenHash, setPin, signInWithPin, type Actor } from '@shareat/auth';
import { bootstrapOrganization } from '../../src/organizations';
import { createStore } from '../../src/stores/service';
import { activateAccount, createEmployment, createPerson, endEmployment, EmploymentError, reinstateAccount, suspendAccount } from '../../src/people';

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

const PENDING_SENTENCE = "Your account isn't active yet. Ask your manager.";
const SUSPENDED_SENTENCE = 'Your account is suspended. Ask your manager.';
const INPUT = { code: 'T612', name: 'T612 Co', adminDisplayName: 'Admin', storeCode: 'MAIN', storeName: 'Main', pin: '135790' };

async function world(hint: string) {
  const boot = await systemTransaction((tx) => bootstrapOrganization(tx, { ...INPUT, code: uid(hint) }));
  const orgId = boot.orgId;
  const boss: Actor = { personId: boot.personId, orgId };
  const storeA = boot.storeId;
  const storeB = (await withOrgPrincipal(orgId, (tx) => createStore(tx, boss, { code: uid(`${hint}b`).slice(0, 10), name: 'Store B' }))).storeId;
  const asOrg = <T>(fn: Parameters<typeof withOrgPrincipal<T>>[1]) => withOrgPrincipal(orgId, fn);
  const issuePin = async (personId: string) => {
    const pin = String(870100 + ++pinSeq);
    await asOrg((tx) => setPin(tx, { orgId, personId, storeId: storeA, pin }));
    return pin;
  };
  /** The real hire: a brand-new person (status pending) hired at a store, with a PIN set. */
  const hireNew = async (storeId: string, last: string, by: Actor = boss) => {
    const r = await asOrg(async (tx) => {
      const person = await createPerson(tx, by, { storeId, name: { lastName: last, firstName: 'Test', middleName: null } });
      const employment = await createEmployment(tx, by, { storeId, personId: person.id, employmentStatus: 'regular', startedOn: '2026-01-01' });
      return { personId: person.id, employmentId: employment.id, displayName: person.displayName };
    });
    return { ...r, pin: await issuePin(r.personId), actor: { personId: r.personId, orgId } as Actor };
  };
  /** A person made by raw SQL (status = the column default 'active'), optionally with a role, then hired through the domain. */
  const rawHire = async (name: string, role: 'manager' | 'admin' | 'super_admin' | null, storeId: string | null, opts: { pin?: boolean } = {}) => {
    const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    const employmentId = storeId
      ? (await asOrg((tx) => createEmployment(tx, boss, { storeId, personId, employmentStatus: 'regular', startedOn: '2026-01-01' }))).id
      : null;
    // A hire of a person with no open job starts `pending` (audit 2b) unless they are an administrator; these fixtures are people who already work.
    if (employmentId && role !== 'admin' && role !== 'super_admin') await activate(boss, employmentId);
    const pin = opts.pin === false ? null : await issuePin(personId);
    return { personId, employmentId, pin, displayName: name, actor: { personId, orgId } as Actor };
  };
  const activate = (by: Actor, employmentId: string) => asOrg((tx) => activateAccount(tx, by, { employmentId }));
  const suspend = (by: Actor, employmentId: string, reason = 'Left the till open') => asOrg((tx) => suspendAccount(tx, by, { employmentId, reason }));
  const reinstate = (by: Actor, employmentId: string) => asOrg((tx) => reinstateAccount(tx, by, { employmentId }));
  const end = (by: Actor, employmentId: string) => asOrg((tx) => endEmployment(tx, by, { employmentId, endedOn: '2026-06-01', employmentStatus: 'terminated' }));
  const pinAt = (pin: string, storeId: string) => signInWithPin(null, { orgId, storeId, pin });
  return { orgId, boss, boot, storeA, storeB, asOrg, hireNew, rawHire, activate, suspend, reinstate, end, pinAt };
}

const status = async (personId: string) => (await sql<{ s: string }[]>`select account_status as s from persons where id = ${personId}`)[0]?.s;
const liveSessions = async (personId: string) => (await sql<{ n: number }[]>`select count(*)::int n from sessions where person_id = ${personId} and ended_at is null`)[0]!.n;
const audit = (orgId: string, action: string) =>
  sql<{ after: Record<string, unknown>; before: Record<string, unknown>; store_id: string | null; entity_id: string; actor_person_id: string }[]>`
    select after, before, store_id, entity_id, actor_person_id from audit_log where org_id = ${orgId} and action = ${action}`;
/** Everything the suspend must leave alone: role, scope, grants, positions, credentials. */
async function rights(personId: string) {
  return {
    roles: await sql`select id, role, revoked_at from person_roles where person_id = ${personId} order by id`,
    scope: await sql`select store_id, source from person_store_scope where person_id = ${personId} order by store_id`,
    grants: await sql`select id, grant_name, revoked_at from person_grants where person_id = ${personId} order by id`,
    credentials: await sql`select id, kind, revoked_at from person_credentials where person_id = ${personId} order by id`,
    positions: await sql`select ep.position_id, ep.is_primary from employment_positions ep join employments e on e.id = ep.employment_id where e.person_id = ${personId} order by ep.position_id`,
  };
}
const refusalOf = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as (Error & { userReason?: string; userMessage?: string }) | undefined;

describe('1 - a new hire starts pending and cannot sign in or act', () => {
  it('createPerson + createEmployment -> pending; the correct PIN is refused with the pending sentence; authorize refuses with it too', async () => {
    const w = await world('t612-1');
    const h = await w.hireNew(w.storeA, 'Newhire');
    // Mutant: createPerson without accountStatus 'pending' (the column default 'active') -> this is red.
    expect(await status(h.personId)).toBe('pending');
    // Mutant: the status check removed from personMaySignInAtStore -> the PIN works and this is red.
    const e = await w.pinAt(h.pin, w.storeA).then(() => undefined, (x: Error) => x);
    expect(e, 'a pending account is refused').toBeInstanceOf(AuthenticationError);
    expect(e!.message).toBe(PENDING_SENTENCE);
    expect(await liveSessions(h.personId)).toBe(0);
    // A WRONG PIN still says only the flat sentence (the pending sentence is never an oracle for an unknown PIN).
    await expect(w.pinAt('000001', w.storeA)).rejects.toMatchObject({ message: 'Sign-in failed: that PIN is not valid.' });
    // Mutant: authorize() without the status check -> the refusal is the generic role sentence instead and this is red.
    const refusal = await refusalOf(w.asOrg((tx) => authorize(tx, h.actor, 'enrol_staff', { storeId: w.storeA })));
    expect(refusal).toBeInstanceOf(AuthorizationError);
    expect(refusal!.userMessage).toBe(PENDING_SENTENCE);
    // The hire kept everything else: role, scope and the employment exist from the moment of hire.
    const r = await rights(h.personId);
    expect(r.roles).toHaveLength(1);
    expect(r.scope).toHaveLength(1);
  });

  it('a second hire of an ACTIVE person at another store leaves them active', async () => {
    const w = await world('t612-1b');
    const p = await w.rawHire('Already Active', null, w.storeA);
    await w.asOrg((tx) => createEmployment(tx, w.boss, { storeId: w.storeB, personId: p.personId, employmentStatus: 'regular', startedOn: '2026-02-01' }));
    expect(await status(p.personId)).toBe('active');
  });
});

describe('2 - activate', () => {
  it('pending -> active: the PIN now signs in; a store manager can do it at their own store, a plain staff member cannot', async () => {
    const w = await world('t612-2');
    const mgr = await w.rawHire('Manager A', 'manager', w.storeA);
    const cook = await w.rawHire('Cook Staff', null, w.storeA);
    const h = await w.hireNew(w.storeA, 'Activated');
    const refused = await refusalOf(w.activate(cook.actor, h.employmentId));
    expect(refused, 'staff cannot activate').toBeInstanceOf(AuthorizationError);
    expect(await status(h.personId)).toBe('pending');

    await w.activate(mgr.actor, h.employmentId);
    expect(await status(h.personId)).toBe('active');
    const signed = await w.pinAt(h.pin, w.storeA);
    expect(signed.personId).toBe(h.personId);
    const row = (await audit(w.orgId, 'account.activated')).find((r) => r.entity_id === h.personId);
    expect(row).toMatchObject({ entity_id: h.personId, store_id: w.storeA, actor_person_id: mgr.personId, before: { accountStatus: 'pending' }, after: { accountStatus: 'active' } });
  });

  it('only a pending account can be activated; activating twice is refused in a sentence', async () => {
    const w = await world('t612-2b');
    const h = await w.hireNew(w.storeA, 'Twice');
    await w.activate(w.boss, h.employmentId);
    const e = await refusalOf(w.activate(w.boss, h.employmentId));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(e!.userReason).toBe('This account is already active.');
  });

  it('works without a PIN set (the page says "Set a PIN so they can sign in")', async () => {
    const w = await world('t612-2c');
    const emp = await w.asOrg(async (tx) => {
      const person = await createPerson(tx, w.boss, { storeId: w.storeA, name: { lastName: 'Nopin', firstName: 'Test', middleName: null } });
      return createEmployment(tx, w.boss, { storeId: w.storeA, personId: person.id, employmentStatus: 'regular', startedOn: '2026-01-01' });
    });
    await w.activate(w.boss, emp.id);
    expect(await status(emp.personId)).toBe('active');
  });
});

describe('3 - suspend: sessions end in the same transaction, sign-in is refused, rights are untouched', () => {
  it('a manager with a live session is suspended by an administrator', async () => {
    const w = await world('t612-3');
    const m = await w.rawHire('Manager To Suspend', 'manager', w.storeA);
    await w.asOrg((tx) => accessRepo.grantCapability(tx, { personId: m.personId, grantName: 'record_wastage', grantedBy: w.boot.personId, grantSource: 'grant' }));
    const session = await w.pinAt(m.pin!, w.storeA);
    expect(await liveSessions(m.personId), 'control: a live session before').toBe(1);
    const before = await rights(m.personId);
    expect(before.grants.length, 'control: a hand-granted right exists').toBeGreaterThan(0);
    // Control: the actor works before the suspend.
    await w.asOrg((tx) => authorize(tx, m.actor, 'enrol_staff', { storeId: w.storeA }));

    await w.suspend(w.boss, m.employmentId!, 'Cash short twice');

    expect(await status(m.personId)).toBe('suspended');
    // Mutant: suspend without endAllForPerson -> the session stays live and this is red.
    expect(await liveSessions(m.personId), 'sessions').toBe(0);
    expect(session.sessionId).toBeTruthy();
    const e = await w.pinAt(m.pin!, w.storeA).then(() => undefined, (x: Error) => x);
    expect(e, 'sign-in refused').toBeInstanceOf(AuthenticationError);
    expect(e!.message).toBe(SUSPENDED_SENTENCE);
    // Rights, role and scope are KEPT (Ian "A"): nothing about them moved.
    expect(await rights(m.personId)).toEqual(before);
    // ... and paused: authorize refuses with the suspended sentence, though the role row still exists.
    const refusal = await refusalOf(w.asOrg((tx) => authorize(tx, m.actor, 'enrol_staff', { storeId: w.storeA })));
    expect(refusal).toBeInstanceOf(AuthorizationError);
    expect(refusal!.userMessage).toBe(SUSPENDED_SENTENCE);
    const [row] = await audit(w.orgId, 'account.suspended');
    expect(row).toMatchObject({ entity_id: m.personId, store_id: w.storeA, before: { accountStatus: 'active' }, after: { accountStatus: 'suspended', reason: 'Cash short twice', endedSessions: 1 } });
    expect((await audit(w.orgId, 'session.ended_all')).length, 'the session.ended_all row too').toBe(1);
  });

  it('the status change and the session end are ONE transaction: a failure after the suspend rolls both back', async () => {
    const w = await world('t612-3b');
    const s = await w.hireNew(w.storeA, 'Atomic');
    await w.activate(w.boss, s.employmentId);
    await w.pinAt(s.pin, w.storeA);
    await expect(
      w.asOrg(async (tx) => {
        await suspendAccount(tx, w.boss, { employmentId: s.employmentId, reason: 'x' });
        throw new Error('boom after the suspend');
      }),
    ).rejects.toThrow('boom after the suspend');
    expect(await status(s.personId), 'status rolled back').toBe('active');
    expect(await liveSessions(s.personId), 'session still live: rolled back with it').toBe(1);
  });

  it('a reason is required; nothing changes without one', async () => {
    const w = await world('t612-3c');
    const s = await w.hireNew(w.storeA, 'Noreason');
    await w.activate(w.boss, s.employmentId);
    const e = await refusalOf(w.suspend(w.boss, s.employmentId, '   '));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(await status(s.personId)).toBe('active');
  });

  it('only an active account can be suspended', async () => {
    const w = await world('t612-3d');
    const s = await w.hireNew(w.storeA, 'Pendingsus');
    const e = await refusalOf(w.suspend(w.boss, s.employmentId));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(await status(s.personId)).toBe('pending');
  });
});

describe('4 - reinstate restores exactly what they had', () => {
  it('suspended -> active: same rights rows, sign-in works again with the same PIN, no re-setup', async () => {
    const w = await world('t612-4');
    const m = await w.rawHire('Manager To Reinstate', 'manager', w.storeA);
    const before = await rights(m.personId);
    await w.suspend(w.boss, m.employmentId!);
    expect(await status(m.personId)).toBe('suspended');

    await w.reinstate(w.boss, m.employmentId!);

    expect(await status(m.personId)).toBe('active');
    expect(await rights(m.personId), 'the very same rows').toEqual(before);
    const signed = await w.pinAt(m.pin!, w.storeA);
    expect(signed.personId).toBe(m.personId);
    await w.asOrg((tx) => authorize(tx, m.actor, 'enrol_staff', { storeId: w.storeA }));
    const [row] = await audit(w.orgId, 'account.reinstated');
    expect(row).toMatchObject({ entity_id: m.personId, before: { accountStatus: 'suspended' }, after: { accountStatus: 'active' } });
  });

  it('only a suspended account can be reinstated', async () => {
    const w = await world('t612-4b');
    const s = await w.hireNew(w.storeA, 'Notsuspended');
    await w.activate(w.boss, s.employmentId);
    const e = await refusalOf(w.reinstate(w.boss, s.employmentId));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(await status(s.personId)).toBe('active');
  });
});

describe('5 - who may act on whom', () => {
  it('a manager suspends staff at their own store; not at another store', async () => {
    const w = await world('t612-5a');
    const mgr = await w.rawHire('Manager A', 'manager', w.storeA);
    const a = await w.hireNew(w.storeA, 'StaffA');
    const b = await w.hireNew(w.storeB, 'StaffB');
    await w.activate(w.boss, a.employmentId);
    await w.activate(w.boss, b.employmentId);
    await w.suspend(mgr.actor, a.employmentId);
    expect(await status(a.personId)).toBe('suspended');
    const e = await refusalOf(w.suspend(mgr.actor, b.employmentId));
    expect(e, 'another store').toBeInstanceOf(AuthorizationError);
    expect(await status(b.personId)).toBe('active');
  });

  it('a manager cannot suspend another manager; an administrator can', async () => {
    const w = await world('t612-5b');
    const m1 = await w.rawHire('Manager One', 'manager', w.storeA);
    const m2 = await w.rawHire('Manager Two', 'manager', w.storeA);
    const e = await refusalOf(w.suspend(m1.actor, m2.employmentId!));
    expect(e, 'manager on manager').toBeInstanceOf(AuthorizationError);
    expect(await status(m2.personId)).toBe('active');
    await w.suspend(w.boss, m2.employmentId!);
    expect(await status(m2.personId)).toBe('suspended');
  });

  it('the rank rule: an administrator cannot suspend a super administrator', async () => {
    const w = await world('t612-5c');
    const sup = await w.rawHire('Super Admin', 'super_admin', w.storeA);
    // An ordinary administrator (the founding admin holds the 'owner' grant that carries super-admin authority, so it is not the actor here).
    const plainAdmin = await w.rawHire('Plain Admin', 'admin', w.storeA);
    // Mutant: the rank check dropped from changeStatus -> the admin suspends the super_admin and this is red.
    const e = await refusalOf(w.suspend(plainAdmin.actor, sup.employmentId!));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(e!.userReason).toMatch(/at least as senior/);
    expect(await status(sup.personId)).toBe('active');
    // Control: a super administrator can.
    const sup2 = await w.rawHire('Super Two', 'super_admin', w.storeA);
    await w.suspend(sup2.actor, sup.employmentId!);
    expect(await status(sup.personId)).toBe('suspended');
  });

  it('nobody suspends themself', async () => {
    const w = await world('t612-5d');
    const adminTwo = await w.rawHire('Second Admin', 'admin', w.storeA);
    const e = await refusalOf(w.suspend(adminTwo.actor, adminTwo.employmentId!));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(e!.userReason).toMatch(/own account/);
    expect(await status(adminTwo.personId)).toBe('active');
  });

  it('the last administrator who can sign in cannot be suspended', async () => {
    const w = await world('t612-5e');
    // The bootstrap admin loses its PIN, so `keeper` (an administrator with a PIN) is the one and only administrator who can sign in.
    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'test' where person_id = ${w.boot.personId} and revoked_at is null`;
    const keeper = await w.rawHire('Only Signer', 'admin', w.storeA);
    const other = await w.rawHire('No Pin Admin', 'admin', w.storeA, { pin: false });
    // Mutant: the hasOtherActiveAdminWhoCanSignIn check dropped -> the suspend goes through and this is red.
    const e = await refusalOf(w.suspend(other.actor, keeper.employmentId!));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(e!.userReason).toMatch(/only administrator who can sign in/);
    expect(await status(keeper.personId)).toBe('active');
    // Control: once another administrator can sign in, the same suspend is allowed.
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
              values (${other.personId}, 'pin', ${w.storeA}, ${await hashPin('424242')}, ${pinLookupHash(w.orgId, '424242')})`;
    await w.suspend(other.actor, keeper.employmentId!);
    expect(await status(keeper.personId)).toBe('suspended');
  });

  it('a suspended administrator does not count as "someone else can still get in"', async () => {
    const w = await world('t612-5f');
    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'test' where person_id = ${w.boot.personId} and revoked_at is null`;
    const signer = await w.rawHire('Signer Admin', 'admin', w.storeA);
    const asker = await w.rawHire('Asking Admin', 'admin', w.storeA, { pin: false });
    const other = () => w.asOrg((tx) => accessRepo.hasOtherActiveAdminWhoCanSignIn(tx, w.orgId, asker.personId));
    expect(await other(), 'control: an active administrator with a PIN counts').toBe(true);
    await sql`update persons set account_status = 'suspended' where id = ${signer.personId}`;
    // Mutant: no status filter in otherActiveRoleExists -> the suspended administrator (still holding a PIN) counts and this is red.
    expect(await other()).toBe(false);
  });
});

describe('6 - T-609 keeps the status in step with employment', () => {
  it('ending the LAST job -> ended; re-hire -> pending; ending one of two jobs leaves the status alone', async () => {
    const w = await world('t612-6');
    const one = await w.hireNew(w.storeA, 'Onejob');
    await w.activate(w.boss, one.employmentId);
    await w.end(w.boss, one.employmentId);
    expect(await status(one.personId), 'last job ended').toBe('ended');
    const e = await w.pinAt(one.pin, w.storeA).then(() => undefined, (x: Error) => x);
    expect(e).toBeInstanceOf(AuthenticationError);

    // Mutant: re-hire leaving 'ended' -> this is red.
    await w.asOrg((tx) => createEmployment(tx, w.boss, { storeId: w.storeA, personId: one.personId, employmentStatus: 'regular', startedOn: '2026-07-01' }));
    expect(await status(one.personId), 're-hired').toBe('pending');

    const two = await w.hireNew(w.storeA, 'Twojobs');
    const second = await w.asOrg((tx) => createEmployment(tx, w.boss, { storeId: w.storeB, personId: two.personId, employmentStatus: 'regular', startedOn: '2026-01-01' }));
    await w.activate(w.boss, two.employmentId);
    await w.end(w.boss, second.id);
    expect(await status(two.personId), 'one of two jobs ended').toBe('active');
  });

  it('a suspended person whose last job ends becomes ended (not stuck suspended)', async () => {
    const w = await world('t612-6b');
    const s = await w.hireNew(w.storeA, 'Susthenend');
    await w.activate(w.boss, s.employmentId);
    await w.suspend(w.boss, s.employmentId);
    await w.end(w.boss, s.employmentId);
    expect(await status(s.personId)).toBe('ended');
  });
});

describe('8 - the invariant: status and employment never disagree', () => {
  /** The spec's invariant as SQL: returns the people who break it. */
  const violations = () =>
    sql<{ display_name: string; account_status: string; why: string }[]>`
      select p.display_name, p.account_status,
        case when p.account_status = 'ended' then 'ended but has an open employment' else 'live status without an open employment' end as why
      from persons p
      where p.kind = 'person' and (
        (p.account_status = 'ended' and exists (select 1 from employments e where e.person_id = p.id and e.ended_on is null))
        or (p.account_status in ('active', 'pending', 'suspended')
            and not exists (select 1 from employments e where e.person_id = p.id and e.ended_on is null)
            and not exists (select 1 from person_roles r where r.person_id = p.id and r.revoked_at is null and r.role in ('admin', 'super_admin'))
            and not (exists (select 1 from person_roles r where r.person_id = p.id and r.revoked_at is null and r.role = 'manager')
                     and not exists (select 1 from employments e where e.person_id = p.id)))
      )`;

  it('a seeded mix of every shape (hire, activate, suspend, end, re-hire, two jobs, admin and franchise manager with no job) has no violation', async () => {
    const w = await world('t612-8');
    const active = await w.hireNew(w.storeA, 'Mixactive');
    await w.activate(w.boss, active.employmentId);
    await w.hireNew(w.storeA, 'Mixpending');
    const susp = await w.hireNew(w.storeA, 'Mixsuspended');
    await w.activate(w.boss, susp.employmentId);
    await w.suspend(w.boss, susp.employmentId);
    const gone = await w.hireNew(w.storeA, 'Mixended');
    await w.activate(w.boss, gone.employmentId);
    await w.end(w.boss, gone.employmentId);
    const back = await w.hireNew(w.storeA, 'Mixrehired');
    await w.activate(w.boss, back.employmentId);
    await w.end(w.boss, back.employmentId);
    await w.asOrg((tx) => createEmployment(tx, w.boss, { storeId: w.storeB, personId: back.personId, employmentStatus: 'regular', startedOn: '2026-08-01' }));
    const two = await w.hireNew(w.storeA, 'Mixtwo');
    await w.asOrg((tx) => createEmployment(tx, w.boss, { storeId: w.storeB, personId: two.personId, employmentStatus: 'regular', startedOn: '2026-01-01' }));
    await w.rawHire('Franchise Owner', 'manager', null, { pin: false });
    await w.rawHire('Jobless Admin', 'admin', null, { pin: false });

    expect(await violations()).toEqual([]);
    // The check is not vacuous: break each half by hand and it sees it.
    const p = await w.rawHire('Rogue', null, null, { pin: false });
    expect((await violations()).map((v) => v.why), 'an active person with no job').toEqual(['live status without an open employment']);
    await sql`delete from persons where id = ${p.personId}`;
    await sql`update persons set account_status = 'ended' where id = ${active.personId}`;
    expect((await violations()).map((v) => v.why), 'an ended person with a job').toEqual(['ended but has an open employment']);
  });
});

describe('9 - a racing sign-in and a suspend serialise', () => {
  it('the suspend waits for the in-flight sign-in transaction, then ends the session that sign-in created', async () => {
    const w = await world('t612-9');
    const m = await w.rawHire('Racer', 'manager', w.storeA);
    const credId = (await sql<{ id: string }[]>`select id from person_credentials where person_id = ${m.personId} and kind = 'pin'`)[0]!.id;
    const token = newSessionToken();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let readEligibility!: () => void;
    const read = new Promise<void>((r) => (readEligibility = r));

    // Connection 1: the sign-in. Reads eligibility (taking the person-row lock), pauses, inserts its session, commits.
    const signIn = w.asOrg(async (tx) => {
      const ok = await accessRepo.personMaySignInAtStore(tx, m.personId, w.storeA);
      expect(ok, 'eligible when it read').toBe(true);
      readEligibility();
      await gate;
      await sessionsRepo.insertSession(tx, {
        tokenHash: sessionTokenHash(token),
        personId: m.personId,
        credentialId: credId,
        credentialKind: 'pin',
        storeId: w.storeA,
        deviceId: null,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    });
    const signInSettled = signIn.then(
      () => undefined,
      (e: Error) => e,
    );
    await Promise.race([read, signInSettled.then((e) => { if (e) throw e; })]);

    // Connection 2: the suspend. It must BLOCK on the person row the sign-in holds `for share`.
    let suspended = false;
    const susp = w.suspend(w.boss, m.employmentId!).then(() => {
      suspended = true;
    });
    await new Promise((r) => setTimeout(r, 1500));
    // Mutant: `for share` removed from the persons subquery of personMaySignInAtStore -> the suspend completed while the sign-in was in flight; red.
    expect(suspended, 'the suspend must wait for the in-flight sign-in').toBe(false);

    release();
    expect(await signInSettled).toBeUndefined();
    await susp;

    const rows = await sql<{ ended_at: Date | null; ended_reason: string | null }[]>`select ended_at, ended_reason from sessions where person_id = ${m.personId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at, 'the session the racing sign-in created is ended by the suspend').not.toBeNull();
    expect(rows[0]!.ended_reason).toBe('revoked');
    expect(await status(m.personId)).toBe('suspended');
  }, 30_000);
});

describe('audit 1 - an ENDED employment record cannot be used to change the person account', () => {
  it('a manager at store A cannot suspend or activate through the ended store A record of someone who now works at B', async () => {
    const w = await world('t612-a1');
    const mgrA = await w.rawHire('Manager A', 'manager', w.storeA);
    const p = await w.hireNew(w.storeA, 'Moved');
    const atB = await w.asOrg((tx) => createEmployment(tx, w.boss, { storeId: w.storeB, personId: p.personId, employmentStatus: 'regular', startedOn: '2026-01-01' }));
    await w.activate(w.boss, p.employmentId);
    await w.end(w.boss, p.employmentId); // the store A job ends; the person still works at B
    expect(await status(p.personId), 'control: still active through the B job').toBe('active');
    // Mutant: the endedOn guard removed from changeStatus -> the manager (enrol_staff at A) suspends them and this is red.
    const e = await refusalOf(w.suspend(mgrA.actor, p.employmentId));
    expect(e).toBeInstanceOf(EmploymentError);
    expect(e!.userReason).toMatch(/has ended/);
    expect(await status(p.personId)).toBe('active');
    const e2 = await refusalOf(w.activate(mgrA.actor, p.employmentId));
    expect(e2).toBeInstanceOf(EmploymentError);
    // Control: the current job's record works.
    await w.suspend(w.boss, atB.id);
    expect(await status(p.personId)).toBe('suspended');
  });
});

describe('audit 2b - a hire of a person with no open job always starts pending (administrators excepted)', () => {
  it('a pre-T-609 leaver left active, a suspended person and an ended person come back pending; a person with another open job and an administrator do not', async () => {
    const w = await world('t612-a2');
    const mkRaw = async (name: string, role: 'admin' | null, ended: boolean) => {
      const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, ${name}) returning id`)[0]!.id;
      if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${w.orgId}, ${role})`;
      if (ended) {
        await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
          values (${w.orgId}, ${w.storeB}, ${personId}, ${`SE-${Date.now()}${++seq}`}, 'resigned', '2025-01-01', '2025-06-01')`;
      }
      return personId;
    };
    const hire = (personId: string) => w.asOrg((tx) => createEmployment(tx, w.boss, { storeId: w.storeA, personId, employmentStatus: 'regular', startedOn: '2026-07-01' }));
    const leaver = await mkRaw('Old Leaver', null, true); // status 'active': the migration never ended it
    expect(await status(leaver), 'control: the legacy leaver is active before the hire').toBe('active');
    await hire(leaver);
    // Mutant: the re-hire only handles status 'ended' (the old rule) -> the leaver stays active and this is red.
    expect(await status(leaver), 'leaver').toBe('pending');
    const susp = await mkRaw('Suspended Rehire', null, true);
    await sql`update persons set account_status = 'suspended' where id = ${susp}`;
    await hire(susp);
    expect(await status(susp), 'suspended with no open job').toBe('pending');
    const admin = await mkRaw('Admin Hire', 'admin', false);
    await hire(admin);
    // Mutant: the administrator exception removed -> the administrator is put on hold and this is red.
    expect(await status(admin), 'an administrator is never put on hold by a hire').toBe('active');
    const two = await w.rawHire('Has Job', null, w.storeB);
    await hire(two.personId);
    expect(await status(two.personId), 'a person with another open job keeps their status').toBe('active');
  });
});

describe('audit 5 - readiness counts and the admin fan-out count only ACTIVE accounts', () => {
  it('a pending or suspended employee / manager is not counted; a suspended administrator is not fanned a new store', async () => {
    const w = await world('t612-a5');
    const mgr = await w.rawHire('Store Manager', 'manager', w.storeA);
    const staff = await w.hireNew(w.storeA, 'Pendingstaff');
    const facts = () => w.asOrg((tx) => storeReadinessRepo.storeFacts(tx, w.orgId, w.storeA));
    const names = (xs: { personId: string }[]) => xs.map((x) => x.personId);
    let f = await facts();
    // Mutant: no account_status filter in the employees query -> the pending hire is counted and this is red.
    expect(names(f.employees), 'pending staff is not an employee for readiness').not.toContain(staff.personId);
    expect(names(f.employees)).toContain(mgr.personId);
    expect(names(f.managers)).toContain(mgr.personId);
    await w.suspend(w.boss, mgr.employmentId!);
    f = await facts();
    expect(names(f.employees)).not.toContain(mgr.personId);
    // Mutant: no filter in the managers query -> the suspended manager (role + scope kept) still counts and this is red.
    expect(names(f.managers), 'a suspended manager does not manage the store').not.toContain(mgr.personId);

    const admin = await w.rawHire('Second Admin', 'admin', w.storeA, { pin: false });
    expect(await w.asOrg((tx) => accessRepo.activeAdminPersonIds(tx, w.orgId))).toContain(admin.personId);
    await sql`update persons set account_status = 'suspended' where id = ${admin.personId}`;
    // Mutant: no status join in activeAdminPersonIds -> the suspended administrator is still fanned and this is red.
    expect(await w.asOrg((tx) => accessRepo.activeAdminPersonIds(tx, w.orgId))).not.toContain(admin.personId);
  });
});
