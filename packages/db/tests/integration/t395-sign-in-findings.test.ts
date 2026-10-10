import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-395 S2, test 16 - the two sign-in findings. docs/tasks/395-pin-sign-in-throttle.md section Findings (R12).
 *
 * TESTER, not BUILDER. Time is moved by seeding `sign_in_attempts` rows at Manila wall-clock times with SQL.
 * Rows are written straight into the table (migration 0190, S1 is built), so the only missing piece at HEAD is the two
 * detectors in `packages/db/src/repo/findings.ts` spread into `listFindings`.
 *
 * ## Why every NEGATIVE leg carries a POSITIVE control
 * "No finding" passes vacuously on HEAD (no detector exists). Each negative leg therefore also seeds a condition that
 * MUST fire at a different terminal or store, and asserts that key is present. On HEAD the control assertion is the
 * red line: "20 misses at one terminal on one Manila day must raise pinSignInFailures:...", so a leg is never green
 * for the wrong reason.
 *
 * ## Mutants (spec test 16), each caught by the named leg
 *  - `>` instead of `>=` at 20: F1/F2 (19 none, 20 fires).
 *  - severity `hard`: F9 (severity soft) and F10 (severity soft, closeReadiness blocking).
 *  - grouping by store only: F5 (two terminals at one store give two keys).
 *  - grouping by UTC day instead of Manila day: F6a and F6b.
 *  - summing the whole week instead of one day: F7.
 *  - lockout ignored: F3.   - 7-day lookback dropped: F4.   - null device not keyed 'none': F8.
 * A missing org_id filter is NOT a killable mutant (listFindings runs under the principal; RLS filters anyway).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, pinAttemptsRepo, type Tx } from '@shareat/db';
import { listFindings, closeReadiness } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface F {
  orgId: string;
  storeA: string;
  storeB: string;
  storeAName: string;
  termA1: string;
  termA2: string;
  termB1: string;
  termA1Name: string;
  managerId: string;
}

