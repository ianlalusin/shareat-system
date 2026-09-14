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
 * applies every migration EXCEPT 0152 (a TEMP copy of `migrations/` with 0152's file and journal
 * entry removed — so the schema exists but 0152 has never run), seeds fixtures with raw SQL, THEN
 * applies 0152 alone by calling the real migrator again against the REAL, unmodified migrations
 * folder — which sees the tracking table already past every earlier entry and applies exactly the
 * one new one. This is 0152's one and only real first application, against real pre-existing data,
 * through the same `drizzle-orm/postgres-js/migrator` the app itself uses (T-118's own
 * `invariant 9` test already proves that mechanism call-for-call; this file does not re-prove it).
 *
 * ⚠️ Not the standing lane DB, so this file does not compete with another lane's integration run
 * against `TEST_DATABASE_URL` — it only borrows that URL's host/credentials to open its own,
 * separate, disposable databases via `/postgres`.
 *
 * ⛔ **21 capability names are hardcoded here, deliberately, the same as in `0152_*.sql` itself.**
 * `packages/db` may not import `@shareat/auth` (ADR-004 / `packages/db/schema/access.ts`'s own
 * header: the dependency direction is the other way). If this list and
 * `packages/auth/src/capabilities.ts`'s real `staff: true` count ever disagree,
 * `tests/unit/capability-matrix.test.ts` is what catches it — not this file, which only proves
 * the migration reproduces whatever list it was given.
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
 * A temp copy of `migrations/` with the `0152_*` file and its journal entry removed — so
 * `migrate()` against it applies every migration EXCEPT 0152. Built fresh per test run rather
 * than committed, because the real folder (and 0152's own `when`) is the only source of truth for
 * what "everything else" currently means.
 */
function buildFolderWithout152(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-0152-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && !f.startsWith(TARGET_TAG_PREFIX)) {
      writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
    }
  }
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => !e.tag.startsWith(TARGET_TAG_PREFIX));
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

/** Applies whatever is left — with the real folder in place, that is exactly 0152. */
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

// =========================================================================================
// Suite 1 — the positionless-employment refuse gate.
// =========================================================================================

describe('T-318 slice B / migration 0152 — refuses when an open employment has no position', () => {
  const dbName = `shareat_scratch_0152_refuse_pos_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  const orphanStaffCode = 'SC-ORPHAN';

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

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  });

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
});

// =========================================================================================
// Suite 2 — the attribution refuse gate (Ian's ruling, 2026-09-14): zero or more than one
// active super_admin in an org must refuse, never guess.
// =========================================================================================

describe('T-318 slice B / migration 0152 — refuses when an org has zero or multiple active super_admins', () => {
  it('refuses with ZERO super_admins in the org', async () => {
    const dbName = `shareat_scratch_0152_refuse_zero_sa_${Date.now()}`;
    await createScratchDatabase(dbName);
    const sql = postgres(scratchUrl(dbName), { max: 1 });
    try {
      await applyEverythingExcept152(sql);
      const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Zero SA Org', 'ZSA') returning id`;
      const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${org!.id}, 'S1', 'Store', true) returning id`;
      const [pos] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${org!.id}, null, 'Cashier', true, true) returning id`;
      const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Worker') returning id`;
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SC-Z1', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;
      // No super_admin at all in this org.

      await expect(apply152(sql)).rejects.toThrow(/exactly one active super_admin/);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });

  it('refuses with TWO active super_admins in the org, naming both', async () => {
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
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SC-T1', 'regular', '2026-01-01') returning id`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;

      await expect(apply152(sql)).rejects.toThrow(/Super One.*Super Two|Super Two.*Super One/s);
    } finally {
      await sql.end();
      await dropScratchDatabase(dbName);
    }
  });

  it('does NOT refuse for an org with no stores and no super_admin — it would receive zero rows either way', async () => {
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
      const [emp] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${org!.id}, ${store!.id}, ${person!.id}, 'SC-R1', 'regular', '2026-01-01') returning id`;
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
    const [cook] = await sql<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Cook', true, true) returning id`;
    cashierId = cashier!.id;
    cookId = cook!.id;

    // Single-position holder, open employment, active store.
    const [personSingle] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Single Position') returning id`;
    const [empSingle] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${activeStore!.id}, ${personSingle!.id}, 'SC-1', 'regular', '2026-01-01') returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empSingle!.id}, ${cashierId}, true)`;
    singlePersonId = personSingle!.id;

    // Multi-position holder — ruled 2026-09-14: union of both, is_primary decides nothing here.
    const [personMulti] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Multi Position') returning id`;
    const [empMulti] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${activeStore!.id}, ${personMulti!.id}, 'SC-2', 'regular', '2026-01-01') returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empMulti!.id}, ${cashierId}, true)`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empMulti!.id}, ${cookId}, false)`;
    multiPersonId = personMulti!.id;

    // Open employment at an INACTIVE store — Contract 4 must hold for them too.
    const [personInactive] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'At Inactive Store') returning id`;
    const [empInactive] = await sql<{ id: string }[]>`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${inactiveStore!.id}, ${personInactive!.id}, 'SC-3', 'regular', '2026-01-01') returning id`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${empInactive!.id}, ${cashierId}, true)`;
    inactiveStorePersonId = personInactive!.id;

    // A person with no employment at all — the invariant-5 red control.
    const [personFresh] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'No Employment') returning id`;
    freshPersonId = personFresh!.id;

    await apply152(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  });

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
    const beforeDefaults = (await sql<{ c: number }[]>`select count(*)::int as c from position_capability_defaults`)[0]!.c;
    const beforeGrants = (await sql<{ c: number }[]>`select count(*)::int as c from person_grants`)[0]!.c;

    const file = readdirSync(REAL_MIGRATIONS_FOLDER).find((f) => f.startsWith(TARGET_TAG_PREFIX));
    expect(file, '0152_*.sql not found in the real migrations folder').toBeDefined();
    const statements = readFileSync(join(REAL_MIGRATIONS_FOLDER, file!), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    await sql.begin(async (tx) => {
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
    });

    const afterDefaults = (await sql<{ c: number }[]>`select count(*)::int as c from position_capability_defaults`)[0]!.c;
    const afterGrants = (await sql<{ c: number }[]>`select count(*)::int as c from person_grants`)[0]!.c;
    expect(afterDefaults).toBe(beforeDefaults);
    expect(afterGrants).toBe(beforeGrants);
  });
});
