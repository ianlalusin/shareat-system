/**
 * T-321/DEF-363 Contract 2 (spec test 7) — migration 0153 refuses rather than failing obscurely
 * when live colliding rows already exist, naming the offending organisations and staff codes.
 *
 * Modelled directly on packages/db/tests/integration/position-access-backfill.test.ts's own
 * refuse-gate proof for migration 0152 — same mechanism, because it is the same shape of problem:
 * a temp copy of migrations/ with 0153's file/journal entry AND EVERYTHING AFTER IT removed
 * (filtered by journal `when`, not filename — see `buildFolderWithoutTarget`'s own comment; a
 * name-prefix filter is what turned this exact shape into 14 failures on `main` in 0152's file
 * the day 0153 was added), applied to a scratch database (so the schema exists but 0153 has never
 * run), fixtures seeded with raw SQL to violate the NEW constraint BEFORE that migration ever
 * runs, then the real migrations folder applied on top — which sees the tracking table already
 * past every earlier entry and applies exactly what is left, in order, against real pre-existing
 * data, through the same `drizzle-orm/postgres-js/migrator` the app itself uses.
 *
 * Separate from attendance-credentials-scan-collision.test.ts, which tests Contract 1's
 * post-migration behaviour (the constraint enforcing going forward) — this file tests the
 * migration's OWN refusal on data that predates it, which needs the scratch-database-per-describe
 * mechanism above rather than the standing lane DB's per-file truncate.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(
    `Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_TAG_PREFIX = '0153_';

/**
 * ⛔⛔ FILTERS BY JOURNAL `when`, NOT BY FILENAME PREFIX — deliberately, and not the obvious
 * version. `position-access-backfill.test.ts` (0152's own proof) originally filtered by
 * `!f.startsWith(TARGET_TAG_PREFIX)`, which excludes only the exact target and lets anything
 * added LATER survive into "everything except the target". The day migration 0154 exists, that
 * shape leaves 0154 in this temp folder too; the temp application's tracking table then has a
 * `when` past 0153's own, and the later `applyTarget()` step's attempt to apply 0153 gets
 * silently SKIPPED by drizzle's `created_at`-already-present gate — 0153 never runs, this file's
 * assertions collapse, and it looks like 0154's fault when it is really this file's. Measured for
 * real in 0152's own proof the day 0153 was added (14 failures on `main`); fixed there and here
 * with the same shape so this file does not repeat it the day 0154 exists.
 */
function buildFolderWithoutTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0153-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (!target) {
    throw new Error(`no journal entry tagged "${TARGET_TAG_PREFIX}" — has 0153 been renamed or removed?`);
  }
  const keptEntries = journal.entries.filter((e: { when: number }) => e.when < target.when);
  const keptTags = new Set(keptEntries.map((e: { tag: string }) => e.tag));

  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -'.sql'.length))) {
      writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
    }
  }
  journal.entries = keptEntries;
  writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(journal, null, 2));
  return dir;
}

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

// DEF-365 — 120s ceiling for a drop under concurrent lane load, not typical-case timing. See
// position-access-backfill.test.ts's dropScratchDatabase for the full measurement history.
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

async function applyEverythingExceptTarget(sql: ReturnType<typeof postgres>): Promise<void> {
  const dir = buildFolderWithoutTarget();
  try {
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Applies whatever is left — with the real folder in place and the temp folder having stopped
 * strictly before 0153, that is 0153 and any migration added after it, in one transaction. Not
 * "exactly 0153" once 0154 exists — see `buildFolderWithoutTarget`'s own comment for why that is
 * fine for this file's assertions and how the temp folder stays correct regardless.
 */
async function applyTarget(sql: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

describe('T-321 Contract 2 / spec test 7 — migration 0153 refuses on pre-existing colliding scan values', () => {
  const dbName = `shareat_scratch_0153_refuse_collision_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  const orgName = 'Collide Org';
  const cardEmploymentStaffCode = 'SE-900001'; // T-464: staff codes must be SE-NNN (migration 0212)

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyEverythingExceptTarget(sql);

    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${orgName}, 'COL') returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, is_active) values (${orgId}, 'S1', 'Store', true) returning id`;
    const storeId = store!.id;
    const [admin] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    const adminId = admin!.id;

    const collidingValue = 'CARD-COLLIDE-PREEXISTING';
    const [cardPerson] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Card Holder') returning id`;
    const [cardEmployment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${cardPerson!.id}, ${cardEmploymentStaffCode}, 'regular', '2025-01-01')
      returning id`;
    const [fingerPerson] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Finger Holder') returning id`;
    const [fingerEmployment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${fingerPerson!.id}, 'SE-083067045070073078071069082045049', 'regular', '2025-01-01')
      returning id`;

    // Pre-existing collision, seeded BEFORE 0153 ever runs — exactly the state Contract 2 must
    // detect and refuse on. Both rows are LIVE (revoked_at null) and would share scan_value the
    // moment the generated column exists — today's schema permits this; 0153 exists to refuse it.
    await sql`
      insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by)
      values (${orgId}, ${storeId}, ${cardEmployment!.id}, 'card', ${collidingValue}, ${adminId})`;
    await sql`
      insert into attendance_credentials
        (org_id, store_id, employment_id, kind, match_token, templates, enrolled_by)
      values (${orgId}, ${storeId}, ${fingerEmployment!.id}, 'fingerprint', ${collidingValue}, ${['t1']}, ${adminId})`;
  });

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('rejects the whole migration run, naming the offending organisation and staff code', async () => {
    await expect(applyTarget(sql)).rejects.toThrow(new RegExp(cardEmploymentStaffCode));
    // Same rejection, orthogonal assertion: the organisation name is named too, not only the
    // staff code — Contract 2 requires both, and a message could satisfy one without the other.
    await expect(applyTarget(sql)).rejects.toThrow(new RegExp(orgName));
  });

  it('writes NOTHING when it refuses — no partial scan_value column, no index swap', async () => {
    await expect(applyTarget(sql)).rejects.toThrow();

    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'attendance_credentials' and column_name = 'scan_value'
    `;
    expect(cols, 'scan_value must not exist — step 1 must have rolled back with the rest').toEqual([]);

    const oldIndexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where tablename = 'attendance_credentials'
        and indexname in ('attendance_credentials_card_live_unique', 'attendance_credentials_token_live_unique')
    `;
    expect(
      oldIndexes.map((r) => r.indexname).sort(),
      'both pre-existing indexes must still be standing — step 3 must not have run',
    ).toEqual(['attendance_credentials_card_live_unique', 'attendance_credentials_token_live_unique']);
  });
});
