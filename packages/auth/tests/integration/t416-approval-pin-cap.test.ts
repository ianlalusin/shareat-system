import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-416 (TESTER) - the per-person administrator-PIN miss cap. docs/tasks/416-per-person-pin-budget.md, cases A1-A11, A6b, A13.
 * (A12 - the schema constraints - lives in packages/db/tests/integration/t416-actor-bucket-schema.test.ts.)
 *
 * CONTRACT PINNED HERE (taken from the spec; the builder matches):
 *   - an approval charges ONLY the actor's bucket: sign_in_attempts / pin_attempt_throttle rows carry `actor_person_id`
 *     and NO store_id (migration 0200). Cap = 5 misses per person per rolling 24 h; the attempt that finds 5 trips it.
 *   - a capped person reads APPROVAL_PIN_CAPPED (typed below, byte for byte) for EVERY attempt, correct PIN included,
 *     with ZERO credential lookups. One `auth.approval_pin_capped` audit row, written by the tripping attempt only.
 *   - the cap auto-lifts 24 h after it tripped. `resetApprovalPinCap(tx, actor, personId)` (exported from @shareat/auth)
 *     clears it: needs `manage_users`, refuses self, writes ONE `auth.approval_pin_cap_reset` row only when something was cleared.
 *   - `pinAttemptsRepo.statusForActor(tx, orgId, personId)` returns an object with boolean `capped` (or `stopped`).
 *   - direct org-bucket / actor-bucket charges (A6, A6b) call `pinAttemptsRepo.chargeAttempt(tx, { orgId, deviceId: null,
 *     bucket: { org: true } | { actor } })`. The spec does not name the input key, so the call ALSO passes the old
 *     `storeId: null` (a builder who named the key `bucket` ignores it; the old code reads it).
 *
 * RED FOR THE RIGHT REASON BEFORE 0200: every case whose behaviour needs `actor_person_id` fails on that missing column
 * or on the old store-keyed rows. Time is moved by back-dating rows with SQL, never by sleeping.
 *
 * MUTANTS (one-line edits, run, red, reverted): M1 charge {store}; M2 cap = 50; M2b skip refuseIfCharged; M2c stopped
 * insert omits actor_person_id; M3 also charge the store bucket; M4 key (actor, store); M5 drop actor filter; M6 omit
 * `and actor_person_id is null` in the org arm; M6b keep the 0199 org on-conflict; M7 window 48 h; M8 auto-lift null;
 * M9 skip refund; M10 charge inside the lookup tx; M11a-d (A11); M13 interpolate the name.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const lookups = vi.hoisted(() => ({ n: 0 }));
vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...real,
    sessionsRepo: {
      ...real.sessionsRepo,
      findActiveCredentialByLookupHash: (...args: Parameters<typeof real.sessionsRepo.findActiveCredentialByLookupHash>) => {
        lookups.n++;
        return real.sessionsRepo.findActiveCredentialByLookupHash(...args);
      },
    },
  };
});

import { APP_ROLE, closeDb, pinAttemptsRepo, transaction, type Tx } from '@shareat/db';
import * as auth from '@shareat/auth';
import { AuthorizationError, flushSecurityEvents, hashPin, pinLookupHash, signInWithPin } from '@shareat/auth';

const sql = postgres(url, { max: 8 });

const ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.';
/** The spec's one capped sentence, typed here on purpose. */
const CAPPED =
  'Too many wrong administrator PINs from your account today. An administrator can clear this on your user page, or try again tomorrow.';
const SELF_CLEAR = 'Another administrator must clear this.';
const WRONG = '000000';

