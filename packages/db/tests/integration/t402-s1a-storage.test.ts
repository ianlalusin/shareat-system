/**
 * T-402 S1a - activity log STORAGE. `docs/tasks/402-activity-log.md`: Rulings R1, R6, R7, Contract section 3
 * (the migration), Invariants 11, 12, 12a, 12b, 12c, 14 (the post-migration shape; 13 and 13a, which need
 * pre-migration rows, live in `t402-s1a-migration.test.ts`).
 *
 * TESTER, not BUILDER. Real Postgres via TEST_DATABASE_URL (`_test` guard). Every row-writing leg runs in a
 * transaction that is ALWAYS rolled back (audit_log is append-only: nothing can be cleaned up afterwards).
 *
 * ## State at HEAD (migration 0NNN does not exist; audit_log is a plain table)
 * SHAPE assertions (they fail on the assertion itself, which names what is missing): the partition tree, the R1
 * columns, the primary key, the indexes, the side tables, the registries. LEG assertions that must INSERT first
 * fail on a missing column (`42703`) for the same root cause; each of those has a control insert with the same
 * shape and a valid value, so a refusal is only accepted when it is the right refusal (SQLSTATE asserted).
 *
 * ## Names the BUILDER must match (the spec fixes these; the rest is found through the catalog)
 *  - columns: store_id, category, sensitivity, severity, retention_class, recorded_at, device_id,
 *    uploaded_by_person_id, event_key, redacted_keys, clock_suspect (R1);
 *  - PK (id, retention_class, recorded_at); LIST (retention_class) -> RANGE (recorded_at) per Manila year;
 *  - trigger audit_log_append_only (parent + every partition, tgenabled = 'A'); policies audit_log_org_read /
 *    audit_log_org_append on the parent only;
 *  - tables audit_log_event_keys, authz_denial_counts (+ drizzle schema exports of the same table names).
 *  Partition NAMES are not specified and are never asserted (found through pg_inherits). There is no named
 *  partition-creation function in the spec, so the S5 route is the R6 recipe written out in `createPartitionR6`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';
import { CUTOVER_CLASSIFICATION } from '../../src/cutover/classification';
import * as schema from '../../schema';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
type Err = Error & { code?: string };
class Rollback extends Error {}

const TESTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)));

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const SEV = { critical: 2, high: 4, normal: 5, low: 6 } as const;
type Sens = keyof typeof SEV;
const CATEGORIES = ['security', 'order', 'money', 'menu_price', 'stock', 'staff', 'settings', 'data', 'customer'] as const;
const MONEYISH = ['money', 'order', 'menu_price', 'customer'] as const;
const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

/** Runs `fn` in a transaction that is ALWAYS rolled back; rethrows anything `fn` throws. */
async function rolledBack(fn: (t: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (t) => {
      await fn(t);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

/** Runs `fn` inside a savepoint; returns the error (SQLSTATE in `.code`) or undefined. The savepoint keeps the outer tx usable. */
async function refused(t: Tx, fn: (s: Tx) => Promise<unknown>): Promise<Err | undefined> {
  try {
    await t.savepoint(async (s) => {
      await fn(s as unknown as Tx);
    });
  } catch (e) {
    return e as Err;
  }
  return undefined;
}

/** `fn` as the restricted app role principalled to `orgId` (pass null for no principal). Always resets the role. */
async function asApp<T>(t: Tx, orgId: string | null, fn: () => Promise<T>): Promise<T> {
  await t.unsafe(`set local role ${APP_ROLE}`);
  if (orgId !== null) await t`select set_config('app.org_id', ${orgId}, true)`;
  try {
    return await fn();
  } finally {
    try {
      await t.unsafe('reset role');
    } catch {
      /* the tx is aborted; the enclosing savepoint rollback restores the role */
    }
  }
}

interface Fx {
  orgA: string;
  orgB: string;
  personA: string;
  personB: string;
  storeA: string;
  storeB: string;
}
async function fixture(t: Tx): Promise<Fx> {
  const mk = async (hint: string) => {
    const code = uid(`t402s1a-${hint}`);
    const [o] = await t<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const [s] = await t<{ id: string }[]>`insert into stores (org_id, code, name) values (${o!.id}, ${uid('st')}, 'Lipa') returning id`;
    const [p] = await t<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Actor') returning id`;
    return { org: o!.id, store: s!.id, person: p!.id };
  };
  const a = await mk('a');
  const b = await mk('b');
  return { orgA: a.org, orgB: b.org, personA: a.person, personB: b.person, storeA: a.store, storeB: b.store };
}

async function manilaYear(t: Tx | typeof sql): Promise<number> {
  const [r] = await t<{ y: number }[]>`select extract(year from now() at time zone 'Asia/Manila')::int as y`;
  return r!.y;
}
const midYear = (y: number) => `${y}-06-15T12:00:00+08:00`;

interface PutOpts {
  orgId: string;
  actor?: string | null;
  action?: string;
  category?: string;
  sens?: Sens;
  severity?: number;
  retention?: string;
  recordedAt?: string;
  occurredAt?: string;
  storeId?: string | null;
  uploadedBy?: string | null;
  deviceId?: string | null;
}
/** One audit_log row with the TARGET shape, as the owner (RLS cannot filter the owner connection). */
async function put(t: Tx, o: PutOpts): Promise<string> {
  const sens = o.sens ?? 'normal';
  const recordedAt = o.recordedAt ?? new Date().toISOString();
  const [r] = await t<{ id: string }[]>`
    insert into audit_log (org_id, actor_person_id, action, entity, entity_id, before, after, source, store_id,
                           uploaded_by_person_id, device_id, category, sensitivity, severity, retention_class,
                           recorded_at, occurred_at)
    values (${o.orgId}, ${o.actor ?? null}, ${o.action ?? 'set_channel_payout'}, 'sales_channels', ${crypto.randomUUID()},
            ${t.json({ a: 1 })}, ${t.json({ a: 2 })}, 'web', ${o.storeId ?? null}, ${o.uploadedBy ?? null}, ${o.deviceId ?? null},
            ${o.category ?? 'security'}, ${sens}, ${o.severity ?? SEV[sens]}, ${o.retention ?? 'r10y'},
            ${recordedAt}::timestamptz, ${o.occurredAt ?? recordedAt}::timestamptz)
    returning id`;
  return r!.id;
}
const leafOf = async (t: Tx, id: string) =>
  (await t<{ leaf: string }[]>`select tableoid::regclass::text as leaf from audit_log where id = ${id}`)[0]!.leaf;

interface Node {
  oid: number;
  relname: string;
  relkind: string;
  depth: number;
  bound: string | null;
  rls: boolean;
  forced: boolean;
}
const TREE_SQL = `
  with recursive tree as (
    select i.inhrelid as oid, 1 as depth from pg_inherits i where i.inhparent = 'public.audit_log'::regclass
    union all
    select i.inhrelid, t.depth + 1 from pg_inherits i join tree t on i.inhparent = t.oid
  )
  select t.oid::int as oid, c.relname, c.relkind, t.depth, pg_get_expr(c.relpartbound, c.oid) as bound,
         c.relrowsecurity as rls, c.relforcerowsecurity as forced
  from tree t join pg_class c on c.oid = t.oid order by t.depth, c.relname`;
const tree = (q: Tx | typeof sql) => q.unsafe<Node[]>(TREE_SQL);

async function appPrivs(q: Tx | typeof sql, relname: string): Promise<string[]> {
  const held: string[] = [];
  for (const p of ALL_PRIVS) {
    const [r] = await q<{ ok: boolean }[]>`select has_table_privilege(${APP_ROLE}, ${`public.${relname}`}, ${p}) as ok`;
    if (r!.ok) held.push(p);
  }
  return held;
}
const policyCount = async (q: Tx | typeof sql, relname: string) =>
  (await q<{ n: number }[]>`select count(*)::int as n from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = ${relname} and c.relnamespace = 'public'::regnamespace`)[0]!.n;

/** R6 (and S5's job): what must happen, in the creating transaction, for a NEW partition. */
async function createPartitionR6(t: Tx, parentClassPartition: string, name: string, fromTs: string, toTs: string) {
  await t.unsafe(`create table "${name}" partition of "${parentClassPartition}" for values from ('${fromTs}') to ('${toTs}')`);
  await t.unsafe(`revoke all on "${name}" from ${APP_ROLE}`);
  await t.unsafe(`alter table "${name}" enable row level security`);
  await t.unsafe(`alter table "${name}" force row level security`);
  await t.unsafe(`alter table "${name}" enable always trigger audit_log_append_only`);
}
async function classPartition(t: Tx | typeof sql, cls: 'r10y' | 'r2y'): Promise<string> {
  const nodes = await tree(t);
  const n = nodes.find((x) => x.depth === 1 && x.bound === `FOR VALUES IN ('${cls}')`);
  expect(n, `a depth-1 partition FOR VALUES IN ('${cls}') of audit_log (R6) - audit_log is not partitioned by retention class yet`).toBeDefined();
  return n!.relname;
}

// =================================================================================================
// R6 shape: LIST (retention_class) -> RANGE (recorded_at) per Manila year, no DEFAULT, PK, columns, indexes
// =================================================================================================
describe('S1a shape - audit_log is partitioned by retention class, then by calendar year (R6)', () => {
  it('the parent is a partitioned table LIST (retention_class) - HEAD: relkind r, not p', async () => {
    const [r] = await sql<{ relkind: string; keydef: string | null }[]>`
      select c.relkind, pg_get_partkeydef(c.oid) as keydef from pg_class c where c.oid = 'public.audit_log'::regclass`;
    expect(r!.relkind, 'audit_log must be relkind p (partitioned)').toBe('p');
    expect(r!.keydef).toBe('LIST (retention_class)');
  });

  it('exactly two class partitions, r10y and r2y, each itself partitioned RANGE (recorded_at)', async () => {
    const nodes = await tree(sql);
    const classes = nodes.filter((n) => n.depth === 1);
    expect(classes.map((n) => n.bound).sort()).toEqual([`FOR VALUES IN ('r10y')`, `FOR VALUES IN ('r2y')`]);
    for (const c of classes) {
      const [r] = await sql<{ relkind: string; keydef: string | null }[]>`
        select c.relkind, pg_get_partkeydef(c.oid) as keydef from pg_class c where c.oid = ${c.oid}::oid`;
      expect(r!.relkind, `${c.relname} must be partitioned`).toBe('p');
      expect(r!.keydef, c.relname).toBe('RANGE (recorded_at)');
    }
  });

  it('NO DEFAULT partition anywhere: a missing year fails loudly instead of landing somewhere unpurgeable (R6)', async () => {
    const nodes = await tree(sql);
    expect(nodes.length, 'the partition tree must exist').toBeGreaterThan(0);
    expect(nodes.filter((n) => n.bound === 'DEFAULT').map((n) => n.relname)).toEqual([]);
  });

  it('the primary key is (id, retention_class, recorded_at) - the partition keys are part of it', async () => {
    const rows = await sql<{ col: string }[]>`
      select a.attname as col from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
      where k.conrelid = 'public.audit_log'::regclass and k.contype = 'p'`;
    expect(rows.map((r) => r.col).sort()).toEqual(['id', 'recorded_at', 'retention_class']);
  });

  it('the R1 columns exist with the specified type, nullability and default', async () => {
    const rows = await sql<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_log'`;
    const col = (n: string) => rows.find((r) => r.column_name === n);
    const want: Array<[string, string, 'YES' | 'NO']> = [
      ['store_id', 'uuid', 'YES'],
      ['category', 'text', 'NO'],
      ['sensitivity', 'text', 'NO'],
      ['severity', 'smallint', 'NO'],
      ['retention_class', 'text', 'NO'],
      ['recorded_at', 'timestamp with time zone', 'NO'],
      ['device_id', 'uuid', 'YES'],
      ['uploaded_by_person_id', 'uuid', 'YES'],
      ['event_key', 'text', 'YES'],
      ['redacted_keys', 'ARRAY', 'NO'],
      ['clock_suspect', 'boolean', 'NO'],
    ];
    for (const [name, type, nullable] of want) {
      expect(col(name), `audit_log.${name} must exist (R1)`).toBeDefined();
      expect({ name, type: col(name)!.data_type, nullable: col(name)!.is_nullable }).toEqual({ name, type, nullable });
    }
    expect(col('redacted_keys')!.udt_name).toBe('_text');
    expect(col('recorded_at')!.column_default).toMatch(/now\(\)|CURRENT_TIMESTAMP/i);
    expect(col('clock_suspect')!.column_default).toBe('false');
    expect(col('redacted_keys')!.column_default).toMatch(/'\{\}'/);
  });

  it('the six indexes of Contract 3 step 4 exist ON THE PARENT (so they propagate to every partition)', async () => {
    const defs = (
      await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'audit_log'`
    ).map((r) => r.indexdef.replace(/\s+/g, ' '));
    const has = (re: RegExp) => defs.some((d) => re.test(d));
    expect(has(/\(org_id, occurred_at DESC, id DESC\)/), 'org_id, occurred_at desc, id desc').toBe(true);
    expect(has(/\(org_id, store_id, occurred_at DESC\)/), 'org_id, store_id, occurred_at desc').toBe(true);
    expect(has(/\(org_id, actor_person_id, occurred_at DESC\)/), 'org_id, actor_person_id, occurred_at desc').toBe(true);
    expect(has(/\(entity, entity_id\)/), 'entity, entity_id (latestForEntity)').toBe(true);
    expect(has(/\(org_id, occurred_at DESC\) WHERE .*sensitivity.*critical.*high/), 'partial: critical/high').toBe(true);
    expect(has(/\(org_id, occurred_at\) WHERE .*clock_suspect/), 'partial: clock_suspect').toBe(true);
  });
});

// =================================================================================================
// Invariant 14 - the partition key is recorded_at (server time) in Manila years, never occurred_at
// =================================================================================================
describe('S1a invariant 14 - rows route by recorded_at in Manila calendar years', () => {
  it('current year and the next two exist for BOTH classes (a row at mid-year routes; none is refused)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      for (const [retention, category, sens] of [
        ['r10y', 'money', 'normal'],
        ['r2y', 'security', 'low'],
      ] as const) {
        for (const yr of [y, y + 1, y + 2]) {
          const err = await refused(t, (s) => put(s, { orgId: f.orgA, retention, category, sens, recordedAt: midYear(yr) }));
          expect(err?.message, `${retention} ${yr} must have a partition`).toBeUndefined();
        }
      }
    });
  });

  it('year current+3 has NO partition: the insert fails loudly (no DEFAULT to swallow it)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      const err = await refused(t, (s) => put(s, { orgId: f.orgA, recordedAt: midYear(y + 3) }));
      expect(err, 'a row for a year with no partition must be refused').toBeInstanceOf(Error);
      expect(err?.code).toBe('23514');
      expect(err?.message).toMatch(/no partition/i);
    });
  });

  it('a row recorded next 1 January 00:00 Manila lands in next year, 1 second earlier in this year (the boundary is MANILA, not UTC)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      const thisYear = await leafOf(t, await put(t, { orgId: f.orgA, recordedAt: midYear(y) }));
      const nextYear = await leafOf(t, await put(t, { orgId: f.orgA, recordedAt: midYear(y + 1) }));
      expect(thisYear).not.toBe(nextYear);
      const lastSecond = await leafOf(t, await put(t, { orgId: f.orgA, recordedAt: `${y}-12-31T23:59:59+08:00` }));
      const firstSecond = await leafOf(t, await put(t, { orgId: f.orgA, recordedAt: `${y + 1}-01-01T00:00:00+08:00` }));
      expect(lastSecond, '31 Dec 23:59:59 Manila is still this year').toBe(thisYear);
      expect(firstSecond, '1 Jan 00:00:00 Manila is next year').toBe(nextYear);
      // 1 Jan 00:00 Manila is 31 Dec 16:00 UTC: a UTC-bounded partition would put it in THIS year.
      const utcEdge = await leafOf(t, await put(t, { orgId: f.orgA, recordedAt: `${y}-12-31T16:00:00Z` }));
      expect(utcEdge, '31 Dec 16:00 UTC = 1 Jan 00:00 Manila = next year').toBe(nextYear);
    });
  });

  it('a device occurred_at of LAST year with recorded_at now lands in THIS year\'s partition (mutant: key = occurred_at)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      const control = await leafOf(t, await put(t, { orgId: f.orgA, recordedAt: midYear(y) }));
      const skewed = await put(t, { orgId: f.orgA, recordedAt: midYear(y), occurredAt: midYear(y - 1) });
      expect(await leafOf(t, skewed)).toBe(control);
      const [r] = await t<{ same: boolean }[]>`select (extract(year from occurred_at at time zone 'Asia/Manila')::int = ${y - 1}) as same from audit_log where id = ${skewed}`;
      expect(r!.same, 'occurred_at keeps its own meaning (last year)').toBe(true);
    });
  });

  it('the class decides the branch: r10y and r2y rows of the same instant land in different partitions of the same year', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      const long = await leafOf(t, await put(t, { orgId: f.orgA, retention: 'r10y', recordedAt: midYear(y) }));
      const short = await leafOf(t, await put(t, { orgId: f.orgA, retention: 'r2y', category: 'security', sens: 'low', recordedAt: midYear(y) }));
      expect(long).not.toBe(short);
    });
  });
});

// =================================================================================================
// Invariants 11, 12a - append-only survives partitioning, trigger ENABLE ALWAYS everywhere
// =================================================================================================
describe('S1a invariant 11 - UPDATE and DELETE are refused on the parent AND on a partition directly, as the owner', () => {
  it('control: the owner can INSERT through the parent and read the row back', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const id = await put(t, { orgId: f.orgA, actor: f.personA });
      const [r] = await t<{ c: number }[]>`select count(*)::int as c from audit_log where id = ${id}`;
      expect(r!.c).toBe(1);
    });
  });

  it('UPDATE and DELETE through the parent: restrict_violation (23001) "append-only"', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const id = await put(t, { orgId: f.orgA, actor: f.personA });
      const upd = await refused(t, (s) => s`update audit_log set action = 'tampered' where id = ${id}`);
      expect(upd?.code).toBe('23001');
      expect(upd?.message).toMatch(/append-only/);
      const del = await refused(t, (s) => s`delete from audit_log where id = ${id}`);
      expect(del?.code).toBe('23001');
      expect(del?.message).toMatch(/append-only/);
      const [r] = await t<{ action: string }[]>`select action from audit_log where id = ${id}`;
      expect(r!.action).toBe('set_channel_payout');
    });
  });

  it('UPDATE and DELETE ON THE PARTITION BY NAME: refused too (mutant: trigger only on the old table name / parent)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const id = await put(t, { orgId: f.orgA, actor: f.personA });
      const leaf = await leafOf(t, id);
      const upd = await refused(t, (s) => s.unsafe(`update ${leaf} set action = 'tampered' where id = '${id}'`));
      expect(upd?.code, `UPDATE on ${leaf}`).toBe('23001');
      const del = await refused(t, (s) => s.unsafe(`delete from ${leaf} where id = '${id}'`));
      expect(del?.code, `DELETE on ${leaf}`).toBe('23001');
    });
  });

  it('TRUNCATE is NOT blocked (the cutover purge relies on it, 0167) - parent and its side tables truncated together, then rolled back', async () => {
    await rolledBack(async (t) => {
      const err = await refused(t, (s) => s.unsafe('truncate audit_log, audit_log_event_keys'));
      expect(err?.message, 'truncate of audit_log + audit_log_event_keys').toBeUndefined();
    });
  });
});

describe('S1a invariant 12a - audit_log_append_only is tgenabled = A on the parent and EVERY partition', () => {
  it('parent, both class partitions, every year leaf (mutant: a new partition left at O)', async () => {
    const nodes = await tree(sql);
    expect(nodes.length, 'the partition tree must exist').toBeGreaterThanOrEqual(2 + 6);
    const rels = ['audit_log', ...nodes.map((n) => n.relname)];
    const rows = await sql<{ relname: string; tgenabled: string }[]>`
      select c.relname, g.tgenabled from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where g.tgname = 'audit_log_append_only' and c.relnamespace = 'public'::regnamespace and c.relname = any(${rels})`;
    const byRel = new Map(rows.map((r) => [r.relname, r.tgenabled]));
    for (const r of rels) expect({ rel: r, tgenabled: byRel.get(r) }, `${r} carries audit_log_append_only`).toEqual({ rel: r, tgenabled: 'A' });
  });
});

// =================================================================================================
// Invariant 12 - the app role cannot reach a partition by name; the parent still isolates orgs
// =================================================================================================
describe('S1a invariant 12 - every partition: REVOKE ALL from shareat_app, RLS ENABLE + FORCE, NO policy', () => {
  it('every non-root node of the tree (class partitions and year leaves)', async () => {
    const nodes = await tree(sql);
    expect(nodes.length, 'the partition tree must exist').toBeGreaterThanOrEqual(2 + 6);
    const bad: string[] = [];
    for (const n of nodes) {
      const privs = await appPrivs(sql, n.relname);
      const pols = await policyCount(sql, n.relname);
      if (privs.length) bad.push(`${n.relname}: app role holds ${privs.join(',')}`);
      if (!n.rls || !n.forced) bad.push(`${n.relname}: RLS enabled=${n.rls} forced=${n.forced}`);
      if (pols) bad.push(`${n.relname}: ${pols} polic(y/ies), want none (deny-all if reached directly)`);
    }
    expect(bad).toEqual([]);
  });

  it('the parent: app role holds exactly SELECT, INSERT (no UPDATE, DELETE, TRUNCATE...), RLS enabled and forced, exactly the two 0167 policies', async () => {
    expect(await appPrivs(sql, 'audit_log')).toEqual(['SELECT', 'INSERT']);
    const [p] = await sql<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced from pg_class where oid = 'public.audit_log'::regclass`;
    expect(p).toEqual({ rls: true, forced: true });
    const pols = await sql<{ polname: string; polcmd: string }[]>`
      select polname, polcmd from pg_policy where polrelid = 'public.audit_log'::regclass order by polname`;
    expect(pols.map((x) => [x.polname, x.polcmd])).toEqual([
      ['audit_log_org_append', 'a'],
      ['audit_log_org_read', 'r'],
    ]);
  });

  it('through the parent: org A reads only its own rows; org B reads none of A\'s; no principal reads none', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const a = await put(t, { orgId: f.orgA, actor: f.personA });
      const b = await put(t, { orgId: f.orgB, actor: f.personB });
      const idsA = await asApp(t, f.orgA, async () => (await t<{ id: string }[]>`select id from audit_log where id in (${a}, ${b})`).map((r) => r.id));
      expect(idsA).toEqual([a]);
      const idsB = await asApp(t, f.orgB, async () => (await t<{ id: string }[]>`select id from audit_log where id in (${a}, ${b})`).map((r) => r.id));
      expect(idsB).toEqual([b]);

    });
  });

  it('no principal reads ZERO rows through the parent, never everything', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      await put(t, { orgId: f.orgA, actor: f.personA });
      const none = await asApp(t, null, async () => (await t<{ c: number }[]>`select count(*)::int as c from audit_log`)[0]!.c);
      expect(none).toBe(0);
    });
  });

  it('through the parent the app role INSERTS its own org (routing needs no partition privilege); another org\'s org_id is 42501; another org\'s actor is 42501 (DEF-183)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const ok = await refused(t, (s) =>
        asApp(s, f.orgA, () => s`
          insert into audit_log (org_id, actor_person_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
          values (${f.orgA}, ${f.personA}, 'set_channel_payout', 'sales_channels', ${crypto.randomUUID()}, 'web', 'security', 'normal', 5, 'r10y', now(), now())`),
      );
      expect(ok?.message, 'control: own-org insert through the parent').toBeUndefined();
      const crossOrg = await refused(t, (s) =>
        asApp(s, f.orgA, () => s`
          insert into audit_log (org_id, actor_person_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
          values (${f.orgB}, ${f.personA}, 'set_channel_payout', 'sales_channels', ${crypto.randomUUID()}, 'web', 'security', 'normal', 5, 'r10y', now(), now())`),
      );
      expect(crossOrg?.code, 'org A naming org B').toBe('42501');
      const crossActor = await refused(t, (s) =>
        asApp(s, f.orgA, () => s`
          insert into audit_log (org_id, actor_person_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
          values (${f.orgA}, ${f.personB}, 'set_channel_payout', 'sales_channels', ${crypto.randomUUID()}, 'web', 'security', 'normal', 5, 'r10y', now(), now())`),
      );
      expect(crossActor?.code, 'org A row naming org B\'s person as actor').toBe('42501');
    });
  });

  it('the app role cannot UPDATE/DELETE the parent (42501) and cannot SELECT or INSERT a partition BY NAME (42501) - migration-created partitions', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const id = await put(t, { orgId: f.orgA, actor: f.personA });
      const leaf = await leafOf(t, id);
      const sel = await refused(t, (s) => asApp(s, f.orgA, () => s.unsafe(`select id from ${leaf}`)));
      expect(sel?.code, `SELECT ${leaf} as the app role`).toBe('42501');
      const ins = await refused(t, (s) =>
        asApp(s, f.orgA, () =>
          s.unsafe(
            `insert into ${leaf} (org_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
             values ('${f.orgA}', 'x', 'y', '${crypto.randomUUID()}', 'web', 'security', 'normal', 5, 'r10y', now(), now())`,
          ),
        ),
      );
      expect(ins?.code, `INSERT ${leaf} as the app role`).toBe('42501');
      const upd = await refused(t, (s) => asApp(s, f.orgA, () => s`update audit_log set action = 'tampered' where id = ${id}`));
      expect(upd?.code).toBe('42501');
      const del = await refused(t, (s) => asApp(s, f.orgA, () => s`delete from audit_log where id = ${id}`));
      expect(del?.code).toBe('42501');
    });
  });
});

