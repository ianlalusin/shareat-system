import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-600 S6 / DEF-902 - migration 0270: a journal entry's date must fall inside its fiscal period. The period-open triggers
 * (0003, 0143) check only the period's STATUS; this is the backstop for a writer that names the wrong period.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function fixture() {
  const code = uid('t600d');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [period] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${org!.id}, '2026-08-01', '2026-08-31', 'open') returning id`;
  return { orgId: org!.id, periodId: period!.id };
}
type Q = postgres.TransactionSql;
type F = { orgId: string; periodId: string };
const entry = (q: Q, f: F, date: string) => q<{ id: string }[]>`
  insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
  values (${f.orgId}, ${date}, ${f.periodId}, 'opening_balance', ${uid('x')}, 'draft') returning id`;

/** Runs `fn` in a transaction that is always rolled back: a line-less entry would fail the deferred balance check at commit, and nothing here needs to persist. */
class Rollback extends Error {}
async function inTx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await sql.begin(async (q) => {
      out = await fn(q);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('DEF-902 - journal_entries.entry_date must lie inside its period', () => {
  it('positive: the first and the last day of the period insert', async () => {
    const f = await fixture();
    const got = await inTx(async (q) => [(await entry(q, f, '2026-08-01')).length, (await entry(q, f, '2026-08-31')).length]);
    expect(got).toEqual([1, 1]);
  });

  it('a date one day after ends_on is rejected', async () => {
    const f = await fixture();
    await expect(inTx((q) => entry(q, f, '2026-09-01'))).rejects.toThrow(/outside fiscal period/);
  });

  it('a date one day before starts_on is rejected', async () => {
    const f = await fixture();
    await expect(inTx((q) => entry(q, f, '2026-07-31'))).rejects.toThrow(/outside fiscal period/);
  });

  it('updating the entry date out of range is rejected; moving it within range is fine', async () => {
    const f = await fixture();
    await expect(
      inTx(async (q) => {
        const [e] = await entry(q, f, '2026-08-10');
        await q`update journal_entries set entry_date = '2026-08-20' where id = ${e!.id}`;
        await q`update journal_entries set entry_date = '2026-09-02' where id = ${e!.id}`;
      }),
    ).rejects.toThrow(/outside fiscal period/);
  });

  it('re-pointing an entry at another period it does not fit is rejected', async () => {
    const f = await fixture();
    await expect(
      inTx(async (q) => {
        const [other] = await q<{ id: string }[]>`
          insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2026-09-01', '2026-09-30', 'open') returning id`;
        const [e] = await entry(q, f, '2026-08-10');
        await q`update journal_entries set period_id = ${other!.id} where id = ${e!.id}`;
      }),
    ).rejects.toThrow(/outside fiscal period/);
  });
});