type Approve = (
  tx: null,
  input: { actor: { personId: string; orgId: string }; storeId: string | null; pin: string; capability: string; deviceId?: string },
) => Promise<{ approverPersonId: string }>;
const verify = auth.verifyAdminApproval as unknown as Approve;
type Reset = (tx: Tx, actor: { personId: string; orgId: string }, personId: string) => Promise<unknown>;
const resetCap = (): Reset => {
  const fn = (auth as Record<string, unknown>).resetApprovalPinCap;
  if (typeof fn !== 'function') throw new Error('MISSING EXPORT: @shareat/auth does not export resetApprovalPinCap (T-416 not built).');
  return fn as Reset;
};

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;
const nextPin = () => String(300000 + ++pinSeq * 17);

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface Who {
  personId: string;
  pin: string;
}
interface Fixture {
  orgId: string;
  storeId: string;
  admin: Who;
  admin2: Who;
  manager: Who; // plain manager: holds void_expense, NOT manage_users
  manager2: Who;
  cashier: Who; // role staff, open employment, live PIN: signs in
  deviceId: string;
}

async function org(hint: string): Promise<Fixture> {
  const code = uid(`t416-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`;
  const storeId = st!.id;
  const mk = async (name: string, role: string, employed = false): Promise<Who> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    const personId = p!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, 'manual')`;
    if (employed) {
      await sql`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')`;
    }
    const pin = nextPin();
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${personId}, 'pin', ${storeId}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { personId, pin };
  };
  const [dev] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, 'Terminal', 'terminal') returning id`;
  return {
    orgId,
    storeId,
    admin: await mk('Alice Admin', 'admin'),
    admin2: await mk('Bob Admin', 'admin'),
    manager: await mk('Manny Manager', 'manager'),
    manager2: await mk('Mona Manager', 'manager'),
    cashier: await mk('Cara Cashier', 'staff', true),
    deviceId: dev!.id,
  };
}

const actorOf = (f: Fixture, who: Who) => ({ personId: who.personId, orgId: f.orgId });
const approve = (f: Fixture, actor: Who, pin: string, storeId: string | null = f.storeId, capability = 'void_expense') =>
  verify(null, { actor: actorOf(f, actor), storeId, pin, capability });
const msg = (p: Promise<unknown>): Promise<string> => p.then(() => 'OK', (e: Error) => e.message);

/** 5 wrong PINs by `who` - each a plain refusal - then the sixth attempt trips the cap. */
async function capPerson(f: Fixture, who: Who, storeId: string | null = f.storeId) {
  for (let i = 0; i < 5; i++) expect(await msg(approve(f, who, WRONG, storeId))).toBe(ADMIN_PIN_REFUSED);
  expect(await msg(approve(f, who, WRONG, storeId)), 'the sixth attempt trips the cap').toBe(CAPPED);
}

const missesOf = async (f: Fixture, who: Who) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where org_id = ${f.orgId} and actor_person_id = ${who.personId} and kind = 'miss'`)[0]!.n;
const storeMisses = async (storeId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${storeId} and kind = 'miss'`)[0]!.n;
const auditRows = async (orgId: string, action: string, entityId?: string) => {
  await flushSecurityEvents();
  return sql<{ actor_person_id: string | null; entity_id: string; before: any; after: any }[]>`
    select actor_person_id, entity_id, before, after from audit_log
     where org_id = ${orgId} and action = ${action} ${entityId ? sql`and entity_id = ${entityId}` : sql``}`;
};
/** Move a person's cap (and all their attempts) back in time, as if it tripped `ago` ago. */
async function backdate(f: Fixture, who: Who, ago: string) {
  await sql`update sign_in_attempts set occurred_at = occurred_at - ${ago}::interval where org_id = ${f.orgId} and actor_person_id = ${who.personId}`;
  await sql`update pin_attempt_throttle set stopped_at = stopped_at - ${ago}::interval where org_id = ${f.orgId} and actor_person_id = ${who.personId}`;
}
const directCharge = (f: Fixture, bucket: { org: true } | { actor: string }) =>
  asOrg(f.orgId, (tx) =>
    (pinAttemptsRepo.chargeAttempt as any)(tx, { orgId: f.orgId, storeId: null, deviceId: null, bucket }),
  ) as Promise<{ refused: string | null; newlyStopped?: boolean }>;

beforeEach(() => {
  lookups.n = 0;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('A1 a wrong approval is charged to the ACTOR, not to the record store', () => {
  it('A1: one miss row, actor_person_id = actor, store_id NULL; the record store has 0 miss rows (M1)', async () => {
    const f = await org('a1');
    expect(await msg(approve(f, f.manager, WRONG))).toBe(ADMIN_PIN_REFUSED);
    const rows = await sql<{ store_id: string | null; actor_person_id: string | null }[]>`
      select store_id, actor_person_id from sign_in_attempts where org_id = ${f.orgId} and kind = 'miss'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(f.manager.personId);
    expect(rows[0]!.store_id).toBeNull();
    expect(await storeMisses(f.storeId), 'the store sign-in budget is untouched').toBe(0);
  });
});

