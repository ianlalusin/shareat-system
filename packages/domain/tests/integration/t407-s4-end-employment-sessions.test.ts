import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-407 S4 (DEF-649, live sessions) - docs/tasks/407-def649-ended-employment-signin.md: R4, R6, R7, Invariants 15-20.
 * `endEmployment` ends the person's sessions IN ITS OWN TRANSACTION, by derived eligibility, never by a flag.
 *
 * ## What is judged
 * Fixtures are committed as the OWNER over a plain postgres.js connection; reads are the owner's, so a count is what
 * COMMITTED. `endEmployment` runs under the real org principal (`withOrgPrincipal`, the restricted harness role). Sessions
 * are made by the REAL sign-in functions, so each fixture session is one a person could really hold.
 *
 * ## Spec reading, flagged
 * R4 gives the event `entity = the person` and `after = { reason: 'employment_ended', employmentId, storeId, ended }`,
 * `actor = the manager`; this file asserts exactly that.
 *
 * ## State at HEAD
 * Red: 15 (both tests), 16, 18 (both: nothing is ended, so nothing fails), 19 (`personMaySignInToOrg` does not exist).
 * Green controls that guard their mutants: 17 (nothing ends) and 20 (leg b). Mutants per invariant in the comments.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

// Failure switches for Invariant 18: the session UPDATE, or the session.ended_all audit append, can be forced to fail.
const ctl = vi.hoisted(() => ({
  failSessionUpdate: false,
  failEndedAllAudit: false,
  // Invariant 21: when set, `personMaySignInToOrg` waits (up to barrierMs) until `barrierSize` callers have arrived.
  barrierSize: 0,
  barrierMs: 4000,
  arrived: 0,
}));
vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...real,
    sessionsRepo: {
      ...real.sessionsRepo,
      endAllForPerson: (...a: Parameters<typeof real.sessionsRepo.endAllForPerson>) =>
        ctl.failSessionUpdate ? Promise.reject(new Error('forced session update failure')) : real.sessionsRepo.endAllForPerson(...a),
    },
    accessRepo: {
      ...real.accessRepo,
      personMaySignInToOrg: async (...a: Parameters<typeof real.accessRepo.personMaySignInToOrg>) => {
        if (ctl.barrierSize > 0) {
          ctl.arrived += 1;
          const t0 = Date.now();
          while (ctl.arrived < ctl.barrierSize && Date.now() - t0 < ctl.barrierMs) await new Promise((r) => setTimeout(r, 20));
        }
        return real.accessRepo.personMaySignInToOrg(...a);
      },
    },
    auditLogRepo: {
      ...real.auditLogRepo,
      append: (tx: never, orgId: string, input: { action: string }) =>
        ctl.failEndedAllAudit && input.action === 'session.ended_all'
          ? Promise.reject(new Error('forced audit append failure'))
          : (real.auditLogRepo.append as (t: never, o: string, i: unknown) => Promise<unknown>)(tx, orgId, input),
    },
  };
});

import { closeDb, withOrgPrincipal, accessRepo, sessionsRepo } from '@shareat/db';
import {
  AuthenticationError,
  flushSecurityEvents,
  hashPin,
  pinLookupHash,
  resolveActor,
  signInWithFirebase,
  signInWithPin,
  sessionTokenHash,
  newSessionToken,
  type Actor,
} from '@shareat/auth';
import { endEmployment } from '@shareat/domain';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Role = 'super_admin' | 'admin' | 'manager' | 'staff';

