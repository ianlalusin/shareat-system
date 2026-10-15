/**
 * T-402 S1a audit findings. `docs/tasks/402-activity-log.md` R6, R7, R10, Contract 3 step 5, Invariants 12, 28, 30.
 *  A. the event-key FK is same-org (a key of org A cannot pin a log row of org B);
 *  B. an r2y year partition with keys pointing at it: dropping or detaching it is REFUSED while keys exist, and works
 *     once S5's first step (delete the keys) has run;
 *  C. the real cutover purge (planPurge + applyPurge, as t347 runs it) succeeds on a database that holds audit rows and
 *     event keys, and leaves both empty.
 * TESTER, not BUILDER. A and B run in rolled-back transactions on the lane DB; C migrates a scratch database.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(`Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(baseUrl, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
type Err = Error & { code?: string };
class Rollback extends Error {}
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const HASH = 'a'.repeat(64);

async function rolledBack(fn: (t: Tx) => Promise<void>) {
  try {
    await sql.begin(async (t) => {
      await fn(t);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
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
async function org(t: Tx, hint: string) {
  const code = uid(`t402aud-${hint}`);
  const [o] = await t<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [p] = await t<{ id: string }[]>`insert into persons (org_id, display_name) values (${o!.id}, 'Actor') returning id`;
  return { orgId: o!.id, personId: p!.id };
}
async function logRow(t: Tx, orgId: string, o: { retention?: string; category?: string; sens?: 'low' | 'normal'; recordedAt: string }) {
  const sens = o.sens ?? 'normal';
  const [r] = await t<{ id: string }[]>`
    insert into audit_log (org_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
    values (${orgId}, 'set_channel_payout', 'sales_channels', ${crypto.randomUUID()}, 'web', ${o.category ?? 'settings'}, ${sens}, ${sens === 'low' ? 6 : 5},
            ${o.retention ?? 'r10y'}, ${o.recordedAt}::timestamptz, ${o.recordedAt}::timestamptz)
    returning id`;
  return r!.id;
}
const keyFor = (t: Tx, keyOrg: string, logId: string, retention: string, recordedAt: string) => t`
  insert into audit_log_event_keys (org_id, event_key, payload_sha256, audit_log_id, retention_class, recorded_at)
  values (${keyOrg}, ${crypto.randomUUID()}, ${HASH}, ${logId}, ${retention}, ${recordedAt}::timestamptz)`;

describe('A - the event-key FK is same-org (R10: a key lives with ITS org\'s log row)', () => {
  it('control: org B\'s key on org B\'s own row is accepted', async () => {
    await rolledBack(async (t) => {
      const b = await org(t, 'b');
      const at = '2026-06-15T12:00:00+08:00';
      const id = await logRow(t, b.orgId, { recordedAt: at });
      const err = await refused(t, (s) => keyFor(s, b.orgId, id, 'r10y', at));
      expect(err?.message).toBeUndefined();
    });
  });

  it('a key in org A naming org B\'s log row is refused 23503 (mutant: FK on (id, retention_class, recorded_at) only - no org_id)', async () => {
    await rolledBack(async (t) => {
      const a = await org(t, 'a');
      const b = await org(t, 'b');
      const at = '2026-06-15T12:00:00+08:00';
      const bRow = await logRow(t, b.orgId, { recordedAt: at });
      const err = await refused(t, (s) => keyFor(s, a.orgId, bRow, 'r10y', at));
      expect(err, 'org A\'s key must not be able to pin org B\'s audit row').toBeInstanceOf(Error);
      expect(err?.code).toBe('23503');
    });
  });
});

describe('B - an r2y year partition that keys point at (S5 invariants 28/30: keys first, then the drop)', () => {
  const AT = '2090-06-15T12:00:00+08:00';
  async function probe(t: Tx) {
    const [cls] = await t<{ relname: string }[]>`
      select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'public.audit_log'::regclass and pg_get_expr(c.relpartbound, c.oid) = 'FOR VALUES IN (''r2y'')'`;
    expect(cls, 'the r2y class partition exists').toBeDefined();
    const name = 'audit_log_t402_aud_2090';
    await t.unsafe(`create table ${name} partition of ${cls!.relname} for values from ('2090-01-01 00:00:00+08') to ('2091-01-01 00:00:00+08')`);
    await t.unsafe(`revoke all on ${name} from ${APP_ROLE}`);
    await t.unsafe(`alter table ${name} enable row level security`);
    await t.unsafe(`alter table ${name} force row level security`);
    await t.unsafe(`alter table ${name} enable always trigger audit_log_append_only`);
    const o = await org(t, 'p');
    const id = await logRow(t, o.orgId, { retention: 'r2y', category: 'security', sens: 'low', recordedAt: AT });
    await keyFor(t, o.orgId, id, 'r2y', AT);
    return { name, cls: cls!.relname, orgId: o.orgId };
  }
  const keyCount = async (t: Tx, orgId: string) => (await t<{ c: number }[]>`select count(*)::int as c from audit_log_event_keys where org_id = ${orgId}`)[0]!.c;

  it('DROP of the partition while its keys exist is refused - and the rows and keys are still there', async () => {
    await rolledBack(async (t) => {
      const p = await probe(t);
      const err = await refused(t, (s) => s.unsafe(`drop table ${p.name}`));
      expect(err, 'a drop that silently orphans keys must not succeed').toBeInstanceOf(Error);
      const [rows] = await t.unsafe<{ c: number }[]>(`select count(*)::int as c from ${p.name}`);
      expect(rows!.c).toBe(1);
      expect(await keyCount(t, p.orgId)).toBe(1);
    });
  });

  it('DETACH of the partition while its keys exist is refused', async () => {
    await rolledBack(async (t) => {
      const p = await probe(t);
      const err = await refused(t, (s) => s.unsafe(`alter table ${p.cls} detach partition ${p.name}`));
      expect(err, 'a detach that leaves keys pointing at rows no longer in audit_log must not succeed').toBeInstanceOf(Error);
    });
  });

  const dropFn = (t: Tx, cls: string, year: number) => t`select audit_log_drop_year_partition(${cls}, ${year}::int)`;
  const exists = async (t: Tx, name: string) => (await t<{ c: number }[]>`select count(*)::int as c from pg_class where relname = ${name}`)[0]!.c;

  it('(a) audit_log_drop_year_partition(r2y, year) drops an r2y partition that no key points at', async () => {
    await rolledBack(async (t) => {
      const p = await probe(t);
      await t`delete from audit_log_event_keys where org_id = ${p.orgId}`;
      const err = await refused(t, (s) => dropFn(s, 'r2y', 2090));
      expect(err?.message, 'the function must drop an unreferenced r2y partition').toBeUndefined();
      expect(await exists(t, p.name)).toBe(0);
    });
  });

  it('(b) keys present, then deleted (S5 step 1): the function drops it - delete keys, DETACH, DROP', async () => {
    await rolledBack(async (t) => {
      const p = await probe(t);
      await t`delete from audit_log_event_keys where org_id = ${p.orgId} and retention_class = 'r2y'`;
      const err = await refused(t, (s) => dropFn(s, 'r2y', 2090));
      expect(err?.message).toBeUndefined();
      expect(await exists(t, p.name)).toBe(0);
    });
  });

  it('(c) with keys still present the function REFUSES, and the partition, its rows and its keys are untouched', async () => {
    await rolledBack(async (t) => {
      const p = await probe(t);
      const err = await refused(t, (s) => dropFn(s, 'r2y', 2090));
      expect(err, 'a drop that orphans keys must be refused').toBeInstanceOf(Error);
      expect(await exists(t, p.name)).toBe(1);
      const [rows] = await t.unsafe<{ c: number }[]>(`select count(*)::int as c from ${p.name}`);
      expect(rows!.c).toBe(1);
      expect(await keyCount(t, p.orgId)).toBe(1);
    });
  });

  it('(d) it refuses any r10y partition (the 10-year class is never dropped) - an existing one, and a 2090 one', async () => {
    await rolledBack(async (t) => {
      const [y] = await t<{ y: number }[]>`select extract(year from now() at time zone 'Asia/Manila')::int as y`;
      const [before] = await t<{ c: number }[]>`select count(*)::int as c from audit_log where retention_class = 'r10y'`;
      const err = await refused(t, (s) => dropFn(s, 'r10y', y!.y));
      expect(err, 'r10y current year must be refused').toBeInstanceOf(Error);
      const [cls] = await t<{ relname: string }[]>`
        select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'public.audit_log'::regclass and pg_get_expr(c.relpartbound, c.oid) = 'FOR VALUES IN (''r10y'')'`;
      await t.unsafe(`create table audit_log_t402_aud10_2090 partition of ${cls!.relname} for values from ('2090-01-01 00:00:00+08') to ('2091-01-01 00:00:00+08')`);
      const err2 = await refused(t, (s) => dropFn(s, 'r10y', 2090));
      expect(err2, 'an EMPTY r10y partition must be refused too').toBeInstanceOf(Error);
      expect(await exists(t, 'audit_log_t402_aud10_2090')).toBe(1);
      const [after] = await t<{ c: number }[]>`select count(*)::int as c from audit_log where retention_class = 'r10y'`;
      expect(after!.c).toBe(before!.c);
    });
  });

  it('(e) the app role cannot EXECUTE it (no grant to shareat_app or PUBLIC), and calling it as the app role is 42501', async () => {
    const fns = await sql<{ oid: number }[]>`select p.oid::int as oid from pg_proc p where p.proname = 'audit_log_drop_year_partition' and p.pronamespace = 'public'::regnamespace`;
    expect(fns.length, 'audit_log_drop_year_partition exists').toBe(1);
    const [g] = await sql<{ ok: boolean }[]>`select has_function_privilege(${APP_ROLE}, ${fns[0]!.oid}::oid, 'EXECUTE') as ok`;
    expect(g!.ok).toBe(false);
    await rolledBack(async (t) => {
      const o = await org(t, 'e');
      await t.unsafe(`set local role ${APP_ROLE}`);
      await t`select set_config('app.org_id', ${o.orgId}, true)`;
      const err = await refused(t, (s) => dropFn(s, 'r2y', 2090));
      expect(err?.code).toBe('42501');
    });
  });

  it('the app role may DELETE its own org\'s keys (the roll-up path) but not another org\'s', async () => {
    await rolledBack(async (t) => {
      const p = await probe(t);
      const other = await org(t, 'o');
      await t.unsafe(`set local role ${APP_ROLE}`);
      await t`select set_config('app.org_id', ${other.orgId}, true)`;
      const none = await t`delete from audit_log_event_keys where org_id = ${p.orgId}`;
      expect(none.count).toBe(0);
      await t`select set_config('app.org_id', ${p.orgId}, true)`;
      const own = await t`delete from audit_log_event_keys where org_id = ${p.orgId}`;
      expect(own.count).toBe(1);
      await t.unsafe('reset role');
    });
  });
});

describe('C - the real cutover purge on a database holding audit rows and event keys', () => {
  const REAL = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
  const dbName = `shareat_scratch_t402_purge_${Date.now()}`;
  const urlOf = (n: string) => {
    const u = new URL(baseUrl!);
    u.pathname = `/${n}`;
    return u.toString();
  };
  const admin = async (fn: (a: ReturnType<typeof postgres>) => Promise<unknown>) => {
    const a = postgres(urlOf('postgres'), { max: 1 });
    try {
      await fn(a);
    } finally {
      await a.end();
    }
  };
  let s: ReturnType<typeof postgres>;
  let orgId: string;
  let personId: string;
  let applyError: unknown;

  beforeAll(async () => {
    await admin((a) => a.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin((a) => a.unsafe(`CREATE DATABASE "${dbName}"`));
    s = postgres(urlOf(dbName), { max: 1 });
    await migrate(drizzle(s), { migrationsFolder: REAL });
    const code = uid('t402purge');
    const [o] = await s<{ id: string }[]>`insert into organizations (name, code) values ('Purge Org', ${code}) returning id`;
    orgId = o!.id;
    const [p] = await s<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    personId = p!.id;
    const at = new Date().toISOString();
    for (const retention of ['r10y', 'r2y'] as const) {
      const [r] = await s<{ id: string }[]>`
        insert into audit_log (org_id, actor_person_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
        values (${orgId}, ${personId}, 'set_channel_payout', 'sales_channels', ${crypto.randomUUID()}, 'web', ${retention === 'r10y' ? 'money' : 'security'},
                ${retention === 'r10y' ? 'high' : 'low'}, ${retention === 'r10y' ? 4 : 6}, ${retention}, ${at}::timestamptz, ${at}::timestamptz) returning id`;
      await s`
        insert into audit_log_event_keys (org_id, event_key, payload_sha256, audit_log_id, retention_class, recorded_at)
        values (${orgId}, ${crypto.randomUUID()}, ${HASH}, ${r!.id}, ${retention}, ${at}::timestamptz)`;
    }
    try {
      const mod = (await import('../../src/cutover/purge')) as {
        planPurge: (sql: unknown, asOf: string) => Promise<unknown>;
        applyPurge: (tx: unknown, plan: unknown, opts?: { performedBy?: Record<string, string>; auditDump?: unknown }) => Promise<unknown>;
      };
      const { auditDumpFor } = await import('../../../../tests/integration/t402-s3-audit-dump');
      const auditDump = await auditDumpFor(urlOf(dbName), '2026-12-31'); // T-402 S3 R15
      await s.begin(async (tx) => {
        const plan = await mod.planPurge(tx, '2026-12-31');
        await mod.applyPurge(tx, plan, { performedBy: { [orgId]: personId }, auditDump });
      });
    } catch (e) {
      applyError = e;
    }
  }, 600_000);

  afterAll(async () => {
    await s?.end();
    await admin((a) => a.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`));
  }, 120_000);

  it('the purge completes (audit_log_event_keys -> audit_log FK does not stop a TRUNCATE of both)', () => {
    expect(applyError, applyError instanceof Error ? applyError.message : String(applyError)).toBeUndefined();
  });

  it('every event key is gone, and so is every audit row the fixture wrote', async () => {
    const [k] = await s<{ c: number }[]>`select count(*)::int as c from audit_log_event_keys`;
    expect(k!.c).toBe(0);
    const [a] = await s<{ c: number }[]>`select count(*)::int as c from audit_log where action = 'set_channel_payout'`;
    expect(a!.c).toBe(0);
  });

  it('audit_log is still partitioned with its partitions after the purge (TRUNCATE, never DROP)', async () => {
    const [r] = await s<{ relkind: string; leaves: number }[]>`
      select c.relkind, (select count(*)::int from pg_inherits where inhparent in (select inhrelid from pg_inherits where inhparent = c.oid)) as leaves
      from pg_class c where c.oid = 'public.audit_log'::regclass`;
    expect(r!.relkind).toBe('p');
    expect(r!.leaves).toBeGreaterThanOrEqual(6);
  });
});
