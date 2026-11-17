/**
 * T-592 - migration 0261: a store code belongs only on a settle-later channel; a store has one ACTIVE channel per platform.
 * docs/tasks/592-sales-channels-store-code.md "Migration 0261". Real Postgres via TEST_DATABASE_URL.
 *
 *  M1  file `0261_*.sql` naming t592, journal idx 261, `when` = 0260's 1808537507084 + 86,400,000, breakpoints true.
 *  M2  CHECK sales_channels_platform_only_settle_later_check is validated and refuses a coded daily channel (insert and update, 23514); an uncoded daily
 *      channel and a coded settle-later channel are accepted.
 *  M3  UNIQUE INDEX sales_channels_store_platform_active_key refuses a second ACTIVE channel on one platform at one store (23505); a retired one, another store
 *      and another platform are fine; reactivating into a clash is refused.
 *  M4  the pre-check DO block raises (naming the count and the store code, changing nothing) when a bad row exists, and the whole file replays cleanly on a good table.
 *
 * Every probe runs in a transaction that is ALWAYS rolled back (the pre-check tests drop the CHECK and the index inside it, which rolls back too).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const CHECK_NAME = 'sales_channels_platform_only_settle_later_check';
const INDEX_NAME = 'sales_channels_store_platform_active_key';
type PgErr = Error & { code?: string; constraint_name?: string };
type Tx = postgres.TransactionSql;
class Rollback extends Error {}
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

async function run<T>(fn: (tx: Tx) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: PgErr }> {
  let value: T | undefined;
  try {
    await sql.begin(async (tx) => {
      value = await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (e instanceof Rollback) return { ok: true, value: value as T };
    return { ok: false, err: e as PgErr };
  }
  return { ok: true, value: value as T };
}
async function refused(fn: (tx: Tx) => Promise<unknown>, code: string, what: string): Promise<PgErr> {
  const o = await run(fn);
  if (o.ok) throw new Error(`${what}: expected SQLSTATE ${code} but the statement succeeded`);
  expect(o.err.code, `${what}: ${o.err.message}`).toBe(code);
  return o.err;
}
async function accepted(fn: (tx: Tx) => Promise<unknown>, what: string): Promise<void> {
  const o = await run(fn);
  if (!o.ok) throw new Error(`${what}: expected success but got ${o.err.code}: ${o.err.message}`);
}

const file = readdirSync(MIGRATIONS).find((f) => /^0261_.*t592.*\.sql$/.test(f));
const statements = (): string[] => readFileSync(join(MIGRATIONS, file!), 'utf8').split('--> statement-breakpoint');
const preCheck = (): string => statements().find((s) => /DO \$\$/.test(s))!;

async function world() {
  const code = uid('t592m');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const store = async (c: string) => {
    const [s] = await sql<{ id: string; code: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(c)}, ${c}) returning id, code`;
    return s!;
  };
  return { orgId, a: await store('A'), b: await store('B') };
}
type World = Awaited<ReturnType<typeof world>>;
const ch = (tx: Tx, w: World, storeId: string, o: { daily?: boolean; platform?: 'grab' | 'foodpanda' | null; code?: string | null; active?: boolean }) =>
  tx<{ id: string; name: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code, is_active)
    values (${w.orgId}, ${storeId}, ${uid('Ch')}, ${o.daily ?? false}, ${o.daily ? null : '1220'}, ${o.platform ?? null}, ${o.code ?? null}, ${o.active ?? true})
    returning id, name`;

describe('T-592 migration 0261 - files and journal', () => {
  it('M1: the migration file exists and the journal entry follows 0260 by one day', () => {
    expect(file, 'a file 0261_*t592*.sql').toBeDefined();
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
    };
    const e = journal.entries.find((x) => x.idx === 261)!;
    expect(e.tag).toBe(file!.replace(/\.sql$/, ''));
    expect(e.when).toBe(1808537507084 + 86_400_000);
    expect(e.breakpoints).toBe(true);
    expect(statements()[0]).toMatch(/SET LOCAL lock_timeout = '5s'/);
  });
});

describe('T-592 migration 0261 - the CHECK', () => {
  it('M2: the CHECK exists and is validated', async () => {
    const [r] = await sql<{ convalidated: boolean; def: string }[]>`
      select convalidated, pg_get_constraintdef(oid) as def from pg_constraint where conname = ${CHECK_NAME} and conrelid = 'sales_channels'::regclass`;
    expect(r, `constraint ${CHECK_NAME}`).toBeDefined();
    expect(r!.convalidated).toBe(true);
  });

  it('M2: a coded daily channel is refused on insert and on update (23514); the neighbours are accepted', async () => {
    const w = await world();
    const e1 = await refused((tx) => ch(tx, w, w.a.id, { daily: true, platform: 'foodpanda', code: 'ab12cd' }), '23514', 'insert coded daily');
    expect(e1.constraint_name).toBe(CHECK_NAME);
    const e2 = await refused(
      async (tx) => {
        const [c] = await ch(tx, w, w.a.id, { daily: true });
        await tx`update sales_channels set platform = 'foodpanda', platform_store_code = 'ab12cd' where id = ${c!.id}`;
      },
      '23514',
      'update daily to coded',
    );
    expect(e2.constraint_name).toBe(CHECK_NAME);
    const e3 = await refused(
      async (tx) => {
        const [c] = await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'ab12cd' });
        await tx`update sales_channels set is_remitted_daily = true, receivable_account_code = null where id = ${c!.id}`;
      },
      '23514',
      'update coded to daily',
    );
    expect(e3.constraint_name).toBe(CHECK_NAME);
    await accepted((tx) => ch(tx, w, w.a.id, { daily: true }), 'uncoded daily');
    await accepted((tx) => ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'ab12cd' }), 'coded settle-later');
  });
});

describe('T-592 migration 0261 - the unique index', () => {
  it('M3: the index exists, is unique and partial on active + platform', async () => {
    const [r] = await sql<{ indisunique: boolean; def: string }[]>`
      select i.indisunique, pg_get_indexdef(i.indexrelid) as def from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = ${INDEX_NAME}`;
    expect(r, `index ${INDEX_NAME}`).toBeDefined();
    expect(r!.indisunique).toBe(true);
    expect(r!.def).toMatch(/\(org_id, store_id, platform\)/);
    expect(r!.def).toMatch(/platform IS NOT NULL/);
    expect(r!.def).toMatch(/is_active/);
  });

  it('M3: a second ACTIVE channel on one platform at one store is refused (23505); retired, other store and other platform are fine', async () => {
    const w = await world();
    const e = await refused(
      async (tx) => {
        await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'ab12cd' });
        await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'zz99yy' });
      },
      '23505',
      'two active on one platform',
    );
    expect(e.constraint_name).toBe(INDEX_NAME);
    await accepted(async (tx) => {
      await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'ab12cd' });
      await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'zz99yy', active: false });
      await ch(tx, w, w.b.id, { platform: 'foodpanda', code: 'qq11ww' });
      await ch(tx, w, w.a.id, { platform: 'grab', code: '11111111-1111-4111-8111-111111111111' });
    }, 'retired, other store, other platform');
    const e2 = await refused(
      async (tx) => {
        await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'ab12cd' });
        const [r] = await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'zz99yy', active: false });
        await tx`update sales_channels set is_active = true where id = ${r!.id}`;
      },
      '23505',
      'reactivate into a clash',
    );
    expect(e2.constraint_name).toBe(INDEX_NAME);
  });
});

describe('T-592 migration 0261 - the pre-check', () => {
  /** Inside a rolled-back transaction: take the two guards off so a bad row can exist, as it could on a database that predates them. */
  const unguard = async (tx: Tx) => {
    await tx.unsafe(`alter table sales_channels drop constraint ${CHECK_NAME}`);
    await tx.unsafe(`drop index ${INDEX_NAME}`);
  };

  it('M4: a coded daily channel makes the pre-check raise, naming the count, the store code and the channel name', async () => {
    const w = await world();
    let dailyRow: { id: string; name: string } | undefined;
    const e = await refused(
      async (tx) => {
        await unguard(tx);
        [dailyRow] = await ch(tx, w, w.a.id, { daily: true, platform: 'foodpanda', code: 'ab12cd' });
        await tx.unsafe(preCheck());
      },
      '23514',
      'pre-check on a coded daily channel',
    );
    expect(e.message).toContain('0261 refused');
    expect(e.message).toContain(`${w.a.code} / "${dailyRow!.name}"`);
    expect(e.message).toMatch(/Move the code on screen first: on Settings > Sales channels, clear it on the daily channel and enter it on the right Foodpanda or Grab channel, then deploy again\. Nothing was changed\.$/);
    expect(e.message).toMatch(/1 channel\(s\) have a platform store code but are remitted daily/);
    expect(e.message).toMatch(/Nothing was changed/);
  });

  it('M4: two active channels on one platform make the pre-check raise, naming the store code and both channel names', async () => {
    const w = await world();
    const names: string[] = [];
    const e = await refused(
      async (tx) => {
        await unguard(tx);
        for (const code of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
          const [r] = await ch(tx, w, w.b.id, { platform: 'grab', code });
          names.push(r!.name);
        }
        await tx.unsafe(preCheck());
      },
      '23514',
      'pre-check on two active channels',
    );
    expect(e.message).toMatch(/1 store\/platform pair\(s\) have two active channels/);
    for (const n of names) expect(e.message).toContain(`${w.b.code} / "${n}"`);
    expect(e.message).toMatch(/Nothing was changed\.$/);
  });

  it('M4: on a clean table the whole file replays: pre-check passes and both guards come back', async () => {
    const w = await world();
    const o = await run(async (tx) => {
      await unguard(tx);
      await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'ab12cd' });
      await ch(tx, w, w.a.id, { platform: 'foodpanda', code: 'zz99yy', active: false });
      for (const s of statements()) if (s.trim()) await tx.unsafe(s);
      const [r] = await tx<{ n: string }[]>`
        select (select count(*) from pg_constraint where conname = ${CHECK_NAME} and convalidated)
             + (select count(*) from pg_class where relname = ${INDEX_NAME} and relkind = 'i') as n`;
      return Number(r!.n);
    });
    if (!o.ok) throw new Error(`replay failed: ${o.err.code}: ${o.err.message}`);
    expect(o.value).toBe(2);
  });
});
