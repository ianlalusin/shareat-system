import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-402 S2 - security events. docs/tasks/402-activity-log.md: Slice S2, R9, R11, Invariants 15, 16, 17 (the live half),
 * and the "no secret in any payload" half of Invariant 18 (the all-of-audit_log after-suite scan is S1b's file).
 *
 * ## What is judged, and by what
 * Every test reads `audit_log` (and `authz_denial_counts`) as the OWNER over a plain postgres.js connection, so what it
 * sees is what COMMITTED - the only way to prove a failure-path event survives the caller's rollback. Fixtures are
 * committed through the same connection (a separate writer transaction cannot see an uncommitted fixture).
 * Each fixture has its own org, so a count by (org, action) is isolated from every other test.
 *
 * ## Interface choices the spec leaves open (the BUILDER must follow these; each is flagged in the hand-back)
 *   - `setPin` takes an optional `actorPersonId` (who issued the PIN); `credential.pin_set` is written only for that actor.
 *   - A refused Firebase sign-in for a KNOWN account (here: a terminal's credential) writes `auth.signin_refused` with a
 *     null actor under the account's org (R11); an UNKNOWN uid writes no audit row and one logger line
 *     `signin.unknown_identifier` (Invariant 16).
 *   - `security.authorize_denied` is org-scoped (catalogue), so the store a denial concerned is in `after`, not `store_id`.
 *   - One `manager.elevated` row per elevation (not per capability); one `session.ended_all` row per call that ended > 0.
 *
 * ## State at HEAD
 * Every S2 entry is `reserved` and no call site writes one, so every "row exists" leg is red on a missing row, and the
 * "survives rollback" legs are red for the same reason. The "writes nothing" legs are green today and are the mutant guards.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

// T-402 S2 audit rulings (A1, T1-T10): the outbox opens its own connection through `withOrgPrincipal`; this wrapper lets a test
// hold it (never resolve), fail it, and count the transactions a flush opens. `orgIdOfPerson` can be forced to "unresolvable" (A4).
const ctl = vi.hoisted(() => ({
  mode: 'real' as 'real' | 'hang' | 'fail',
  held: [] as Array<() => void>,
  calls: [] as string[],
  orgOfPersonNull: false,
}));
vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...real,
    withOrgPrincipal: ((orgId: string, fn: never) => {
      ctl.calls.push(orgId);
      if (ctl.mode === 'fail') return Promise.reject(new Error('forced audit write failure'));
      if (ctl.mode === 'hang') {
        return new Promise<unknown>((resolve, reject) => {
          ctl.held.push(() => {
            (real.withOrgPrincipal as (o: string, f: never) => Promise<unknown>)(orgId, fn).then(resolve, reject);
          });
        });
      }
      return real.withOrgPrincipal(orgId, fn);
    }) as typeof real.withOrgPrincipal,
    authzDenialCountsRepo: {
      ...real.authzDenialCountsRepo,
      orgIdOfPerson: (...a: Parameters<typeof real.authzDenialCountsRepo.orgIdOfPerson>) =>
        ctl.orgOfPersonNull ? Promise.resolve(null) : real.authzDenialCountsRepo.orgIdOfPerson(...a),
    },
  };
});

import { closeDb, withOrgPrincipal, authzDenialCountsRepo, type Tx } from '@shareat/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { enqueueAuthorizeDenied } from '../../src/security-events';
import { logger } from '@shareat/core/logger';
import {
  assignRole,
  assignRoleAsActor,
  AuthenticationError,
  AuthorizationError,
  authorize,
  canAt,
  CAPABILITIES,
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  elevateManager,
  flushSecurityEvents,
  can,
  endAllForDevice,
  endShift,
  grantCapabilityAsActor,
  hashPin,
  heldCapabilities,
  linkFirebaseCredential,
  pinLookupHash,
  setPin,
  signInWithFirebase,
  signInWithPin,
  signOut,
  SUPER_ADMIN_ONLY_CAPABILITIES,
  unlinkCredential,
  type Actor,
  type Capability,
} from '@shareat/auth';
import { createEmployment, endEmployment, searchPersons, seedCanonicalPositions, setEmploymentPositions } from '@shareat/domain';
import { AUDIT_CATALOGUE, catalogueEntry, retentionFor, severityFor } from '../../../db/src/audit/catalogue';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const PIN = '739154'; // the cashier's real PIN in every fixture
const WRONG = '482916'; // well-formed, issued to nobody
const NEW_PIN = '551826';
const orgsMade: string[] = [];

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------------------------------------------
// Fixture: one org, two stores, an admin (both stores), a staff person (store 1 only), a cashier with a live PIN at
// store 1, a plain worker with no role/credential, and a terminal person (the device).
// ---------------------------------------------------------------------------------------------------------------
async function fixture(hint: string) {
  const code = uid(`t402s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  orgsMade.push(orgId);
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`)[0]!.id;
  const mkPerson = async (name: string, kind = 'person') =>
    (await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${name}, ${kind}) returning id`)[0]!.id;
  const storeId = await mkStore(`${hint}-s1`);
  const storeId2 = await mkStore(`${hint}-s2`);
  const adminId = await mkPerson('Admin');
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId2})`;
  const staffId = await mkPerson('Staff');
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffId}, ${storeId})`;
  const cashierId = await mkPerson('Cashier');
  await sql`insert into person_store_scope (person_id, store_id) values (${cashierId}, ${storeId})`;
  // T-407: the PIN door also needs the org-level rule, so the cashier is employed (open employment) as well as scoped.
  await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeId}, ${cashierId}, ${`FX${++seq}`}, 'regular', '2020-01-01')`;
  await sql`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${cashierId}, 'pin', ${storeId}, ${await hashPin(PIN)}, ${pinLookupHash(orgId, PIN)})`;
  const workerId = await mkPerson('Worker');
  const deviceId = await mkPerson('Terminal', 'terminal');
  const actor = (personId: string): Actor => ({ personId, orgId });
  return { orgId, storeId, storeId2, adminId, staffId, cashierId, workerId, deviceId, admin: actor(adminId), staff: actor(staffId), actor };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

