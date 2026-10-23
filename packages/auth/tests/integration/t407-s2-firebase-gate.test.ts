import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-407 S2 (DEF-649, email door) - docs/tasks/407-def649-ended-employment-signin.md: R1, R3, Invariants 4-10.
 *
 * ## What is judged
 * Fixtures are committed as the OWNER over a plain postgres.js connection and every read is the owner's, so a count is
 * what COMMITTED (refusal events are written by the outbox after the caller returns: drain it with `flushSecurityEvents`).
 * Each fixture has its own org, so a count by (org, action) is isolated.
 *
 * ## Who may sign in to an org (R1), restated so a reader of this file does not need the spec
 *   (a) an OPEN employment (ended_on is null) at ANY store of the org, or
 *   (b) an active admin / super_admin role, or
 *   (c) an active manager role AND no employment row EVER in the org (the franchise owner).
 * Anyone else is refused: an ended person with NO_ACCESS, staff with no employment likewise.
 *
 * ## Spec problem reported, not worked around (Invariant 10)
 * The spec's "another org's open employment does not admit the person to this org" cannot be built end to end:
 * migration 0194's same-org foreign keys make an `employments` row for a person of another org unrepresentable. The
 * only observable leg is the repo function itself asked about the WRONG org, which is what the repo-level test below
 * does (mutant: the `org_id` filter dropped makes it answer true).
 *
 * ## State at HEAD
 * Red: Invariants 4, 6 (second half), 8, 9 (revoked leg), and the whole `personMaySignInToOrg` truth table (the function
 * does not exist yet). Green controls (already pass, and guard the mutants): 5, 6 (first half), 7, an employed staff
 * person, an unknown uid. Mutants named per invariant in the comments.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, withOrgPrincipal, authTransaction, accessRepo } from '@shareat/db';
import { logger } from '@shareat/core/logger';
import { AuthenticationError, flushSecurityEvents, signInWithFirebase } from '@shareat/auth';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** The sentences, written out in full: the test must not import the constant it is judging. */
const NO_ACCESS = 'Sign-in failed: this account no longer has access. Ask an admin if this is wrong.';
const PIN_ONLY = 'Sign-in failed: staff sign in with their PIN. Ask an admin if this is wrong.';
const NOT_LINKED = 'Sign-in failed: this account is not linked to a person in this system.';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Role = 'super_admin' | 'admin' | 'manager' | 'staff';

async function fixture(hint: string) {
  const code = uid(`t407s2-${hint}`);
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`)[0]!.id;
  const storeA = await mkStore(`${hint}-A`);
  const storeB = await mkStore(`${hint}-B`);
  /** A person with a linked Firebase credential and (optionally) an active role. */
  const person = async (name: string, role: Role | null) => {
    const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    const externalId = uid('fbuid');
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${personId}, 'firebase', null, ${externalId})`;
    return { personId, externalId };
  };
  /** open employment when `endedOn` is omitted, else an ended one. */
  const employ = async (personId: string, storeId: string, startedOn: string, endedOn?: string) => {
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
      values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, ${endedOn ? 'terminated' : 'regular'}, ${startedOn}, ${endedOn ?? null})`;
  };
  return { orgId, storeA, storeB, person, employ };
}

const refusals = async (orgId: string) => {
  await flushSecurityEvents();
  return sql<{ entity_id: string; actor_person_id: string | null; after: { personId?: string; reason?: string } }[]>`
    select entity_id, actor_person_id, after from audit_log where org_id = ${orgId} and action = 'auth.signin_refused' order by recorded_at, id`;
};
const sessionCount = async (personId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sessions where person_id = ${personId}`)[0]!.n;

