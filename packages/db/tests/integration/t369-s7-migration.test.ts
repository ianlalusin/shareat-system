import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-369 S7 (DEF-479; Ian Q1, ruling (a), row 260) — a VOIDED sales day frees its date.
 * `docs/tasks/369-unwired-money-screens.md` §S7, the DB half.
 *
 * Asserted BY BEHAVIOUR, never by index name or migration file (the builder hand-authors the migration; its
 * number and the index's shape are the builder's): the unique rule on (org_id, store_id, business_date) must
 * count only days that are NOT voided.
 *
 *   - two rows for one store/date, one voided and one live        -> the insert SUCCEEDS
 *   - two LIVE rows for one store/date (open/submitted/verified)  -> still refused (unique violation 23505)
 *   - two voided rows for one store/date                          -> fine (a date may be withdrawn twice over time)
 *   - the same date at ANOTHER store                              -> never a conflict (control)
 *
 * ⛔ TESTER, not BUILDER. On HEAD the unique index counts voided rows, so the first leg is red on the
 * assertion that matters ("duplicate key value violates unique constraint"), not on a missing file.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t369s7db-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const otherStoreId = await mkStore('Malvar');
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  return { orgId, storeId, otherStoreId, personId: person!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const insertDay = (f: Fixture, status: 'open' | 'submitted' | 'verified' | 'voided', date: string, storeId = f.storeId) =>
  sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${storeId}, ${date}, ${status}, '1000.00', '1000.00', '0.00', ${f.personId})`;
async function uniqueViolation(p: PromiseLike<unknown>): Promise<string | null> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return e.code === '23505' ? 'unique' : `other: ${e.message}`;
  }
  return null;
}
const countOn = async (f: Fixture, date: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from sales_days where org_id = ${f.orgId} and store_id = ${f.storeId} and business_date = ${date}`)[0]!.n);

describe('S7 — the unique rule counts only days that are not voided', () => {
  it('one voided and one live row for the same store and date: the insert SUCCEEDS (both orders)', async () => {
    const f = await fixture('voided-then-live');
    await insertDay(f, 'voided', '2026-01-10');
    expect(await uniqueViolation(insertDay(f, 'open', '2026-01-10')), 'a live day was refused over a voided one').toBeNull();
    expect(await countOn(f, '2026-01-10')).toBe(2);

    const g = await fixture('live-then-voided');
    await insertDay(g, 'verified', '2026-01-10');
    expect(await uniqueViolation(insertDay(g, 'voided', '2026-01-10')), 'a voided day was refused over a live one').toBeNull();
    expect(await countOn(g, '2026-01-10')).toBe(2);
  });

  it('two LIVE rows for one store/date are still refused with a unique violation — for every live status pairing', async () => {
    const f = await fixture('two-live');
    for (const [i, [a, b]] of ([['open', 'open'], ['open', 'submitted'], ['submitted', 'verified'], ['verified', 'open']] as const).entries()) {
      const date = `2026-02-${String(10 + i).padStart(2, '0')}`;
      await insertDay(f, a, date);
      expect(await uniqueViolation(insertDay(f, b, date)), `${a} + ${b} for ${date} was accepted`).toBe('unique');
      expect(await countOn(f, date)).toBe(1);
    }
  });

  it('a live day alongside TWO voided days for the same date is fine, and a SECOND live one is then refused', async () => {
    const f = await fixture('history');
    await insertDay(f, 'voided', '2026-03-05');
    await insertDay(f, 'voided', '2026-03-05');
    expect(await uniqueViolation(insertDay(f, 'open', '2026-03-05'))).toBeNull();
    expect(await uniqueViolation(insertDay(f, 'submitted', '2026-03-05'))).toBe('unique');
    expect(await countOn(f, '2026-03-05')).toBe(3);
  });

  it('control: the same date at ANOTHER store is never a conflict', async () => {
    const f = await fixture('stores');
    await insertDay(f, 'open', '2026-04-01');
    expect(await uniqueViolation(insertDay(f, 'open', '2026-04-01', f.otherStoreId))).toBeNull();
  });
});

describe('S7 — a day that BECOMES voided frees its date (the UPDATE path, as voidSalesDay does it)', () => {
  it('voiding the live day by UPDATE lets a new live day in; un-voiding is not possible while a live one exists — the rule holds after the update', async () => {
    const f = await fixture('update');
    await insertDay(f, 'open', '2026-05-05');
    const [first] = await sql<{ id: string }[]>`select id from sales_days where org_id = ${f.orgId} and business_date = '2026-05-05'`;
    await sql`update sales_days set status = 'voided' where id = ${first!.id}`;
    expect(await uniqueViolation(insertDay(f, 'open', '2026-05-05')), 'the date was not freed by the status change').toBeNull();
    // Moving the voided row BACK to live would make two live days: the rule must refuse it.
    expect(await uniqueViolation(sql`update sales_days set status = 'open' where id = ${first!.id}`)).toBe('unique');
  });
});
