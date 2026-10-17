import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-438 S1 - docs/tasks/438-hire-name-parts-and-staff-pin-only.md, N8 and cases A1-A7.
 * Rule: email (Firebase) sign-in needs an ACTIVE manager / admin / super_admin role in the org, checked AFTER the existing
 * `personMaySignInToOrg` gate. Staff / no role is PIN-only. The rule must NOT live in `personMaySignInToOrg` (PIN paths use it).
 *
 * Fixtures are committed as the owner over plain postgres.js; refusal events are drained with `flushSecurityEvents`.
 * Runs on any `_test` database (no lane DB name).
 *
 * Mutants (one-line edits in packages/auth/src/sessions.ts / packages/db/src/repo/access.ts):
 *   A1 check missing, or placed after `issue`            A2 `role <> staff` (no-role slips through)
 *   A3 role list too narrow                              A4 `revoked_at is null` dropped
 *   A5 `org_id` filter dropped                           A6 rule folded into personMaySignInToOrg
 *   A7 new check placed before the employment check
 * State at HEAD (before S1 is built): A1, A2, A4, A5 red; A3, A6, A7 green controls (the rule does not exist yet).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { accessRepo, authTransaction, closeDb } from '@shareat/db';
import { AuthenticationError, flushSecurityEvents, hashPin, pinLookupHash, signInWithFirebase, signInWithPin, verifyAdminApproval } from '@shareat/auth';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;
const nextPin = () => String(300000 + ++pinSeq * 17);

/** Written out in full: the test must not import the constants it judges. */
const PIN_ONLY = 'Sign-in failed: staff sign in with their PIN. Ask an admin if this is wrong.';
const NO_ACCESS = 'Sign-in failed: this account no longer has access. Ask an admin if this is wrong.';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Role = 'super_admin' | 'admin' | 'manager' | 'staff';

async function fixture(hint: string) {
  const code = uid(`t438-${hint}`);
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const storeId = (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`)[0]!.id;
  /** A person with a linked Firebase credential, an optional role, an optional PIN, and (default) an open employment. */
  const person = async (name: string, role: Role | null, opts: { employed?: boolean; pin?: boolean } = {}) => {
    const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    const externalId = uid('fbuid');
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${personId}, 'firebase', null, ${externalId})`;
    if (opts.employed !== false) {
      await sql`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${orgId}, ${storeId}, ${personId}, ${uid('SC')}, 'regular', '2026-01-01')`;
    }
    await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, 'manual')`;
    let pin: string | null = null;
    if (opts.pin) {
      pin = nextPin();
      await sql`
        insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
        values (${personId}, 'pin', ${storeId}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    }
    return { personId, externalId, pin };
  };
  return { orgId, storeId, person };
}

