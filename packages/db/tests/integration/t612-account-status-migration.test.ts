/**
 * T-612 test 7 - migration 0268 backfills `persons.account_status` from `is_active` and a terminal is always active.
 * docs/tasks/612-staff-account-status.md. Same mechanism as t339-attendance-revoke-reason-migration.test.ts: a temp copy of `migrations/` with
 * 0268 AND EVERYTHING AFTER IT removed (by journal `when`), applied to a scratch database, persons seeded in the OLD shape, then the real
 * folder applied on top.
 * Mutants (run by hand): backfill copying every row as 'active' -> the suspended case is red; dropping the terminal clause of the CASE -> the
 * deactivated terminal case is red (the CHECK refuses the UPDATE); dropping either CHECK -> its refusal case is red.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
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
if (!isTestDatabaseUrl(baseUrl)) {
  throw new Error(`Refusing to run against ${redactDbUrl(baseUrl)} — the database name must contain "_test".`);
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_TAG_PREFIX = '0268_';

/** ⛔⛔ Filters by journal `when`, NOT filename prefix — see
 *  `attendance-credentials-scan-collision-migration.test.ts`'s own header for the exact incident
 *  (0152/0153) this shape exists to avoid repeating the day a migration after 0268 exists. */
function buildFolderWithoutTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0268-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (!target) {
    throw new Error(`no journal entry tagged "${TARGET_TAG_PREFIX}" — has 0268 been renamed, removed, or not built yet?`);
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


describe('T-612 - migration 0268 backfills the account status', () => {
  const dbName = `shareat_scratch_0268_account_status_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let orgId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyEverythingExceptTarget(sql);
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('T612 Org', 'T612') returning id`;
    orgId = org!.id;
    const mk = async (key: string, isActive: boolean, kind: 'person' | 'terminal') => {
      const [p] = await sql<{ id: string }[]>`
        insert into persons (org_id, display_name, is_active, kind) values (${orgId}, ${key}, ${isActive}, ${kind}) returning id`;
      ids[key] = p!.id;
    };
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'S1', 'Store', true) returning id`;
    let code = 0;
    const employ = async (key: string, endedOn: string | null) => {
      await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
        values (${orgId}, ${store!.id}, ${ids[key]!}, ${`SE-${String(++code).padStart(3, "0")}`}, ${endedOn ? 'resigned' : 'regular'}, '2025-01-01', ${endedOn})`;
    };
    const role = (key: string, r: string) => sql`insert into person_roles (person_id, org_id, role) values (${ids[key]!}, ${orgId}, ${r})`;
    await mk('working', true, 'person');
    await employ('working', null);
    await mk('switched-off', false, 'person');
    await employ('switched-off', null);
    await mk('live-terminal', true, 'terminal');
    await mk('retired-terminal', false, 'terminal'); // the usage system author is exactly this shape
    // Audit 2a: pre-T-609 leavers kept 'active' (is_active true) with no open job.
    await mk('leaver', true, 'person');
    await employ('leaver', '2025-06-01');
    await mk('never-employed-no-role', true, 'person');
    await mk('ex-manager', true, 'person');
    await role('ex-manager', 'manager');
    await employ('ex-manager', '2025-06-01');
    // ... except the shapes personMaySignInToOrg admits with no open job.
    await mk('admin-no-job', true, 'person');
    await role('admin-no-job', 'admin');
    await mk('super-no-job', true, 'person');
    await role('super-no-job', 'super_admin');
    await mk('franchise-owner', true, 'person');
    await role('franchise-owner', 'manager');
  });

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  const status = async (key: string) => (await sql<{ s: string }[]>`select account_status as s from persons where id = ${ids[key]!}`)[0]?.s;

  it('before the migration there is no such column', async () => {
    await expect(sql`select account_status from persons limit 1`).rejects.toThrow(/account_status/);
  });

  it('an existing is_active person is active (nobody who works today is locked out); a switched-off one is suspended; every terminal is active', async () => {
    await applyTarget(sql);
    expect(await status('working')).toBe('active');
    expect(await status('switched-off')).toBe('suspended');
    expect(await status('live-terminal')).toBe('active');
    expect(await status('retired-terminal'), 'a terminal can only be active (CHECK), whatever is_active said').toBe('active');
  });

  it('audit 2a: a person with no open job is ended, except an administrator and a manager who was never employed', async () => {
    // Mutant: no second UPDATE (or one that spares leavers) -> the leaver stays active and this is red.
    expect(await status('leaver'), 'ended job, no role').toBe('ended');
    expect(await status('never-employed-no-role')).toBe('ended');
    expect(await status('ex-manager'), 'an employed manager whose job ended').toBe('ended');
    // Mutant: no exceptions in the WHERE -> an administrator with no job is ended and this is red.
    expect(await status('admin-no-job')).toBe('active');
    expect(await status('super-no-job')).toBe('active');
    expect(await status('franchise-owner'), 'a manager with no employment EVER').toBe('active');
    expect(await status('working'), 'an open job keeps its status').toBe('active');
  });

  it('a person written by older code (no status given) is active; the vocabulary CHECK refuses anything else', async () => {
    const [p] = await sql<{ s: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Legacy writer') returning account_status as s`;
    expect(p!.s).toBe('active');
    await expect(sql`update persons set account_status = 'paused' where id = ${ids['working']!}`).rejects.toThrow(/persons_account_status_check/);
  });

  it('franchise_reader_check now reads the status; the clock-roster mirror trigger is untouched (still employment / is_active based, by ruling)', async () => {
    const def = async (fn: string) => (await sql<{ d: string }[]>`select pg_get_functiondef(p.oid) as d from pg_proc p where p.proname = ${fn}`)[0]!.d;
    const franchise = await def('franchise_reader_check');
    expect(franchise).toMatch(/"account_status" = 'active'/);
    expect(franchise).not.toMatch(/is_active/);
    const mirror = await def('mirror_enqueue_person_employments');
    expect(mirror).toMatch(/new\.is_active is distinct from old\.is_active/i);
    expect(mirror).not.toMatch(/account_status/);
  });

  it('the terminal CHECK refuses a non-active terminal, and a person may still be pending, suspended or ended', async () => {
    await expect(sql`update persons set account_status = 'suspended' where id = ${ids['live-terminal']!}`).rejects.toThrow(/persons_terminal_always_active_check/);
    for (const s of ['pending', 'suspended', 'ended', 'active']) {
      await sql`update persons set account_status = ${s} where id = ${ids['working']!}`;
      expect(await status('working')).toBe(s);
    }
  });
});