describe('S1a invariants 12 + 12a - a partition created the way S5 will create it (R6 recipe, same transaction)', () => {
  it('with the recipe: no app privilege, RLS forced, no policy, trigger A, rows route through the parent, direct access is 42501, the row is append-only', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const cls = await classPartition(t, 'r2y');
      const probe = 'audit_log_t402_probe_2099';
      await createPartitionR6(t, cls, probe, '2099-01-01 00:00:00+08', '2100-01-01 00:00:00+08');

      expect(await appPrivs(t, probe), 'REVOKE ALL took (0169 default privileges would otherwise leave SELECT, INSERT)').toEqual([]);
      const [n] = await t<{ rls: boolean; forced: boolean; trig: string }[]>`
        select c.relrowsecurity as rls, c.relforcerowsecurity as forced,
               (select g.tgenabled from pg_trigger g where g.tgrelid = c.oid and g.tgname = 'audit_log_append_only') as trig
        from pg_class c where c.oid = ${`public.${probe}`}::regclass`;
      expect(n).toEqual({ rls: true, forced: true, trig: 'A' });
      expect(await policyCount(t, probe)).toBe(0);

      // Through the parent the app role still writes into it (partition routing needs no leaf privilege).
      const viaParent = await refused(t, (s) =>
        asApp(s, f.orgA, () => s`
          insert into audit_log (org_id, actor_person_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
          values (${f.orgA}, ${f.personA}, 'set_channel_payout', 'sales_channels', ${crypto.randomUUID()}, 'web', 'security', 'low', 6, 'r2y', '2099-06-15T12:00:00+08:00', '2099-06-15T12:00:00+08:00')`),
      );
      expect(viaParent?.message, 'insert through the parent into the new partition').toBeUndefined();
      const [landed] = await t<{ c: number }[]>`select count(*)::int as c from audit_log where tableoid = ${`public.${probe}`}::regclass`;
      expect(landed!.c).toBe(1);

      const sel = await refused(t, (s) => asApp(s, f.orgA, () => s.unsafe(`select 1 from ${probe}`)));
      expect(sel?.code).toBe('42501');
      const del = await refused(t, (s) => s.unsafe(`delete from ${probe}`));
      expect(del?.code, 'owner DELETE on the new partition').toBe('23001');
    });
  });

  it('control for the recipe: WITHOUT it the census (below) flags the partition - so the recipe, not luck, makes it pass', async () => {
    await rolledBack(async (t) => {
      const cls = await classPartition(t, 'r2y');
      await t.unsafe(`create table audit_log_t402_bare partition of "${cls}" for values from ('2098-01-01 00:00:00+08') to ('2099-01-01 00:00:00+08')`);
      const v = await partitionCensus(t);
      expect(v.filter((x) => x.startsWith('audit_log_t402_bare:')).length, `census violations: ${JSON.stringify(v)}`).toBeGreaterThanOrEqual(1);
    });
  });
});