describe('A2 five misses cap the person; the capped sentence, zero lookups, one audit row', () => {
  it('A2: 5 misses, then the admin CORRECT PIN reads APPROVAL_PIN_CAPPED with zero lookups (M2, M2b, M2c)', async () => {
    const f = await org('a2');
    for (let i = 0; i < 5; i++) expect(await msg(approve(f, f.manager, WRONG)), `miss ${i + 1}`).toBe(ADMIN_PIN_REFUSED);
    lookups.n = 0;
    expect(await msg(approve(f, f.manager, f.admin.pin)), 'the sixth, with a correct admin PIN').toBe(CAPPED);
    expect(lookups.n, 'refused at the charge, before any credential lookup').toBe(0);
    expect(await msg(approve(f, f.manager, f.admin.pin)), 'and still capped on the seventh').toBe(CAPPED);
    expect(lookups.n).toBe(0);

    const cappedRows = await auditRows(f.orgId, 'auth.approval_pin_capped', f.manager.personId);
    expect(cappedRows, 'exactly one row, written by the tripping attempt only').toHaveLength(1);
    expect(cappedRows[0]!.actor_person_id, 'system actor').toBeNull();
    expect(cappedRows[0]!.after).toMatchObject({ cap: 5 });

    const attempts = await sql<{ kind: string; store_id: string | null; actor_person_id: string | null }[]>`
      select kind, store_id, actor_person_id from sign_in_attempts where org_id = ${f.orgId} order by occurred_at, id`;
    expect(attempts.filter((a) => a.kind === 'miss')).toHaveLength(5);
    expect(attempts.filter((a) => a.kind === 'stopped')).toHaveLength(1);
    for (const a of attempts) {
      expect(a.actor_person_id, `${a.kind} row carries the actor`).toBe(f.manager.personId);
      expect(a.store_id, `${a.kind} row has no store`).toBeNull();
    }
    const throttle = await sql<{ store_id: string | null; actor_person_id: string | null; stopped_at: Date | null }[]>`
      select store_id, actor_person_id, stopped_at from pin_attempt_throttle where org_id = ${f.orgId}`;
    expect(throttle).toHaveLength(1);
    expect(throttle[0]!.actor_person_id).toBe(f.manager.personId);
    expect(throttle[0]!.store_id).toBeNull();
    expect(throttle[0]!.stopped_at).not.toBeNull();
  });
});