const refused = async (uidv: string): Promise<Error> => {
  try {
    await signInWithFirebase(null, { verifiedUid: uidv });
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the sign-in to be refused, but it succeeded');
};

describe('Invariant 4 - an ended person is refused, with a refusal event', () => {
  it('manager whose only employment ended: AuthenticationError(NO_ACCESS), no session row, one auth.signin_refused reason employment_ended', async () => {
    const f = await fixture('ended');
    const p = await f.person('Ex Manager', 'manager');
    await f.employ(p.personId, f.storeA, '2026-01-01', '2026-03-01');

    const e = await refused(p.externalId);
    expect(e, 'mutant: R1 check removed - the sign-in succeeds').toBeInstanceOf(AuthenticationError);
    expect(e.message).toBe(NO_ACCESS);
    expect(await sessionCount(p.personId), 'no session row').toBe(0);

    const rows = await refusals(f.orgId);
    expect(rows, 'one refusal event').toHaveLength(1);
    expect(rows[0]!.after.reason).toBe('employment_ended');
    expect(rows[0]!.after.personId).toBe(p.personId);
    expect(rows[0]!.entity_id).toBe(p.personId);
    expect(rows[0]!.actor_person_id, 'nobody signed in: null actor').toBeNull();
  });

  it('the same refusal inside a caller transaction that rolls back still commits its event (outbox), and still creates no session', async () => {
    const f = await fixture('ended-tx');
    const p = await f.person('Ex Manager', 'manager');
    await f.employ(p.personId, f.storeA, '2026-01-01', '2026-03-01');

    await expect(
      withOrgPrincipal(f.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: p.externalId })),
    ).rejects.toMatchObject({ message: NO_ACCESS });
    const rows = await refusals(f.orgId);
    expect(rows, 'mutant: the event written inside the caller transaction vanishes on rollback').toHaveLength(1);
    expect(rows[0]!.after.reason).toBe('employment_ended');
    expect(await sessionCount(p.personId)).toBe(0);
  });
});

describe('Invariant 5 - admin and super_admin need no employment (leg b)', () => {
  it.each(['admin', 'super_admin'] as const)('%s with no employment signs in', async (role) => {
    const f = await fixture(`leg-b-${role}`);
    const p = await f.person(role, role);
    const r = await signInWithFirebase(null, { verifiedUid: p.externalId });
    expect(r.personId, 'mutant: leg (b) dropped').toBe(p.personId);
    expect(await sessionCount(p.personId)).toBe(1);
    expect(await refusals(f.orgId)).toHaveLength(0);
  });
});

describe('Invariant 6 - the franchise owner (leg c): a manager who was never employed', () => {
  it('never-employed manager signs in', async () => {
    const f = await fixture('owner');
    const p = await f.person('Owner', 'manager');
    const r = await signInWithFirebase(null, { verifiedUid: p.externalId });
    expect(r.personId, 'mutant: leg (c) dropped').toBe(p.personId);
  });

  it('the same manager, once an employment has been opened AND ended, is refused', async () => {
    const f = await fixture('owner-then-ended');
    const p = await f.person('Owner', 'manager');
    await signInWithFirebase(null, { verifiedUid: p.externalId }); // fine while never employed
    await f.employ(p.personId, f.storeA, '2026-02-01', '2026-02-15');
    const e = await refused(p.externalId);
    expect(e.message, 'mutant: leg (c) without the "never employed" clause - an ex-employee manager walks in').toBe(NO_ACCESS);
    const rows = await refusals(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after.reason).toBe('employment_ended');
  });

  it('control: an open employment re-admits the same manager', async () => {
    const f = await fixture('owner-rehired');
    const p = await f.person('Owner', 'manager');
    await f.employ(p.personId, f.storeA, '2026-02-01', '2026-02-15');
    await f.employ(p.personId, f.storeA, '2026-04-01');
    expect((await signInWithFirebase(null, { verifiedUid: p.externalId })).personId).toBe(p.personId);
  });
});