// =================================================================================================
// Invariant 12b + R4 - CHECKs and NOT NULLs
// =================================================================================================
describe('S1a invariant 12b - the R7 retention CHECK (as the owner): no writer bug can file money into the 2-year class', () => {
  it('control: security/low into r2y is ACCEPTED; money/normal into r10y is accepted', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      expect((await refused(t, (s) => put(s, { orgId: f.orgA, category: 'security', sens: 'low', retention: 'r2y', recordedAt: midYear(y) })))?.message).toBeUndefined();
      expect((await refused(t, (s) => put(s, { orgId: f.orgA, category: 'money', sens: 'normal', retention: 'r10y', recordedAt: midYear(y) })))?.message).toBeUndefined();
      expect((await refused(t, (s) => put(s, { orgId: f.orgA, category: 'money', sens: 'low', retention: 'r10y', recordedAt: midYear(y) })))?.message, 'money/low in r10y').toBeUndefined();
    });
  });

  for (const category of MONEYISH) {
    it(`${category}/low into r2y is refused 23514`, async () => {
      await rolledBack(async (t) => {
        const f = await fixture(t);
        const y = await manilaYear(t);
        const err = await refused(t, (s) => put(s, { orgId: f.orgA, category, sens: 'low', retention: 'r2y', recordedAt: midYear(y) }));
        expect(err, `${category}/low must not be accepted into r2y`).toBeInstanceOf(Error);
        expect(err?.code).toBe('23514');
      });
    });
  }

  for (const sens of ['critical', 'high', 'normal'] as const) {
    it(`security/${sens} into r2y is refused 23514 (only sensitivity low may be short-lived)`, async () => {
      await rolledBack(async (t) => {
        const f = await fixture(t);
        const y = await manilaYear(t);
        const err = await refused(t, (s) => put(s, { orgId: f.orgA, category: 'security', sens, retention: 'r2y', recordedAt: midYear(y) }));
        expect(err, `security/${sens} must not be accepted into r2y`).toBeInstanceOf(Error);
        expect(err?.code).toBe('23514');
      });
    });
  }

  it('an unknown retention class has nowhere to go: refused', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const err = await refused(t, (s) => put(s, { orgId: f.orgA, retention: 'r5y' }));
      expect(err).toBeInstanceOf(Error);
      expect(err?.code).toBe('23514');
    });
  });
});