async function fixture(hint: string) {
  const code = uid(`t407s4-${hint}`);
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`)[0]!.id;
  const storeA = await mkStore(`${hint}-A`);
  const storeB = await mkStore(`${hint}-B`);
  const scope = (personId: string, storeId: string, source: 'manual' | 'fan_out' | 'employment') =>
    sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, ${source})`;
  /** A person with a Firebase credential AND a PIN. */
  const person = async (name: string, role: Role | null) => {
    const personId = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    const externalId = uid('fbuid');
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${personId}, 'firebase', null, ${externalId})`;
    const pin = String(850100 + ++pinSeq);
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${personId}, 'pin', ${storeA}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { personId, externalId, pin };
  };
  /** An open employment, plus the employment-sourced scope row a real hire writes. */
  const hire = async (personId: string, storeId: string) => {
    const id = (await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2026-01-01') returning id`)[0]!.id;
    // A manual/fan_out row already there wins (T-336): the employment-sourced row is only written when none exists.
    await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, 'employment') on conflict do nothing`;
    return id;
  };
  const boss = await person('Boss', 'admin');
  await scope(boss.personId, storeA, 'fan_out');
  await scope(boss.personId, storeB, 'fan_out');
  const bossActor: Actor = { personId: boss.personId, orgId };
  const end = (actor: Actor, employmentId: string) =>
    withOrgPrincipal(orgId, (tx) => endEmployment(tx, actor, { employmentId, endedOn: '2026-06-01', employmentStatus: 'terminated' }));
  const pinSession = (p: { pin: string }, storeId: string) => signInWithPin(null, { orgId, storeId, pin: p.pin });
  const browserSession = (p: { externalId: string }) => signInWithFirebase(null, { verifiedUid: p.externalId });
  return { orgId, storeA, storeB, scope, person, hire, boss, bossActor, end, pinSession, browserSession };
}

const live = async (personId: string, storeId?: string | null) =>
  (await sql<{ n: number }[]>`
    select count(*)::int as n from sessions
     where person_id = ${personId} and ended_at is null
       ${storeId === undefined ? sql`` : storeId === null ? sql`and store_id is null` : sql`and store_id = ${storeId}`}`)[0]!.n;
const endedAll = async (orgId: string) => {
  await flushSecurityEvents();
  return sql<{ actor_person_id: string | null; entity_id: string; store_id: string | null; after: Record<string, unknown> }[]>`
    select actor_person_id, entity_id, store_id, after from audit_log where org_id = ${orgId} and action = 'session.ended_all' order by recorded_at, id`;
};
const employmentOpen = async (id: string) =>
  (await sql<{ ended_on: string | null }[]>`select ended_on from employments where id = ${id}`)[0]!.ended_on === null;
const rejectsResolve = (token: string) => expect(resolveActor(null, token)).rejects.toBeInstanceOf(AuthenticationError);

describe('Invariant 15 - ending a manager\'s only employment ends every session they hold', () => {
  it('browser session and PIN sessions at both stores end; one session.ended_all (employment_ended, storeId null); the next request fails resolveActor', async () => {
    const f = await fixture('inv15');
    const m = await f.person('Manager', 'manager');
    const empId = await f.hire(m.personId, f.storeA);
    await f.scope(m.personId, f.storeB, 'manual'); // a PIN session at B too
    const browser = await f.browserSession(m);
    const pinA = await f.pinSession(m, f.storeA);
    const pinB = await f.pinSession(m, f.storeB);
    expect(await live(m.personId)).toBe(3);
    await expect(resolveActor(null, browser.token)).resolves.toMatchObject({ actor: { personId: m.personId } });

    await f.end(f.bossActor, empId);

    expect(await live(m.personId), 'mutant: no endAllForPerson call').toBe(0);
    const rows = await endedAll(f.orgId);
    expect(rows, 'one event for the whole call').toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(m.personId);
    expect(rows[0]!.actor_person_id, 'actor = the manager who ended it').toBe(f.boss.personId);
    expect(rows[0]!.after).toMatchObject({ reason: 'employment_ended', employmentId: empId, storeId: null, ended: 3 });
    await rejectsResolve(browser.token);
    await rejectsResolve(pinA.token);
    await rejectsResolve(pinB.token);
    const reasons = await sql<{ ended_reason: string }[]>`select distinct ended_reason from sessions where person_id = ${m.personId}`;
    expect(reasons.map((r) => r.ended_reason), 'R10: the existing reason `revoked`, no new end reason').toEqual(['revoked']);
  });

  it('control: another person\'s sessions are untouched', async () => {
    const f = await fixture('inv15-other');
    const m = await f.person('Manager', 'manager');
    const empId = await f.hire(m.personId, f.storeA);
    await f.browserSession(m);
    await f.browserSession(f.boss);
    await f.end(f.bossActor, empId);
    expect(await live(m.personId)).toBe(0);
    expect(await live(f.boss.personId), 'the boss keeps their session').toBe(1);
  });
});

// T-438: email sign-in needs a manager/admin role (staff are PIN-only), so the browser-session fixtures below use manager.
describe('Invariant 16 - ended at A, still open at B (R6)', () => {
  it('browser session and the PIN session at B survive; the PIN session at A ends; the event carries storeId A', async () => {
    const f = await fixture('inv16');
    const s = await f.person('Floater', 'manager');
    const empA = await f.hire(s.personId, f.storeA);
    await f.hire(s.personId, f.storeB);
    const browser = await f.browserSession(s);
    const pinA = await f.pinSession(s, f.storeA);
    const pinB = await f.pinSession(s, f.storeB);

    await f.end(f.bossActor, empA);

    expect(await live(s.personId, f.storeA), 'PIN at A ends').toBe(0);
    expect(await live(s.personId, f.storeB), 'PIN at B survives (mutant: always end everything)').toBe(1);
    expect(await live(s.personId, null), 'browser session survives (still employed at B)').toBe(1);
    await expect(resolveActor(null, browser.token)).resolves.toBeDefined();
    await expect(resolveActor(null, pinB.token)).resolves.toBeDefined();
    await rejectsResolve(pinA.token);

    const rows = await endedAll(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_id).toBe(s.personId);
    expect(rows[0]!.after).toMatchObject({ reason: 'employment_ended', employmentId: empA, storeId: f.storeA, ended: 1 });
  });
});

describe('Invariant 17 - ended at A but keeps manual scope at A and is open at B: nothing ends', () => {
  it('no session ends and no session.ended_all event is written (mutant: end at A unconditionally)', async () => {
    const f = await fixture('inv17');
    const s = await f.person('Keeper', 'manager');
    await f.scope(s.personId, f.storeA, 'manual'); // a deliberate manual grant: survives the end (T-336)
    const empA = await f.hire(s.personId, f.storeA);
    await f.hire(s.personId, f.storeB);
    const browser = await f.browserSession(s);
    const pinA = await f.pinSession(s, f.storeA);
    const pinB = await f.pinSession(s, f.storeB);
    expect(await live(s.personId)).toBe(3);

    await f.end(f.bossActor, empA);

    expect(await live(s.personId), 'all three still live').toBe(3);
    await expect(resolveActor(null, pinA.token)).resolves.toBeDefined();
    await expect(resolveActor(null, pinB.token)).resolves.toBeDefined();
    await expect(resolveActor(null, browser.token)).resolves.toBeDefined();
    expect(await endedAll(f.orgId), 'no event when nothing ended').toHaveLength(0);
  });
});

describe('Invariant 18 - a failure ending the sessions refuses the whole termination', () => {
  it.each([
    ['the session UPDATE fails', 'failSessionUpdate'],
    ['the session.ended_all audit append fails', 'failEndedAllAudit'],
  ] as const)('%s: endEmployment rejects, the employment stays open, every session stays live, no employment.ended row', async (_label, flag) => {
    const f = await fixture(`inv18-${flag}`);
    const m = await f.person('Manager', 'manager');
    const empId = await f.hire(m.personId, f.storeA);
    await f.browserSession(m);
    await f.pinSession(m, f.storeA);

    ctl[flag] = true;
    try {
      await expect(f.end(f.bossActor, empId), 'mutant: sessions ended in a separate transaction / skipped on failure').rejects.toThrow();
    } finally {
      ctl[flag] = false;
    }
    expect(await employmentOpen(empId), 'the employment end rolled back').toBe(true);
    expect(await live(m.personId), 'both sessions still live').toBe(2);
    await flushSecurityEvents();
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${f.orgId} and action in ('employment.ended', 'session.ended_all')`)[0]!.n;
    expect(n).toBe(0);
  });
});