describe('Invariant 7 - employed at B, ended at A: any open employment admits (leg a)', () => {
  it('signs in; the MOST RECENT employment (A, started later) is the ended one', async () => {
    const f = await fixture('two-stores');
    const p = await f.person('Floater', 'manager');
    await f.employ(p.personId, f.storeB, '2026-01-01'); // open at B, the OLDER row
    await f.employ(p.personId, f.storeA, '2026-02-01', '2026-03-01'); // ended at A, the NEWER row
    const r = await signInWithFirebase(null, { verifiedUid: p.externalId });
    expect(r.personId, 'mutant: R1 reads only the most recent employment').toBe(p.personId);
  });

  it('control: an employed manager with a plain open employment signs in', async () => {
    const f = await fixture('mgr-ok');
    const p = await f.person('Supervisor', 'manager');
    await f.employ(p.personId, f.storeA, '2026-01-01');
    expect((await signInWithFirebase(null, { verifiedUid: p.externalId })).personId).toBe(p.personId);
  });

  // T-438 S1 (bible row 361): was "an employed staff person signs in by email"; staff are PIN-only now.
  it('an employed staff person with a plain open employment is refused by email: PIN_ONLY (reason pin_only_role)', async () => {
    const f = await fixture('staff-pin-only');
    const p = await f.person('Cashier', 'staff');
    await f.employ(p.personId, f.storeA, '2026-01-01');
    const e = await refused(p.externalId);
    expect(e.message).toBe(PIN_ONLY);
    expect(await sessionCount(p.personId)).toBe(0);
    expect((await refusals(f.orgId))[0]?.after.reason).toBe('pin_only_role');
  });
});

describe('Invariant 8 - staff with no employment ever is refused', () => {
  it('staff role, never employed: refused with NO_ACCESS and an employment_ended event', async () => {
    const f = await fixture('staff-never');
    const p = await f.person('Nobody', 'staff');
    const e = await refused(p.externalId);
    expect(e.message, 'mutant: leg (c) accepts any role').toBe(NO_ACCESS);
    expect(await sessionCount(p.personId)).toBe(0);
    expect((await refusals(f.orgId))[0]?.after.reason).toBe('employment_ended');
  });

  it('a person with no role at all and no employment is refused too', async () => {
    const f = await fixture('norole');
    const p = await f.person('Roleless', null);
    expect((await refused(p.externalId)).message).toBe(NO_ACCESS);
  });
});

describe('Invariant 9 - a revoked credential is refused as NOT_LINKED and logged as credential_revoked', () => {
  it('revoked credential: NOT_LINKED, one auth.signin_refused reason credential_revoked under the right org; an unknown uid still writes none', async () => {
    const f = await fixture('revoked');
    const other = await fixture('revoked-other-org'); // an unrelated org must receive nothing
    const p = await f.person('Unlinked', 'admin');
    await sql`
      update person_credentials set revoked_at = now(), revoke_reason = 'unlinked by an admin' where person_id = ${p.personId}`;

    const e = await refused(p.externalId);
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(e.message).toBe(NOT_LINKED);
    const rows = await refusals(f.orgId);
    expect(rows, 'mutant: revoked lookup skipped - no event').toHaveLength(1);
    expect(rows[0]!.after.reason).toBe('credential_revoked');
    expect(rows[0]!.after.personId).toBe(p.personId);
    expect(rows[0]!.actor_person_id).toBeNull();
    expect(await refusals(other.orgId), 'the event is filed under the person\'s org only').toHaveLength(0);
    expect(await sessionCount(p.personId)).toBe(0);

    // an identifier that belongs to no account at all: still no row, one logger line
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'auth.signin_refused'`)[0]!.n;
    const spies = (['info', 'warn', 'error'] as const).map((l) => vi.spyOn(logger, l));
    try {
      expect((await refused(uid('nobody'))).message).toBe(NOT_LINKED);
      const lines = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).filter((l) => l.includes('signin.unknown_identifier'));
      expect(lines, 'unknown uid: one logger line').toHaveLength(1);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    await flushSecurityEvents();
    const after = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'auth.signin_refused'`)[0]!.n;
    expect(after, 'unknown uid writes no audit row').toBe(before);
  });

  it('when a uid was revoked and later re-linked to a live credential, the LIVE one signs in and nothing is refused', async () => {
    const f = await fixture('relinked');
    const p = await f.person('Relinked', 'admin');
    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'old link' where person_id = ${p.personId}`;
    const fresh = uid('fbuid-new');
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${p.personId}, 'firebase', null, ${fresh})`;
    expect((await signInWithFirebase(null, { verifiedUid: fresh })).personId).toBe(p.personId);
    expect(await refusals(f.orgId)).toHaveLength(0);
  });
});

