/**
 * T-347 M1 — migration `0164_t347_asset_shell_disposal_pair.sql`.
 * `docs/tasks/347-def-437-cutover-purge-assets.md` §3.5, §4 (case M1).
 *
 * Unlike T-346's own M1 (a backfill against pre-existing data, needing the before/after-target
 * scratch-DB split), 0164 makes **no data change** — "no shell rows can exist" today, so there is
 * nothing to backfill. This is the simpler scratch-DB-per-describe technique of
 * `attendance-credentials-scan-collision-migration.test.ts:79-104` (migrate straight to whatever
 * `main` currently calls HEAD), exactly as this task's own §4 header cites.
 *
 * The migration drops and re-adds `fixed_assets_disposal_pair_check` with a third branch:
 * `(status = 'pending_valuation' and disposed_on is null and disposal_reason is null and
 * disposed_by is null)`, alongside the two existing branches (`active` with both null, `disposed`
 * with both set) — unchanged.
 *
 * ⛔ RED on current `main` (migrations end at 0163; 0164 does not exist yet): migrating to HEAD
 * stops at 0163, whose `fixed_assets_disposal_pair_check` has only the `active`/`disposed`
 * branches — ANY `pending_valuation` row fails 23514 regardless of `disposed_on`, because neither
 * branch matches. This is DEF-437's own blocker restated as a migration case: a bare shell insert,
 * expected to succeed once 0164 lands, throws 23514 today.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(`Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');

async function createScratchDatabase(name: string): Promise<void> {
  const adminUrl = new URL(baseUrl!);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
// DEF-365 — a ceiling for a contended DROP DATABASE, not a claim about typical speed.
async function dropScratchDatabase(name: string): Promise<void> {
  const adminUrl = new URL(baseUrl!);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.end();
  }
}
function scratchUrl(name: string): string {
  const u = new URL(baseUrl!);
  u.pathname = `/${name}`;
  return u.toString();
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

describe('T-347 M1 — migration 0164 adds the pending_valuation branch to fixed_assets_disposal_pair_check', () => {
  const dbName = `shareat_scratch_0164_disposal_pair_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let orgId: string;
  let storeId: string;
  let personId: string;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });

    const code = uid('t347m1');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, ${code}, 'Store', true) returning id`;
    storeId = store!.id;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Fixture') returning id`;
    personId = person!.id;
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('a bare shell (pending_valuation, disposed_on/reason/by all NULL) is accepted', async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into fixed_assets (org_id, store_id, name, category, status, created_by)
      values (${orgId}, ${storeId}, 'Shell', 'equipment', 'pending_valuation', ${personId})
      returning id`;
    expect(row?.id).toBeDefined();
  });

  it('⛔ a shell with disposed_on set is refused 23514', async () => {
    await expect(
      sql`
        insert into fixed_assets (org_id, store_id, name, category, status, disposed_on, created_by)
        values (${orgId}, ${storeId}, 'Shell', 'equipment', 'pending_valuation', '2026-04-01', ${personId})`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('⛔ an active asset with NULL cost is still refused 23514 (fixed_assets_valuation_shape_check, unchanged by 0164)', async () => {
    await expect(
      sql`
        insert into fixed_assets (org_id, store_id, name, category, status, acquired_on, salvage_value, useful_life_months, interval, created_by)
        values (${orgId}, ${storeId}, 'Asset', 'equipment', 'active', '2026-03-15', '0', 24, 'monthly', ${personId})`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