interface Row {
  id: string;
  action: string;
  store_id: string | null;
  actor_person_id: string | null;
  entity: string;
  entity_id: string;
  category: string;
  sensitivity: string;
  severity: number;
  retention_class: string;
  text: string;
}
/** Failure-path and post-commit events are written by the outbox after the caller returns (A1): drain it before every read. */
const rows = async (orgId: string, action: string, entityId?: string) => {
  await flushSecurityEvents();
  return sql<Row[]>`
    select id, action, store_id, actor_person_id, entity, entity_id, category, sensitivity, severity, retention_class,
           coalesce(before::text, '') || ' ' || coalesce(after::text, '') as text
      from audit_log
     where org_id = ${orgId} and action = ${action} ${entityId ? sql`and entity_id = ${entityId}` : sql``}
     order by recorded_at, id`;
};
const count = async (orgId: string, action: string, entityId?: string) => (await rows(orgId, action, entityId)).length;
const countAll = async (orgId: string) => {
  await flushSecurityEvents();
  return (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId}`)[0]!.n;
};

/** The labels come from the catalogue, never the call site; the store column follows the entry's scope. */
function expectLabels(row: Row, action: string, storeId: string | null) {
  const e = catalogueEntry(action)!;
  expect(e, `${action} in the catalogue`).toBeDefined();
  expect(e.reserved, `${action} is live (its slice flipped it)`).toBe(false);
  expect(row.category).toBe(e.category);
  expect(row.sensitivity).toBe(e.sensitivity);
  expect(row.severity).toBe(severityFor(e.sensitivity));
  expect(row.retention_class).toBe(retentionFor(e.category, e.sensitivity));
  expect(row.entity).toBe(e.entity);
  expect(row.store_id, `store_id for a ${e.scope}-scoped entry`).toBe(e.scope === 'store' ? storeId : null);
}

/** Invariant 18 (this slice's half): no PIN, password, token, hash or session token anywhere in the org's rows. */
async function expectNoSecrets(orgId: string, extra: readonly string[] = []) {
  const all = await sql<{ t: string }[]>`
    select coalesce(before::text, '') || ' ' || coalesce(after::text, '') as t from audit_log where org_id = ${orgId}`;
  const stored = await sql<{ v: string | null }[]>`
    select v from (
      select pc.secret_hash as v from person_credentials pc join persons p on p.id = pc.person_id where p.org_id = ${orgId}
      union all select pc.lookup_hash from person_credentials pc join persons p on p.id = pc.person_id where p.org_id = ${orgId}
      union all select s.token_hash from sessions s join persons p on p.id = s.person_id where p.org_id = ${orgId}
    ) x where v is not null`;
  const secrets = [PIN, WRONG, NEW_PIN, ...extra, ...stored.map((r) => r.v!)];
  for (const { t } of all) {
    for (const s of secrets) expect(t.includes(s), `a secret leaked into an audit payload: ${s.slice(0, 8)}...`).toBe(false);
    expect(t).not.toMatch(/scrypt\$/);
    expect(t).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./);
  }
}

const rejects = (p: Promise<unknown>): Promise<Error> =>
  p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: Error) => e,
  );

// ---------------------------------------------------------------------------------------------------------------
describe('S2 flips its catalogue entries live (and only those)', () => {
  const S2 = [
    'auth.signin_succeeded', 'auth.signin_refused', 'auth.pin_signin_succeeded', 'auth.pin_paused', 'auth.pin_stopped_for_day',
    'session.ended', 'session.ended_all', 'credential.linked', 'credential.unlinked', 'credential.pin_set', 'role.assigned',
    'capability.granted', 'manager.elevated', 'security.authorize_denied', 'employment.created', 'employment.ended',
    'employment.positions_set',
  ];
  it('the 17 S2 entries are not reserved; the S3 envelope entries are live and the S5 summary stays reserved', () => {
    for (const a of S2) expect(catalogueEntry(a)?.reserved, `${a} reserved?`).toBe(false);
    expect(catalogueEntry('security.authorize_denied_summary')?.reserved, 'stays reserved (S5 owns it)').toBe(true);
    for (const a of ['security.event_replay_conflict', 'security.event_store_mismatch']) {
      expect(catalogueEntry(a)?.reserved, `${a} is live (T-402 S3 flipped it)`).toBe(false);
    }
    expect(AUDIT_CATALOGUE.some((e) => e.reserved)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 15 / 16 - Firebase sign-in (accepted, refused, unknown)', () => {
  const mkFirebasePerson = async (f: Fx, kind: 'person' | 'terminal', storeId: string | null = null) => {
    const p = kind === 'terminal' ? await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${f.orgId}, 'Term', 'terminal') returning id`
      : await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Fb Person') returning id`;
    const externalId = uid('fbuid');
    // T-407: an email sign-in needs the org-level rule; an ordinary Firebase person here is an admin (R1 leg b).
    if (kind === 'person') await sql`insert into person_roles (person_id, org_id, role) values (${p[0]!.id}, ${f.orgId}, 'admin')`;
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${p[0]!.id}, 'firebase', ${storeId}, ${externalId})`;
    return { personId: p[0]!.id, externalId };
  };

  it('accepted: one auth.signin_succeeded row, org-scoped, actor = the person, entity = the person; no refusal row', async () => {
    const f = await fixture('fb-ok');
    const fb = await mkFirebasePerson(f, 'person');
    const r = await signInWithFirebase(null, { verifiedUid: fb.externalId });
    const got = await rows(f.orgId, 'auth.signin_succeeded');
    expect(got, 'one success row (mutant: call removed)').toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(fb.personId);
    expect(got[0]!.entity_id).toBe(fb.personId);
    expectLabels(got[0]!, 'auth.signin_succeeded', null);
    expect(await count(f.orgId, 'auth.signin_refused')).toBe(0);
    await expectNoSecrets(f.orgId, [r.token]);
  });

  it('refused for a KNOWN account (a terminal credential in the admin form): one auth.signin_refused row, null actor, under that org - with tx=null and with a tx that then rolls back', async () => {
    const f = await fixture('fb-refused');
    const term = await mkFirebasePerson(f, 'terminal', f.storeId);
    await expect(signInWithFirebase(null, { verifiedUid: term.externalId })).rejects.toBeInstanceOf(AuthenticationError);
    let got = await rows(f.orgId, 'auth.signin_refused');
    expect(got, 'refused with tx=null leaves its event').toHaveLength(1);
    expect(got[0]!.actor_person_id, 'R11: a failure writes the account, not an actor').toBeNull();
    expect(got[0]!.text, 'the known account is named in the payload').toContain(term.personId);
    expectLabels(got[0]!, 'auth.signin_refused', null);

    // the SAME refusal inside a caller transaction that rolls back (a real refused request): the row must commit on its own
    await rejects(withOrgPrincipal(f.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: term.externalId })));
    got = await rows(f.orgId, 'auth.signin_refused');
    expect(got, 'mutant: written in the caller transaction (vanishes on rollback)').toHaveLength(2);
    expect(await count(f.orgId, 'auth.signin_succeeded')).toBe(0);
    await expectNoSecrets(f.orgId);
  });

  it('Invariant 16: an unknown uid writes NO audit_log row (any org) and exactly one logger line signin.unknown_identifier', async () => {
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action like 'auth.%'`)[0]!.n;
    const spies = (['info', 'warn', 'error'] as const).map((l) => vi.spyOn(logger, l));
    try {
      await expect(signInWithFirebase(null, { verifiedUid: uid('nobody') })).rejects.toBeInstanceOf(AuthenticationError);
      const lines = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).filter((l) => l.includes('signin.unknown_identifier'));
      expect(lines, 'one logger line for the unknown identifier').toHaveLength(1);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const after = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action like 'auth.%'`)[0]!.n;
    expect(after, 'mutant: a row with a null org (or any org)').toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 15 / 17 - PIN sign-in: success, the tier-1 pause, the T-395 stop', () => {
  const attempt = (f: Fx, pin: string) => signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin, deviceId: f.deviceId });

  it('success: one auth.pin_signin_succeeded row, store-scoped, actor = the cashier; a miss writes nothing (pin_attempts is the miss log)', async () => {
    const f = await fixture('pin-ok');
    for (let i = 0; i < 3; i++) await expect(attempt(f, WRONG)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(attempt(f, 'nope')).rejects.toBeInstanceOf(AuthenticationError);
    expect(await countAll(f.orgId), 'mutant: each PIN miss copied into audit_log').toBe(0);

    const r = await attempt(f, PIN);
    const got = await rows(f.orgId, 'auth.pin_signin_succeeded');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.cashierId);
    expect(got[0]!.entity_id).toBe(f.cashierId);
    expectLabels(got[0]!, 'auth.pin_signin_succeeded', f.storeId);
    expect(await countAll(f.orgId), 'only the success row exists').toBe(1);
    await expectNoSecrets(f.orgId, [r.token]);
  });

  it('the tx-supplied success path writes its row too, and it is the caller transaction\'s row (it rolls back with it)', async () => {
    const f = await fixture('pin-ok-tx');
    await rejects(
      withOrgPrincipal(f.orgId, async (tx) => {
        await signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: PIN, deviceId: f.deviceId });
        throw new Error('rollback the caller');
      }),
    );
    expect(await count(f.orgId, 'auth.pin_signin_succeeded'), 'a success is not a failure-path event: no row for a rolled-back sign-in').toBe(0);
    await withOrgPrincipal(f.orgId, (tx) => signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin: PIN, deviceId: f.deviceId }));
    expect(await count(f.orgId, 'auth.pin_signin_succeeded')).toBe(1);
  });

  const seedPause = (f: Fx) =>
    sql`insert into pin_attempt_throttle (org_id, store_id, fail_count, window_started_at) values (${f.orgId}, ${f.storeId}, 9, now())`;
  const seedStop = (f: Fx) => sql`
    insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
    select ${f.orgId}::uuid, ${f.storeId}::uuid, ${f.deviceId}::uuid, 'miss', now() - interval '1 hour'
    from generate_series(1, 50)`;
  const inCallerTx = (f: Fx, pin: string, commit: boolean) =>
    withOrgPrincipal(f.orgId, async (tx) => {
      const p = signInWithPin(tx, { orgId: f.orgId, storeId: f.storeId, pin, deviceId: f.deviceId });
      if (commit) await p.catch(() => undefined); // the caller swallows the refusal and COMMITS
      else await p; // the refusal propagates: the caller rolls back
    });

  it('T10 / A6 pause, caller-tx path: a rolled-back sign-in leaves NO charge and NO pause event (the event lives where its charge lives)', async () => {
    const f = await fixture('pin-pause-rb');
    await seedPause(f);
    await rejects(inCallerTx(f, WRONG, false));
    expect(await count(f.orgId, 'auth.pin_paused'), 'mutant: the event escapes the caller rollback').toBe(0);
    const t = await sql<{ fail_count: number }[]>`select fail_count from pin_attempt_throttle where store_id = ${f.storeId}`;
    expect(t[0]!.fail_count, 'the rolled-back charge is gone').toBe(9);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${f.storeId}`)[0]!.n).toBe(0);
  });

  it('pause, caller-tx path that COMMITS: the 10th miss writes ONE auth.pin_paused (high, store-scoped, null actor) in that transaction', async () => {
    const f = await fixture('pin-pause-c');
    await seedPause(f);
    await inCallerTx(f, WRONG, true);
    const got = await rows(f.orgId, 'auth.pin_paused');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBeNull();
    expect(got[0]!.entity_id).toBe(f.storeId);
    expectLabels(got[0]!, 'auth.pin_paused', f.storeId);
    await expectNoSecrets(f.orgId);
  });

  it('pause, tx=null path: the event is written once at the moment the pause starts, not on every refused attempt while it lasts', async () => {
    const f = await fixture('pin-pause2');
    await seedPause(f);
    await expect(attempt(f, WRONG)).rejects.toBeInstanceOf(AuthenticationError); // 10th miss: starts the pause
    expect(await count(f.orgId, 'auth.pin_paused')).toBe(1);
    for (let i = 0; i < 3; i++) await expect(attempt(f, WRONG)).rejects.toThrow(/paused until/);
    expect(await count(f.orgId, 'auth.pin_paused'), 'mutant: an event per refused attempt').toBe(1);
  });

  it('stop, caller-tx path: rolled back leaves no stop event; committed writes ONE auth.pin_stopped_for_day (critical); tx=null writes one; later refusals add none', async () => {
    const f = await fixture('pin-stop');
    await seedStop(f);
    await rejects(inCallerTx(f, WRONG, false));
    expect(await count(f.orgId, 'auth.pin_stopped_for_day'), 'mutant: the event escapes the caller rollback').toBe(0);
    await inCallerTx(f, WRONG, true);
    const got = await rows(f.orgId, 'auth.pin_stopped_for_day');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBeNull();
    expect(got[0]!.entity_id).toBe(f.storeId);
    expectLabels(got[0]!, 'auth.pin_stopped_for_day', f.storeId);
    for (let i = 0; i < 3; i++) await expect(attempt(f, PIN)).rejects.toThrow(/stopped at this store/);
    expect(await count(f.orgId, 'auth.pin_stopped_for_day'), 'mutant: an event per refused attempt').toBe(1);

    const g = await fixture('pin-stop-null');
    await seedStop(g);
    await expect(attempt(g, WRONG)).rejects.toThrow(/stopped at this store/);
    expect(await count(g.orgId, 'auth.pin_stopped_for_day'), 'tx=null: the committed charge event is enqueued').toBe(1);
    await expectNoSecrets(g.orgId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 15 - sessions: ended, ended_all', () => {
  const signIn = (f: Fx, personPin = PIN) => signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: personPin, deviceId: f.deviceId });

  // endShift / endAllForDevice read `sessions` through RLS, so they need an org-principal'd tx (tx=null has none).
  const shift = (f: Fx) => withOrgPrincipal(f.orgId, (tx) => endShift(tx, { personId: f.cashierId, storeId: f.storeId }));
  const allForDevice = (f: Fx) => withOrgPrincipal(f.orgId, (tx) => endAllForDevice(tx, { deviceId: f.deviceId }));

  it('signOut writes one session.ended (low, org-scoped, actor = the person, entity = the session); signing out twice or with a junk token writes nothing more', async () => {
    const f = await fixture('so');
    const s = await signIn(f);
    await signOut(null, s.token);
    const got = await rows(f.orgId, 'session.ended');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.cashierId);
    expect(got[0]!.entity_id).toBe(s.sessionId);
    expectLabels(got[0]!, 'session.ended', null);
    await signOut(null, s.token);
    await signOut(null, 'x'.repeat(40));
    expect(await count(f.orgId, 'session.ended'), 'mutant: logs a no-op sign-out').toBe(1);
    await expectNoSecrets(f.orgId, [s.token]);
  });

  it('endShift: one session.ended when a session was live; none when nothing was; never an ended_all', async () => {
    const f = await fixture('shift');
    expect((await shift(f)).ended).toBe(0);
    expect(await count(f.orgId, 'session.ended'), 'mutant: logs when nothing ended').toBe(0);
    await signIn(f);
    expect((await shift(f)).ended).toBe(1);
    expect(await count(f.orgId, 'session.ended')).toBe(1);
    expect(await count(f.orgId, 'session.ended_all')).toBe(0);
  });

  it('endAllForDevice: one session.ended_all (high, org-scoped) when it ended sessions, none when it ended nothing', async () => {
    const f = await fixture('alldev');
    expect((await allForDevice(f)).ended).toBe(0);
    expect(await count(f.orgId, 'session.ended_all'), 'mutant: logs when nothing ended').toBe(0);
    await signIn(f);
    await signIn(f);
    expect((await allForDevice(f)).ended).toBe(2);
    const got = await rows(f.orgId, 'session.ended_all');
    expect(got, 'one row for the call, not one per session').toHaveLength(1);
    expectLabels(got[0]!, 'session.ended_all', null);
    expect(await count(f.orgId, 'session.ended'), 'the sessions are not also logged one by one').toBe(0);
    await expectNoSecrets(f.orgId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 15 - credentials: linked, unlinked, pin_set', () => {
  it('linkFirebaseCredential: one credential.linked (high, admin-viewed, actor = the admin, entity = the person); a refused link and a rolled-back link leave none', async () => {
    const f = await fixture('link');
    await expect(withOrgPrincipal(f.orgId, (tx) => linkFirebaseCredential(tx, f.admin, { personId: f.workerId, uid: 'a@b.com' }))).rejects.toThrow();
    expect(await count(f.orgId, 'credential.linked'), 'mutant: logged before validation').toBe(0);
    await rejects(
      withOrgPrincipal(f.orgId, async (tx) => {
        await linkFirebaseCredential(tx, f.admin, { personId: f.workerId, uid: uid('fb-rb') });
        throw new Error('rollback the caller');
      }),
    );
    expect(await count(f.orgId, 'credential.linked'), 'a success event rolls back with its change (not a failure-path event)').toBe(0);
    await withOrgPrincipal(f.orgId, (tx) => linkFirebaseCredential(tx, f.admin, { personId: f.workerId, uid: uid('fb') }));
    const got = await rows(f.orgId, 'credential.linked');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expect(got[0]!.entity_id).toBe(f.workerId);
    expectLabels(got[0]!, 'credential.linked', null);
    await expectNoSecrets(f.orgId);
  });

  it('unlinkCredential: one credential.unlinked; an empty reason (refused) leaves none', async () => {
    const f = await fixture('unlink');
    const extId = uid('fbuid');
    const [cred] = await sql<{ id: string }[]>`
      insert into person_credentials (person_id, kind, external_id) values (${f.staffId}, 'firebase', ${extId}) returning id`;
    await expect(
      withOrgPrincipal(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.staffId, credentialId: cred!.id, reason: '   ' })),
    ).rejects.toThrow();
    expect(await count(f.orgId, 'credential.unlinked')).toBe(0);
    await withOrgPrincipal(f.orgId, (tx) => unlinkCredential(tx, f.admin, { personId: f.staffId, credentialId: cred!.id, reason: 'lost phone' }));
    const got = await rows(f.orgId, 'credential.unlinked');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expect(got[0]!.entity_id).toBe(f.staffId);
    expectLabels(got[0]!, 'credential.unlinked', null);
    await expectNoSecrets(f.orgId);
  });

  it('setPin: one credential.pin_set (high, actor = who issued it, entity = the person) carrying NO PIN, hash or lookup hash; an in-use or malformed PIN leaves none', async () => {
    const f = await fixture('setpin');
    const issue = (pin: string) =>
      withOrgPrincipal(f.orgId, (tx) =>
        setPin(tx, { orgId: f.orgId, personId: f.workerId, storeId: f.storeId, pin, actorPersonId: f.adminId } as Parameters<typeof setPin>[1]),
      );
    await expect(issue('abc')).rejects.toBeInstanceOf(AuthenticationError);
    await expect(issue(PIN)).rejects.toThrow(/already in use/); // the cashier holds it
    expect(await count(f.orgId, 'credential.pin_set')).toBe(0);
    await issue(NEW_PIN);
    const got = await rows(f.orgId, 'credential.pin_set');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expect(got[0]!.entity_id).toBe(f.workerId);
    expectLabels(got[0]!, 'credential.pin_set', null);
    await expectNoSecrets(f.orgId); // NEW_PIN is in the secret list: mutant "raw PIN in after"
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 15 - roles, grants, elevation', () => {
  const grantable = (CAPABILITIES as readonly Capability[]).find(
    (c) =>
      CAPABILITY_SCOPE[c] === 'org' &&
      !CAPABILITY_MATRIX[c].staff &&
      !(SUPER_ADMIN_ONLY_CAPABILITIES as readonly string[]).includes(c) &&
      !/^view_activity_log/.test(c),
  )!;

  it('assignRoleAsActor: exactly one role.assigned (high, admin-viewed, actor = the admin, entity = the person); a refused self-assignment leaves none', async () => {
    const f = await fixture('role');
    await expect(withOrgPrincipal(f.orgId, (tx) => assignRoleAsActor(tx, f.admin, { personId: f.adminId, role: 'manager' }))).rejects.toThrow();
    expect(await count(f.orgId, 'role.assigned'), 'mutant: logged before the refusal').toBe(0);
    await withOrgPrincipal(f.orgId, (tx) => assignRoleAsActor(tx, f.admin, { personId: f.workerId, role: 'manager' }));
    const got = await rows(f.orgId, 'role.assigned');
    expect(got, 'one row, not one from each layer').toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expect(got[0]!.entity_id).toBe(f.workerId);
    expectLabels(got[0]!, 'role.assigned', null);
  });

  it('grantCapabilityAsActor: one capability.granted when a grant was written; the repeat (wrote: false) adds none', async () => {
    const f = await fixture('grant');
    const grant = () => withOrgPrincipal(f.orgId, (tx) => grantCapabilityAsActor(tx, f.admin, { personId: f.staffId, capability: grantable }));
    expect((await grant()).wrote).toBe(true);
    const got = await rows(f.orgId, 'capability.granted');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expect(got[0]!.entity_id).toBe(f.staffId);
    expect(got[0]!.text).toContain(grantable);
    expectLabels(got[0]!, 'capability.granted', null);
    expect((await grant()).wrote).toBe(false);
    expect(await count(f.orgId, 'capability.granted'), 'mutant: a no-op grant is logged').toBe(1);
  });

  it('elevateManager writes one manager.elevated (critical, admin-viewed); so does assignRole\'s automatic elevation of a manager into an adminless org', async () => {
    const f = await fixture('elev');
    await withOrgPrincipal(f.orgId, (tx) => elevateManager(tx, { personId: f.workerId, orgId: f.orgId, grantedBy: f.adminId }));
    const got = await rows(f.orgId, 'manager.elevated', f.workerId);
    expect(got, 'one row per elevation, not one per capability').toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expectLabels(got[0]!, 'manager.elevated', null);

    // an org with no admin at all: assigning a manager elevates them automatically
    const g = await fixture('elev2');
    await sql`update person_roles set revoked_at = now() where person_id = ${g.adminId}`;
    await withOrgPrincipal(g.orgId, (tx) => assignRole(tx, { personId: g.workerId, orgId: g.orgId, role: 'manager', grantedBy: g.staffId }));
    expect(await count(g.orgId, 'manager.elevated', g.workerId), 'the automatic path is logged too').toBe(1);

    // a manager appointed into an org that HAS an admin is not elevated, so no elevation event
    const h = await fixture('elev3');
    await withOrgPrincipal(h.orgId, (tx) => assignRole(tx, { personId: h.workerId, orgId: h.orgId, role: 'manager', grantedBy: h.adminId }));
    expect(await count(h.orgId, 'manager.elevated'), 'mutant: logged on every manager assignment').toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 15 - employment created / ended / positions_set', () => {
  async function staffed(hint: string) {
    const f = await fixture(hint);
    await withOrgPrincipal(f.orgId, (tx) => seedCanonicalPositions(tx, f.orgId));
    const pos = await sql<{ id: string; name: string }[]>`select id, name from positions where org_id = ${f.orgId} and store_id is null`;
    return { f, cashier: pos.find((p) => p.name === 'Cashier')!, cook: pos.find((p) => p.name === 'Cook')! };
  }
  const hire = (f: Fx, over: Record<string, unknown> = {}) =>
    withOrgPrincipal(f.orgId, (tx) =>
      createEmployment(tx, f.admin, { storeId: f.storeId, personId: f.workerId, employmentStatus: 'probationary', startedOn: '2026-01-05', ...over }),
    );

  it('createEmployment: one employment.created (store-scoped, actor = the admin, entity = the employment); a staff-code override adds set_staff_code beside it, not instead; a refused or rolled-back hire leaves none', async () => {
    const { f } = await staffed('emp-c');
    await rejects(
      withOrgPrincipal(f.orgId, async (tx) => {
        await createEmployment(tx, f.admin, { storeId: f.storeId, personId: f.workerId, employmentStatus: 'probationary', startedOn: '2026-01-05' });
        throw new Error('rollback the caller');
      }),
    );
    expect(await count(f.orgId, 'employment.created'), 'a success event rolls back with its change').toBe(0);
    const e = await hire(f, { staffCode: 'SE-777' });
    const got = await rows(f.orgId, 'employment.created');
    expect(got).toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expect(got[0]!.entity_id).toBe(e.id);
    expectLabels(got[0]!, 'employment.created', f.storeId);
    expect(await count(f.orgId, 'set_staff_code'), 'the existing override row is unchanged').toBe(1);
    await expect(hire(f)).rejects.toThrow(/already/i); // a second open employment: refused
    expect(await count(f.orgId, 'employment.created'), 'mutant: logged before the refusal').toBe(1);
  });

  it('endEmployment: one employment.ended; a refused end (non-terminal status) leaves none', async () => {
    const { f } = await staffed('emp-e');
    const e = await hire(f);
    await expect(
      withOrgPrincipal(f.orgId, (tx) => endEmployment(tx, f.admin, { employmentId: e.id, endedOn: '2026-03-31', employmentStatus: 'probationary' })),
    ).rejects.toThrow();
    expect(await count(f.orgId, 'employment.ended')).toBe(0);
    await withOrgPrincipal(f.orgId, (tx) => endEmployment(tx, f.admin, { employmentId: e.id, endedOn: '2026-03-31', employmentStatus: 'resigned' }));
    const got = await rows(f.orgId, 'employment.ended');
    expect(got).toHaveLength(1);
    expect(got[0]!.entity_id).toBe(e.id);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expectLabels(got[0]!, 'employment.ended', f.storeId);
  });

  it('setEmploymentPositions: one employment.positions_set; a refused change (primary not in the set) leaves none', async () => {
    const { f, cashier, cook } = await staffed('emp-p');
    const e = await hire(f);
    await expect(
      withOrgPrincipal(f.orgId, (tx) => setEmploymentPositions(tx, f.admin, { employmentId: e.id, positionIds: [cashier.id], primaryPositionId: cook.id })),
    ).rejects.toThrow(/primary/i);
    expect(await count(f.orgId, 'employment.positions_set')).toBe(0);
    await withOrgPrincipal(f.orgId, (tx) => setEmploymentPositions(tx, f.admin, { employmentId: e.id, positionIds: [cashier.id, cook.id], primaryPositionId: cashier.id }));
    const got = await rows(f.orgId, 'employment.positions_set');
    expect(got).toHaveLength(1);
    expect(got[0]!.entity_id).toBe(e.id);
    expect(got[0]!.actor_person_id).toBe(f.adminId);
    expectLabels(got[0]!, 'employment.positions_set', f.storeId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 17 - authorize() denials: first of the day is a row, the rest are counted, all outside the refused transaction', () => {
  const ORG_CAP: Capability = 'manage_users';
  const STORE_CAP: Capability = 'enrol_staff';

  const deny = (f: Fx, actor: Actor, cap: Capability, storeId?: string) =>
    withOrgPrincipal(f.orgId, (tx) => authorize(tx, actor, cap, storeId ? { storeId } : {}));
  const counted = async (orgId: string, personId: string, cap: string, storeId: string | null) => {
    await flushSecurityEvents();
    return (
      await sql<{ n: number }[]>`
        select coalesce(sum(count), 0)::int as n from authz_denial_counts
         where org_id = ${orgId} and actor_person_id = ${personId} and capability = ${cap}
           and store_id is not distinct from ${storeId}::uuid`
    )[0]!.n;
  };

  it('fixture sanity: staff may not do the two capabilities used below (so a rotted matrix cannot make these tests vacuous)', () => {
    expect(CAPABILITY_MATRIX[ORG_CAP].staff).toBe(false);
    expect(CAPABILITY_SCOPE[ORG_CAP]).toBe('org');
    expect(CAPABILITY_MATRIX[STORE_CAP].staff).toBe(false);
    expect(CAPABILITY_SCOPE[STORE_CAP]).toBe('store');
  });

  it('25 denials of one capability by one actor, each inside a transaction that rolls back, leave 1 immediate row + a counter of 24', async () => {
    const f = await fixture('deny25');
    for (let i = 0; i < 25; i++) {
      await expect(deny(f, f.staff, ORG_CAP)).rejects.toBeInstanceOf(AuthorizationError);
    }
    const got = await rows(f.orgId, 'security.authorize_denied');
    expect(got, 'mutant: every denial is a row / mutant: written in the caller transaction (none survive)').toHaveLength(1);
    expect(got[0]!.actor_person_id).toBe(f.staffId);
    expect(got[0]!.text, 'the capability is named').toContain(ORG_CAP);
    expectLabels(got[0]!, 'security.authorize_denied', null);
    expect(await counted(f.orgId, f.staffId, ORG_CAP, null), 'the other 24 are counted, none lost').toBe(24);
    const buckets = (await sql<{ n: number }[]>`select count(*)::int as n from authz_denial_counts where org_id = ${f.orgId}`)[0]!.n;
    expect(buckets, 'one counter row per hour bucket (a run may straddle one hour boundary)').toBeLessThanOrEqual(2);
    await expectNoSecrets(f.orgId);
  });

  it('the key is (actor, capability, store): another capability, another store, another actor each get their own first-of-day row', async () => {
    const f = await fixture('denykey');
    const staff2 = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Staff 2') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${staff2[0]!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${staff2[0]!.id}, ${f.storeId})`;
    const s2 = f.actor(staff2[0]!.id);

    await expect(deny(f, f.staff, ORG_CAP)).rejects.toThrow();
    await expect(deny(f, f.staff, ORG_CAP)).rejects.toThrow(); // same key: counted
    await expect(deny(f, f.staff, 'grant_capability')).rejects.toThrow(); // other capability: new row
    await expect(deny(f, s2, ORG_CAP)).rejects.toThrow(); // other actor: new row
    await expect(deny(f, f.staff, STORE_CAP, f.storeId)).rejects.toThrow(); // store capability at store 1: new row
    await expect(deny(f, f.staff, STORE_CAP, f.storeId2)).rejects.toThrow(); // same capability, other store: new row
    await expect(deny(f, f.staff, STORE_CAP, f.storeId)).rejects.toThrow(); // repeat at store 1: counted

    const got = await rows(f.orgId, 'security.authorize_denied');
    expect(got, 'five distinct (actor, capability, store) keys, five rows').toHaveLength(5);
    expect(got.filter((r) => r.text.includes(f.storeId2))).toHaveLength(1);
    expect(await counted(f.orgId, f.staffId, ORG_CAP, null)).toBe(1);
    expect(await counted(f.orgId, f.staffId, STORE_CAP, f.storeId)).toBe(1);
    expect(await counted(f.orgId, f.staffId, STORE_CAP, f.storeId2)).toBe(0);
    expect(await counted(f.orgId, s2.personId, ORG_CAP, null)).toBe(0);
  });

  it('a caller that catches the refusal and keeps working in its own transaction is not broken by the denial write (the probe-caller pattern)', async () => {
    const f = await fixture('denyprobe');
    const out = await withOrgPrincipal(f.orgId, async (tx: Tx) => {
      const refused = await authorize(tx, f.staff, ORG_CAP).then(() => false, () => true);
      const ok = (await tx.execute(dsql`select 1 as x`)) as unknown as Array<{ x: number }>;
      return { refused, ok: ok[0]!.x };
    });
    expect(out).toEqual({ refused: true, ok: 1 });
    expect(await count(f.orgId, 'security.authorize_denied'), 'the denial was still recorded, outside that transaction').toBe(1);
  });

  it('a permitted authorize, canAt, and heldCapabilities write nothing', async () => {
    const f = await fixture('denyquiet');
    await withOrgPrincipal(f.orgId, (tx) => authorize(tx, f.admin, ORG_CAP));
    expect(await withOrgPrincipal(f.orgId, (tx) => canAt(tx, f.staffId, STORE_CAP, f.storeId)), 'staff is denied').toBe(false);
    await withOrgPrincipal(f.orgId, (tx) => heldCapabilities(tx, f.staff));
    expect(await count(f.orgId, 'security.authorize_denied'), 'mutant: the non-throwing probe logs denials').toBe(0);
    expect(await countAll(f.orgId)).toBe(0);
    const counters = (await sql<{ n: number }[]>`select count(*)::int as n from authz_denial_counts where org_id = ${f.orgId}`)[0]!.n;
    expect(counters).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// S2 audit rulings (Opus planner, 2026-10-14): T1-T11. One rule: a security event never holds a second connection, never
// blocks the caller and never changes the caller's outcome (A1 outbox).
// ---------------------------------------------------------------------------------------------------------------
describe('S2 audit rulings T1-T11 - the outbox, the probes, the guards', () => {
  const ORG_CAP: Capability = 'manage_users';
  const STORE_CAP: Capability = 'enrol_staff';
  const sleep = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
  const counted = async (orgId: string, personId: string, cap: string, storeId: string | null) => {
    await flushSecurityEvents();
    return (
      await sql<{ n: number }[]>`
        select coalesce(sum(count), 0)::int as n from authz_denial_counts
         where org_id = ${orgId} and actor_person_id = ${personId} and capability = ${cap}
           and store_id is not distinct from ${storeId}::uuid`
    )[0]!.n;
  };
  const counterRows = async (orgId: string) => {
    await flushSecurityEvents();
    return (await sql<{ n: number }[]>`select count(*)::int as n from authz_denial_counts where org_id = ${orgId}`)[0]!.n;
  };
  /** Release every write the hung wrapper is holding, back to the real implementation, then drain. */
  const release = async () => {
    ctl.mode = 'real';
    for (const r of ctl.held.splice(0)) r();
    await flushSecurityEvents();
  };
  const spyLogger = () => (['info', 'warn', 'error'] as const).map((l) => ({ l, spy: vi.spyOn(logger, l) }));
  const linesOf = (spies: ReturnType<typeof spyLogger>, level?: string) =>
    spies.filter((x) => !level || x.l === level).flatMap((x) => x.spy.mock.calls.map((c) => JSON.stringify(c)));

  it('T1: with withOrgPrincipal held (never resolves), a denied authorize() still rejects promptly with the same AuthorizationError - mutant: awaited write', async () => {
    const f = await fixture('t1');
    let outcome: unknown;
    await withOrgPrincipal(f.orgId, async (tx) => {
      ctl.mode = 'hang';
      try {
        outcome = await Promise.race([authorize(tx, f.staff, ORG_CAP).then(() => 'allowed', (e: unknown) => e), sleep(3000)]);
      } finally {
        ctl.mode = 'real';
      }
    });
    try {
      expect(outcome, 'the refusal arrived without waiting for the audit write').toBeInstanceOf(AuthorizationError);
      expect((outcome as AuthorizationError).message).toMatch(/may not 'manage_users'/);
    } finally {
      await release();
    }
    expect(await count(f.orgId, 'security.authorize_denied'), 'the held write completed once released: nothing lost').toBe(1);
  });

  it('T2: 5 denied can() + flush leave zero audit_log rows and zero counter rows - mutant: can() calls authorize()', async () => {
    const f = await fixture('t2');
    await withOrgPrincipal(f.orgId, async (tx) => {
      for (let i = 0; i < 5; i++) expect(await can(tx, f.staff, ORG_CAP)).toBe(false);
      expect(await can(tx, f.admin, ORG_CAP)).toBe(true);
    });
    expect(await countAll(f.orgId)).toBe(0);
    expect(await counterRows(f.orgId)).toBe(0);
  });

  it('T4: 25 denials in one rolled-back caller tx -> after the flush 1 row + 24 counted, and the flush wrote them in a handful of transactions for that org, not one per denial - mutant: per-denial write', async () => {
    const f = await fixture('t4');
    ctl.calls = [];
    await rejects(
      withOrgPrincipal(f.orgId, async (tx) => {
        ctl.mode = 'hang'; // hold the first flush so the rest pile up in the buffer, as they do under load
        for (let i = 0; i < 25; i++) await expect(authorize(tx, f.staff, ORG_CAP)).rejects.toBeInstanceOf(AuthorizationError);
        ctl.mode = 'real';
        throw new Error('rollback the caller');
      }),
    );
    const mine = () => ctl.calls.filter((o) => o === f.orgId).length;
    const beforeRelease = mine();
    await release();
    expect(await count(f.orgId, 'security.authorize_denied')).toBe(1);
    expect(await counted(f.orgId, f.staffId, ORG_CAP, null)).toBe(24);
    // the caller's own transaction accounts for 1 call; the outbox's flushes for the rest
    expect(mine() - 1, 'the outbox coalesces: a handful of transactions for 25 denials, never one each').toBeLessThan(8);
    expect(beforeRelease).toBeGreaterThanOrEqual(2);
  });

  it('T5: a non-uuid and an other-org storeId are counted under a null store with deniedAtStore "unknown"; the raw value is nowhere, and nothing logs an error', async () => {
    const f = await fixture('t5');
    const other = await fixture('t5-other');
    const spies = spyLogger();
    try {
      await expect(withOrgPrincipal(f.orgId, (tx) => authorize(tx, f.staff, STORE_CAP, { storeId: other.storeId }))).rejects.toBeInstanceOf(AuthorizationError);
      const raw = "not-a-uuid'; drop table audit_log; --";
      enqueueAuthorizeDenied({ orgId: f.orgId, actorPersonId: f.staffId, capability: STORE_CAP, storeId: raw }, Date.now);
      const got = await rows(f.orgId, 'security.authorize_denied');
      expect(got, 'both collapse onto one null-store key: one row').toHaveLength(1);
      expect(got[0]!.store_id).toBeNull();
      expect(got[0]!.text).toContain('unknown');
      expect(await counted(f.orgId, f.staffId, STORE_CAP, null), 'the second is counted under the null store').toBe(1);
      const stored = await sql<{ t: string }[]>`
        select coalesce(before::text,'') || coalesce(after::text,'') as t from audit_log where org_id = ${f.orgId}
        union all select capability || coalesce(store_id::text,'') from authz_denial_counts where org_id = ${f.orgId}`;
      for (const { t } of stored) {
        expect(t).not.toContain(other.storeId);
        expect(t).not.toContain('drop table');
      }
      const allLogs = linesOf(spies).join('\n');
      expect(allLogs).not.toContain('drop table');
      expect(allLogs).not.toContain(other.storeId);
      expect(linesOf(spies, 'error'), 'no logger.error').toHaveLength(0);
    } finally {
      for (const x of spies) x.spy.mockRestore();
    }
  });

  it('T6: a forced flush DB error logs ONE logger.error and the caller\'s refusal is unchanged', async () => {
    const f = await fixture('t6');
    const spies = spyLogger();
    try {
      let refusal: unknown;
      try {
        await withOrgPrincipal(f.orgId, async (tx) => {
          ctl.mode = 'real'; // the caller's own transaction is not the one under test
          refusal = await authorize(tx, f.staff, ORG_CAP).then(() => 'allowed', (e: unknown) => e);
          ctl.mode = 'fail';
          // three more in the same tick: one flush, so one error - never one per request
          for (let i = 0; i < 3; i++) enqueueAuthorizeDenied({ orgId: f.orgId, actorPersonId: f.staffId, capability: ORG_CAP, storeId: null }, Date.now);
        });
        await flushSecurityEvents();
      } finally {
        ctl.mode = 'real';
      }
      expect(refusal).toBeInstanceOf(AuthorizationError);
      expect(linesOf(spies, 'error'), 'once per org per flush, never per request (A3)').toHaveLength(1);
    } finally {
      for (const x of spies) x.spy.mockRestore();
    }
    expect(await count(f.orgId, 'security.authorize_denied'), 'accepted loss: dropped, no retry').toBe(0);
  });

  it('T7: the key cap - 10,001 distinct denial keys give ONE drop warning and a bounded buffer', async () => {
    const f = await fixture('t7');
    await flushSecurityEvents();
    const spies = spyLogger();
    try {
      for (let i = 0; i < 10_001; i++) {
        enqueueAuthorizeDenied({ orgId: f.orgId, actorPersonId: crypto.randomUUID(), capability: ORG_CAP, storeId: null }, Date.now);
      }
      ctl.mode = 'fail'; // the flush drains the buffer, then its write fails fast: only the drop warning is under test
      try {
        await flushSecurityEvents();
      } finally {
        ctl.mode = 'real';
      }
      const warns = linesOf(spies, 'warn').filter((l) => /dropped/i.test(l));
      expect(warns, 'one drop warning per flush').toHaveLength(1);
      expect(warns[0]).toMatch(/"dropped":1\b/);
      // bounded: a second flush has nothing left to drop or warn about
      const again = linesOf(spies, 'warn').length;
      await flushSecurityEvents();
      expect(linesOf(spies, 'warn').length).toBe(again);
    } finally {
      for (const x of spies) x.spy.mockRestore();
    }
  }, 60_000);

  it('T8: elevateManager with an unresolvable org, and endShift / endAllForDevice that cannot resolve the org, THROW and leave no grant and no ended session', async () => {
    const f = await fixture('t8');
    await expect(
      withOrgPrincipal(f.orgId, (tx) => elevateManager(tx, { personId: f.workerId, orgId: crypto.randomUUID(), grantedBy: f.adminId })),
    ).rejects.toThrow();
    expect((await sql<{ n: number }[]>`select count(*)::int as n from person_grants where person_id = ${f.workerId}`)[0]!.n, 'no grant survives').toBe(0);
    expect(await count(f.orgId, 'manager.elevated')).toBe(0);

    const live = async (id: string) => (await sql<{ ended_at: Date | null }[]>`select ended_at from sessions where id = ${id}`)[0]!.ended_at;
    const s1 = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: PIN, deviceId: f.deviceId });
    ctl.orgOfPersonNull = true;
    try {
      await expect(withOrgPrincipal(f.orgId, (tx) => endShift(tx, { personId: f.cashierId, storeId: f.storeId }))).rejects.toThrow();
      await expect(withOrgPrincipal(f.orgId, (tx) => endAllForDevice(tx, { deviceId: f.deviceId }))).rejects.toThrow();
    } finally {
      ctl.orgOfPersonNull = false;
    }
    expect(await live(s1.sessionId), 'mutant: a silent skip - the session was ended without its event').toBeNull();
    expect(await count(f.orgId, 'session.ended')).toBe(0);
    expect(await count(f.orgId, 'session.ended_all')).toBe(0);
  });

  it('T9: signInWithFirebase(null) and signOut(null) with the audit write forced to fail still succeed - the session is real, one logger.error', async () => {
    const f = await fixture('t9');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Fb') returning id`;
    const externalId = uid('fbuid');
    // T-407: an email sign-in needs the org-level rule (admin role, R1 leg b).
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'admin')`;
    await sql`insert into person_credentials (person_id, kind, external_id) values (${p!.id}, 'firebase', ${externalId})`;
    const spies = spyLogger();
    ctl.mode = 'fail';
    try {
      const r = await signInWithFirebase(null, { verifiedUid: externalId });
      expect(r.token.length).toBeGreaterThan(16);
      await signOut(null, r.token);
      await flushSecurityEvents();
      expect(linesOf(spies, 'error').length, 'one error per failed flush (two events, at most two flushes), none per request').toBeGreaterThanOrEqual(1);
      expect(linesOf(spies, 'error').length).toBeLessThanOrEqual(2);
      const sess = await sql<{ ended_at: Date | null }[]>`select ended_at from sessions where id = ${r.sessionId}`;
      expect(sess[0]!.ended_at, 'the sign-out itself took effect').not.toBeNull();
    } finally {
      ctl.mode = 'real';
      for (const x of spies) x.spy.mockRestore();
    }
    expect(await count(f.orgId, 'auth.signin_succeeded'), 'accepted loss: the event, never the sign-in').toBe(0);
  });

  it('a manager-like actor holding enrol_staff only at their 2nd store can searchPersons, and the store-1 miss writes NO denial row or counter (the sweep is a probe)', async () => {
    const f = await fixture('probe-search');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Two Stores') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId2})`;
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id) values (${p!.id}, 'enrol_staff', ${f.adminId}, 'grant', ${f.storeId2})`;
    const actor = f.actor(p!.id);
    await expect(withOrgPrincipal(f.orgId, (tx) => can(tx, actor, 'enrol_staff', { storeId: f.storeId2 }))).resolves.toBe(true);
    await expect(withOrgPrincipal(f.orgId, (tx) => can(tx, actor, 'enrol_staff', { storeId: f.storeId }))).resolves.toBe(false);
    await expect(withOrgPrincipal(f.orgId, (tx) => searchPersons(tx, actor, { query: 'x' }))).resolves.toBeDefined();
    expect(await count(f.orgId, 'security.authorize_denied'), 'mutant: the per-store authorize() loop logs the first-store miss').toBe(0);
    expect(await counterRows(f.orgId)).toBe(0);
    // and a person with the capability nowhere is still refused, and THAT is logged
    await expect(withOrgPrincipal(f.orgId, (tx) => searchPersons(tx, f.staff, { query: 'x' }))).rejects.toBeInstanceOf(AuthorizationError);
    expect(await count(f.orgId, 'security.authorize_denied'), 'the real refusal is logged').toBe(1);
  });

  it('T11: EXPLAIN of the first-of-day query touches the current year\'s partitions only - mutant: the recorded_at bound removed', async () => {
    const f = await fixture('t11');
    const captured: unknown[] = [];
    await withOrgPrincipal(f.orgId, async (tx) => {
      const spy = new Proxy(tx as object, {
        get(t, prop) {
          const v = (t as Record<string | symbol, unknown>)[prop];
          if (prop === 'execute') {
            return (q: unknown) => {
              captured.push(q);
              return (v as (x: unknown) => unknown).call(t, q);
            };
          }
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      }) as Tx;
      await authzDenialCountsRepo.registerDenial(spy, { orgId: f.orgId, actorPersonId: f.staffId, capability: ORG_CAP, storeId: null, at: new Date(), count: 1 });
    });
    const dialect = new PgDialect();
    const queries = captured.map((q) => dialect.sqlToQuery(q as never)).filter((q) => /from audit_log/i.test(q.sql));
    expect(queries, 'the first-of-day scan was issued').toHaveLength(1);
    const plan = (await sql.unsafe(`explain (analyze, format json) ${queries[0]!.sql}`, queries[0]!.params as never[])) as unknown as Array<Record<string, unknown>>;
    const touched = new Set<string>();
    const walk = (n: Record<string, unknown>) => {
      const name = n['Relation Name'];
      if (typeof name === 'string' && /^audit_log_/.test(name) && Number(n['Actual Loops'] ?? 0) > 0) touched.add(name);
      for (const c of (n['Plans'] as Array<Record<string, unknown>> | undefined) ?? []) walk(c);
    };
    walk((plan[0]!['QUERY PLAN'] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
    const years = new Set([...touched].map((n) => /(\d{4})$/.exec(n)?.[1] ?? n));
    expect(touched.size, `partitions touched: ${[...touched].join(', ')}`).toBeGreaterThan(0);
    expect(years.size, `one year of partitions only: ${[...touched].join(', ')}`).toBe(1);
    expect(touched.size).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Invariant 18 (this slice\'s half) - no secret in any payload this file wrote', () => {
  it('across every org this file made: no scrypt hash, JWT, PIN, session token, token hash or lookup hash in any audit_log row', async () => {
    expect(orgsMade.length).toBeGreaterThan(5);
    let total = 0;
    for (const orgId of orgsMade) {
      total += await countAll(orgId);
      await expectNoSecrets(orgId);
    }
    expect(total, 'the scan is not vacuous: S2 rows exist to scan').toBeGreaterThan(20);
  });
});
