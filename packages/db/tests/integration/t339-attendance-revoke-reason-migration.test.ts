/**
 * T-339 slice 5 / DEF-236 — `docs/tasks/339-small-defects-batch-1.md` "Slice 5", "Tests" (migration
 * half). Modelled directly on
 * `attendance-credentials-scan-collision-migration.test.ts` (0153's own proof) — same mechanism,
 * same reason: a temp copy of `migrations/` with 0158 AND EVERYTHING AFTER IT removed (filtered by
 * journal `when`, never by filename prefix — see that file's own header for why a name-prefix
 * filter silently stops working the day a later migration exists), applied to a scratch database,
 * fixtures seeded with raw SQL to violate the NEW constraint's blank-reason clause BEFORE 0158 ever
 * runs, then the real migrations folder applied on top.
 *
 * ⛔ RED before 0158 exists: `buildFolderWithoutTarget()` cannot find a journal entry tagged
 * `0158_`, and throws "no journal entry tagged" — exactly the spec's own named red ("no migration
 * tagged 0158").
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
  throw new Error(`Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_TAG_PREFIX = '0158_';

/** ⛔⛔ Filters by journal `when`, NOT filename prefix — see
 *  `attendance-credentials-scan-collision-migration.test.ts`'s own header for the exact incident
 *  (0152/0153) this shape exists to avoid repeating the day a migration after 0158 exists. */
function buildFolderWithoutTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0158-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (!target) {
    throw new Error(`no journal entry tagged "${TARGET_TAG_PREFIX}" — has 0158 been renamed, removed, or not built yet?`);
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

// DEF-365 — 120s ceiling for a drop under concurrent lane load (see the sibling migration test's
// own dropScratchDatabase for the full measurement history).
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

async function applyTarget(sql: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

const DEF_236_SENTENCE = 'Revoked with a blank reason before one was required — DEF-236.';

describe('T-339 slice 5 / DEF-236 — migration 0158 backfills blank revoke reasons and refuses new ones', () => {
  const dbName = `shareat_scratch_0158_revoke_reason_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let blankReasonCredId: string;
  let lostReasonCredId: string;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyEverythingExceptTarget(sql);

    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values ('T339 Slice 5 Org', 'T339S5') returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, is_active) values (${orgId}, 'S1', 'Store', true) returning id`;
    const storeId = store!.id;
    const [admin] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    const adminId = admin!.id;

    const [blankPerson] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Blank Reason Holder') returning id`;
    const [blankEmployment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${blankPerson!.id}, 'SC-BLANK-1', 'regular', '2025-01-01') returning id`;
    const [blankCred] = await sql<{ id: string }[]>`
      insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by, revoked_at, revoked_by, revoke_reason)
      values (${orgId}, ${storeId}, ${blankEmployment!.id}, 'card', 'CARD-BLANK', ${adminId}, now(), ${adminId}, '  ')
      returning id`;
    blankReasonCredId = blankCred!.id;

    const [lostPerson] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, 'Lost Reason Holder') returning id`;
    const [lostEmployment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${lostPerson!.id}, 'SC-LOST-1', 'regular', '2025-01-01') returning id`;
    const [lostCred] = await sql<{ id: string }[]>`
      insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by, revoked_at, revoked_by, revoke_reason)
      values (${orgId}, ${storeId}, ${lostEmployment!.id}, 'card', 'CARD-LOST', ${adminId}, now(), ${adminId}, 'Lost')
      returning id`;
    lostReasonCredId = lostCred!.id;
  });

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('backfills the blank-reason row with the DEF-236 sentence; leaves the real-reason row untouched', async () => {
    await applyTarget(sql);

    const [blank] = await sql<{ revoke_reason: string }[]>`
      select revoke_reason from attendance_credentials where id = ${blankReasonCredId}`;
    expect(blank!.revoke_reason).toBe(DEF_236_SENTENCE);

    const [lost] = await sql<{ revoke_reason: string }[]>`
      select revoke_reason from attendance_credentials where id = ${lostReasonCredId}`;
    expect(lost!.revoke_reason).toBe('Lost');
  });

  it('the widened attendance_credentials_revoke_check constraint is present (pg_constraint)', async () => {
    const [constraint] = await sql<{ conname: string; consrc: string }[]>`
      select conname, pg_get_constraintdef(oid) as consrc
      from pg_constraint
      where conname = 'attendance_credentials_revoke_check'`;
    expect(constraint, 'attendance_credentials_revoke_check must exist after 0158').toBeDefined();
    // ⭐ Audit follow-up (2026-09-25): a bare `/btrim/` match would pass a NULL-blind constraint that
    // merely mentions btrim somewhere unrelated. Match the actual clause, measured against the real
    // `pg_get_constraintdef` output on a migrated DB: `...(revoke_reason IS NOT NULL) AND
    // (btrim(revoke_reason) <> ''::text)...` — the non-blank check tied to the same column, in order.
    expect(constraint!.consrc).toMatch(/revoke_reason IS NOT NULL\)\s*AND\s*\(btrim\(revoke_reason\)\s*<>\s*''/i);
  });

  it('the widened constraint now refuses a fresh blank-reason revoke', async () => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name)
      select org_id, 'Fresh Blank Holder' from attendance_credentials where id = ${blankReasonCredId} limit 1
      returning id`;
    const [org] = await sql<{ org_id: string }[]>`select org_id from persons where id = ${p!.id}`;
    const [store] = await sql<{ id: string }[]>`select id from stores where org_id = ${org!.org_id} limit 1`;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${org!.org_id}, ${store!.id}, ${p!.id}, 'SC-FRESH-1', 'regular', '2025-01-01') returning id`;
    const [cred] = await sql<{ id: string }[]>`
      insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by)
      values (${org!.org_id}, ${store!.id}, ${emp!.id}, 'card', 'CARD-FRESH', ${p!.id}) returning id`;
    await expect(
      sql`update attendance_credentials set revoked_at = now(), revoked_by = ${p!.id}, revoke_reason = '   ' where id = ${cred!.id}`,
    ).rejects.toThrow(/attendance_credentials_revoke_check/);
  });
});