describe('S1a - category and sensitivity: NOT NULL and CHECK-constrained to the catalogue sets (R3, R4)', () => {
  it('control + all nine categories are accepted', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      for (const category of CATEGORIES) {
        const err = await refused(t, (s) => put(s, { orgId: f.orgA, category }));
        expect(err?.message, category).toBeUndefined();
      }
    });
  });

  it('an unknown category is refused 23514', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const err = await refused(t, (s) => put(s, { orgId: f.orgA, category: 'bogus' }));
      expect(err?.code).toBe('23514');
    });
  });

  it('an unknown sensitivity is refused 23514', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const err = await refused(t, (s) => put(s, { orgId: f.orgA, sens: 'urgent' as Sens, severity: 5 }));
      expect(err?.code).toBe('23514');
    });
  });

  it('(sensitivity, severity) is bound: critical 2, high 4, normal 5, low 6 accepted; every other pairing refused 23514', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      for (const sens of Object.keys(SEV) as Sens[]) {
        const ok = await refused(t, (s) => put(s, { orgId: f.orgA, sens, severity: SEV[sens], recordedAt: midYear(y) }));
        expect(ok?.message, `${sens}/${SEV[sens]} accepted`).toBeUndefined();
        for (const wrong of [0, 1, 2, 3, 4, 5, 6, 7].filter((n) => n !== SEV[sens])) {
          const err = await refused(t, (s) => put(s, { orgId: f.orgA, sens, severity: wrong, recordedAt: midYear(y) }));
          expect({ pair: `${sens}/${wrong}`, code: err?.code }).toEqual({ pair: `${sens}/${wrong}`, code: '23514' });
        }
      }
    });
  });

  it('category NULL and sensitivity NULL are refused 23502 (NOT NULL), not defaulted', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const noCategory = await refused(t, (s) => s`
        insert into audit_log (org_id, action, entity, entity_id, source, sensitivity, severity, retention_class, recorded_at, occurred_at)
        values (${f.orgA}, 'x', 'y', ${crypto.randomUUID()}, 'web', 'normal', 5, 'r10y', now(), now())`);
      expect(noCategory?.code, 'omitting category').toBe('23502');
      const noSens = await refused(t, (s) => s`
        insert into audit_log (org_id, action, entity, entity_id, source, category, severity, retention_class, recorded_at, occurred_at)
        values (${f.orgA}, 'x', 'y', ${crypto.randomUUID()}, 'web', 'security', 5, 'r10y', now(), now())`);
      expect(noSens?.code, 'omitting sensitivity').toBe('23502');
    });
  });

  it('defaults: recorded_at = now(), redacted_keys = {}, clock_suspect = false when not supplied', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const [r] = await t<{ id: string }[]>`
        insert into audit_log (org_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class)
        values (${f.orgA}, 'x', 'y', ${crypto.randomUUID()}, 'web', 'security', 'normal', 5, 'r10y') returning id`;
      const [row] = await t<{ keys: string[]; suspect: boolean; fresh: boolean }[]>`
        select redacted_keys as keys, clock_suspect as suspect, (recorded_at > now() - interval '1 minute' and recorded_at <= now()) as fresh
        from audit_log where id = ${r!.id}`;
      expect(row).toEqual({ keys: [], suspect: false, fresh: true });
    });
  });
});