describe('Invariant 10 - accessRepo.personMaySignInToOrg: the truth table, and the org boundary', () => {
  // Through the AUTH DOOR (no org principal), exactly where the sign-in gate runs it: with no RLS to mask a wrong-org
  // read, only the function's own explicit org_id filters can keep org X's rows out of an answer about org Y.
  const ask = (_orgId: string, personId: string, asOrg: string = _orgId) =>
    authTransaction((tx) => accessRepo.personMaySignInToOrg(tx, personId, asOrg));

  it('answers R1 for every leg, including the near-misses', async () => {
    const f = await fixture('truth');
    const open = await f.person('open', 'staff');
    await f.employ(open.personId, f.storeA, '2026-01-01');
    const ended = await f.person('ended', 'staff');
    await f.employ(ended.personId, f.storeA, '2026-01-01', '2026-02-01');
    const admin = await f.person('admin', 'admin');
    const superAdmin = await f.person('super', 'super_admin');
    const ownerMgr = await f.person('owner', 'manager');
    const exMgr = await f.person('exmgr', 'manager');
    await f.employ(exMgr.personId, f.storeB, '2026-01-01', '2026-02-01');
    const staffNever = await f.person('staffnever', 'staff');
    const roleless = await f.person('roleless', null);
    const revokedAdmin = await f.person('revokedadmin', 'admin');
    await sql`update person_roles set revoked_at = now() where person_id = ${revokedAdmin.personId}`;

    expect(await ask(f.orgId, open.personId), 'leg a').toBe(true);
    expect(await ask(f.orgId, ended.personId), 'ended staff').toBe(false);
    expect(await ask(f.orgId, admin.personId), 'leg b admin').toBe(true);
    expect(await ask(f.orgId, superAdmin.personId), 'leg b super_admin').toBe(true);
    expect(await ask(f.orgId, ownerMgr.personId), 'leg c never-employed manager').toBe(true);
    expect(await ask(f.orgId, exMgr.personId), 'ended manager').toBe(false);
    expect(await ask(f.orgId, staffNever.personId), 'staff, never employed').toBe(false);
    expect(await ask(f.orgId, roleless.personId), 'no role, no employment').toBe(false);
    expect(await ask(f.orgId, revokedAdmin.personId), 'a REVOKED admin role does not count').toBe(false);
  });

  it('the org boundary: a person of org X is never admitted to org Y by X\'s employment or X\'s admin role', async () => {
    const x = await fixture('org-x');
    const y = await fixture('org-y');
    const worker = await x.person('worker', 'staff');
    await x.employ(worker.personId, x.storeA, '2026-01-01');
    const adminX = await x.person('adminx', 'admin');
    expect(await ask(x.orgId, worker.personId), 'control: admitted to their own org').toBe(true);
    expect(await ask(x.orgId, worker.personId, y.orgId), 'mutant: org_id filter dropped from the employment leg').toBe(false);
    expect(await ask(x.orgId, adminX.personId, y.orgId), 'mutant: org_id filter dropped from the role leg').toBe(false);
  });
});

describe('Q2 - an employment whose ended_on is in the FUTURE counts as ended (open means ended_on is null)', () => {
  it('manager whose only employment ends TOMORROW is refused at the Firebase door with NO_ACCESS and no session', async () => {
    const f = await fixture('future-end');
    const p = await f.person('Leaving Manager', 'manager');
    const tomorrow = (await sql<{ d: string }[]>`select (current_date + 1)::text as d`)[0]!.d;
    await f.employ(p.personId, f.storeA, '2026-01-01', tomorrow);
    const e = await refused(p.externalId);
    expect(e, 'mutant: `ended_on <= current_date` - a future end date still counts as open and the sign-in succeeds').toBeInstanceOf(AuthenticationError);
    expect(e.message).toBe(NO_ACCESS);
    expect(await sessionCount(p.personId)).toBe(0);
  });
});
