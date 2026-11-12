/**
 * T-510 S1a - migration 0233 applied to a POPULATED menu_offers table (audit round 1).
 *
 * Same technique as t346-migrations.test.ts: a scratch database migrated to everything strictly BEFORE 0233 (a temp folder
 * filtered by journal `when`), rows seeded with raw SQL, then the real folder applied. The standing test database cannot
 * prove this: 0233 runs once per database, on data that already exists.
 */
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(`Refusing to run against ${redactDbUrl(baseUrl)} - the database name must contain "_test".`);
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_TAG_PREFIX = '0233_';
const SCRATCH = 't510_s1a_populated_test';

function buildFolderWithoutTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0233-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (!target) throw new Error(`no journal entry tagged "${TARGET_TAG_PREFIX}"`);
  const kept = journal.entries.filter((e: { when: number }) => e.when < target.when);
  const tags = new Set(kept.map((e: { tag: string }) => e.tag));
  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && tags.has(f.slice(0, -'.sql'.length))) writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
  }
  journal.entries = kept;
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  return dir;
}

const adminUrl = () => {
  const u = new URL(baseUrl!);
  u.pathname = '/postgres';
  return u.toString();
};
const scratchUrl = () => {
  const u = new URL(baseUrl!);
  u.pathname = `/${SCRATCH}`;
  return u.toString();
};

let db: ReturnType<typeof postgres>;

type InForce = { id: string; withdrawn: boolean; amount: string | null }[];
let ids: { scheduledOnline: string; orgId: string; storeId: string; variantId: string; liveOld: string; liveNew: string; withdrawnOnline: string; effectiveFrom: string };
let before: { store: InForce; online: InForce };

beforeAll(async () => {
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
    await admin.unsafe(`CREATE DATABASE "${SCRATCH}"`);
  } finally {
    await admin.end();
  }
  db = postgres(scratchUrl(), { max: 2 });

  const dir = buildFolderWithoutTarget();
  try {
    await migrate(drizzle(db), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const code = `t510pop-${Date.now()}`;
  const [org] = await db<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await db<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${`ST-${code}`}, 'Lipa') returning id`;
  const [person] = await db<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [stock] = await db<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, 'POPA-001', 'Pork', 'raw_material', 'kg', ${person!.id}) returning id`;
  const [cat] = await db<{ id: string }[]>`insert into menu_categories (org_id, name, sort_order, status, created_by) values (${orgId}, 'Cat', 0, 'active', ${person!.id}) returning id`;
  const [item] = await db<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${orgId}, ${cat!.id}, 'Item', 'a_la_carte', true, false, true, 0, 'active', ${person!.id}) returning id`;
  const [variant] = await db<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by) values (${orgId}, ${item!.id}, null, true, 0, 'active', ${person!.id}) returning id`;
  await db`insert into menu_depletion_rules (org_id, variant_id, mode, item_id, quantity_per_sale, created_by) values (${orgId}, ${variant!.id}, 'direct', ${stock!.id}, 0.2, ${person!.id})`;

  // Pre-0233 rows: a price, a price change (the live one), and a withdrawn row on another channel.
  const [liveOld] = await db<{ id: string }[]>`
    insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${orgId}, ${store!.id}, ${variant!.id}, 'store', 100, false, ${person!.id}) returning id`;
  const [liveNew] = await db<{ id: string; effective_from: string }[]>`
    insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${orgId}, ${store!.id}, ${variant!.id}, 'store', 110, false, ${person!.id}) returning id, effective_from::text`;
  await db`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${orgId}, ${store!.id}, ${variant!.id}, 'online', 120, false, ${person!.id})`;
  const [wd] = await db<{ id: string }[]>`
    insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${orgId}, ${store!.id}, ${variant!.id}, 'online', null, true, ${person!.id}) returning id`;
  // A scheduled (future) price: the only kind of row a duplicate can reach the unique key with (a past-dated one is refused by the back-dating guard first).
  const [sched] = await db<{ id: string }[]>`
    insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, amount, withdrawn, created_by) values (${orgId}, ${store!.id}, ${variant!.id}, 'online', now() + interval '10 days', 130, false, ${person!.id}) returning id`;
  ids = {
    scheduledOnline: sched!.id,
    orgId,
    storeId: store!.id,
    variantId: variant!.id,
    liveOld: liveOld!.id,
    liveNew: liveNew!.id,
    withdrawnOnline: wd!.id,
    effectiveFrom: liveNew!.effective_from,
  };
  const inForce = (channel: string) =>
    db<InForce>`select id, withdrawn, amount from menu_offer_in_force(${ids.storeId}, ${ids.variantId}, ${channel}, now() + interval '1 minute')`;
  before = { store: await inForce('store'), online: await inForce('online') };

  await migrate(drizzle(db), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}, 240_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  } finally {
    await admin.end();
  }
}, 60_000);