describe('S1a - same-org composite FKs on store_id and uploaded_by_person_id (0194 pattern) alongside the actor FK', () => {
  it('control: a same-org store, a same-org uploader and a null store are accepted', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      expect((await refused(t, (s) => put(s, { orgId: f.orgA, storeId: f.storeA, uploadedBy: f.personA, actor: f.personA })))?.message).toBeUndefined();
      expect((await refused(t, (s) => put(s, { orgId: f.orgA, storeId: null })))?.message).toBeUndefined();
    });
  });

  it('org A\'s row naming org B\'s store is refused 23503 (the owner connection, where RLS does not help)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const err = await refused(t, (s) => put(s, { orgId: f.orgA, storeId: f.storeB }));
      expect(err?.code).toBe('23503');
    });
  });

  it('org A\'s row naming org B\'s person as uploader is refused 23503; as actor, 23503 too', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      expect((await refused(t, (s) => put(s, { orgId: f.orgA, uploadedBy: f.personB })))?.code).toBe('23503');
      expect((await refused(t, (s) => put(s, { orgId: f.orgA, actor: f.personB })))?.code).toBe('23503');
    });
  });
});

// =================================================================================================
// Contract step 5 - the two side tables
// =================================================================================================
describe('S1a - audit_log_event_keys (R10) and authz_denial_counts (R9)', () => {
  it('both are ordinary tables with RLS enabled and forced; event_keys PK is (org_id, event_key)', async () => {
    const rows = await sql<{ relname: string; relkind: string; rls: boolean; forced: boolean }[]>`
      select relname, relkind, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relnamespace = 'public'::regnamespace and relname in ('audit_log_event_keys', 'authz_denial_counts') order by relname`;
    expect(rows.map((r) => r.relname), 'both tables must exist').toEqual(['audit_log_event_keys', 'authz_denial_counts']);
    for (const r of rows) expect({ t: r.relname, kind: r.relkind, rls: r.rls, forced: r.forced }).toEqual({ t: r.relname, kind: 'r', rls: true, forced: true });
    const pk = await sql<{ col: string }[]>`
      select a.attname as col from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
      where k.conrelid = 'public.audit_log_event_keys'::regclass and k.contype = 'p'`;
    expect(pk.map((r) => r.col).sort()).toEqual(['event_key', 'org_id']);
  });

  it('the columns the spec names exist', async () => {
    const cols = async (t: string) =>
      (await sql<{ c: string }[]>`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = ${t}`).map((r) => r.c);
    expect(await cols('audit_log_event_keys')).toEqual(
      expect.arrayContaining(['org_id', 'event_key', 'payload_sha256', 'audit_log_id', 'retention_class', 'recorded_at']),
    );
    expect(await cols('authz_denial_counts')).toEqual(
      expect.arrayContaining(['org_id', 'actor_person_id', 'capability', 'store_id', 'hour_bucket', 'count']),
    );
  });

  it('privileges: event_keys = SELECT, INSERT, DELETE (no UPDATE); denial_counts = SELECT, INSERT, UPDATE, DELETE', async () => {
    expect(await appPrivs(sql, 'audit_log_event_keys')).toEqual(['SELECT', 'INSERT', 'DELETE']);
    expect(await appPrivs(sql, 'authz_denial_counts')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  });

  it('an org-isolation policy exists for EVERY granted command on both tables', async () => {
    const want: Record<string, string[]> = {
      audit_log_event_keys: ['a', 'd', 'r'],
      authz_denial_counts: ['a', 'd', 'r', 'w'],
    };
    for (const [table, cmds] of Object.entries(want)) {
      const rows = await sql<{ polcmd: string }[]>`
        select p.polcmd from pg_policy p join pg_class c on c.oid = p.polrelid where c.relname = ${table} and c.relnamespace = 'public'::regnamespace`;
      const have = new Set(rows.map((r) => r.polcmd));
      // '*' (FOR ALL) covers every command at once.
      const covered = have.has('*') ? new Set(['a', 'd', 'r', 'w']) : have;
      expect(cmds.filter((c) => !covered.has(c)), `${table}: commands with no policy`).toEqual([]);
    }
  });

  it('audit_log_event_keys: org A inserts/reads/deletes its own key; org B sees none of it and cannot delete it; cross-org insert 42501', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const y = await manilaYear(t);
      const recordedAt = midYear(y);
      const logId = await put(t, { orgId: f.orgA, actor: f.personA, recordedAt });
      const ins = await refused(t, (s) =>
        asApp(s, f.orgA, () => s`
          insert into audit_log_event_keys (org_id, event_key, payload_sha256, audit_log_id, retention_class, recorded_at)
          values (${f.orgA}, ${crypto.randomUUID()}, ${'a'.repeat(64)}, ${logId}, 'r10y', ${recordedAt}::timestamptz)`),
      );
      expect(ins?.message, 'control: own-org key insert as the app role').toBeUndefined();
      const [own] = await asApp(t, f.orgA, async () => t<{ c: number }[]>`select count(*)::int as c from audit_log_event_keys`);
      expect(own!.c).toBe(1);
      const [other] = await asApp(t, f.orgB, async () => t<{ c: number }[]>`select count(*)::int as c from audit_log_event_keys`);
      expect(other!.c, 'org B sees none of org A\'s keys').toBe(0);
      const delB = await asApp(t, f.orgB, async () => t`delete from audit_log_event_keys`);
      expect(delB.count, 'org B deletes nothing').toBe(0);
      const cross = await refused(t, (s) =>
        asApp(s, f.orgB, () => s`
          insert into audit_log_event_keys (org_id, event_key, payload_sha256, audit_log_id, retention_class, recorded_at)
          values (${f.orgA}, ${crypto.randomUUID()}, ${'b'.repeat(64)}, ${logId}, 'r10y', ${recordedAt}::timestamptz)`),
      );
      expect(cross?.code).toBe('42501');
      const delA = await asApp(t, f.orgA, async () => t`delete from audit_log_event_keys`);
      expect(delA.count, 'org A deletes its own key').toBe(1);
    });
  });

  it('audit_log_event_keys: UPDATE by the app role is 42501 (a key is never rewritten)', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const err = await refused(t, (s) => asApp(s, f.orgA, () => s`update audit_log_event_keys set payload_sha256 = ${'c'.repeat(64)}`));
      expect(err?.code).toBe('42501');
    });
  });

  it('authz_denial_counts: org isolation for read/insert/update/delete', async () => {
    await rolledBack(async (t) => {
      const f = await fixture(t);
      const bucket = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
      const ins = await refused(t, (s) =>
        asApp(s, f.orgA, () => s`
          insert into authz_denial_counts (org_id, actor_person_id, capability, store_id, hour_bucket, count)
          values (${f.orgA}, ${f.personA}, 'post_journal_entry', ${f.storeA}, ${bucket}::timestamptz, 1)`),
      );
      expect(ins?.message, 'control: own-org counter insert').toBeUndefined();
      const [b] = await asApp(t, f.orgB, async () => t<{ c: number }[]>`select count(*)::int as c from authz_denial_counts`);
      expect(b!.c, 'org B sees no counters of org A').toBe(0);
      const updB = await asApp(t, f.orgB, async () => t`update authz_denial_counts set count = 99`);
      expect(updB.count).toBe(0);
      const delB = await asApp(t, f.orgB, async () => t`delete from authz_denial_counts`);
      expect(delB.count).toBe(0);
      const updA = await asApp(t, f.orgA, async () => t`update authz_denial_counts set count = count + 1`);
      expect(updA.count).toBe(1);
      const cross = await refused(t, (s) =>
        asApp(s, f.orgA, () => s`
          insert into authz_denial_counts (org_id, actor_person_id, capability, store_id, hour_bucket, count)
          values (${f.orgB}, ${f.personB}, 'post_journal_entry', ${f.storeB}, ${bucket}::timestamptz, 1)`),
      );
      expect(cross?.code).toBe('42501');
    });
  });
});

