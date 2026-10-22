/**
 * T-318 slice B — migration 0152's own proof.
 * docs/tasks/318-position-decides-access.md, Scope "Slice B", Tests "Slice B", invariant 5.
 *
 * ⛔ **This migration only ever runs ONCE per database** (RULES §1 rule 9: an applied migration
 * is never edited or re-run). The standing lane database (`TEST_DATABASE_URL`, per-file
 * `TRUNCATE`) cannot prove any of this migration's behaviours reliably: by the time a test file's
 * fixtures exist, 0152 has either already run against an earlier, unrelated state, or never runs
 * again once it has. **Every behaviour proved here genuinely needs a database that has never seen
 * 0152 before** — exactly ADR-012 §5 step 8's own prescription ("prove it on a *scratch*
 * database... create `shareat_scratch_<x>`... drop it"), automated here instead of run by hand.
 *
 * Mechanism: each `describe` block creates its own disposable database (connecting to the
 * `postgres` maintenance database to do so — the same technique `provision-test-role.mjs` uses),
 * applies every migration STRICTLY BEFORE 0152 (a TEMP copy of `migrations/` filtered by
 * journal `when`, not by filename — see `buildFolderWithout152`'s own comment for why), seeds
 * fixtures with raw SQL, THEN applies 0152 **and everything after it** by calling the real
 * migrator again against the REAL, unmodified migrations folder — which sees the tracking table
 * already past every earlier entry and applies exactly what is left, in order. ⛔⛔ **NOT "0152
 * alone" any more, and this is a fixed CI-red incident, not a hypothetical:** once a later
 * migration (0153) exists, the temp folder must exclude it too, or the real-folder step's `when`
 * high-water mark jumps past 0152 and drizzle SKIPS it (the `created_at`-already-present gate
 * `trackedRunCount`'s own comment below names) — measured on `main` as 14 failures the day 0153
 * was added, fixed by filtering the temp folder on `when < target.when` rather than on filename
 * prefix. Whatever runs alongside 0152 here is real, through the
 * same `drizzle-orm/postgres-js/migrator` the app itself uses (T-118's own `invariant 9` test
 * already proves that mechanism call-for-call; this file does not re-prove it) — and it is safe
 * for 0152's OWN assertions because `trackedRunCount()` below counts 0152's exact `when`, not a
 * total.
 *
 * ⛔⛔ **CORRECTED (T-341, 2026-09-25) — "no later migration touches the tables this file
 * backfills" is no longer true.** Migration 0159 adds `person_grants.store_id`, drops
 * `person_grants_active_person_grant_unique` and replaces it with two partial indexes. Every
 * assertion here that only reads `grant_name` / `set_by` / `granted_by` / row counts is
 * unaffected (0159's own backfill step preserves them). The one exception is the standalone
 * idempotency test below, which re-executes 0152's raw SQL a second time: post-0159 that
 * statement's `ON CONFLICT ("person_id","grant_name") WHERE revoked_at IS NULL` no longer
 * names an existing constraint at all, so it now runs in its OWN scratch database stopped
 * exactly at 0152 — proving "safe if replayed" is only ever a coherent question asked at a
 * migration's own historical schema position, never forever.
 *
 * ⚠️ Not the standing lane DB, so this file does not compete with another lane's integration run
 * against `TEST_DATABASE_URL` — it only borrows that URL's host/credentials to open its own,
 * separate, disposable databases via `/postgres`.
 *
 * ⛔ **21 capability names are hardcoded here, deliberately, the same as in `0152_*.sql` itself.**
 * `packages/db` may not import `@shareat/auth` (ADR-004 / `packages/db/schema/access.ts`'s own
 * header: the dependency direction is the other way).
 *
 * ⛔⛔ **CORRECTED — the sentence that used to stand here named a guard that does not exist.** It
 * claimed `tests/unit/capability-matrix.test.ts` would catch this list drifting from
 * `packages/auth/src/capabilities.ts`'s real `staff: true` cells. That test only parses
 * `CAPABILITY-MATRIX.md` against `capabilities.ts` — it has never read this file, and nothing does.
 * ⭐ **Nor is the drift merely theoretical any more: after T-318 slice C, `capabilities.ts` has
 * ZERO `staff: true` cells, while the list below still names 21 — the two already disagree, and
 * `tests/unit/capability-matrix.test.ts` passes 208/208 regardless, because it was never looking.**
 * ⚠️ **The list itself is correct and must NOT be changed to match** — it is a frozen record of
 * exactly what migration `0152` backfilled against real pre-existing data, `0152` is applied in
 * production, and RULES §1 rule 9 forbids editing an applied migration or the proof of what it
 * did. What was wrong is only the claim that something still checks it against the live matrix:
 * nothing does, because after this task the matrix no longer carries "the everyday 21" as a
 * concept at all — that information now lives only here, in `CAPABILITY-MATRIX.md`'s Notes
 * column, and in the position-grant rows `0152` wrote.
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(
    `Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_TAG_PREFIX = '0152_';

/** The 21 — packages/auth/src/capabilities.ts's `staff: true` cells, T-318 moves them. */
const THE_21 = [
  'record_sale',
  'submit_sales_day',
  'record_statutory_discount',
  'record_till_count',
  'create_expense',
  'edit_own_expense',
  'record_stock_movement',
  'record_wastage',
  'transfer_stock',
  'record_supplier_return',
  'record_customer_return',
  'confirm_receipt',
  'set_item_threshold',
  'post_order_message',
  'place_branch_order',
  'fulfil_branch_order',
  'receive_delivery',
  'record_supplier_invoice',
  'create_wholesale_order',
  'record_order_wastage',
  'request_pos_map',
].sort();

