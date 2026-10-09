import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-395 S1 against real Postgres. docs/tasks/395-pin-sign-in-throttle.md (tests 1-15, minus 11).
 *
 * Time is moved by back-dating rows with SQL (the T-303 tests' idiom), never by sleeping.
 * Lookups are counted by wrapping `sessionsRepo.findActiveCredentialByLookupHash` through a
 * `vi.mock` of `@shareat/db` (a module namespace cannot be `vi.spyOn`'d). Every "wrong PIN" in a
 * lookup-count test is WELL-FORMED: a malformed PIN is refused before the lookup and proves nothing.
 *
 * Test 11 (option b) calls chargeAttempt(tx, charge, { stopAutoReopenMinutes: 60 }) directly (coordinator ruling).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

const lookups = vi.hoisted(() => ({ n: 0 }));
vi.mock('@shareat/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/db')>();
  return {
    ...real,
    sessionsRepo: {
      ...real.sessionsRepo,
      findActiveCredentialByLookupHash: (
        ...args: Parameters<typeof real.sessionsRepo.findActiveCredentialByLookupHash>
      ) => {
        lookups.n++;
        return real.sessionsRepo.findActiveCredentialByLookupHash(...args);
      },
    },
  };
});

import { closeDb, withOrgPrincipal, pinAttemptsRepo } from '@shareat/db';
import { signInWithPin, signInWithFirebase, hashPin, pinLookupHash, AuthenticationError } from '@shareat/auth';

const sql = postgres(url, { max: 8 });

const BAD_PIN = 'Sign-in failed: that PIN is not valid.';
const STOPPED =
  /PIN sign-in is stopped at this store after too many wrong PINs today\. A manager can reopen it: sign in with email and password, then open Staff\./;
const PAUSED = /paused until/;
const WRONG = '000000'; // well-formed, never issued to anyone in these fixtures

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  storeId: string;
  storeId2: string;
  personId: string;
  adminId: string;
  deviceId: string; // the terminal's persons.id
  pin: string;
}

async function setup(hint: string, pin = '123456'): Promise<Fixture> {
  const code = uid(`t395-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  const mkStore = async (h: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id
    `;
    return r!.id;
  };
  const mkPerson = async (n: string, kind = 'person') => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name, kind) values (${orgId}, ${n}, ${kind}) returning id
    `;
    return r!.id;
  };
  const storeId = await mkStore(`${hint}-s1`);
  const storeId2 = await mkStore(`${hint}-s2`);
  const personId = await mkPerson(`${hint} Cashier`);
  const adminId = await mkPerson(`${hint} Admin`);
  const deviceId = await mkPerson(`${hint} Terminal`, 'terminal');
  await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`;
  await sql`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})
  `;
  return { orgId, storeId, storeId2, personId, adminId, deviceId, pin };
}

const attempt = (f: Fixture, pin: string, deviceId: string | null = f.deviceId, storeId = f.storeId) =>
  signInWithPin(null, { orgId: f.orgId, storeId, pin, ...(deviceId ? { deviceId } : {}) });

const msg = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (e: Error) => e.message,
  );

async function seedAttempts(f: Fixture, kind: string, n: number, ago: string) {
  await sql`
    insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
    select ${f.orgId}::uuid, ${f.storeId}::uuid, ${f.deviceId}::uuid, ${kind}, now() - ${ago}::interval
    from generate_series(1, ${n}::int)
  `;
}
const countKind = async (f: Fixture, kind: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${f.storeId} and kind = ${kind}`)[0]!.n;
const countAll = async (f: Fixture) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${f.storeId}`)[0]!.n;
const throttleRow = async (f: Fixture) =>
  (
    await sql<{ fail_count: number; locked_until: Date | null; stopped_at: Date | null }[]>`
      select fail_count, locked_until, stopped_at from pin_attempt_throttle where store_id = ${f.storeId}`
  )[0];

/** Put a store into the stopped state the spec's own way: 50 recent misses, then one attempt trips it. */
async function stopStore(f: Fixture) {
  await seedAttempts(f, 'miss', 50, '1 hour');
  expect(await msg(attempt(f, WRONG))).toMatch(STOPPED);
}