describe('A3 a capped person does not touch anyone store sign-in', () => {
  it('A3: with the actor capped, a cashier correct PIN signs in at that store; the store is neither paused nor stopped (M3)', async () => {
    const f = await org('a3');
    await capPerson(f, f.manager);
    const r = await signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: f.cashier.pin, deviceId: f.deviceId });
    expect(r).toBeTruthy();
    const store = await sql<{ stopped_at: Date | null; locked_until: Date | null }[]>`
      select stopped_at, locked_until from pin_attempt_throttle where store_id = ${f.storeId}`;
    for (const row of store) {
      expect(row.stopped_at).toBeNull();
      expect(row.locked_until).toBeNull();
    }
    expect(await storeMisses(f.storeId)).toBe(0);
    expect(
      (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${f.storeId} and kind = 'stopped'`)[0]!.n,
    ).toBe(0);
  });
});

describe('A4 the cap is per PERSON, not per (person, store)', () => {
  it('A4: 3 wrong on a store-A record + 2 on a store-B record cap the person (M4)', async () => {
    const f = await org('a4');
    const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('sb')}, 'B') returning id`;
    for (let i = 0; i < 3; i++) expect(await msg(approve(f, f.manager, WRONG, f.storeId))).toBe(ADMIN_PIN_REFUSED);
    for (let i = 0; i < 2; i++) expect(await msg(approve(f, f.manager, WRONG, b!.id))).toBe(ADMIN_PIN_REFUSED);
    expect(await msg(approve(f, f.manager, f.admin.pin, f.storeId)), 'capped at store A').toBe(CAPPED);
    expect(await msg(approve(f, f.manager, f.admin.pin, b!.id)), 'and at store B').toBe(CAPPED);
    expect(await missesOf(f, f.manager)).toBe(5);
  });

  it('A4b (the inverse of T-412 I11): wrong sign-ins at the store and wrong approvals no longer pool', async () => {
    const f = await org('a4b');
    for (let i = 0; i < 5; i++) await msg(signInWithPin(null, { orgId: f.orgId, storeId: f.storeId, pin: WRONG, deviceId: f.deviceId }));
    for (let i = 0; i < 4; i++) expect(await msg(approve(f, f.manager, WRONG))).toBe(ADMIN_PIN_REFUSED);
    expect(await missesOf(f, f.manager), 'four approval misses on the actor').toBe(4);
    expect(await storeMisses(f.storeId), 'five sign-in misses on the store').toBe(5);
    expect(await approve(f, f.manager, f.admin.pin), 'not capped: the approval goes through').toEqual({ approverPersonId: f.admin.personId });
  });
});

describe('A5 one person cap is nobody else', () => {
  it('A5: P capped; Q in the same org approves with the admin PIN (M5)', async () => {
    const f = await org('a5');
    await capPerson(f, f.manager);
    expect(await approve(f, f.manager2, f.admin.pin)).toEqual({ approverPersonId: f.admin.personId });
    expect(await msg(approve(f, f.manager, f.admin.pin)), 'P is still capped').toBe(CAPPED);
  });
});

describe('A6 / A6b the organisation bucket and the actor buckets coexist', () => {
  it('A6: 50 actor-bucket misses in the last hour (several persons) do not count against the org bucket (M6)', async () => {
    const f = await org('a6');
    const people = [f.admin, f.admin2, f.manager, f.manager2, f.cashier];
    for (const p of people) {
      await sql`
        insert into sign_in_attempts (org_id, actor_person_id, kind, occurred_at)
        select ${f.orgId}::uuid, ${p.personId}::uuid, 'miss', now() - interval '1 hour' from generate_series(1, 10)`;
    }
    const charge = await directCharge(f, { org: true });
    expect(charge.refused, 'the org bucket is not stopped by other buckets rows').toBeNull();
    const own = await sql<{ n: number }[]>`
      select count(*)::int as n from sign_in_attempts
       where org_id = ${f.orgId} and store_id is null and actor_person_id is null and kind = 'miss'`;
    expect(own[0]!.n, 'the org bucket own count, read directly').toBe(1);
  });

  it('A6b: an org-bucket charge and actor-bucket charges in one org all succeed (no 42P10, no unique violation) (M6b)', async () => {
    const f = await org('a6b');
    expect((await directCharge(f, { org: true })).refused).toBeNull();
    expect(await msg(approve(f, f.manager, WRONG))).toBe(ADMIN_PIN_REFUSED);
    expect(await msg(approve(f, f.manager2, WRONG))).toBe(ADMIN_PIN_REFUSED);
    expect((await directCharge(f, { org: true })).refused).toBeNull();
    expect((await directCharge(f, { actor: f.admin.personId })).refused).toBeNull();
    const t = await sql<{ store_id: string | null; actor_person_id: string | null }[]>`
      select store_id, actor_person_id from pin_attempt_throttle where org_id = ${f.orgId}`;
    expect(t.filter((r) => r.actor_person_id === null && r.store_id === null), 'one org-bucket row').toHaveLength(1);
    expect(t.filter((r) => r.actor_person_id !== null), 'three person rows').toHaveLength(3);
  });
});