/**
 * A temp copy of `migrations/` with 0152's file/journal entry AND EVERY MIGRATION AFTER IT
 * removed — so `migrate()` against it applies every migration STRICTLY BEFORE 0152, and the
 * later real-folder step (`apply152`) has exactly 0152-and-onward left to apply, in order.
 *
 * ⛔⛔ FIXED — this used to filter by FILENAME PREFIX (`!f.startsWith(TARGET_TAG_PREFIX)`), which
 * excludes only the exact target and lets anything added LATER survive into the temp folder. The
 * day migration 0153 existed, that filter left 0153 in the "everything except 0152" folder; the
 * temp application recorded 0153's `when` (1799292707084) as the tracking table's high-water
 * mark; the real-folder step then tried to apply 0152 (`when` 1799206307084, EARLIER) and drizzle
 * silently SKIPPED it — the exact gate this file's own `trackedRunCount` comment already named.
 * 0152 never ran, nothing backfilled, 14 assertions collapsed, `main` went red. **Filtering by
 * `when` instead of by name is what makes "before the target" mean the same thing regardless of
 * how many migrations get added after 0152 in the future** — the temp folder always ends at
 * 0152's own timestamp, never at whatever happens to be newest on disk.
 *
 * Built fresh per test run rather than committed, because the real folder (and 0152's own `when`)
 * is the only source of truth for what "before 0152" currently means.
 */