beforeEach(() => {
  lookups.n = 0;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe("fixture sanity (green on today's code; proves the counters below measure something)", () => {
  it('the correct PIN signs in; a well-formed wrong PIN reaches the lookup once; a malformed PIN never does', async () => {
    const f = await setup('sanity');
    expect(await msg(attempt(f, f.pin))).toBe('OK');
    expect(lookups.n).toBe(1);

    lookups.n = 0;
    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
    expect(lookups.n).toBe(1);

    lookups.n = 0;
    expect(await msg(attempt(f, 'not-a-pin'))).toBe(BAD_PIN);
    expect(lookups.n).toBe(0);

    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from persons where id = ${f.deviceId} and kind = 'terminal'`;
    expect(row!.n).toBe(1);
  });
});

describe('T-395 S1 — tier 2, the daily budget (tests 1-8)', () => {
  it('test 1 — a patient guesser (9 misses a window) is stopped at the 50th miss; the next attempt, with the CORRECT PIN, is refused with no lookup', async () => {
    const f = await setup('patient');
    for (let i = 0; i < 50; i++) {
      expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
      if ((i + 1) % 9 === 0) {
        await sql`update pin_attempt_throttle set window_started_at = now() - interval '61 seconds' where store_id = ${f.storeId}`;
      }
    }
    lookups.n = 0;
    expect(await msg(attempt(f, f.pin))).toMatch(STOPPED);
    expect(lookups.n).toBe(0);
  });

  it('test 2 — a correct sign-in after every 9th miss does not refill the budget; its own rows vanish, the others stay', async () => {
    const f = await setup('own-pin-reset');
    let misses = 0;
    while (misses < 50) {
      for (let i = 0; i < 9 && misses < 50; i++, misses++) expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
      if (misses < 50) expect(await msg(attempt(f, f.pin))).toBe('OK');
    }
    lookups.n = 0;
    expect(await msg(attempt(f, f.pin))).toMatch(STOPPED);
    expect(lookups.n).toBe(0);
    expect(await countKind(f, 'miss')).toBe(50);
    expect(await countKind(f, 'stopped')).toBe(1);
    expect(await countAll(f)).toBe(51);
  });

  it('test 3 — only the last 24 hours count: 49 misses from 25 hours ago do not stop anything', async () => {
    const f = await setup('window24');
    await seedAttempts(f, 'miss', 49, '25 hours');
    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
    expect(lookups.n).toBe(2);
    expect((await throttleRow(f))!.stopped_at).toBeNull();
  });

  it('test 4 — only since the last reopen: stop, reopen, then misses are not stopped (the old 50 stay uncounted)', async () => {
    const f = await setup('since-reopen');
    await stopStore(f);
    await sql`
      update pin_attempt_throttle
         set stopped_at = null, reopened_at = now(), reopened_by = ${f.adminId},
             fail_count = 0, window_started_at = null, locked_until = null
       where store_id = ${f.storeId}`;
    lookups.n = 0;
    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
    expect(lookups.n).toBe(2);
    expect((await throttleRow(f))!.stopped_at).toBeNull();
  });

  it('test 5 — only misses count: 49 misses plus 10 lockout rows is not stopped; the 50th miss stops the next attempt', async () => {
    const f = await setup('kind-filter');
    await seedAttempts(f, 'miss', 49, '1 hour');
    await seedAttempts(f, 'lockout', 10, '1 hour');
    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN); // charged: the 50th miss
    expect(await countKind(f, 'miss')).toBe(50);
    lookups.n = 0;
    expect(await msg(attempt(f, WRONG))).toMatch(STOPPED);
    expect(lookups.n).toBe(0);
  });

  it('test 6 — a success leaves no row, including the lockout row it wrote on the 10th attempt; a refusal writes none', async () => {
    const f = await setup('refund');
    for (let i = 0; i < 9; i++) await msg(attempt(f, WRONG));
    expect(await countKind(f, 'miss')).toBe(9);
    // the 10th attempt is CORRECT: its charge reaches the tier-1 threshold (writes a lockout row), then it is refunded
    expect(await msg(attempt(f, f.pin))).toBe('OK');
    expect(await countKind(f, 'miss')).toBe(9);
    expect(await countKind(f, 'lockout')).toBe(0);
    const t = await throttleRow(f);
    expect(t!.fail_count).toBe(0);
    expect(t!.locked_until).toBeNull();

    // refusal while paused writes nothing
    const g = await setup('refusal-paused');
    for (let i = 0; i < 10; i++) await msg(attempt(g, WRONG));
    const before = await countAll(g);
    expect(before).toBe(11); // ten misses + one lockout
    expect(await msg(attempt(g, WRONG))).toMatch(PAUSED);
    expect(await countAll(g)).toBe(before);

    // refusal while stopped writes nothing (the trip itself wrote the one 'stopped' row)
    const h = await setup('refusal-stopped');
    await stopStore(h);
    const afterStop = await countAll(h);
    expect(afterStop).toBe(51);
    expect(await msg(attempt(h, WRONG))).toMatch(STOPPED);
    expect(await msg(attempt(h, h.pin))).toMatch(STOPPED);
    expect(await countAll(h)).toBe(afterStop);
  });

  it("test 6b — a correct and a wrong PIN in parallel: only the success's own row is refunded, the wrong PIN's row stays (kills a refund of every row since the charge)", async () => {
    // Charge order between the two is not controlled, so repeat: in some rounds the success is charged first
    // and the wrong PIN is charged while the success's scrypt runs; a refund by time would delete the wrong row.
    for (let round = 0; round < 12; round++) {
      const f = await setup(`parallel-${round}`);
      for (let i = 0; i < 5; i++) expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
      expect(await countKind(f, 'miss')).toBe(5);

      const [ok, bad] = await Promise.all([msg(attempt(f, f.pin)), msg(attempt(f, WRONG))]);
      expect(ok).toBe('OK');
      expect(bad).toBe(BAD_PIN);
      expect(await countKind(f, 'miss')).toBe(6); // 5 + the wrong PIN's; the success's own row is gone
      expect(await countKind(f, 'lockout')).toBe(0);
    }
  });

  it('test 7 — I5: an unknown PIN and a real-person-other-store PIN leave identical rows', async () => {
    const f = await setup('parity');
    const [other] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Elsewhere') returning id`;
    await sql`insert into person_store_scope (person_id, store_id) values (${other!.id}, ${f.storeId2})`;
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${other!.id}, 'pin', ${f.storeId2}, ${await hashPin('654321')}, ${pinLookupHash(f.orgId, '654321')})`;

    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN); // unknown
    expect(await msg(attempt(f, '654321'))).toBe(BAD_PIN); // real person, wrong store

    const rows = await sql`
      select org_id, store_id, device_id, kind from sign_in_attempts where store_id = ${f.storeId} order by occurred_at, id`;
    expect(rows.length).toBe(2);
    expect({ ...rows[0] }).toEqual({ ...rows[1] });
    expect(rows[0]!.kind).toBe('miss');
  });

  it('test 8 — I6: sign_in_attempts has exactly the specified columns', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'sign_in_attempts' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(['device_id', 'id', 'kind', 'occurred_at', 'org_id', 'store_id']);
  });
});

describe('T-395 S1 — DEF-626, charge before the lookup under the store row lock (tests 9, 10)', () => {
  it('test 9 — 60 parallel well-formed wrong PINs from a clean store: exactly 10 lookups, 10 misses, one lockout; the other 50 get the pause sentence', async () => {
    const f = await setup('burst-tier1');
    const results = await Promise.all(Array.from({ length: 60 }, () => msg(attempt(f, WRONG))));
    // DEF-626: today's check-then-record lets many lookups run before any miss commits.
    expect(lookups.n).toBe(10);
    expect(results.filter((r) => r === BAD_PIN).length).toBe(10);
    expect(results.filter((r) => PAUSED.test(r)).length).toBe(50);
    expect((await throttleRow(f))!.fail_count).toBe(10);
    expect(await countKind(f, 'miss')).toBe(10);
    expect(await countKind(f, 'lockout')).toBe(1);
  });

  it('test 10 — tier-2 burst: 45 misses in the window, then 60 parallel wrong PINs: exactly 5 lookups, one stopped row', async () => {
    const f = await setup('burst-tier2');
    await seedAttempts(f, 'miss', 45, '1 hour');
    const results = await Promise.all(Array.from({ length: 60 }, () => msg(attempt(f, WRONG))));
    expect(lookups.n).toBe(5);
    expect(results.filter((r) => r === BAD_PIN).length).toBe(5);
    expect(results.filter((r) => STOPPED.test(r)).length).toBe(55);
    expect(await countKind(f, 'miss')).toBe(50);
    expect(await countKind(f, 'stopped')).toBe(1);
  });
});

describe('T-395 S1 — option b, attribution, retention, email, RLS (tests 11-15)', () => {
  it('test 11 — option b (opts.stopAutoReopenMinutes = 60): an expired stop is charged, 50 further misses stop it again with a new stopped_at and a second stopped row', async () => {
    const f = await setup('option-b');
    await stopStore(f);
    const first = (await throttleRow(f))!.stopped_at!;
    await sql`update pin_attempt_throttle set stopped_at = now() - interval '61 minutes' where store_id = ${f.storeId}`;
    const charge = (): Promise<{ refused: string | null }> =>
      withOrgPrincipal(f.orgId, (tx) =>
        pinAttemptsRepo.chargeAttempt(
          tx,
          { orgId: f.orgId, storeId: f.storeId, deviceId: f.deviceId },
          { stopAutoReopenMinutes: 60 },
        ),
      );
    const clearTier1 = () =>
      sql`update pin_attempt_throttle set fail_count = 0, window_started_at = null, locked_until = null where store_id = ${f.storeId}`;

    // the 50 misses from before the expiry do not count: 50 further charges all go through
    for (let i = 0; i < 50; i++) {
      expect((await charge()).refused).toBeNull();
      await clearTier1();
    }
    expect((await charge()).refused).toBe('stopped');
    expect(await countKind(f, 'stopped')).toBe(2);
    const second = (await throttleRow(f))!.stopped_at!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    // a live stop (stopped_at just now) refuses without writing
    expect((await charge()).refused).toBe('stopped');
    expect(await countKind(f, 'stopped')).toBe(2);
  });

  it('test 12 — a miss through signInWithPin(null, {deviceId}) writes that device_id; with no deviceId it writes null', async () => {
    const f = await setup('device');
    expect(await msg(attempt(f, WRONG, f.deviceId))).toBe(BAD_PIN);
    expect(await msg(attempt(f, WRONG, null))).toBe(BAD_PIN);
    const rows = await sql<{ device_id: string | null }[]>`
      select device_id from sign_in_attempts where store_id = ${f.storeId} and kind = 'miss' order by occurred_at, id`;
    expect(rows.map((r) => r.device_id)).toEqual([f.deviceId, null]);
  });

  it("test 13 — retention: a charge purges THIS org's 91-day-old rows (500 per charge), never another org's", async () => {
    const f = await setup('retention');
    const other = await setup('retention-other');
    await sql`
      insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
      select ${f.orgId}::uuid, ${f.storeId}::uuid, ${f.deviceId}::uuid, 'miss', now() - interval '91 days' from generate_series(1, 600)`;
    await sql`
      insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
      select ${other.orgId}::uuid, ${other.storeId}::uuid, ${other.deviceId}::uuid, 'miss', now() - interval '91 days' from generate_series(1, 5)`;
    const old = async (orgId: string) =>
      (
        await sql<{ n: number }[]>`
          select count(*)::int as n from sign_in_attempts
           where org_id = ${orgId} and occurred_at < now() - interval '90 days'`
      )[0]!.n;

    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
    expect(await old(f.orgId)).toBe(100); // 600 minus one batch of 500
    expect(await old(other.orgId)).toBe(5);

    expect(await msg(attempt(f, WRONG))).toBe(BAD_PIN);
    expect(await old(f.orgId)).toBe(0);
    expect(await old(other.orgId)).toBe(5);
  });

  it('test 14 — I11: email sign-in succeeds while the store is stopped', async () => {
    const f = await setup('email-while-stopped');
    await stopStore(f);
    const externalId = uid('fbuid-t395');
    await sql`insert into person_credentials (person_id, kind, external_id) values (${f.adminId}, 'firebase', ${externalId})`;
    const session = await signInWithFirebase(null, { verifiedUid: externalId });
    expect(session.personId).toBe(f.adminId);
  });

  it("test 15 — RLS: org B cannot see org A's rows, and cannot insert with org A's id", async () => {
    const a = await setup('rls-a');
    const b = await setup('rls-b');
    await seedAttempts(a, 'miss', 3, '1 hour');

    const visible = await withOrgPrincipal(b.orgId, (tx) =>
      tx.execute(dsql`select count(*)::int as n from sign_in_attempts where store_id = ${a.storeId}`),
    );
    expect((visible as unknown as { n: number }[])[0]!.n).toBe(0);

    // the principal is org B, the claimed org_id is org A: WITH CHECK must refuse (not a trivially-satisfied pair)
    await expect(
      withOrgPrincipal(b.orgId, (tx) =>
        tx.execute(
          dsql`insert into sign_in_attempts (org_id, store_id, device_id, kind) values (${a.orgId}, ${a.storeId}, ${a.deviceId}, 'miss')`,
        ),
      ),
    ).rejects.toThrow();
    expect(await countKind(a, 'miss')).toBe(3);
  });
});

describe('the refusal type is unchanged', () => {
  it('a stopped store refuses with AuthenticationError', async () => {
    const f = await setup('error-type');
    await stopStore(f);
    await expect(attempt(f, f.pin)).rejects.toThrow(AuthenticationError);
  });
});