describe('A7 the window is a rolling 24 hours', () => {
  it('A7: five misses 25 h old do not count; four fresh wrong ones still leave the person uncapped (M7)', async () => {
    const f = await org('a7');
    await sql`
      insert into sign_in_attempts (org_id, actor_person_id, kind, occurred_at)
      select ${f.orgId}::uuid, ${f.manager.personId}::uuid, 'miss', now() - interval '25 hours' from generate_series(1, 5)`;
    for (let i = 0; i < 4; i++) expect(await msg(approve(f, f.manager, WRONG)), `fresh miss ${i + 1}`).toBe(ADMIN_PIN_REFUSED);
    expect(await approve(f, f.manager, f.admin.pin), 'not capped').toEqual({ approverPersonId: f.admin.personId });
  });
});

describe('A8 the cap lifts by itself 24 hours after it tripped', () => {
  it('A8: tripped 24 h + 1 min ago, no reset: the next correct approval succeeds (M8)', async () => {
    const f = await org('a8');
    await capPerson(f, f.manager);
    expect(await msg(approve(f, f.manager, f.admin.pin)), 'control: capped now').toBe(CAPPED);
    await backdate(f, f.manager, '24 hours 1 minute');
    expect(await approve(f, f.manager, f.admin.pin)).toEqual({ approverPersonId: f.admin.personId });
  });
});

describe('A9 a correct PIN refunds its charge on the actor bucket', () => {
  it('A9: ten correct approvals leave 0 miss rows; the next wrong one is a plain refusal (M9)', async () => {
    const f = await org('a9');
    for (let i = 0; i < 10; i++) {
      expect(await approve(f, f.manager, f.admin.pin), `approval ${i + 1}`).toEqual({ approverPersonId: f.admin.personId });
    }
    expect(await missesOf(f, f.manager)).toBe(0);
    expect(await msg(approve(f, f.manager, WRONG))).toBe(ADMIN_PIN_REFUSED);
  });
});

describe('A10 the miss survives the throw (tx = null)', () => {
  it('A10: a wrong approval miss row and tier-1 count are committed although the call threw (M10)', async () => {
    const f = await org('a10');
    expect(await msg(approve(f, f.manager, WRONG))).toBe(ADMIN_PIN_REFUSED);
    expect(await missesOf(f, f.manager)).toBe(1);
    const t = await sql<{ fail_count: number }[]>`select fail_count from pin_attempt_throttle where org_id = ${f.orgId} and actor_person_id = ${f.manager.personId}`;
    expect(t[0]?.fail_count).toBe(1);
  });
});