describe('Invariant 19 - the race: a sign-in that read "eligible" cannot slip past the termination (R7, for share)', () => {
  it('endEmployment waits for the in-flight sign-in transaction, then ends the session that sign-in created', async () => {
    const f = await fixture('inv19');
    const m = await f.person('Manager', 'manager');
    const empId = await f.hire(m.personId, f.storeA);
    const credId = (await sql<{ id: string }[]>`select id from person_credentials where person_id = ${m.personId} and kind = 'firebase'`)[0]!.id;
    const token = newSessionToken();

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let readEligibility!: () => void;
    const read = new Promise<void>((r) => (readEligibility = r));

    // Connection 1: the sign-in. Reads eligibility (taking the row lock), pauses, inserts its session, commits.
    const signIn = withOrgPrincipal(f.orgId, async (tx) => {
      const ok = await accessRepo.personMaySignInToOrg(tx, m.personId, f.orgId);
      expect(ok, 'eligible when it read').toBe(true);
      readEligibility();
      await gate;
      await sessionsRepo.insertSession(tx, {
        tokenHash: sessionTokenHash(token),
        personId: m.personId,
        credentialId: credId,
        credentialKind: 'firebase',
        storeId: null,
        deviceId: null,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    });
    const signInSettled = signIn.then(
      () => undefined,
      (e: Error) => e,
    );
    // If the sign-in failed before reaching the pause (the function missing at HEAD), surface THAT as the failure.
    await Promise.race([read, signInSettled.then((e) => { if (e) throw e; })]);

    // Connection 2: the termination. It must BLOCK on the employment row the sign-in holds a share lock on.
    let ended = false;
    const end = f.end(f.bossActor, empId).then(() => {
      ended = true;
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(ended, 'mutant: `for share` removed - the termination completed while the sign-in was still in flight').toBe(false);

    release();
    expect(await signInSettled).toBeUndefined();
    await end;

    const rows = await sql<{ ended_at: Date | null; ended_reason: string | null }[]>`
      select ended_at, ended_reason from sessions where person_id = ${m.personId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ended_at, 'the session the racing sign-in created is ended by the termination').not.toBeNull();
    expect(rows[0]!.ended_reason).toBe('revoked');
    await rejectsResolve(token);
  }, 30_000);
});

describe('Invariant 20 - ending the last admin\'s employment never locks the org out (leg b)', () => {
  it('the only admin ends their own employment: sessions survive, no event, and they can still sign in', async () => {
    const f = await fixture('inv20');
    const admin = await f.person('Only Admin', 'super_admin');
    await f.scope(admin.personId, f.storeA, 'fan_out');
    const empId = await f.hire(admin.personId, f.storeA);
    const browser = await f.browserSession(admin);
    const actor: Actor = { personId: admin.personId, orgId: f.orgId };

    await f.end(actor, empId);

    expect(await employmentOpen(empId), 'the employment did end').toBe(false);
    expect(await live(admin.personId), 'mutant: R1 leg (b) requires an employment - the admin\'s session is ended').toBe(1);
    await expect(resolveActor(null, browser.token)).resolves.toBeDefined();
    expect(await endedAll(f.orgId)).toHaveLength(0);
    expect((await f.browserSession(admin)).personId, 'and a fresh sign-in still works').toBe(admin.personId);
  });
});

describe('Invariant 21 - two terminations of the SAME person (different stores) must serialise, not deadlock', () => {
  it('both endEmployment calls succeed; the person ends with no open employment and no live session', async () => {
    const f = await fixture('inv21');
    const s = await f.person('Floater', 'manager');
    const empA = await f.hire(s.personId, f.storeA);
    const empB = await f.hire(s.personId, f.storeB);
    await f.browserSession(s);
    await f.pinSession(s, f.storeA);
    expect(await live(s.personId)).toBe(2);

    // Barrier: each transaction has done its employment UPDATE before either runs the eligibility check, so the two
    // `for share` reads cross the two row locks (A holds A, wants B; B holds B, wants A) unless the code serialises first.
    ctl.barrierSize = 2;
    ctl.arrived = 0;
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([f.end(f.bossActor, empA), f.end(f.bossActor, empB)]);
    } finally {
      ctl.barrierSize = 0;
    }
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => String((r.reason as { code?: string })?.code ?? r.reason));
    expect(failures, 'mutant: lock-all-employments-in-order removed - Postgres aborts one with deadlock 40P01').toEqual([]);
    expect(await employmentOpen(empA)).toBe(false);
    expect(await employmentOpen(empB)).toBe(false);
    expect(await live(s.personId), 'no live session left').toBe(0);
  }, 30_000);
});
