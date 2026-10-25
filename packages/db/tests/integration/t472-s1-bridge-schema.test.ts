/**
 * T-472 S1 - migration 0216: the POS receipt bridge tables. `docs/tasks/472-pos-nightly-receipt-bridge.md` Rulings 3, 4, 5, 7.
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard. No database name is hard-coded: any `_test` database migrated to the
 * journal head works.
 *
 * Red on HEAD because 0216 does not exist (the tables are absent, the scheduler CHECK refuses 'pos_receipt_bridge').
 * Every refusal has a positive control in the same file. Writes that would pollute the shared database run inside a
 * transaction that is rolled back (`attempt`).
 *
 * MUTANTS: single-column org FK on a child -> B3; missing UNIQUE(org_id,id) on tenders -> B4; version key dropped -> B5;
 * view without security_invoker -> B6; job CHECK not widened or old job dropped -> B7; a personal-data column -> B8;
 * a float/numeric money column -> B9; RLS not forced or policy missing -> B2/B10.
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { APP_ROLE } from '../../src/rls/registry';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const HASH_A = 'a'.repeat(63) + '1';
const HASH_B = 'b'.repeat(63) + '2';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const BRIDGE_TABLES = ['pos_bridge_receipts', 'pos_bridge_receipt_lines', 'pos_bridge_receipt_tenders', 'pos_bridge_day_checks'] as const;
const CHILDREN = ['pos_bridge_receipt_lines', 'pos_bridge_receipt_tenders'] as const;

type PgErr = Error & { code?: string };
class Rollback extends Error {}
type Tx = postgres.TransactionSql;

/** Run `fn` in a transaction that is always rolled back; as shareat_app with app.org_id = `org` when `org` is given. */
async function attempt<T>(org: string | null, fn: (tx: Tx) => Promise<T>): Promise<{ err?: PgErr; value?: T }> {
  const out: { err?: PgErr; value?: T } = {};
  try {
    await sql.begin(async (tx) => {
      if (org) {
        await tx.unsafe(`set local role ${APP_ROLE}`);
        await tx`select set_config('app.org_id', ${org}, true)`;
      }
      try {
        await tx.savepoint(async (sp) => {
          out.value = await fn(sp as unknown as Tx);
        });
      } catch (e) {
        out.err = e as PgErr;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

async function orgFixture(hint: string) {
  const code = uid(`t472s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
  const [tender] = await sql<{ id: string }[]>`
    insert into tenders (org_id, store_id, name, kind) values (${orgId}, ${store!.id}, 'Cash', 'cash') returning id`;
  return { orgId, storeId: store!.id, tenderId: tender!.id };
}
type F = Awaited<ReturnType<typeof orgFixture>>;

const insReceipt = (
  tx: Tx | postgres.Sql,
  f: { orgId: string; storeId: string },
  o: { doc?: string; version?: number; status?: string; kind?: string; total?: number; hash?: string; date?: string; posStore?: string } = {},
) => tx<{ id: string }[]>`
  insert into pos_bridge_receipts (org_id, store_id, pos_store_id, firestore_doc_id, version, kind, status, pos_calendar_date,
                                   subtotal_centavos, discount_centavos, total_centavos, raw, doc_hash)
  values (${f.orgId}, ${f.storeId}, ${o.posStore ?? 'pos-lipa'}, ${o.doc ?? 'doc-1'}, ${o.version ?? 1}, ${o.kind ?? 'sale'},
          ${o.status ?? 'final'}, ${o.date ?? '2027-01-05'}, ${o.total ?? 10000}, 0, ${o.total ?? 10000}, '{"lines":[]}'::jsonb,
          ${o.hash ?? HASH_A})
  returning id`;

const insLine = (tx: Tx | postgres.Sql, orgId: string, receiptId: string, lineNo = 1) => tx`
  insert into pos_bridge_receipt_lines (org_id, receipt_id, line_no, pos_calendar_date, item_name, quantity, unit_price_centavos, line_total_centavos)
  values (${orgId}, ${receiptId}, ${lineNo}, '2027-01-05', 'Unli pork', 2, 5000, 10000)`;

const insTender = (tx: Tx | postgres.Sql, orgId: string, receiptId: string, tenderId: string | null, s = 1) => tx`
  insert into pos_bridge_receipt_tenders (org_id, receipt_id, seq, pos_calendar_date, method_alias, tender_id, amount_centavos)
  values (${orgId}, ${receiptId}, ${s}, '2027-01-05', 'Cash', ${tenderId}, 10000)`;

describe('B1 - migration 0216 is on the journal, in order', () => {
  it('0216_pos_receipt_bridge follows 0214 on the one-day grid (0215 belongs to T-455)', () => {
    const j = JSON.parse(readFileSync(join(__dirname, '../../migrations/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const e214 = j.entries.find((e) => e.idx === 214)!;
    const e216 = j.entries.find((e) => e.idx === 216);
    expect(e216?.tag).toBe('0216_pos_receipt_bridge');
    expect(e216!.when).toBe(e214.when + 2 * 86_400_000);
  });
});

describe('B2 - the four tables exist, RLS enabled and FORCED, grants are exactly the spec', () => {
  it('relrowsecurity and relforcerowsecurity on all four', async () => {
    const rows = await sql<{ relname: string; rls: boolean; forced: boolean }[]>`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${[...BRIDGE_TABLES]})`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...BRIDGE_TABLES].sort());
    for (const r of rows) expect({ t: r.relname, rls: r.rls, forced: r.forced }).toEqual({ t: r.relname, rls: true, forced: true });
  });

  const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;
  const EXPECTED: Record<(typeof BRIDGE_TABLES)[number], string[]> = {
    pos_bridge_receipts: ['INSERT', 'SELECT'],
    pos_bridge_receipt_lines: ['INSERT', 'SELECT'],
    pos_bridge_receipt_tenders: ['INSERT', 'SELECT'],
    pos_bridge_day_checks: ['INSERT', 'SELECT', 'UPDATE'],
  };
  for (const table of BRIDGE_TABLES) {
    it(`${table}: ${APP_ROLE} holds exactly ${EXPECTED[table].join(', ')}`, async () => {
      const exists = await sql<{ n: number }[]>`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relname = ${table}`;
      expect(exists[0]!.n, `${table} must exist (0216)`).toBe(1);
      const held: string[] = [];
      for (const priv of PRIVS) {
        const [r] = await sql<{ ok: boolean }[]>`select has_table_privilege(${APP_ROLE}, ${`public.${table}`}, ${priv}) as ok`;
        if (r!.ok) held.push(priv);
      }
      expect(held.sort()).toEqual(EXPECTED[table]);
    });
  }
});

describe('B3 - composite same-org FKs: a child cannot point at another org', () => {
  it('the catalog shows each child FK as (org_id, x) with no single-column org->org FK', async () => {
    const rows = await sql<{ child: string; cols: string[]; parent: string }[]>`
      select c.conrelid::regclass::text as child,
             (select array_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
                join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
             c.confrelid::regclass::text as parent
      from pg_constraint c
      where c.contype = 'f' and c.conrelid::regclass::text = any(${[...BRIDGE_TABLES]})`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.parent === 'organizations') continue; // the org_id -> organizations FK itself
      expect({ fk: `${r.child}->${r.parent}`, first: r.cols[0], n: r.cols.length }).toEqual({ fk: `${r.child}->${r.parent}`, first: 'org_id', n: 2 });
    }
    for (const child of CHILDREN) {
      expect(rows.some((r) => r.child === child && r.parent === 'pos_bridge_receipts' && r.cols.join() === 'org_id,receipt_id')).toBe(true);
    }
  });

  it('control: a line and a tender for a receipt of the SAME org are accepted', async () => {
    const f = await orgFixture('b3c');
    const { err } = await attempt(null, async (tx) => {
      const [r] = await insReceipt(tx, f);
      await insLine(tx, f.orgId, r!.id);
      await insTender(tx, f.orgId, r!.id, f.tenderId);
    });
    expect(err).toBeUndefined();
  });

  for (const child of ['line', 'tender'] as const) {
    it(`a ${child} carrying org A but pointing at org B's receipt is refused (23503)`, async () => {
      const a = await orgFixture('b3a');
      const b = await orgFixture('b3b');
      const { err } = await attempt(null, async (tx) => {
        const [rb] = await insReceipt(tx, b);
        if (child === 'line') await insLine(tx, a.orgId, rb!.id);
        else await insTender(tx, a.orgId, rb!.id, null);
      });
      expect(err?.code).toBe('23503');
    });
  }

  it("a tender row pointing at another org's tenders master row is refused (23503); a NULL tender_id is accepted", async () => {
    const a = await orgFixture('b3ta');
    const b = await orgFixture('b3tb');
    const bad = await attempt(null, async (tx) => {
      const [r] = await insReceipt(tx, a);
      await insTender(tx, a.orgId, r!.id, b.tenderId);
    });
    expect(bad.err?.code).toBe('23503');
    const ok = await attempt(null, async (tx) => {
      const [r] = await insReceipt(tx, a);
      await insTender(tx, a.orgId, r!.id, null);
    });
    expect(ok.err).toBeUndefined();
  });

  it("a receipt for another org's store is refused (23503)", async () => {
    const a = await orgFixture('b3sa');
    const b = await orgFixture('b3sb');
    const { err } = await attempt(null, (tx) => insReceipt(tx, { orgId: a.orgId, storeId: b.storeId }));
    expect(err?.code).toBe('23503');
  });
});

describe('B4 - tenders carries UNIQUE (org_id, id), the target of the tender FK', () => {
  it('tenders_org_id_id_unique exists on exactly (org_id, id)', async () => {
    const rows = await sql<{ cols: string[] }[]>`
      select array_agg(a.attname order by a.attname)::text[] as cols
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.conrelid = 'tenders'::regclass and c.contype = 'u' and c.conname = 'tenders_org_id_id_unique'
      group by c.oid`;
    expect(rows.map((r) => r.cols)).toEqual([['id', 'org_id']]);
  });
});

describe('B5 - UNIQUE (org_id, pos_store_id, firestore_doc_id, version)', () => {
  it('control: the same document at version 2 is accepted; a distinct doc at version 1 is accepted', async () => {
    const f = await orgFixture('b5c');
    const { err } = await attempt(null, async (tx) => {
      await insReceipt(tx, f, { version: 1 });
      await insReceipt(tx, f, { version: 2, hash: HASH_B });
      await insReceipt(tx, f, { doc: 'doc-2', version: 1 });
    });
    expect(err).toBeUndefined();
  });
  it('the same document and version twice is refused (23505), even with another hash', async () => {
    const f = await orgFixture('b5d');
    const { err } = await attempt(null, async (tx) => {
      await insReceipt(tx, f, { version: 1 });
      await insReceipt(tx, f, { version: 1, hash: HASH_B });
    });
    expect(err?.code).toBe('23505');
  });
  it('a refused version leaves no row behind (the key is the guard, not the app)', async () => {
    const f = await orgFixture('b5e');
    await insReceipt(sql, f, { version: 1 });
    await expect(insReceipt(sql, f, { version: 1, hash: HASH_B })).rejects.toMatchObject({ code: '23505' });
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from pos_bridge_receipts where org_id = ${f.orgId}`;
    expect(n!.n).toBe(1);
  });
});

describe('B6 - pos_bridge_receipts_current is security_invoker and returns the latest version', () => {
  it('reloptions carries security_invoker=true', async () => {
    const rows = await sql<{ opts: string[] | null }[]>`select reloptions as opts from pg_class where relname = 'pos_bridge_receipts_current' and relkind = 'v'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.opts ?? []).toContain('security_invoker=true');
  });

  it('one row per document, the highest version; other documents are untouched', async () => {
    const f = await orgFixture('b6');
    await insReceipt(sql, f, { doc: 'd1', version: 1, total: 10000, hash: HASH_A });
    await insReceipt(sql, f, { doc: 'd1', version: 2, total: 12000, status: 'voided', hash: HASH_B });
    await insReceipt(sql, f, { doc: 'd2', version: 1, total: 500 });
    const rows = await sql<{ firestore_doc_id: string; version: number; total_centavos: string; status: string }[]>`
      select firestore_doc_id, version, total_centavos, status from pos_bridge_receipts_current where org_id = ${f.orgId} order by firestore_doc_id`;
    expect(rows.map((r) => [r.firestore_doc_id, r.version, Number(r.total_centavos), r.status])).toEqual([
      ['d1', 2, 12000, 'voided'],
      ['d2', 1, 500, 'final'],
    ]);
  });

  it('read as shareat_app it applies the caller\'s RLS: org A sees only its own rows', async () => {
    const a = await orgFixture('b6a');
    const b = await orgFixture('b6b');
    await insReceipt(sql, a, { doc: 'only-a' });
    await insReceipt(sql, b, { doc: 'only-b' });
    const { value } = await attempt(a.orgId, (tx) => tx<{ org_id: string }[]>`select org_id from pos_bridge_receipts_current where firestore_doc_id in ('only-a', 'only-b')`);
    expect(value!.map((r) => r.org_id)).toEqual([a.orgId]);
  });
});

describe('B7 - scheduler_runs_job_check accepts pos_receipt_bridge and every old job', () => {
  const OLD = [
    'depreciation', 'amortisation', 'attendance_sweep', 'mirror_publish', 'inbox_relay', 'order_wastage_backstop',
    'finding_observation', 'budget_reissue', 'recurring_expenses', 'orphan_file_sweep', 'fiscal_period_seed',
    'usage_auto_post', 'pos_day_import',
  ];
  for (const job of [...OLD, 'pos_receipt_bridge']) {
    it(`accepts ${job}`, async () => {
      const f = await orgFixture('b7');
      const { err } = await attempt(null, (tx) => tx`insert into scheduler_runs (org_id, job, period) values (${f.orgId}, ${job}, '2027-01')`);
      expect(err).toBeUndefined();
    });
  }
  it('still refuses an unknown job (23514)', async () => {
    const f = await orgFixture('b7x');
    const { err } = await attempt(null, (tx) => tx`insert into scheduler_runs (org_id, job, period) values (${f.orgId}, 'pos_receipt_bridgee', '2027-01')`);
    expect(err?.code).toBe('23514');
  });
});

describe('B8 - no personal data (Ruling 7): no personal-data column in any bridge table', () => {
  const PERSONAL = /(customer|cust_|diner|senior|pwd|tin\b|_tin|tin_|address|phone|mobile|email|birth|id_?no|id_?num|id_number|guest_name|client_name|buyer)/i;
  it('column names carry none of the personal-data words', async () => {
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name = any(${[...BRIDGE_TABLES, 'pos_bridge_receipts_current']})`;
    expect(cols.length).toBeGreaterThan(20);
    const bad = cols.filter((c) => PERSONAL.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`);
    expect(bad).toEqual([]);
  });
});