// =================================================================================================
// Invariant 12c - the three census guards learn partitions
// =================================================================================================
/**
 * The census R6 specifies, as a query: every PARTITION (a relispartition relation of kind r or p) must have RLS
 * forced, no policy and no app-role privilege. Returns `<relname>: <reason>` lines. A scan on `relkind = 'r'`
 * alone cannot see the partitioned PARENT (kind p) and therefore cannot tell a leaf from a table.
 */
async function partitionCensus(q: Tx | typeof sql): Promise<string[]> {
  const rows = await q<{ relname: string; rls: boolean; forced: boolean }[]>`
    select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relispartition`;
  const out: string[] = [];
  for (const r of rows) {
    if (!r.rls || !r.forced) out.push(`${r.relname}: RLS not enabled+forced`);
    if (await policyCount(q, r.relname)) out.push(`${r.relname}: has a policy`);
    const privs = await appPrivs(q, r.relname);
    if (privs.length) out.push(`${r.relname}: app role holds ${privs.join(',')}`);
  }
  return out;
}

describe('S1a invariant 12c - the censuses count partitions (and fail when a partition is unsafe)', () => {
  it('the partition census is clean on the migrated database - and is not vacuous (>= 8 partitions seen)', async () => {
    const [n] = await sql<{ c: number }[]>`
      select count(*)::int as c from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and relispartition`;
    expect(n!.c, 'audit_log must have its partitions').toBeGreaterThanOrEqual(8);
    expect(await partitionCensus(sql)).toEqual([]);
  });

  it('the partitioned PARENT is relkind p - a relkind = r scan would skip it entirely (mutant: census scanning r only)', async () => {
    const kinds = await sql<{ relname: string; relkind: string; rls: boolean; forced: boolean }[]>`
      select relname, relkind, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and relname = 'audit_log'`;
    expect(kinds).toEqual([{ relname: 'audit_log', relkind: 'p', rls: true, forced: true }]);
  });

  it('a partition with an app grant is flagged', async () => {
    await rolledBack(async (t) => {
      const cls = await classPartition(t, 'r2y');
      await createPartitionR6(t, cls, 'audit_log_t402_granted', '2097-01-01 00:00:00+08', '2098-01-01 00:00:00+08');
      expect(await partitionCensus(t)).toEqual([]);
      await t.unsafe(`grant select on audit_log_t402_granted to ${APP_ROLE}`);
      expect(await partitionCensus(t)).toEqual([`audit_log_t402_granted: app role holds SELECT`]);
    });
  });

  it('a partition without forced RLS is flagged', async () => {
    await rolledBack(async (t) => {
      const cls = await classPartition(t, 'r2y');
      await createPartitionR6(t, cls, 'audit_log_t402_unforced', '2097-01-01 00:00:00+08', '2098-01-01 00:00:00+08');
      await t.unsafe('alter table audit_log_t402_unforced no force row level security');
      expect(await partitionCensus(t)).toEqual([`audit_log_t402_unforced: RLS not enabled+forced`]);
    });
  });

  it('the guards are taught: rls.test.ts scans relkind r AND p and maps a leaf to its parent', () => {
    const src = readFileSync(join(TESTS_DIR, 'rls.test.ts'), 'utf8');
    expect(src, "rls.test.ts invariant 9 must scan relkind in ('r', 'p')").toMatch(/relkind\s+in\s*\(\s*'r'\s*,\s*'p'\s*\)/);
    expect(src, 'rls.test.ts must read relispartition / pg_inherits to treat a leaf as its parent').toMatch(/relispartition|pg_inherits/);
  });

  it('the guards are taught: t398-s1-same-org-fk-census.test.ts no-FK and jsonb censuses count a leaf as its parent', () => {
    const src = readFileSync(join(TESTS_DIR, 't398-s1-same-org-fk-census.test.ts'), 'utf8');
    expect(src, 'must scan relkind p as well as r (or exclude leaves via relispartition and keep the parent)').toMatch(/relispartition|pg_inherits|relkind\s+in\s*\(\s*'r'\s*,\s*'p'\s*\)/);
  });

  it('the guards are taught: the jsonb census still finds audit_log.before/after exactly once each (the parent), not once per leaf', async () => {
    const rows = await sql<{ t: string; col: string }[]>`
      select c.relname as t, a.attname as col
      from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
        and a.atttypid = 'jsonb'::regtype and c.relname = 'audit_log' order by 2`;
    expect(rows.map((r) => `${r.t}.${r.col}`)).toEqual(['audit_log.after', 'audit_log.before']);
  });
});

describe('S1a registries - classification, RLS registry, drizzle schema', () => {
  const schemaTables = new Set<string>();
  for (const v of Object.values(schema)) if (is(v, PgTable)) schemaTables.add(getTableName(v));

  for (const t of ['audit_log', 'audit_log_event_keys', 'authz_denial_counts']) {
    it(`${t}: in the drizzle schema, classified purge (R15 dumps first), and in the RLS registry`, () => {
      expect(schemaTables.has(t), `${t} exported from packages/db/schema`).toBe(true);
      expect(CUTOVER_CLASSIFICATION[t], `${t} classification`).toBeDefined();
      expect(CUTOVER_CLASSIFICATION[t]!.class).toBe('purge');
      expect(RLS_REGISTRY[t], `${t} in rls/registry.ts`).toBeDefined();
      expect(RLS_REGISTRY[t]!.scope).toBe('org_column');
    });
  }

  it('no partition is registered or classified by name: a partition is its parent (R6)', () => {
    const leafish = (k: string) => /^audit_log_(r10y|r2y)/.test(k);
    expect(Object.keys(CUTOVER_CLASSIFICATION).filter(leafish)).toEqual([]);
    expect(Object.keys(RLS_REGISTRY).filter(leafish)).toEqual([]);
  });
});