async function fixture(hint: string): Promise<F> {
  const code = uid(`t395f-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${`Store ${n}`}) returning id`)[0]!.id;
  const mkPerson = async (n: string, kind = 'person') =>
    (await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${n}, ${kind}) returning id`)[0]!.id;
  const storeA = await mkStore(`${hint}A`);
  const storeB = await mkStore(`${hint}B`);
  const termA1 = await mkPerson(`${hint} Till One`, 'terminal');
  const termA2 = await mkPerson(`${hint} Till Two`, 'terminal');
  const termB1 = await mkPerson(`${hint} Back Till`, 'terminal');
  const managerId = await mkPerson(`${hint} Manager`);
  return {
    orgId, storeA, storeB, storeAName: `Store ${hint}A`, termA1, termA2, termB1, termA1Name: `${hint} Till One`, managerId,
  };
}

/** n rows of `kind` at Manila wall-clock `time` on the Manila date `daysAgo` days before Manila today. */
async function seed(
  f: F, storeId: string, deviceId: string | null, kind: 'miss' | 'lockout' | 'stopped', n: number, daysAgo: number, time = '10:00',
) {
  await sql`
    insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
    select ${f.orgId}::uuid, ${storeId}::uuid, ${deviceId}::uuid, ${kind},
           ((((now() at time zone 'Asia/Manila')::date - ${daysAgo}::int) + ${time}::time) at time zone 'Asia/Manila')
    from generate_series(1, ${n}::int)`;
}

async function period(): Promise<string> {
  const [r] = await sql<{ p: string }[]>`select to_char(now() at time zone 'Asia/Manila', 'YYYY-MM') as p`;
  return r!.p;
}
async function feed(f: F) {
  return asOrg(f.orgId, async (tx) => (await listFindings(tx, f.orgId, { period: await period() })).findings);
}
const failuresKey = (storeId: string, deviceId: string | null) => `pinSignInFailures:${storeId}:${deviceId ?? 'none'}`;
const stoppedKey = (storeId: string) => `pinSignInStopped:${storeId}`;
const byKey = <T extends { key: string }>(all: T[], key: string) => all.find((x) => x.key === key);

/** The control every negative leg runs: 20 misses at store B's terminal must fire. Red on HEAD, by name. */
async function controlFires(f: F) {
  await seed(f, f.storeB, f.termB1, 'miss', 20, 1);
  const all = await feed(f);
  const c = byKey(all, failuresKey(f.storeB, f.termB1));
  expect(c, `control: 20 misses at one terminal on one Manila day must raise ${failuresKey(f.storeB, f.termB1)}`).toBeDefined();
  return all;
}

describe('T-395 S2 test 16 - pinSignInFailures', () => {
  it('F1: 19 misses in a Manila day give no finding, 20 give one (soft, store-scoped, terminal named)', async () => {
    const f = await fixture('f1');
    await seed(f, f.storeA, f.termA1, 'miss', 19, 1);
    await seed(f, f.storeB, f.termB1, 'miss', 20, 1);
    const all = await feed(f);
    const hit = byKey(all, failuresKey(f.storeB, f.termB1));
    expect(hit, 'F1: 20 misses at one terminal in one Manila day must raise a pinSignInFailures finding').toBeDefined();
    expect(hit!.kind).toBe('pinSignInFailures');
    expect(hit!.severity).toBe('soft');
    expect(hit!.storeId).toBe(f.storeB);
    expect(hit!.detail).toContain('20 wrong PINs at');
    expect(hit!.detail).toContain('f1 Back Till');
    expect(byKey(all, failuresKey(f.storeA, f.termA1)), '19 misses is below the bar of 20').toBeUndefined();
  });

  it('F2: the detail names the terminal and the store in the spec words', async () => {
    const f = await fixture('f2');
    await seed(f, f.storeA, f.termA1, 'miss', 20, 2);
    const hit = byKey(await feed(f), failuresKey(f.storeA, f.termA1));
    expect(hit, 'F2: 20 misses two Manila days ago is inside the 7-day lookback').toBeDefined();
    expect(hit!.detail).toContain(`20 wrong PINs at ${f.termA1Name} (${f.storeAName})`);
    expect(hit!.detail).toContain('A wrong PIN does not say who typed it.');
  });

  it('F3: one lockout alone (no misses over the bar) gives a finding', async () => {
    const f = await fixture('f3');
    await seed(f, f.storeA, f.termA1, 'lockout', 1, 1);
    const hit = byKey(await feed(f), failuresKey(f.storeA, f.termA1));
    expect(hit, 'F3: a single lockout row at a terminal must raise pinSignInFailures').toBeDefined();
    expect(hit!.severity).toBe('soft');
  });

  it('F4: rows 8 days old give none (the 7-day lookback), even 40 misses and a lockout', async () => {
    const f = await fixture('f4');
    await seed(f, f.storeA, f.termA1, 'miss', 40, 8);
    await seed(f, f.storeA, f.termA1, 'lockout', 1, 8);
    const all = await controlFires(f);
    expect(byKey(all, failuresKey(f.storeA, f.termA1)), 'rows 8 Manila days old are outside the lookback').toBeUndefined();
  });

  it('F5: two terminals at one store give two keys (the key is per terminal, not per store)', async () => {
    const f = await fixture('f5');
    await seed(f, f.storeA, f.termA1, 'miss', 20, 1);
    await seed(f, f.storeA, f.termA2, 'miss', 20, 1);
    const all = (await feed(f)).filter((x) => x.kind === 'pinSignInFailures');
    expect(byKey(all, failuresKey(f.storeA, f.termA1)), 'F5: terminal 1 key').toBeDefined();
    expect(byKey(all, failuresKey(f.storeA, f.termA2)), 'F5: terminal 2 key').toBeDefined();
    expect(all.filter((x) => x.storeId === f.storeA)).toHaveLength(2);
  });

  it('F5b: 10 misses at each of two terminals (20 for the store) is NOT a finding for either terminal', async () => {
    const f = await fixture('f5b');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 1);
    await seed(f, f.storeA, f.termA2, 'miss', 10, 1);
    const all = await controlFires(f);
    expect(all.filter((x) => x.kind === 'pinSignInFailures' && x.storeId === f.storeA), 'the bar is per terminal').toHaveLength(0);
  });

  it('F6a: 10 misses at 23:30 Manila and 10 at 00:30 the next Manila day (one UTC day) is NOT a finding', async () => {
    const f = await fixture('f6a');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 3, '23:30');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 2, '00:30');
    const all = await controlFires(f);
    expect(byKey(all, failuresKey(f.storeA, f.termA1)), 'two Manila days, 10 each; a UTC-day grouping would wrongly see 20').toBeUndefined();
  });

  it('F6b: 20 misses inside one Manila day that straddle UTC midnight (06:00 and 10:00 Manila) ARE a finding', async () => {
    const f = await fixture('f6b');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 2, '06:00');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 2, '10:00');
    expect(
      byKey(await feed(f), failuresKey(f.storeA, f.termA1)),
      'one Manila day, 20 misses; a UTC-day grouping would split them across two days',
    ).toBeDefined();
  });

  it('F7: 10 misses on each of two days is NOT a finding (the bar is one Manila day, not the week)', async () => {
    const f = await fixture('f7');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 2);
    await seed(f, f.storeA, f.termA1, 'miss', 10, 3);
    const all = await controlFires(f);
    expect(byKey(all, failuresKey(f.storeA, f.termA1))).toBeUndefined();
  });

  it('F4b: the lookback edge (Ian ruling): "last 7 Manila days" = today and the 6 before; today-6 is INCLUDED, today-7 is EXCLUDED', async () => {
    const f = await fixture('f4b');
    await seed(f, f.storeA, f.termA1, 'miss', 20, 6);
    await seed(f, f.storeB, f.termB1, 'miss', 20, 7);
    const all = await feed(f);
    expect(byKey(all, failuresKey(f.storeA, f.termA1)), 'today-6 is inside the 7 Manila days').toBeDefined();
    expect(byKey(all, failuresKey(f.storeB, f.termB1)), 'today-7 is outside the 7 Manila days').toBeUndefined();
  });

  it("F8: misses with no terminal (device_id null) key as ':none'", async () => {
    const f = await fixture('f8');
    await seed(f, f.storeA, null, 'miss', 20, 1);
    const hit = byKey(await feed(f), `pinSignInFailures:${f.storeA}:none`);
    expect(hit, 'F8: a null device must key as :none').toBeDefined();
  });
});

describe('T-395 S2 audit round - finding details', () => {
  it('F11: the pause count k belongs to the SHOWN worst day, and "between X and Y" are Manila clock times', async () => {
    const f = await fixture('f11');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 5, '09:00');
    await seed(f, f.storeA, f.termA1, 'miss', 10, 5, '11:30');
    await seed(f, f.storeA, f.termA1, 'lockout', 1, 1, '15:00'); // a different, later day
    const hit = byKey(await feed(f), failuresKey(f.storeA, f.termA1));
    expect(hit, 'F11: 20 misses on one Manila day must raise the finding').toBeDefined();
    expect(hit!.detail).toContain('20 wrong PINs');
    expect(hit!.detail, 'the line is about the 20-miss day, and that day had no pause').toContain('it paused 0 time(s)');
    expect(hit!.detail, 'Manila wall-clock times (a UTC rendering would say 1:00 AM)').toMatch(/between 9:00\s*AM and 11:30\s*AM/i);
  });

  it('F12: a store stopped 3 days ago says "after 50 wrong PINs in a day" (the 24h before stopped_at, not before now)', async () => {
    const f = await fixture('f12');
    await sql`
      insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
      select ${f.orgId}::uuid, ${f.storeA}::uuid, ${f.termA1}::uuid, 'miss', now() - interval '3 days' - interval '1 hour'
      from generate_series(1, 50)`;
    await sql`insert into pin_attempt_throttle (org_id, store_id, stopped_at) values (${f.orgId}, ${f.storeA}, now() - interval '3 days')`;
    const hit = byKey(await feed(f), stoppedKey(f.storeA));
    expect(hit, 'F12: the store is stopped').toBeDefined();
    expect(hit!.detail).toContain('after 50 wrong PINs in a day');
  });
});

describe('T-395 S2 test 16 - pinSignInStopped, severity, closeReadiness', () => {
  it('F9: a stopped store gives pinSignInStopped (soft, store-scoped); a store not stopped gives none; after reopen it is gone', async () => {
    const f = await fixture('f9');
    await seed(f, f.storeA, f.termA1, 'miss', 50, 0, '01:00');
    await sql`insert into pin_attempt_throttle (org_id, store_id, stopped_at) values (${f.orgId}, ${f.storeA}, now())`;
    await sql`insert into pin_attempt_throttle (org_id, store_id) values (${f.orgId}, ${f.storeB})`;
    const all = await feed(f);
    const hit = byKey(all, stoppedKey(f.storeA));
    expect(hit, `F9: stopped_at is set, so ${stoppedKey(f.storeA)} must fire`).toBeDefined();
    expect(hit!.kind).toBe('pinSignInStopped');
    expect(hit!.severity).toBe('soft');
    expect(hit!.storeId).toBe(f.storeA);
    expect(hit!.detail).toContain(`PIN sign-in at ${f.storeAName} has been stopped since`);
    expect(byKey(all, stoppedKey(f.storeB)), 'a store with a throttle row but no stopped_at is not stopped').toBeUndefined();

    await asOrg(f.orgId, (tx) => pinAttemptsRepo.reopen(tx, f.storeA, f.managerId));
    expect(byKey(await feed(f), stoppedKey(f.storeA)), 'after a reopen the finding is gone').toBeUndefined();
  });

  it('F10: neither finding can block closeReadiness (both soft, never in `blocking`)', async () => {
    const f = await fixture('f10');
    await seed(f, f.storeA, f.termA1, 'miss', 50, 0, '01:00');
    await seed(f, f.storeA, f.termA1, 'lockout', 1, 0, '01:00');
    await sql`insert into pin_attempt_throttle (org_id, store_id, stopped_at) values (${f.orgId}, ${f.storeA}, now())`;
    const all = await feed(f);
    const mine = all.filter((x) => x.kind === 'pinSignInFailures' || x.kind === 'pinSignInStopped');
    expect(mine.map((x) => x.kind).sort(), 'F10: both kinds must be present for this leg to mean anything').toEqual([
      'pinSignInFailures',
      'pinSignInStopped',
    ]);
    expect(mine.every((x) => x.severity === 'soft')).toBe(true);
    const ready = await asOrg(f.orgId, async (tx) => closeReadiness(tx, f.orgId, await period()));
    expect(ready.blocking.filter((x) => x.kind.startsWith('pinSignIn'))).toHaveLength(0);
  });
});
