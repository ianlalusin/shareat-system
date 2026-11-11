import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { deleteBeforeCutoff } from '../../src/cutover/purge';

/**
 * T-536 (audit CR-5) - the cutover purge's date-scoped delete reads its cutoff in the business time zone (Asia/Manila), not in
 * whatever time zone the database session happens to use. A timestamptz row created at 02:00 Manila on 1 Jan 2027 is real
 * history and must survive a purge run from a UTC session.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const sql = postgres(url, { max: 2 });

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

class Rollback extends Error {}

/** Runs `fn` in a transaction on a throwaway table, then rolls everything back. */
async function inScratch<T>(zone: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let out!: T;
  await sql
    .begin(async (tx) => {
      await tx.unsafe(`set local time zone '${zone}'`);
      await tx.unsafe(`create temp table t536_scratch (id int, made_at timestamptz, made_on date) on commit drop`);
      out = await fn(tx);
      throw new Rollback();
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e;
    });
  return out;
}

describe('T-536 / CR-5 - date-scoped purge cutoff is a Manila calendar date', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Asia/Manila'])('timestamptz column, session time zone %s', async (zone) => {
    const kept = await inScratch(zone, async (tx) => {
      await tx.unsafe(`insert into t536_scratch (id, made_at) values
        (1, '2026-12-31 23:00:00+08'),  -- 23:00 Manila on 31 Dec: before the cutoff, purged
        (2, '2027-01-01 00:00:00+08'),  -- the first instant of 1 Jan Manila: kept
        (3, '2027-01-01 02:00:00+08'),  -- 02:00 Manila on 1 Jan: kept (a UTC session read the cutoff as 08:00 Manila and deleted it)
        (4, '2027-01-01 12:00:00+08')`);
      await deleteBeforeCutoff(tx, 't536_scratch', 'made_at', '2027-01-01');
      return (await tx.unsafe<{ id: number }[]>(`select id from t536_scratch order by id`)).map((r) => r.id);
    });
    expect(kept).toEqual([2, 3, 4]);
  });

  it('date column is unchanged by the fix', async () => {
    const kept = await inScratch('UTC', async (tx) => {
      await tx.unsafe(`insert into t536_scratch (id, made_on) values (1, '2026-12-31'), (2, '2027-01-01'), (3, '2027-01-02')`);
      await deleteBeforeCutoff(tx, 't536_scratch', 'made_on', '2027-01-01');
      return (await tx.unsafe<{ id: number }[]>(`select id from t536_scratch order by id`)).map((r) => r.id);
    });
    expect(kept).toEqual([2, 3]);
  });
});
