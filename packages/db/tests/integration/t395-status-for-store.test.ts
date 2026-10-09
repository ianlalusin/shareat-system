import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-395 S2 audit round - `pinAttemptsRepo.statusForStore` (the Staff panel's read): paused, stopped, neither, plus the
 * count a STOPPED store shows. TESTER, not BUILDER. Fields are the builder's: stopped, stoppedAt, paused, pausedUntil,
 * missesLast24h. NEW field asserted for the stopped case: `missesBeforeStop` = misses in the 24h before stopped_at (and
 * since any reopen), so a store stopped 3 days ago still shows the figure that stopped it, not 0.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, pinAttemptsRepo, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 4 });
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

async function fx(hint: string) {
  const code = uid(`t395s-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`;
  const [d] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, 'Term', 'terminal') returning id`;
  return { orgId, storeId: s!.id, deviceId: d!.id };
}
type Fx = Awaited<ReturnType<typeof fx>>;
const misses = (f: Fx, n: number, ago: string) =>
  sql`insert into sign_in_attempts (org_id, store_id, device_id, kind, occurred_at)
      select ${f.orgId}::uuid, ${f.storeId}::uuid, ${f.deviceId}::uuid, 'miss', now() - ${ago}::interval from generate_series(1, ${n}::int)`;
const status = (f: Fx) => asOrg(f.orgId, (tx) => pinAttemptsRepo.statusForStore(tx, f.storeId));

describe('T-395 S2 statusForStore', () => {
  it('S1: paused (tier 1): paused true with pausedUntil, not stopped, misses counted', async () => {
    const f = await fx('s1');
    await misses(f, 4, '10 minutes');
    await sql`insert into pin_attempt_throttle (org_id, store_id, fail_count, locked_until) values (${f.orgId}, ${f.storeId}, 10, now() + interval '90 seconds')`;
    const st = await status(f);
    expect(st.paused).toBe(true);
    expect(st.pausedUntil).toBeInstanceOf(Date);
    expect(st.stopped).toBe(false);
    expect(st.stoppedAt).toBeNull();
    expect(st.missesLast24h).toBe(4);
  });

  it('S2: stopped (tier 2): stopped true with stoppedAt; a stop 3 days old still shows the 50 misses before it (missesBeforeStop)', async () => {
    const f = await fx('s2');
    await misses(f, 50, '3 days 1 hour');
    await sql`insert into pin_attempt_throttle (org_id, store_id, stopped_at) values (${f.orgId}, ${f.storeId}, now() - interval '3 days')`;
    const st = (await status(f)) as Awaited<ReturnType<typeof status>> & { missesBeforeStop?: number };
    expect(st.stopped).toBe(true);
    expect(st.stoppedAt).toBeInstanceOf(Date);
    expect(st.paused).toBe(false);
    expect(st.missesBeforeStop, 'a stopped store shows the 24h before stopped_at, not the 24h before now').toBe(50);
  });

  it('S3: neither: not paused, not stopped; with no throttle row at all the same, with 0 misses', async () => {
    const f = await fx('s3');
    await misses(f, 3, '1 hour');
    await sql`insert into pin_attempt_throttle (org_id, store_id, fail_count) values (${f.orgId}, ${f.storeId}, 3)`;
    expect(await status(f)).toMatchObject({ stopped: false, stoppedAt: null, paused: false, pausedUntil: null, missesLast24h: 3 });
    const g = await fx('s3b');
    expect(await status(g)).toMatchObject({ stopped: false, paused: false, missesLast24h: 0 });
  });
});