function buildFolderWithout152(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0152-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (!target) {
    throw new Error(`no journal entry tagged "${TARGET_TAG_PREFIX}" — has 0152 been renamed or removed?`);
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

/**
 * DEF-365 — `DROP DATABASE` has been measured at two very different speeds on this same
 * development machine, and the difference is the CONDITION it ran under, not a property of the
 * machine itself:
 *
 *   - **2026-09-16, several lanes running integration suites against this Postgres concurrently:**
 *     dropping a database with NO connections took **38,477ms** — past vitest's 30,000ms
 *     `hookTimeout`, which failed this file's `afterAll` while all 17 of its tests passed.
 *   - **2026-09-17, quiet machine:** the same operation took **57–75ms** across three fresh runs,
 *     and this file passes with the default 30s timeout, unmodified.
 *
 * ⭐ **So the two `afterAll` hooks below carry an explicit 120,000ms timeout as a CEILING for the
 * contended case, not a description of normal behaviour.** A reader who measures 57ms tomorrow has
 * not found a stale comment — they have found the quiet case this comment already names. 120s is
 * ~3x the one contended measurement on record, sized on the asymmetry: a ceiling that is too high
 * only delays reporting a genuinely hung drop; one too low reports a FAILED file whose tests all
 * passed, which is exactly the signal this row exists to protect (docs/DEFECTS-REGISTER.md DEF-365).
 * ⛔ **A lingering connection is not the failure mode to suspect here** — it makes `DROP DATABASE`
 * FAIL in ~5s with "database is being accessed by other users", never hang, so a slow drop is
 * never evidence of a stuck connection. ⚠️ Neither hook below ever drops more than ONE database
 * (the middle describe block's six scratch databases are each created and dropped inline inside
 * their own `it()`, under `testTimeout`, not here) — so the ceiling is one drop plus margin, never
 * a multiple.
 */
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

async function applyEverythingExcept152(sql: ReturnType<typeof postgres>): Promise<void> {
  const dir = buildFolderWithout152();
  try {
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Applies whatever is left — with the real folder in place and the temp folder having stopped
 * strictly before 0152, that is 0152 AND ANY MIGRATION ADDED AFTER IT, applied together in one
 * transaction (all pending migrations share one `migrate()` transaction — confirmed at source).
 * No longer "exactly 0152 alone": once 0153 exists this also applies 0153, which is harmless to
 * every assertion below because `trackedRunCount()` counts 0152's own `when`, not a total.
 * ⛔ **Not universally harmless any more (T-341, 2026-09-25):** 0159 restructures
 * `person_grants`'s unique indexes. Every `it()` in this file that uses this function only reads
 * state 0152 itself wrote, which stays correct; the one exception (the idempotency test) does
 * NOT use this function — see its own comment.
 */
function buildFolderThrough152(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-through-0152-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag.startsWith(TARGET_TAG_PREFIX));
  if (!target) {
    throw new Error(`no journal entry tagged "${TARGET_TAG_PREFIX}" — has 0152 been renamed or removed?`);
  }
  const keptEntries = journal.entries.filter((e: { when: number }) => e.when <= target.when);
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

/** Applies every migration up to AND INCLUDING 0152, and stops there — never any later
 *  migration. Used only by the idempotency test, which needs 0152's OWN historical schema
 *  position, not whatever the tip currently is (T-341, 2026-09-25). */
async function applyThrough152(sql: ReturnType<typeof postgres>): Promise<void> {
  const dir = buildFolderThrough152();
  try {
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function apply152(sql: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

async function activeGrantNames(sql: ReturnType<typeof postgres>, personId: string): Promise<string[]> {
  const rows = await sql<{ grant_name: string }[]>`
    select grant_name from person_grants where person_id = ${personId} and revoked_at is null order by grant_name
  `;
  return rows.map((r) => r.grant_name);
}

/** Mirrors packages/auth/src/authorize.ts's axis 3a exactly: `matrixAllows || grant`. Lets the
 *  test express "if the matrix had already been flipped" without touching slice C's code. */
function wouldHoldViaAxis3a(matrixAllowsForRole: boolean, hasActiveGrant: boolean): boolean {
  return matrixAllowsForRole || hasActiveGrant;
}

/**
 * DEF-039's exact failure mode, proved rather than assumed: a migration that fails inside its own
 * transaction must leave NO row in drizzle's tracking table, or a corrected re-run of the same
 * file would be silently skipped forever (drizzle gates on `created_at` already present). 0152's
 * own `when` is 1799206307084 (packages/db/migrations/meta/_journal.json) — this is the literal
 * value production's failed first run left unrecorded, confirmed directly against
 * `drizzle.__drizzle_migrations` on `shareat_dev` and `shareat_test_lanea` before this file's
 * 2026-09-16 edit (both absent) — this assertion is what keeps that true going forward.
 */
async function trackedRunCount(sql: ReturnType<typeof postgres>): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    select count(*)::int as c from drizzle.__drizzle_migrations where created_at = 1799206307084
  `;
  return rows[0]!.c;
}

// =========================================================================================
// Suite 1 — the positionless-employment refuse gate.
// =========================================================================================

describe('T-318 slice B / migration 0152 — refuses when an open employment has no position', () => {
  const dbName = `shareat_scratch_0152_refuse_pos_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  const orphanStaffCode = 'SE-900002'; // T-464: staff codes must be SE-NNN (migration 0212)

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyEverythingExcept152(sql);

    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Refuse Org', 'RFS') returning id`;
    const [ian] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Ian') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${ian!.id}, ${org!.id}, 'super_admin')`;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
    const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'No Position') returning id`;
    await sql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${org!.id}, ${store!.id}, ${person!.id}, ${orphanStaffCode}, 'regular', '2026-01-01')
    `;
    // Deliberately NO employment_positions row for this employment — and a real super_admin
    // exists, so the ONLY thing that can make this migration refuse is the positionless check.
  });

  // DEF-365 — see dropScratchDatabase's own comment for the full reasoning and both dated
  // measurements. 120_000 is a ceiling for a database drop under concurrent load, not a claim
  // about typical speed.
  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('rejects the whole migration run, naming the offending staff code', async () => {
    await expect(apply152(sql)).rejects.toThrow(new RegExp(orphanStaffCode));
  });

  it('writes NOTHING when it refuses — no partial position_capability_defaults or person_grants rows', async () => {
    // The DO block is the first statement in the file; if the migrator wraps the whole batch in
    // one transaction (it does — drizzle-orm's pg-core dialect, verified at source:
    // `session.transaction(async (tx) => { for (migration of migrations) for (stmt of
    // migration.sql) await tx.execute(stmt) })`), a later statement could never have run anyway.
    // This assertion is what makes that a proven fact for THIS migration, not an assumption.
    const defaults = await sql<{ c: number }[]>`select count(*)::int as c from position_capability_defaults`;
    const grants = await sql<{ c: number }[]>`select count(*)::int as c from person_grants`;
    expect(defaults[0]!.c).toBe(0);
    expect(grants[0]!.c).toBe(0);
  });

  it('leaves no row in drizzle.__drizzle_migrations — a corrected re-run is not silently skipped', async () => {
    expect(await trackedRunCount(sql)).toBe(0);
  });
});

// =========================================================================================
// Suite 2 — the attribution refuse gate. RULED TWICE, 2026-09-14 then corrected 2026-09-16
// after production's first real deploy failed: `createFirstAdmin`
// (packages/domain/src/organizations/index.ts) has NO code path that ever creates a
// super_admin, so a bootstrap-created org genuinely has zero — that was the gate demanding a
// role the system does not produce, not a data error. The corrected rule, per org: exactly one
// active super_admin wins; failing that, exactly one active admin (the account the bootstrap
// actually creates for the org owner) wins; anything else refuses, naming every candidate found
// at whichever tier was ambiguous.
// =========================================================================================

describe('T-318 slice B / migration 0152 — the two-tier attribution rule', () => {
  it('refuses with ZERO super_admins AND zero admins in the org — admin tier, no candidates', async () => {
    const dbName = `shareat_scratch_0152_refuse_zero_both_${Date.now()}`;
    await createScratchDatabase(dbName);
    const sql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(sql);
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Zero Both Org', 'ZBO') returning id`;
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SE-083067045090049', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;
      // No super_admin, no admin at all — production's actual shape before this fix.

      await expect(apply152(sql)).rejects.toThrow(/admin tier: 0 candidate\(s\): none/);
      expect(await trackedRunCount(sql)).toBe(0);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });

  it('⭐ succeeds with ZERO super_admins and ONE admin — attributes to the admin (production\'s real shape)', async () => {
    // This is the leg that would have caught the production failure: a bootstrap-created org has
    // exactly one admin (createFirstAdmin) and no super_admin, ever, by construction.
    const dbName = `shareat_scratch_0152_admin_fallback_${Date.now()}`;
    await createScratchDatabase(dbName);
    const sql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(sql);
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Admin Only Org', 'AOO') returning id`;
      const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'The Owner') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${org!.id}, 'admin')`;
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SE-083067045065049', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;

      await expect(apply152(sql)).resolves.toBeUndefined();
      expect(await trackedRunCount(sql)).toBe(1);

      const setByRows = await sql<{ set_by: string }[]>`select distinct set_by from position_capability_defaults`;
      expect(setByRows.map((r) => r.set_by)).toEqual([admin!.id]);
      const grantedByRows = await sql<{ granted_by: string }[]>`select distinct granted_by from person_grants`;
      expect(grantedByRows.map((r) => r.granted_by)).toEqual([admin!.id]);
      const names = await activeGrantNames(sql, person!.id);
      expect(names).toEqual(THE_21);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });

  it('refuses with ZERO super_admins and TWO admins — admin tier ambiguous, naming both', async () => {
    const dbName = `shareat_scratch_0152_refuse_two_admin_${Date.now()}`;
    await createScratchDatabase(dbName);
    const sql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(sql);
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Two Admin Org', 'TAO') returning id`;
      const [a1] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Admin One') returning id`;
      const [a2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Admin Two') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${a1!.id}, ${org!.id}, 'admin')`;
      await sql`insert into person_roles (person_id, org_id, role) values (${a2!.id}, ${org!.id}, 'admin')`;
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SE-083067045068049', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;

      await expect(apply152(sql)).rejects.toThrow(/Admin One.*Admin Two|Admin Two.*Admin One/s);
      expect(await trackedRunCount(sql)).toBe(0);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });

  it('refuses with TWO active super_admins in the org, naming both — super_admin tier, even though the org also has zero admins', async () => {
    const dbName = `shareat_scratch_0152_refuse_two_sa_${Date.now()}`;
    await createScratchDatabase(dbName);
    const sql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(sql);
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Two SA Org', 'TSA') returning id`;
      const [sa1] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Super One') returning id`;
      const [sa2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Super Two') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${sa1!.id}, ${org!.id}, 'super_admin')`;
      await sql`insert into person_roles (person_id, org_id, role) values (${sa2!.id}, ${org!.id}, 'super_admin')`;
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SE-083067045084049', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;

      await expect(apply152(sql)).rejects.toThrow(/Super One.*Super Two|Super Two.*Super One/s);
      await expect(apply152(sql)).rejects.toThrow(/super_admin tier ambiguous/);
      expect(await trackedRunCount(sql)).toBe(0);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });

  it('⭐ prefers the super_admin over the admin when an org has exactly one of each', async () => {
    // Proves the PREFERENCE ORDER, not merely that either tier alone works.
    const dbName = `shareat_scratch_0152_prefer_sa_${Date.now()}`;
    await createScratchDatabase(dbName);
    const sql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(sql);
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Both Roles Org', 'BRO') returning id`;
      const [sa] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'The Super') returning id`;
      const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'The Admin') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${sa!.id}, ${org!.id}, 'super_admin')`;
      await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${org!.id}, 'admin')`;
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SE-083067045080049', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;

      await expect(apply152(sql)).resolves.toBeUndefined();
      const setByRows = await sql<{ set_by: string }[]>`select distinct set_by from position_capability_defaults`;
      expect(setByRows.map((r) => r.set_by)).toEqual([sa!.id]);
      expect(setByRows.map((r) => r.set_by)).not.toEqual([admin!.id]);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });

  it('does NOT refuse for an org with no stores and no super_admin or admin — it would receive zero rows either way', async () => {
    // Review finding, system32-85, 2026-09-14: Step 2 must only check organisations Step 3 would
    // actually write a row for. An org with nothing to back-fill has nobody to protect by
    // refusing, and refusing anyway would halt a production deploy for no reason. Proven here
    // alongside a SECOND, real org that DOES receive rows and DOES have an ambiguity-free
    // super_admin — the empty org must not block the real one's backfill either.
    const dbName = `shareat_scratch_0152_empty_org_exempt_${Date.now()}`;
    await createScratchDatabase(dbName);
    const sql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(sql);

      // Org with no stores, no positions, no super_admin at all — must be silently skipped.
      await sql`insert into organizations (name, code) values ('Empty Org', 'EMP')`;

      // A real org, with a normal, unambiguous backfill.
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Real Org', 'RL1') returning id`;
      const [ian] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Ian') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${ian!.id}, ${org!.id}, 'super_admin')`;
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SE-083067045082049', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;

      await expect(apply152(sql)).resolves.toBeUndefined();

      const names = await activeGrantNames(sql, person!.id);
      expect(names).toEqual(THE_21);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });
});

