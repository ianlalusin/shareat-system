/**
 * T-512 (T-511 S5c) TESTER - the table `business_rule_values`, as the migration builds it (hand-authored, ADR-012 s5; precedent pay_rates, migrations 0105 and 0221).
 * docs/tasks/512-business-rules-s5c-spec.md "Table". Real Postgres via TEST_DATABASE_URL, `_test` name guard.
 *
 * RED today: migration 0239 does not exist, so the journal has no idx 239 and the table is missing.
 *
 * ASSUMPTIONS beyond the agreed list (builders must follow them):
 *   - the migration file is packages/db/migrations/0239_*.sql (the spec names 0239_t511_business_rule_values.sql) and the journal entry has idx 239 and the same tag;
 *   - (the seed rows are checked against the registry defaults in packages/domain/tests/integration/t512-seed-matches-registry.test.ts: the registry lives in the domain package)
 *   - the append-only trigger is ENABLE ALWAYS (tgenabled = 'A'), BEFORE UPDATE and BEFORE DELETE; the exact SQLSTATE of its refusal is not pinned here (only that it refuses).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const TABLE = 'business_rule_values';
let OWNER: string;

beforeAll(async () => {
  const [row] = await sql<{ tableowner: string }[]>`select tableowner from pg_tables where schemaname = 'public' and tablename = ${TABLE}`;
  if (!row?.tableowner) throw new Error('T-512: public.business_rule_values does not exist (migration 0239 not applied).');
  OWNER = row.tableowner;
});
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  return undefined;
}
async function asApp<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.principal_kind', 'staff', true)`;
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

async function org(hint: string) {
  const code = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Admin') returning id`;
  return { orgId: o!.id, personId: p!.id };
}
async function rule(o: { orgId: string; personId: string }, key: string, value: string, from: string, reason = 'test change') {
  const [r] = await sql<{ id: string }[]>`
    insert into business_rule_values (org_id, key, value, effective_from, set_by, reason)
    values (${o.orgId}, ${key}, ${value}, ${from}, ${o.personId}, ${reason}) returning id`;
  return r!.id;
}

describe('T-512 migration 0239 - applied through the journal', () => {
  it('the journal has idx 239, its tag names a file that exists, and its when is later than every earlier entry [kills: a file nobody registered; a clock-time when]', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
    const e = journal.entries.find((x) => x.idx === 239);
    expect(e, 'no journal entry with idx 239').toBeDefined();
    expect(e!.tag).toMatch(/^0239_/);
    expect(readdirSync(MIGRATIONS)).toContain(`${e!.tag}.sql`);
    for (const x of journal.entries.filter((y) => y.idx < 239)) expect(e!.when, `after idx ${x.idx}`).toBeGreaterThan(x.when);
    // the filesystem has exactly one 0239 file
    expect(readdirSync(MIGRATIONS).filter((n) => n.startsWith('0239_'))).toHaveLength(1);
  });

  it('the table exists with the spec columns and types: value numeric(18,6), effective_from date, reason text, set_by nullable, created_at timestamptz', async () => {
    const cols = await sql<{ column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null; is_nullable: string }[]>`
      select column_name, data_type, numeric_precision, numeric_scale, is_nullable
        from information_schema.columns where table_schema = 'public' and table_name = ${TABLE}`;
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    expect(Object.keys(by).sort()).toEqual(['created_at', 'effective_from', 'id', 'key', 'org_id', 'reason', 'set_by', 'value']);
    expect(by.value).toMatchObject({ data_type: 'numeric', numeric_precision: 18, numeric_scale: 6, is_nullable: 'NO' });
    expect(by.effective_from).toMatchObject({ data_type: 'date', is_nullable: 'NO' });
    expect(by.reason).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(by.key).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(by.set_by).toMatchObject({ is_nullable: 'YES' });
    expect(by.created_at).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'NO' });
    expect(by.org_id).toMatchObject({ data_type: 'uuid', is_nullable: 'NO' });
  });
});

describe('T-512 table - row-level security: enabled, forced, scoped by org', () => {
  it('RLS is ENABLED and FORCED, and a policy keyed on app_current_org() exists [kills: an owner that bypasses; a table nobody scoped]', async () => {
    const [c] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`select relrowsecurity, relforcerowsecurity from pg_class where oid = ${`public.${TABLE}`}::regclass`;
    expect(c).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pol = await sql<{ qual: string | null; with_check: string | null }[]>`select qual, with_check from pg_policies where schemaname = 'public' and tablename = ${TABLE}`;
    expect(pol.length).toBeGreaterThanOrEqual(1);
    expect(pol.some((p) => /app_current_org\(\)/.test(`${p.qual ?? ''} ${p.with_check ?? ''}`))).toBe(true);
  });

  it('two organisations: each reads only its own rows, as the app role [kills: a missing USING]', async () => {
    const a = await org('t512rls-a');
    const b = await org('t512rls-b');
    const ra = await rule(a, 'settlement.variance_floor_amount', '70.000000', '2026-12-01');
    const rb = await rule(b, 'settlement.variance_floor_amount', '90.000000', '2026-12-01');
    const seenByA = await asApp(a.orgId, (tx) => tx<{ id: string }[]>`select id from business_rule_values`);
    const seenByB = await asApp(b.orgId, (tx) => tx<{ id: string }[]>`select id from business_rule_values`);
    expect(seenByA.map((r) => r.id)).toEqual([ra]);
    expect(seenByB.map((r) => r.id)).toEqual([rb]);
  });

  it('an organisation cannot write a row labelled with another organisation (WITH CHECK) [kills: a policy that checks reads only]', async () => {
    const a = await org('t512rls-w-a');
    const b = await org('t512rls-w-b');
    const err = await caught(
      asApp(a.orgId, (tx) => tx`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${b.orgId}, 'tax.vat_percent', '10', '2026-12-01', ${a.personId}, 'cross-org')`),
    );
    expect(err, 'a cross-org insert succeeded').toBeDefined();
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from business_rule_values where org_id = ${b.orgId}`;
    expect(n!.n).toBe(0);
  });

  it('with no principal set, the app role sees nothing', async () => {
    const a = await org('t512rls-np');
    await rule(a, 'tax.vat_percent', '10', '2026-12-01');
    const rows = await sql
      .begin(async (tx) => {
        await tx.unsafe(`set local role ${APP_ROLE}`);
        return tx<{ id: string }[]>`select id from business_rule_values`;
      })
      .catch(() => 'refused' as const);
    expect(rows === 'refused' || (rows as unknown[]).length === 0).toBe(true);
  });
});

describe('T-512 table - append-only', () => {
  it('app role: SELECT and INSERT only (UPDATE, DELETE, TRUNCATE are not granted) [kills: a grant wider than the spec]', async () => {
    const has = async (priv: string) => (await sql<{ ok: boolean }[]>`select has_table_privilege(${APP_ROLE}, ${`public.${TABLE}`}, ${priv}) as ok`)[0]!.ok;
    expect(await has('SELECT')).toBe(true);
    expect(await has('INSERT')).toBe(true);
    expect(await has('UPDATE')).toBe(false);
    expect(await has('DELETE')).toBe(false);
    expect(await has('TRUNCATE')).toBe(false);
  });

  it('app role: a positive control, then UPDATE and DELETE are refused with 42501 and the row is unchanged', async () => {
    const a = await org('t512ao-app');
    const id = await rule(a, 'settlement.variance_floor_amount', '70.000000', '2026-12-01');
    const seen = await asApp(a.orgId, (tx) => tx<{ id: string }[]>`select id from business_rule_values where id = ${id}`);
    expect(seen).toHaveLength(1);
    const upd = await caught(asApp(a.orgId, (tx) => tx`update business_rule_values set value = '1' where id = ${id}`));
    expect(upd?.code).toBe('42501');
    const del = await caught(asApp(a.orgId, (tx) => tx`delete from business_rule_values where id = ${id}`));
    expect(del?.code).toBe('42501');
    const [row] = await sql<{ value: string }[]>`select value::text from business_rule_values where id = ${id}`;
    expect(Number(row!.value)).toBe(70);
  });

  it('the TABLE OWNER (privileges bypassed) is refused by the trigger on UPDATE and DELETE, also under session_replication_role = replica; the row is unchanged [kills: a trigger that is not ENABLE ALWAYS]', async () => {
    const a = await org('t512ao-owner');
    const id = await rule(a, 'tax.vat_percent', '10.000000', '2026-12-01');
    const asOwner = (stmt: (tx: postgres.TransactionSql) => Promise<unknown>, replica: boolean) =>
      caught(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${OWNER}`);
          if (replica) await tx.unsafe(`set local session_replication_role = 'replica'`);
          await stmt(tx);
        }),
      );
    for (const replica of [false, true]) {
      const upd = await asOwner((tx) => tx`update business_rule_values set value = '1' where id = ${id}`, replica);
      expect(upd, `update replica=${replica} was NOT refused`).toBeDefined();
      const del = await asOwner((tx) => tx`delete from business_rule_values where id = ${id}`, replica);
      expect(del, `delete replica=${replica} was NOT refused`).toBeDefined();
    }
    const [row] = await sql<{ value: string }[]>`select value::text from business_rule_values where id = ${id}`;
    expect(Number(row!.value)).toBe(10);
  });

  it('the guard trigger is enabled ALWAYS and covers both UPDATE and DELETE, BEFORE the change [kills: ENABLE ORIGIN, the default]', async () => {
    const trg = await sql<{ tgname: string; tgenabled: string; tgtype: number }[]>`
      select tgname, tgenabled, tgtype::int as tgtype from pg_trigger where tgrelid = ${`public.${TABLE}`}::regclass and not tgisinternal`;
    expect(trg.length).toBeGreaterThanOrEqual(1);
    const guards = trg.filter((t) => t.tgenabled === 'A' && (t.tgtype & 2) === 2);
    expect(guards.length, 'no BEFORE trigger with tgenabled = A').toBeGreaterThanOrEqual(1);
    expect(guards.some((t) => (t.tgtype & 16) === 16), 'no ALWAYS BEFORE trigger on UPDATE').toBe(true);
    expect(guards.some((t) => (t.tgtype & 8) === 8), 'no ALWAYS BEFORE trigger on DELETE').toBe(true);
  });

  it('INSERT still works as the app role, and a correction is a NEWER row: both rows are kept, in the order made [kills: a guard that blocks inserts]', async () => {
    const a = await org('t512ao-ins');
    await asApp(a.orgId, (tx) => tx`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${a.orgId}, 'tax.vat_percent', '11', '2026-12-01', ${a.personId}, 'first')`);
    await asApp(a.orgId, (tx) => tx`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${a.orgId}, 'tax.vat_percent', '13', '2026-12-01', ${a.personId}, 'correction')`);
    const rows = await sql<{ reason: string }[]>`select reason from business_rule_values where org_id = ${a.orgId} order by created_at, id`;
    expect(rows.map((r) => r.reason)).toEqual(['first', 'correction']);
  });

  it('no unique index on (org, key, effective_from): a same-day correction must be insertable (spec: "No unique index")', async () => {
    const idx = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'public' and tablename = ${TABLE}`;
    const unique = idx.filter((i) => /unique/i.test(i.indexdef) && !/\(id\)/.test(i.indexdef));
    expect(unique.map((u) => u.indexdef)).toEqual([]);
  });

  it('the reason is never empty (CHECK) [kills: a rule changed for no stated reason]', async () => {
    const a = await org('t512-reason');
    const err = await caught(rule(a, 'tax.vat_percent', '10', '2026-12-01', ''));
    expect(err?.code).toBe('23514');
  });

  it('the table itself refuses a negative value and a third decimal, as the app role, and still takes the registry values [kills: a row the writer never saw]', async () => {
    const a = await org('t512-value-checks');
    const ins = (value: string) =>
      asApp(a.orgId, (tx) => tx`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${a.orgId}, 'tax.vat_percent', ${value}, '2026-12-01', ${a.personId}, 'check')`);
    expect((await caught(ins('-5')))?.code).toBe('23514');
    expect((await caught(ins('0.125')))?.code).toBe('23514');
    for (const ok of ['0', '0.5', '12', '0.01', '50.00', '10', '100000']) expect(await caught(ins(ok)), ok).toBeUndefined();
  });
});