describe('A11 an administrator clears the cap', () => {
  it('A11: admin clears P -> P approves again; exactly one auth.approval_pin_cap_reset row (admin, P, before/after)', async () => {
    const f = await org('a11');
    await capPerson(f, f.manager);
    await asOrg(f.orgId, (tx) => resetCap()(tx, actorOf(f, f.admin), f.manager.personId));
    expect(await approve(f, f.manager, f.admin.pin), 'P approves again').toEqual({ approverPersonId: f.admin.personId });
    const rows = await auditRows(f.orgId, 'auth.approval_pin_cap_reset');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(f.admin.personId);
    expect(rows[0]!.entity_id).toBe(f.manager.personId);
    expect(rows[0]!.before).toHaveProperty('cappedAt');
    expect(rows[0]!.before.cappedAt).toBeTruthy();
    expect(rows[0]!.after).toHaveProperty('resetAt');
    expect(rows[0]!.after.resetAt).toBeTruthy();
  });

  it('A11b: a plain manager is refused (manage_users) and the cap stays (M11a)', async () => {
    const f = await org('a11b');
    await capPerson(f, f.manager2);
    const err = await asOrg(f.orgId, (tx) => resetCap()(tx, actorOf(f, f.manager), f.manager2.personId)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(await msg(approve(f, f.manager2, f.admin.pin)), 'still capped').toBe(CAPPED);
    expect(await auditRows(f.orgId, 'auth.approval_pin_cap_reset')).toHaveLength(0);
  });

  it('A11c: an administrator clearing their OWN cap is refused with the one sentence; the cap stays (M11b)', async () => {
    const f = await org('a11c');
    await capPerson(f, f.admin2); // an administrator holds manage_users, so only the self check can refuse
    const m = await msg(asOrg(f.orgId, (tx) => resetCap()(tx, actorOf(f, f.admin2), f.admin2.personId)));
    expect(m).toContain(SELF_CLEAR);
    expect(await msg(approve(f, f.admin2, f.admin.pin)), 'still capped').toBe(CAPPED);
    expect(await auditRows(f.orgId, 'auth.approval_pin_cap_reset')).toHaveLength(0);
    // another administrator can
    await asOrg(f.orgId, (tx) => resetCap()(tx, actorOf(f, f.admin), f.admin2.personId));
    expect(await approve(f, f.admin2, f.admin.pin)).toEqual({ approverPersonId: f.admin.personId });
  });

  it('A11d: clearing a person who is not capped writes nothing (M11c)', async () => {
    const f = await org('a11d');
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from pin_attempt_throttle where org_id = ${f.orgId}`)[0]!.n;
    await asOrg(f.orgId, (tx) => resetCap()(tx, actorOf(f, f.admin), f.manager.personId));
    expect(await auditRows(f.orgId, 'auth.approval_pin_cap_reset')).toHaveLength(0);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from pin_attempt_throttle where org_id = ${f.orgId}`)[0]!.n).toBe(before);
  });

  it('A11e: a cap that auto-lifted reads "not capped"; clearing it is a no-op with no audit row (M11d)', async () => {
    const f = await org('a11e');
    await capPerson(f, f.manager);
    const status = () => asOrg(f.orgId, (tx) => pinAttemptsRepo.statusForActor(tx, f.orgId, f.manager.personId));
    const live = await status();
    expect(live.capped, 'control: capped right now').toBe(true);
    await backdate(f, f.manager, '24 hours 1 minute');
    const lifted = await status();
    expect(lifted.capped, 'auto-lifted: not capped').toBe(false);
    await asOrg(f.orgId, (tx) => resetCap()(tx, actorOf(f, f.admin), f.manager.personId));
    expect(await auditRows(f.orgId, 'auth.approval_pin_cap_reset'), 'no audit row for clearing a lifted cap').toHaveLength(0);
  });
});

describe('A13 the capped sentence leaks nothing', () => {
  it('A13: the same string for every capped person; no name, id, digit or time (M13)', async () => {
    const f = await org('a13');
    const seen: string[] = [];
    for (const who of [f.manager, f.manager2]) {
      await capPerson(f, who);
      seen.push(await msg(approve(f, who, f.admin.pin)));
    }
    expect(seen).toEqual([CAPPED, CAPPED]);
    expect(CAPPED).not.toMatch(/\d/);
    for (const name of ['Manny', 'Mona', 'Alice']) expect(seen.join('|')).not.toContain(name);
    expect(seen.join('|')).not.toContain(f.manager.personId);
  });
});