describe('B9 - money is integer centavos, never float or numeric', () => {
  it('every *_centavos column is bigint, and no bridge column is a float or numeric except line quantity', async () => {
    const cols = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = any(${[...BRIDGE_TABLES]})`;
    const money = cols.filter((c) => c.column_name.endsWith('_centavos'));
    expect(money.length).toBeGreaterThanOrEqual(10);
    expect(money.filter((c) => c.data_type !== 'bigint').map((c) => `${c.table_name}.${c.column_name}`)).toEqual([]);
    const floaty = cols.filter((c) => ['real', 'double precision', 'numeric', 'money'].includes(c.data_type)).map((c) => `${c.table_name}.${c.column_name}`);
    expect(floaty).toEqual(['pos_bridge_receipt_lines.quantity']);
  });
  it('a fractional centavo cannot be stored (the column is integral)', async () => {
    const f = await orgFixture('b9');
    const { err } = await attempt(null, (tx) => tx`
      insert into pos_bridge_receipts (org_id, store_id, pos_store_id, firestore_doc_id, version, kind, status, pos_calendar_date,
                                       subtotal_centavos, discount_centavos, total_centavos, raw, doc_hash)
      values (${f.orgId}, ${f.storeId}, 'p', 'd', 1, 'sale', 'final', '2027-01-05', 1, 0, 'abc', '{}'::jsonb, ${HASH_A})`);
    expect(err).toBeDefined();
  });
});

describe('B10 - RLS isolates orgs', () => {
  it('control: org A inserts and reads its own receipt as shareat_app', async () => {
    const a = await orgFixture('b10c');
    const { err, value } = await attempt(a.orgId, async (tx) => {
      await insReceipt(tx, a, { doc: 'rls-own' });
      return tx<{ n: number }[]>`select count(*)::int as n from pos_bridge_receipts where firestore_doc_id = 'rls-own'`;
    });
    expect(err).toBeUndefined();
    expect(value![0]!.n).toBe(1);
  });
  it("org A cannot see org B's receipts, lines or day checks", async () => {
    const a = await orgFixture('b10a');
    const b = await orgFixture('b10b');
    const [rb] = await insReceipt(sql, b, { doc: 'rls-b' });
    await insLine(sql, b.orgId, rb!.id);
    await sql`insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, result)
              values (${b.orgId}, ${b.storeId}, 'pos-lipa', '2027-01-05', 1, 10000, 'pending')`;
    const { value } = await attempt(a.orgId, async (tx) => ({
      r: await tx`select 1 from pos_bridge_receipts where org_id = ${b.orgId}`,
      l: await tx`select 1 from pos_bridge_receipt_lines where org_id = ${b.orgId}`,
      d: await tx`select 1 from pos_bridge_day_checks where org_id = ${b.orgId}`,
    }));
    expect({ r: value!.r.length, l: value!.l.length, d: value!.d.length }).toEqual({ r: 0, l: 0, d: 0 });
  });
  it("org A cannot write a row labelled org B (42501 on every table)", async () => {
    const a = await orgFixture('b10wa');
    const b = await orgFixture('b10wb');
    const r = await attempt(a.orgId, (tx) => insReceipt(tx, b));
    expect(r.err?.code).toBe('42501');
    const d = await attempt(a.orgId, (tx) => tx`
      insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, result)
      values (${b.orgId}, ${b.storeId}, 'pos-lipa', '2027-01-05', 0, 0, 'pending')`);
    expect(d.err?.code).toBe('42501');
    const [rb] = await insReceipt(sql, b, { doc: 'rls-wb' });
    const l = await attempt(a.orgId, (tx) => insLine(tx, b.orgId, rb!.id));
    expect(l.err?.code).toBe('42501');
    const t = await attempt(a.orgId, (tx) => insTender(tx, b.orgId, rb!.id, null));
    expect(t.err?.code).toBe('42501');
  });
  it('shareat_app cannot UPDATE or DELETE a receipt (append-only by grant)', async () => {
    const a = await orgFixture('b10u');
    const [r] = await insReceipt(sql, a, { doc: 'rls-append' });
    const u = await attempt(a.orgId, (tx) => tx`update pos_bridge_receipts set total_centavos = 1 where id = ${r!.id}`);
    expect(u.err?.code).toBe('42501');
    const d = await attempt(a.orgId, (tx) => tx`delete from pos_bridge_receipts where id = ${r!.id}`);
    expect(d.err?.code).toBe('42501');
  });
});

describe('B11 - day checks', () => {
  it('one row per store-day; pending iff no feed figure', async () => {
    const f: F = await orgFixture('b11');
    const ok = await attempt(null, async (tx) => {
      await tx`insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, result)
               values (${f.orgId}, ${f.storeId}, 'p', '2027-01-05', 3, 30000, 'pending')`;
      await tx`insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, feed_total_centavos, difference_centavos, result)
               values (${f.orgId}, ${f.storeId}, 'p', '2027-01-06', 3, 30000, 30000, 0, 'match')`;
    });
    expect(ok.err).toBeUndefined();
    const dup = await attempt(null, async (tx) => {
      await tx`insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, result)
               values (${f.orgId}, ${f.storeId}, 'p', '2027-01-05', 3, 30000, 'pending')`;
      await tx`insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, result)
               values (${f.orgId}, ${f.storeId}, 'p', '2027-01-05', 4, 40000, 'pending')`;
    });
    expect(dup.err?.code).toBe('23505');
    const shape = await attempt(null, (tx) => tx`
      insert into pos_bridge_day_checks (org_id, store_id, pos_store_id, pos_calendar_date, receipt_count, net_sales_centavos, result)
      values (${f.orgId}, ${f.storeId}, 'p', '2027-01-07', 3, 30000, 'match')`);
    expect(shape.err?.code).toBe('23514');
  });
});
