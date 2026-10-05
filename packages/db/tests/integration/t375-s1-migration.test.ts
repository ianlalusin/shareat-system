/**
 * T-375 S1 - migration 0183 (structure, no enforcement). `docs/tasks/375-pos-v1-day-feed.md` section S1, tests M1-M5.
 *
 * TESTER, not BUILDER. Raw SQL on the migration role, so the DATABASE is what is proven.
 *
 * ## Why these are red on HEAD
 * 0183 does not exist, so the four tables are absent. Where a test can assert on that directly (M1: the
 * catalog query returns 4 rows) it fails on THAT assertion. Where a test must INSERT into a table to prove a
 * refusal (M2, M3, M5, the M4 controls), the honest red on HEAD is `relation "pos_v1_..." does not exist` from
 * the fixture: a missing table is the real failure for a migration test, and once the table exists the same
 * legs assert the exact refusal. The M4 legs that name `source` / `pos_v1_day_feed_id` / `refunds` fail on
 * `column ... does not exist`.
 *
 * ## Where the spec is silent (read, not invented)
 *  - the append-only refusal text is read as `/append-only/` (the `0009` / stock_movements convention);
 *  - the CHECK / unique-index names are NOT asserted (the spec names none for the tables); a refusal is
 *    asserted by SQLSTATE (`23514` check, `23505` unique) and, for a refusal, that no row landed;
 *  - the feed insert always supplies every R1 column explicitly (no reliance on column defaults).
 * Every refusal has a positive control in the same file.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const HASH = 'a'.repeat(64);

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const TABLES = ['pos_v1_store_links', 'pos_v1_day_feeds', 'tenders', 'sales_day_pos_corrections'] as const;

async function fixture(hint: string) {
  const code = uid(`t375s1m-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Lipa') returning id`;
  const [store2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Batangas') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const personId = p!.id;
  const [acct] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${store!.id}, 'GCash', 'bank', '1140', 'office') returning id`;
  const [period] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open') returning id`;
  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${store!.id}, '2027-01-05', 0, 0, 0, ${personId}) returning id`;
  return {
    orgId,
    storeId: store!.id,
    store2Id: store2!.id,
    personId,
    moneyAccountId: acct!.id,
    periodId: period!.id,
    dayId: day!.id,
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

const insertFeed = (f: F, o: { kind?: string; purpose?: string; hash?: string; posStoreId?: string; batch?: string } = {}) => sql<{ id: string }[]>`
  insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
  values (${f.orgId}, ${f.storeId}, '2027-01-05', ${o.kind ?? 'sales'}, ${o.purpose ?? 'import'}, ${o.batch ?? crypto.randomUUID()},
          ${o.posStoreId ?? 'pos-abc'}, '{"found":true}', '{"found":true}'::jsonb, ${o.hash ?? HASH}, now(), ${f.personId}) returning id`;

const insertTender = (f: F, o: { storeId?: string; name: string; kind: string; account?: string | null; alias?: string | null; active?: boolean }) => sql`
  insert into tenders (org_id, store_id, name, kind, money_account_id, pos_v1_alias, is_active)
  values (${f.orgId}, ${o.storeId ?? f.storeId}, ${o.name}, ${o.kind}, ${o.account ?? null}, ${o.alias ?? null}, ${o.active ?? true})`;

const sqlstate = (e: unknown) => (e as { code?: string }).code;

describe('M1 - the four tables exist, RLS enabled and FORCED, shareat_app privileges are exactly the spec', () => {
  it('all four tables exist with relrowsecurity and relforcerowsecurity - HEAD: the catalog returns 0 rows', async () => {
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean }[]>`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${[...TABLES]})`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of rows) {
      expect({ table: r.relname, rls: r.rls, forced: r.forced }).toEqual({ table: r.relname, rls: true, forced: true });
    }
  });

  const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
  const EXPECTED: Record<(typeof TABLES)[number], string[]> = {
    pos_v1_day_feeds: ['INSERT', 'SELECT'],
    sales_day_pos_corrections: ['INSERT', 'SELECT'],
    pos_v1_store_links: ['INSERT', 'SELECT', 'UPDATE'],
    tenders: ['INSERT', 'SELECT', 'UPDATE'],
  };
  for (const table of TABLES) {
    it(`${table}: ${APP_ROLE} holds exactly ${EXPECTED[table].join(', ')} (no DELETE anywhere, no UPDATE on append-only tables)`, async () => {
      const exists = await sql<{ n: number }[]>`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relname = ${table}`;
      expect(exists[0]!.n, `${table} must exist (0183)`).toBe(1);
      const held: string[] = [];
      for (const priv of PRIVS) {
        const [r] = await sql<{ ok: boolean }[]>`select has_table_privilege(${APP_ROLE}, ${`public.${table}`}, ${priv}) as ok`;
        if (r!.ok) held.push(priv);
      }
      expect(held.sort()).toEqual(EXPECTED[table]);
    });
  }
});

describe('M2 - pos_v1_day_feeds is append-only', () => {
  it('control: INSERT and SELECT work and the row reads back', async () => {
    const f = await fixture('m2c');
    const [feed] = await insertFeed(f);
    const [row] = await sql<{ body: string; kind: string; content_hash: string }[]>`select body, kind, content_hash from pos_v1_day_feeds where id = ${feed!.id}`;
    expect(row).toMatchObject({ body: '{"found":true}', kind: 'sales', content_hash: HASH });
  });

  it('UPDATE is refused and the row is unchanged - Mutant: no append-only trigger lets it through', async () => {
    const f = await fixture('m2u');
    const [feed] = await insertFeed(f);
    await expect(sql`update pos_v1_day_feeds set body = '{"found":false}' where id = ${feed!.id}`).rejects.toThrow(/append-only/i);
    const [row] = await sql<{ body: string }[]>`select body from pos_v1_day_feeds where id = ${feed!.id}`;
    expect(row!.body).toBe('{"found":true}');
  });

  it('DELETE is refused and the row survives', async () => {
    const f = await fixture('m2d');
    const [feed] = await insertFeed(f);
    await expect(sql`delete from pos_v1_day_feeds where id = ${feed!.id}`).rejects.toThrow(/append-only/i);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pos_v1_day_feeds where id = ${feed!.id}`;
    expect(row!.n).toBe(1);
  });

  it('the R1 shapes: bad kind / purpose / hash / blank pos_store_id refused (23514); a duplicate (batch_id, kind) refused (23505); same batch other kind accepted', async () => {
    const f = await fixture('m2s');
    for (const bad of [{ kind: 'receipts' }, { purpose: 'nightly' }, { hash: 'ABC' }, { hash: 'A'.repeat(64) }, { posStoreId: '   ' }]) {
      const err = await insertFeed(f, bad).catch((e) => e);
      expect(err, `refused: ${JSON.stringify(bad)}`).toBeInstanceOf(Error);
      expect(sqlstate(err)).toBe('23514');
    }
    const batch = crypto.randomUUID();
    await insertFeed(f, { batch, kind: 'sales' });
    const dup = await insertFeed(f, { batch, kind: 'sales' }).catch((e) => e);
    expect(dup).toBeInstanceOf(Error);
    expect(sqlstate(dup)).toBe('23505');
    await expect(insertFeed(f, { batch, kind: 'sold_items' })).resolves.toBeDefined();
  });
});

describe('M3 - tenders', () => {
  it('controls: a cash tender with no account, and a wallet tender with an account, are accepted', async () => {
    const f = await fixture('m3c');
    await expect(insertTender(f, { name: 'Cash', kind: 'cash' })).resolves.toBeDefined();
    await expect(insertTender(f, { name: 'GCash', kind: 'wallet', account: f.moneyAccountId })).resolves.toBeDefined();
  });

  it('a wallet with no money account is refused (23514)', async () => {
    const f = await fixture('m3w');
    const err = await insertTender(f, { name: 'GCash', kind: 'wallet', account: null }).catch((e) => e);
    expect(err, 'wallet without an account must be refused').toBeInstanceOf(Error);
    expect(sqlstate(err)).toBe('23514');
  });

  it('a cash tender WITH a money account is refused (23514)', async () => {
    const f = await fixture('m3k');
    const err = await insertTender(f, { name: 'Cash', kind: 'cash', account: f.moneyAccountId }).catch((e) => e);
    expect(err, 'cash with an account must be refused').toBeInstanceOf(Error);
    expect(sqlstate(err)).toBe('23514');
  });

  it("aliases 'G-Cash' and 'gcash' on two ACTIVE tenders of one store: the second is refused (23505) - Mutant: alias index without normalization accepts it", async () => {
    const f = await fixture('m3a');
    await insertTender(f, { name: 'GCash A', kind: 'wallet', account: f.moneyAccountId, alias: 'G-Cash' });
    const err = await insertTender(f, { name: 'GCash B', kind: 'wallet', account: f.moneyAccountId, alias: 'gcash' }).catch((e) => e);
    expect(err, 'the normalized alias is the identity').toBeInstanceOf(Error);
    expect(sqlstate(err)).toBe('23505');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from tenders where store_id = ${f.storeId}`;
    expect(n!.n).toBe(1);
  });

  it('controls: the same normalized alias is accepted on an INACTIVE row, and on another store', async () => {
    const f = await fixture('m3x');
    await insertTender(f, { name: 'GCash A', kind: 'wallet', account: f.moneyAccountId, alias: 'G-Cash' });
    await expect(insertTender(f, { name: 'GCash old', kind: 'wallet', account: f.moneyAccountId, alias: 'gcash', active: false })).resolves.toBeDefined();
    await expect(insertTender(f, { storeId: f.store2Id, name: 'GCash', kind: 'wallet', account: f.moneyAccountId, alias: 'gcash' })).resolves.toBeDefined();
  });
});

describe('F4 - a tender alias that normalizes to nothing is refused by the database', () => {
  for (const alias of ['-', '(*)', '  - . ']) {
    it(`alias ${JSON.stringify(alias)} (nothing left after stripping non-alphanumerics) -> 23514 and no row`, async () => {
      const f = await fixture('f4');
      const err = await insertTender(f, { name: 'Odd', kind: 'wallet', account: f.moneyAccountId, alias }).catch((e) => e);
      expect(err, 'an alias that normalizes to the empty string must be refused').toBeInstanceOf(Error);
      expect(sqlstate(err)).toBe('23514');
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from tenders where store_id = ${f.storeId}`;
      expect(n!.n).toBe(0);
    });
  }

  it('control: alias GCash inserts and reads back', async () => {
    const f = await fixture('f4c');
    await expect(insertTender(f, { name: 'GCash', kind: 'wallet', account: f.moneyAccountId, alias: 'GCash' })).resolves.toBeDefined();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from tenders where store_id = ${f.storeId}`;
    expect(n!.n).toBe(1);
  });
});

describe('M4 - sales_days: source, feed id, refunds', () => {
  const insertDay = (f: F, date: string, o: { source?: string; feed?: string | null; posSourced?: boolean; refunds?: string }) => sql`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by,
                            source, pos_v1_day_feed_id, pos_sourced, pos_sourced_at, refunds)
    values (${f.orgId}, ${f.storeId}, ${date}, 0, 0, 0, ${f.personId},
            ${o.source ?? 'legacy_typed'}, ${o.feed ?? null}, ${o.posSourced ?? false}, ${o.posSourced ? new Date().toISOString() : null}, ${o.refunds ?? '0'})`;

  it('an existing sales_days row reads legacy_typed, feed id null, refunds 0', async () => {
    const f = await fixture('m4e');
    const [row] = await sql<{ source: string; feed: string | null; refunds: string }[]>`
      select source, pos_v1_day_feed_id as feed, refunds::text as refunds from sales_days where id = ${f.dayId}`;
    expect(row).toEqual({ source: 'legacy_typed', feed: null, refunds: '0.00' });
  });

  it('control: a well-formed feed-sourced row (feed id, pos_sourced true) is accepted ON A LINKED STORE (T-375 S4: a feed day needs a link; the derivation flag is on for the insert)', async () => {
    const f = await fixture('m4c');
    const [ch] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${f.orgId}, ${f.storeId}, 'Walk-in', true) returning id`;
    await sql`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
      values (${f.orgId}, ${f.storeId}, ${uid('pos')}, 'POS store', ${ch!.id}, 'vat_inclusive', ${f.personId})`;
    const [feed] = await insertFeed(f);
    await expect(
      sql.begin(async (t) => {
        await t`select set_config('app.sales_day_derivation', 'on', true)`;
        await t`
          insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by, source, pos_v1_day_feed_id, pos_sourced, pos_sourced_at, refunds)
          values (${f.orgId}, ${f.storeId}, '2027-01-06', 0, 0, 0, ${f.personId}, 'pos_v1_day_feed', ${feed!.id}, true, now(), '10.00')`;
      }),
    ).resolves.not.toThrow();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from sales_days where store_id = ${f.storeId} and source = 'pos_v1_day_feed'`;
    expect(n!.n).toBe(1);
  });

  it('T-375 S4: the same feed-sourced row on an UNLINKED store is refused (sales_days_figures_locked, 23514), flag on or off', async () => {
    const f = await fixture('m4u');
    const [feed] = await insertFeed(f);
    const err = await insertDay(f, '2027-01-06', { source: 'pos_v1_day_feed', feed: feed!.id, posSourced: true, refunds: '10.00' }).catch((e) => e);
    expect({ code: sqlstate(err), constraint: (err as { constraint_name?: string }).constraint_name }).toEqual({ code: '23514', constraint: 'sales_days_figures_locked' });
  });

  it('control: legacy_typed with refunds 0 is accepted (the default shape)', async () => {
    const f = await fixture('m4d');
    await expect(insertDay(f, '2027-01-06', {})).resolves.toBeDefined();
  });

  it('feed source with a null feed id is refused (23514)', async () => {
    const f = await fixture('m4n');
    const err = await insertDay(f, '2027-01-06', { source: 'pos_v1_day_feed', feed: null, posSourced: true }).catch((e) => e);
    expect(err, 'a feed day must name its feed').toBeInstanceOf(Error);
    expect(sqlstate(err)).toBe('23514');
  });

  it('feed source with pos_sourced = false is refused (23514)', async () => {
    const f = await fixture('m4p');
    const [feed] = await insertFeed(f);
    const err = await insertDay(f, '2027-01-06', { source: 'pos_v1_day_feed', feed: feed!.id, posSourced: false }).catch((e) => e);
    expect(err, 'a feed day is pos_sourced').toBeInstanceOf(Error);
    expect(sqlstate(err)).toBe('23514');
  });

  it('legacy_typed with refunds 5 is refused (23514)', async () => {
    const f = await fixture('m4r');
    const err = await insertDay(f, '2027-01-06', { source: 'legacy_typed', refunds: '5.00' }).catch((e) => e);
    expect(err, 'only a feed day carries refunds').toBeInstanceOf(Error);
    expect(sqlstate(err)).toBe('23514');
  });

  it('a negative refunds figure and an unknown source are refused (23514)', async () => {
    const f = await fixture('m4s');
    const [feed] = await insertFeed(f);
    const neg = await insertDay(f, '2027-01-06', { source: 'pos_v1_day_feed', feed: feed!.id, posSourced: true, refunds: '-1.00' }).catch((e) => e);
    expect(neg).toBeInstanceOf(Error);
    expect(sqlstate(neg)).toBe('23514');
    const bad = await insertDay(f, '2027-01-07', { source: 'typed' }).catch((e) => e);
    expect(bad).toBeInstanceOf(Error);
    expect(sqlstate(bad)).toBe('23514');
  });

  it('pos_usage_pulls.pos_v1_day_feed_id exists and is nullable', async () => {
    const [col] = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns where table_name = 'pos_usage_pulls' and column_name = 'pos_v1_day_feed_id'`;
    expect(col, 'column pos_usage_pulls.pos_v1_day_feed_id (0183)').toBeDefined();
    expect(col!.is_nullable).toBe('YES');
  });
});

describe('M5 - sales_day_pos_corrections is append-only', () => {
  async function correction(f: F) {
    const [a] = await insertFeed(f, { posStoreId: 'pos-abc' });
    const [b] = await insertFeed(f, { posStoreId: 'pos-abc' });
    // A journal entry must balance (deferred trigger), so it is written WITH two balanced lines in one transaction;
    // otherwise the balance trigger rejects the fixture before the append-only trigger is ever reached.
    const entry = await sql.begin(async (tx) => {
      const [debit] = await tx<{ id: string }[]>`
        insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
        values (${f.orgId}, '9001', 'Probe debit', 'expense', 'debit', true, true, 'active') returning id`;
      const [credit] = await tx<{ id: string }[]>`
        insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
        values (${f.orgId}, '9002', 'Probe credit', 'asset', 'debit', true, true, 'active') returning id`;
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, memo, status)
        values (${f.orgId}, ${f.periodId}, '2027-01-10', 'sale', ${uid('src')}, ${uid('idem')}, 'correction probe', 'draft') returning id`;
      await tx`
        insert into journal_lines (entry_id, account_id, line_no, debit, credit)
        values (${e!.id}, ${debit!.id}, 1, 100, 0), (${e!.id}, ${credit!.id}, 2, 0, 100)`;
      return e!;
    });
    const [c] = await sql<{ id: string }[]>`
      insert into sales_day_pos_corrections (org_id, store_id, sales_day_id, from_feed_id, to_feed_id, entry_date, journal_entry_id, reason, posted_by, posted_at)
      values (${f.orgId}, ${f.storeId}, ${f.dayId}, ${a!.id}, ${b!.id}, '2027-01-10', ${entry.id}, 'POS voided a receipt', ${f.personId}, now()) returning id`;
    return c!.id;
  }

  it('control: INSERT and SELECT work', async () => {
    const f = await fixture('m5c');
    const id = await correction(f);
    const [row] = await sql<{ reason: string }[]>`select reason from sales_day_pos_corrections where id = ${id}`;
    expect(row!.reason).toBe('POS voided a receipt');
  });

  it('UPDATE is refused and the row is unchanged', async () => {
    const f = await fixture('m5u');
    const id = await correction(f);
    await expect(sql`update sales_day_pos_corrections set reason = 'edited' where id = ${id}`).rejects.toThrow(/append-only/i);
    const [row] = await sql<{ reason: string }[]>`select reason from sales_day_pos_corrections where id = ${id}`;
    expect(row!.reason).toBe('POS voided a receipt');
  });

  it('DELETE is refused and the row survives', async () => {
    const f = await fixture('m5d');
    const id = await correction(f);
    await expect(sql`delete from sales_day_pos_corrections where id = ${id}`).rejects.toThrow(/append-only/i);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from sales_day_pos_corrections where id = ${id}`;
    expect(row!.n).toBe(1);
  });
});