// =========================================================================================
// Suite 3 — the backfill itself, once every open employment has a position and every org has
// exactly one active super_admin.
// =========================================================================================

describe('T-318 slice B / migration 0152 — backfills position_capability_defaults + person_grants', () => {
  const dbName = `shareat_scratch_0152_backfill_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;

  let ianId: string;
  let cashierId: string;
  let cookId: string;
  let singlePersonId: string;
  let multiPersonId: string;
  let inactiveStorePersonId: string;
  let freshPersonId: string;

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyEverythingExcept152(sql);

    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Backfill Org', 'BKF') returning id`;
    const orgId = org!.id;
    const [ian] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Ian') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${ian!.id}, ${orgId}, 'super_admin')`;
    ianId = ian!.id;

    const [activeStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'ACT', 'Active Store', true) returning id`;
    const [inactiveStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'INA', 'Inactive Store', false) returning id`;

    const [cashier] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Cashier', true, true) returning id`;
    const [cook] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Kitchen Staff', true, true) returning id`;
    cashierId = cashier!.id;
    cookId = cook!.id;

    // Single-position holder, open employment, active store.
    const [personSingle] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Single Position') returning id`;
    const [empSingle] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${activeStore!.id}, ${personSingle!.id}, 'SE-083067045049', 'regular', '2026-01-01') returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empSingle!.id}, ${cashierId}, true)`;
    singlePersonId = personSingle!.id;

    // Multi-position holder — ruled 2026-09-14: union of both, is_primary decides nothing here.
    const [personMulti] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Multi Position') returning id`;
    const [empMulti] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${activeStore!.id}, ${personMulti!.id}, 'SE-083067045050', 'regular', '2026-01-01') returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empMulti!.id}, ${cashierId}, true)`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empMulti!.id}, ${cookId}, false)`;
    multiPersonId = personMulti!.id;

    // Open employment at an INACTIVE store — Contract 4 must hold for them too.
    const [personInactive] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'At Inactive Store') returning id`;
    const [empInactive] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${inactiveStore!.id}, ${personInactive!.id}, 'SE-083067045051', 'regular', '2026-01-01') returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empInactive!.id}, ${cashierId}, true)`;
    inactiveStorePersonId = personInactive!.id;

    // A person with no employment at all — the invariant-5 red control.
    const [personFresh] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'No Employment') returning id`;
    freshPersonId = personFresh!.id;

    await apply152(sql);
  });

  // DEF-365 — see dropScratchDatabase's own comment for the full reasoning and both dated
  // measurements. 120_000 is a ceiling for a database drop under concurrent load, not a claim
  // about typical speed.
  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('⭐ CONTRACT 4: a single-position holder receives exactly the 21, via grant_source=position', async () => {
    const names = await activeGrantNames(sql, singlePersonId);
    expect(names).toEqual(THE_21);
    const sources = await sql<{ grant_source: string }[]>`
      select distinct grant_source from person_grants where person_id = ${singlePersonId}
    `;
    expect(sources.map((r) => r.grant_source)).toEqual(['position']);
  });

  it('⭐ a multi-position holder receives the UNION — exactly 21, never 42, is_primary irrelevant', async () => {
    const names = await activeGrantNames(sql, multiPersonId);
    expect(names).toEqual(THE_21);
  });

  it('an open employment at an INACTIVE store still receives the 21 — Contract 4 does not stop at store.is_active', async () => {
    const names = await activeGrantNames(sql, inactiveStorePersonId);
    expect(names).toEqual(THE_21);
  });

  it('a person with no employment at all receives nothing — the migration backfills existing data, not people', async () => {
    const names = await activeGrantNames(sql, freshPersonId);
    expect(names).toEqual([]);
  });

  it("⭐ ATTRIBUTION: every row this migration writes is attributed to the org's super_admin (Ian, by his own ruling)", async () => {
    const setByRows = await sql<{ set_by: string }[]>`select distinct set_by from position_capability_defaults`;
    expect(setByRows.map((r) => r.set_by)).toEqual([ianId]);
    const grantedByRows = await sql<{ granted_by: string }[]>`select distinct granted_by from person_grants`;
    expect(grantedByRows.map((r) => r.granted_by)).toEqual([ianId]);
  });

  it('⭐⭐ INVARIANT 5, the paired red control 0148 never had: loses access without the backfill, keeps it with', async () => {
    // "Without the backfill" is simulated, not literally undone (the migration is applied and
    // irreversible by design) — by asking the SAME question authorize()'s axis 3a asks
    // (`matrixAllows || grant`) with matrixAllows forced to `false`, exactly the state once slice
    // C flips CAPABILITY_MATRIX.record_sale.staff to false. The grant half is real, queried
    // straight from what this migration wrote.
    const freshGrant = (await activeGrantNames(sql, freshPersonId)).includes('record_sale');
    const backfilledGrant = (await activeGrantNames(sql, singlePersonId)).includes('record_sale');

    expect(wouldHoldViaAxis3a(false, freshGrant)).toBe(false); // RED: no backfill, no grant -> loses it
    expect(wouldHoldViaAxis3a(false, backfilledGrant)).toBe(true); // GREEN: backfilled -> keeps it
  });

  it('non-vacuity: the scan actually found positions, stores and open employments', async () => {
    const defaults = await sql<{ c: number }[]>`select count(*)::int as c from position_capability_defaults`;
    const grants = await sql<{ c: number }[]>`select count(*)::int as c from person_grants`;
    expect(defaults[0]!.c).toBeGreaterThan(0);
    expect(grants[0]!.c).toBeGreaterThan(0);
  });

  it('idempotent: re-applying the same statements a second time changes nothing — proven directly, not inferred', async () => {
    // 0152 will never actually be re-run by the app's own migrator (drizzle skips an
    // already-recorded tag) — this proves the SQL itself is safe if it ever were, by executing
    // its statements a second time directly, the same way T-118's `invariant 9` proves its
    // trigger is not duplicated.
    //
    // ⛔ **Own dedicated scratch database, stopped exactly AT 0152 (T-341, 2026-09-25) — never
    // this describe block's shared, already-fully-migrated-to-tip `sql`.** Migration 0159 drops
    // the exact index 0152's `ON CONFLICT ("person_id","grant_name") WHERE revoked_at IS NULL`
    // targets and replaces it with two partial ones; against the post-0159 schema that statement
    // no longer names an existing constraint at all ("there is no unique or exclusion constraint
    // matching the ON CONFLICT specification") — not a defect in 0159, just proof that "is 0152's
    // frozen SQL safe to replay" is only a coherent question AT 0152's own historical schema
    // position, never forever. `applyThrough152` stops there on purpose.
    const dbName = `shareat_scratch_0152_idempotent_${Date.now()}`;
    await createScratchDatabase(dbName);
    const idemSql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(idemSql);
      const [org] = await idemSql<{ id: string }[]>`insert into organizations (name, code) values ('Idempotent Org', 'IDM') returning id`;
      const [admin] = await idemSql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'The Owner') returning id`;
      await idemSql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${org!.id}, 'admin')`;
      const [store] = await idemSql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await idemSql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await idemSql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await idemSql<{ id: string }[]>`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${org!.id}, ${store!.id}, ${person!.id}, 'SE-083067045073068077049', 'regular', '2026-01-01') returning id`;
      await idemSql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;

      await applyThrough152(idemSql);

      const beforeDefaults = (await idemSql<{ c: number }[]>`select count(*)::int as c from position_capability_defaults`)[0]!.c;
      const beforeGrants = (await idemSql<{ c: number }[]>`select count(*)::int as c from person_grants`)[0]!.c;
      expect(beforeGrants, 'non-vacuity: the fixture must actually produce rows for the replay to prove anything').toBeGreaterThan(0);

      const file = readdirSync(REAL_MIGRATIONS_FOLDER).find((f) => f.startsWith(TARGET_TAG_PREFIX));
      expect(file, '0152_*.sql not found in the real migrations folder').toBeDefined();
      const statements = readFileSync(join(REAL_MIGRATIONS_FOLDER, file!), 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      await idemSql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
      });

      const afterDefaults = (await idemSql<{ c: number }[]>`select count(*)::int as c from position_capability_defaults`)[0]!.c;
      const afterGrants = (await idemSql<{ c: number }[]>`select count(*)::int as c from person_grants`)[0]!.c;
      expect(afterDefaults).toBe(beforeDefaults);
      expect(afterGrants).toBe(beforeGrants);
    } finally {
      await idemSql.end();
      await dropScratchDatabase(dbName);
    }
  });
});