const refusals = async (orgId: string) => {
  await flushSecurityEvents();
  return sql<{ after: { personId?: string; reason?: string } }[]>`
    select after from audit_log where org_id = ${orgId} and action = 'auth.signin_refused' order by recorded_at, id`;
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

describe('A1 staff role + open employment + linked Firebase credential is refused by email', () => {
  it('throws the N8 sentence, creates no session, files one refusal event reason pin_only_role', async () => {
    const f = await fixture('a1');
    const p = await f.person('Staffer', 'staff');
    const e = await refused(p.externalId);
    expect(e, 'mutant: check missing - the sign-in succeeds').toBeInstanceOf(AuthenticationError);
    expect(e.message).toBe(PIN_ONLY);
    expect(await sessionCount(p.personId), 'mutant: check placed after issue').toBe(0);
    const rows = await refusals(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after.reason).toBe('pin_only_role');
    expect(rows[0]!.after.personId).toBe(p.personId);
  });
});

describe('A2 an open employment and NO role is refused the same way', () => {
  it('no person_roles row -> PIN_ONLY, reason pin_only_role', async () => {
    const f = await fixture('a2');
    const p = await f.person('Roleless', null);
    const e = await refused(p.externalId);
    expect(e.message, 'mutant: written as role <> staff').toBe(PIN_ONLY);
    expect(await sessionCount(p.personId)).toBe(0);
    expect((await refusals(f.orgId))[0]?.after.reason).toBe('pin_only_role');
  });
});

describe('A3 manager, admin and super_admin (each) are issued a session', () => {
  it.each(['manager', 'admin', 'super_admin'] as const)('%s signs in', async (role) => {
    const f = await fixture(`a3-${role}`);
    const p = await f.person(role, role);
    const r = await signInWithFirebase(null, { verifiedUid: p.externalId });
    expect(r.personId, 'mutant: role list too narrow').toBe(p.personId);
    expect(await sessionCount(p.personId)).toBe(1);
    expect(await refusals(f.orgId)).toHaveLength(0);
  });
});

describe('A4 a REVOKED manager role, re-granted as staff, is refused', () => {
  it('only the active (staff) role counts', async () => {
    const f = await fixture('a4');
    const p = await f.person('Demoted', 'manager');
    await sql`update person_roles set revoked_at = now() where person_id = ${p.personId} and role = 'manager'`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p.personId}, ${f.orgId}, 'staff')`;
    const e = await refused(p.externalId);
    expect(e.message, 'mutant: revoked_at is null missing').toBe(PIN_ONLY);
    expect(await sessionCount(p.personId)).toBe(0);
  });
});

describe('A5 a manager role in ANOTHER org only does not admit email sign-in here', () => {
  it('the repo read is org-scoped, and a staff person here is refused', async () => {
    const f = await fixture('a5');
    const other = await fixture('a5-other');
    const p = await f.person('Staff here', 'staff');
    // A person cannot hold a role row of another org (same-org FKs), so the cross-org leg is the repo read asked about the wrong org.
    const otherMgr = await other.person('Mgr there', 'manager');
    const fn = (accessRepo as Record<string, unknown>).personMayUseEmailSignIn as
      | ((tx: unknown, personId: string, orgId: string) => Promise<boolean>)
      | undefined;
    if (typeof fn !== 'function') throw new Error('MISSING: accessRepo.personMayUseEmailSignIn (T-438 S1 not built)');
    expect(await authTransaction((tx) => fn(tx, otherMgr.personId, other.orgId)), 'control: true in own org').toBe(true);
    expect(await authTransaction((tx) => fn(tx, otherMgr.personId, f.orgId)), 'mutant: org_id filter dropped').toBe(false);
    expect((await refused(p.externalId)).message).toBe(PIN_ONLY);
  });
});

describe('A6 the same staff person still signs in with their PIN; a manager PIN approval still works', () => {
  it('PIN sign-in succeeds (mutant: rule folded into personMaySignInToOrg)', async () => {
    const f = await fixture('a6');
    const p = await f.person('Staffer', 'staff', { pin: true });
    expect((await refused(p.externalId)).message).toBe(PIN_ONLY);
    const r = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: p.pin! });
    expect(r.personId).toBe(p.personId);
  });

  it('a manager PIN approves an action for a staff actor (adminless org, void_expense)', async () => {
    const f = await fixture('a6b');
    const staff = await f.person('Staffer', 'staff', { pin: true });
    const mgr = await f.person('Manager', 'manager', { pin: true });
    const r = await verifyAdminApproval(null, {
      actor: { personId: staff.personId, orgId: f.orgId },
      storeId: f.storeId,
      pin: mgr.pin!,
      capability: 'void_expense',
    });
    expect(r.approverPersonId, 'mutant: rule folded into personMaySignInToOrg').toBe(mgr.personId);
  });
});

describe('A7 an ended-employment staff person still gets NO_ACCESS, not the new sentence', () => {
  it('employment check runs first', async () => {
    const f = await fixture('a7');
    const p = await f.person('Ex Staff', 'staff', { employed: false });
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
      values (${f.orgId}, ${f.storeId}, ${p.personId}, ${uid('SC')}, 'terminated', '2026-01-01', '2026-03-01')`;
    const e = await refused(p.externalId);
    expect(e.message, 'mutant: new check before the employment check').toBe(NO_ACCESS);
    expect((await refusals(f.orgId))[0]?.after.reason).toBe('employment_ended');
  });
});