describe('0233 on a populated menu_offers', () => {
  it('before 0233 the in-force rows were the newest live row and the newest (withdrawn) row', () => {
    expect(before.store.map((r) => r.id)).toEqual([ids.liveNew]);
    expect(before.online.map((r) => [r.withdrawn])).toEqual([[true]]);
  });

  it('every pre-existing offer has daypart_id NULL (all day); nothing was backfilled', async () => {
    const rows = await db<{ n: number; nulls: number }[]>`select count(*)::int n, count(*) filter (where daypart_id is null)::int nulls from menu_offers where org_id = ${ids.orgId}`;
    expect(rows[0]).toEqual({ n: 5, nulls: 5 });
  });

  it('menu_offer_in_force returns exactly the same rows as before', async () => {
    const inForce = (channel: string) =>
      db<InForce>`select id, withdrawn, amount from menu_offer_in_force(${ids.storeId}, ${ids.variantId}, ${channel}, now() + interval '1 minute')`;
    expect(await inForce('store')).toEqual(before.store);
    expect(await inForce('online')).toEqual(before.online);
  });

  it('the rebuilt unique key still collides for two NULL-daypart rows in one slot (23505)', async () => {
    let code: string | undefined;
    try {
      await db`insert into menu_offers (org_id, store_id, variant_id, channel, effective_from, amount, withdrawn, created_by)
               select org_id, store_id, variant_id, channel, effective_from, 999, false, created_by from menu_offers where id = ${ids.scheduledOnline}`;
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23505');
  });

  it('a dayparted offer can still be added next to the migrated data once the all-day offer is withdrawn', async () => {
    const [person] = await db<{ id: string }[]>`select id from persons where org_id = ${ids.orgId}`;
    const [dp] = await db<{ id: string }[]>`
      insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, created_by)
      values (${ids.orgId}, ${ids.storeId}, 'Lunch', '{0,1,2,3,4,5,6}'::smallint[], '08:00', '17:00', ${person!.id}) returning id`;
    let code: string | undefined;
    try {
      await db`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
               values (${ids.orgId}, ${ids.storeId}, ${ids.variantId}, 'store', ${dp!.id}, 338, false, ${person!.id})`;
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code, 'the migrated live all-day offer should block a live dayparted one').toBe('23514');
    await db`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
             values (${ids.orgId}, ${ids.storeId}, ${ids.variantId}, 'store', null, null, true, ${person!.id})`;
    await db`insert into menu_offers (org_id, store_id, variant_id, channel, daypart_id, amount, withdrawn, created_by)
             values (${ids.orgId}, ${ids.storeId}, ${ids.variantId}, 'store', ${dp!.id}, 338, false, ${person!.id})`;
    const rows = await db<{ daypart_id: string | null; withdrawn: boolean }[]>`
      select daypart_id, withdrawn from menu_offer_in_force(${ids.storeId}, ${ids.variantId}, 'store', now() + interval '1 minute')`;
    expect(rows).toEqual([{ daypart_id: dp!.id, withdrawn: false }]);
  });
});
