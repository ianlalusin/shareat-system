/**
 * T-349 / DEF-456 — S3, migration `0166_t349_def456_repair.sql`. Built by BUILDER (Ian answered Q1
 * yes, 2026-09-27; S3 Amendment A1 bounded it, 2026-09-28; see
 * `docs/tasks/349-def-456-store-scoped-hold-own-right.md` §3.5, §4 leg M6, and the Amendment A1
 * section for the date-bound/capability-scope conditions).
 *
 * ⛔ TESTER, not BUILDER. `0166` now exists and both M6 legs are GREEN: (1) the pre-state (0165
 * alone leaves every seeded row — R1/R2/control/S1-S4 — untouched); (2) the post-repair leg, which
 * applies 0166 and asserts the FULL repair: R1/R2 revoked with the DEF-456 reason and one active
 * `'grant'` row at A each, while the control and A1's four survival seeds (S1-S4) and store B stay
 * completely untouched. A third leg proves the migration's `row_security` wrapper: applied as the
 * restricted, RLS-filterable app role with `app.org_id` set to only ONE of two seeded orgs, 0166
 * must reject loudly rather than silently under-repairing the other org.
 *
 * Modelled on `t341-person-grants-store-migration.test.ts`'s own technique (scratch DB, a temp copy
 * of `migrations/` filtered by journal `when`, never a hardcoded slot number — the exact slot may
 * move if another lane's migration lands first this cycle).
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

interface JournalEntry {
  tag: string;
  when: number;
}
function journal(): JournalEntry[] {
  return (JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] })
    .entries;
}

/** The 0165 tag itself — this one DOES exist, and locates it the same substring-not-slot way. */
function find0165Tag(): string {
  const candidates = journal().filter((e) => e.tag.includes('t349_person_grants_store_grant'));
  expect(candidates.length, `expected 1 migration tagged t349_person_grants_store_grant, found ${candidates.length}`).toBe(1);
  return candidates[0]!.tag;
}

/** The 0166 tag — does not exist yet. Locating it is exactly the leg-1 red. */
function find0166Tag(): string {
  const candidates = journal().filter((e) => e.tag.includes('t349_def456_repair'));
  expect(candidates.length, `expected 1 migration tagged t349_def456_repair, found ${candidates.length}`).toBe(1);
  return candidates[0]!.tag;
}

/** The full, real migrations folder — once 0166 exists, this applies it too (t341's own `applyTarget`). */
async function applyEverything(sql: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

/**
 * Builds a migrations folder containing every entry with `when` UP TO AND INCLUDING the target's —
 * the "0165-only" cutoff. Unlike `t341`'s own `buildFolderWithoutTarget` (strictly `<`, used to
 * exclude a migration that DOES exist so its own effect can be measured), this is inclusive: 0165
 * itself must be applied, and everything after it (0166, whenever it lands) must not be, regardless
 * of what a concurrent BUILDER session may commit to the real folder while this suite runs.
 */
function buildFolderThroughTag(targetTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-through-0165-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const entries = journal();
  const target = entries.find((e) => e.tag === targetTag);
  if (!target) throw new Error(`journal entry for "${targetTag}" vanished between lookup and use`);
  const keptEntries = entries.filter((e) => e.when <= target.when);
  const keptTags = new Set(keptEntries.map((e) => e.tag));

  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -'.sql'.length))) {
      writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
    }
  }
  const journalCopy = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  journalCopy.entries = keptEntries;
  writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(journalCopy, null, 2));
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
async function applyThroughTag(sql: ReturnType<typeof postgres>, targetTag: string): Promise<void> {
  const dir = buildFolderThroughTag(targetTag);
  try {
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** `@shareat/db`'s `APP_ROLE` — an ordinary, FORCE-RLS-filterable role, deliberately never `doadmin`
 *  (the one role 0166's own header names as exempt). Not imported from `@shareat/db` to keep this
 *  file's only dependency on real Postgres, matching `t341`'s own no-drizzle-schema-import style. */
const APP_ROLE_FOR_RLS_TEST = 'shareat_app';

describe('T-349 / DEF-456 S3 — the data-repair migration 0166 (M6)', () => {
  const dbName = `shareat_scratch_t349s3_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;

  interface FixtureIds {
    orgId: string;
    storeA: string;
    storeB: string;
    adminId: string;
    r1Id: string;
    r1RowId: string;
    r2Id: string;
    r2RowId: string;
    controlId: string;
    controlRowId: string;
    // S3 Amendment A1 — the four survival seeds.
    s1Id: string;
    s1RowId: string;
    s2Id: string;
    s2ElevationRowId: string;
    s2GrantRowId: string;
    s3Id: string;
    s3RowId: string;
    s4Id: string;
    s4RowId: string;
  }
  const ids = {} as FixtureIds;

  beforeAll(async () => {
    const tag0165 = find0165Tag();
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyThroughTag(sql, tag0165);

    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('T349 S3 Org', 'T349S3') returning id`;
    const orgId = org!.id;
    ids.orgId = orgId;
    const [storeA] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'A', 'Store A', true) returning id`;
    const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'B', 'Store B', true) returning id`;
    ids.storeA = storeA!.id;
    ids.storeB = storeB!.id;
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    ids.adminId = admin!.id;

    // A real position + capability default, at store A — a 'position' row's source_ref must point
    // to one (person_grants_position_source_ref_check, 0146; the composite (source_ref, store_id)
    // FK, 0159 step 8).
    const [cashier] = await sql<{ id: string }[]>`
      insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Cashier', true, true) returning id`;
    const [defA] = await sql<{ id: string }[]>`
      insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by, set_at)
      values (${orgId}, ${cashier!.id}, ${storeA!.id}, 'record_sale', ${ids.adminId}, '2025-12-01T00:00:00Z')
      returning id`;
    const defAId = defA!.id;

    async function widenedGrant(personName: string, grantedAt: string) {
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${personName}) returning id`;
      const [row] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at)
        values (${p!.id}, 'record_sale', 'grant', null, null, ${ids.adminId}, ${grantedAt})
        returning id`;
      return { personId: p!.id, rowId: row!.id };
    }
    async function positionRowAt(personId: string, storeId: string, grantedAt: string, opts: { revokedAt?: string } = {}) {
      const [row] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at, revoked_at, revoke_reason)
        values (${personId}, 'record_sale', 'position', ${storeId}, ${defAId}, ${ids.adminId}, ${grantedAt},
                ${opts.revokedAt ?? null}, ${opts.revokedAt ? 'Revoked for T-349 S3 migration test fixture' : null})
        returning id`;
      return row!.id;
    }

    // R1 — widened: P at A active both at R1's granted_at AND still active now.
    const r1 = await widenedGrant('R1', '2026-01-10T00:00:00Z');
    ids.r1Id = r1.personId;
    ids.r1RowId = r1.rowId;
    await positionRowAt(r1.personId, ids.storeA, '2026-01-01T00:00:00Z');

    // R2 — widened: P at A active AT R2's granted_at, but revoked AFTER it (the revoked-since case).
    const r2 = await widenedGrant('R2', '2026-02-10T00:00:00Z');
    ids.r2Id = r2.personId;
    ids.r2RowId = r2.rowId;
    await positionRowAt(r2.personId, ids.storeA, '2026-02-01T00:00:00Z', { revokedAt: '2026-03-01T00:00:00Z' });

    // Control — NULL-store 'grant' with NO P active at its time (revoked before it was granted).
    const control = await widenedGrant('Control', '2026-04-10T00:00:00Z');
    ids.controlId = control.personId;
    ids.controlRowId = control.rowId;
    await positionRowAt(control.personId, ids.storeA, '2026-01-01T00:00:00Z', { revokedAt: '2026-04-01T00:00:00Z' });

    // =====================================================================================
    // S3 Amendment A1 — the four survival seeds. Each has a P at A active since 2026-01-01
    // and still active, so shape condition 1 (§3.5, unchanged) matches on its own; only the
    // NEW date-bound and capability-scope conditions (A1 items 2-3) must exclude them.
    // =====================================================================================

    // S1 — a post-S2b deliberate picker grant: shape-identical to a widened row, granted AFTER
    // the bound (2026-09-27T10:59:23Z).
    const s1 = await widenedGrant('S1-PickerGrant', '2026-09-28T00:00:00Z');
    ids.s1Id = s1.personId;
    ids.s1RowId = s1.rowId;
    await positionRowAt(s1.personId, ids.storeA, '2026-01-01T00:00:00Z');

    // S2 — an S2c replacement: a revoked 'elevation' NULL-store row (the thing S2c replaces),
    // plus an active NULL-store 'grant' row minted after the bound.
    const [s2Person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'S2-Replacement') returning id`;
    ids.s2Id = s2Person!.id;
    const [s2Elevation] = await sql<{ id: string }[]>`
      insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at, revoked_at, revoke_reason)
      values (${s2Person!.id}, 'record_sale', 'elevation', null, null, ${ids.adminId}, '2026-01-05T00:00:00Z',
              '2026-09-28T01:00:00Z', 'Replaced by a hand grant of the same capability.')
      returning id`;
    ids.s2ElevationRowId = s2Elevation!.id;
    const [s2Grant] = await sql<{ id: string }[]>`
      insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at)
      values (${s2Person!.id}, 'record_sale', 'grant', null, null, ${ids.adminId}, '2026-09-28T01:00:00Z')
      returning id`;
    ids.s2GrantRowId = s2Grant!.id;
    await positionRowAt(s2Person!.id, ids.storeA, '2026-01-01T00:00:00Z');

    // S3 — an org-scoped hold BEFORE the bound. manage_fixed_assets is CAPABILITY_SCOPE 'org'
    // (packages/auth/src/capabilities.ts) — condition 3 (A1 item 3) must exclude it regardless
    // of the date, since re-scoping an org-scoped capability to one store would be wrong.
    const [s3Person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'S3-OrgScoped') returning id`;
    ids.s3Id = s3Person!.id;
    const [defAOrgScoped] = await sql<{ id: string }[]>`
      insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by, set_at)
      values (${orgId}, ${cashier!.id}, ${storeA!.id}, 'manage_fixed_assets', ${ids.adminId}, '2025-12-01T00:00:00Z')
      returning id`;
    const [s3PositionRow] = await sql<{ id: string }[]>`
      insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at)
      values (${s3Person!.id}, 'manage_fixed_assets', 'position', ${storeA!.id}, ${defAOrgScoped!.id}, ${ids.adminId}, '2026-01-01T00:00:00Z')
      returning id`;
    void s3PositionRow;
    const [s3Grant] = await sql<{ id: string }[]>`
      insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at)
      values (${s3Person!.id}, 'manage_fixed_assets', 'grant', null, null, ${ids.adminId}, '2026-03-10T00:00:00Z')
      returning id`;
    ids.s3RowId = s3Grant!.id;

    // S4 — the bound edge itself: granted_at EXACTLY equal to the bound. The bound is a strict
    // `<`, so a row AT the bound must NOT be treated as pre-bound (must survive, same as S1).
    const s4 = await widenedGrant('S4-BoundEdge', '2026-09-27T10:59:23Z');
    ids.s4Id = s4.personId;
    ids.s4RowId = s4.rowId;
    await positionRowAt(s4.personId, ids.storeA, '2026-01-01T00:00:00Z');
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it(
    '⛔ green — M6 pre-state: against 0165 alone, R1/R2/control/S1-S4 are all still active exactly ' +
      'as seeded, and 0166 is locatable (it now exists — the second `it` below applies it and ' +
      'proves the actual repair)',
    async () => {
      // --- pre-state: nothing has repaired anything yet ---
      const [r1Row] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${ids.r1RowId}`;
      expect(r1Row!.revoked_at, '0165 alone does not touch R1 — it is still an active, widened row').toBeNull();

      const [r2Row] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${ids.r2RowId}`;
      expect(r2Row!.revoked_at, '0165 alone does not touch R2 either').toBeNull();

      const [controlRow] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${ids.controlRowId}`;
      expect(controlRow!.revoked_at, 'the control row is untouched by construction').toBeNull();

      // S3 Amendment A1 — the four survival seeds stay active pre-repair too (trivially true
      // before 0166 exists; the point is they are seeded correctly for the second `it` below).
      for (const [label, rowId] of [
        ['S1 (post-S2b picker grant)', ids.s1RowId],
        ['S2 (S2c replacement grant)', ids.s2GrantRowId],
        ['S3 (org-scoped hold)', ids.s3RowId],
        ['S4 (bound edge)', ids.s4RowId],
      ] as const) {
        const [row] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${rowId}`;
        expect(row!.revoked_at, `${label} must be seeded active`).toBeNull();
      }
      const [s2ElevationRow] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${ids.s2ElevationRowId}`;
      expect(s2ElevationRow!.revoked_at, 'S2\'s elevation row is seeded already-revoked (that is what makes it an S2c replacement)').not.toBeNull();

      const grantsAtA = await sql<{ id: string }[]>`
        select id from person_grants where store_id = ${ids.storeA} and grant_source = 'grant' and revoked_at is null`;
      expect(grantsAtA.length, 'no active grant row at A exists yet for anyone — nothing has been re-scoped').toBe(0);

      // --- locating 0166 (now green — it exists) ---
      const candidates = journal().filter((e) => e.tag.includes('t349_def456_repair'));
      expect(candidates.length, `expected 1 migration tagged t349_def456_repair, found ${candidates.length}`).toBe(1);
    },
    30_000,
  );

  it(
    '⛔ green — M6 post-repair: applies 0166 and asserts the FULL repaired state — R1/R2 revoked ' +
      'with the DEF-456 reason and each gets exactly one active grant row at A; the control, S1-S4 ' +
      'and store B are all untouched',
    async () => {
      const tag0166 = find0166Tag();
      await applyEverything(sql);

      // R1/R2 — revoked with the DEF-456 reason, one active grant row at A each.
      for (const [label, personId, rowId] of [
        ['R1', ids.r1Id, ids.r1RowId],
        ['R2', ids.r2Id, ids.r2RowId],
      ] as const) {
        const [row] = await sql<{ revoked_at: string | null; revoke_reason: string | null }[]>`
          select revoked_at, revoke_reason from person_grants where id = ${rowId}`;
        expect(row!.revoked_at, `${label} must be revoked after 0166`).not.toBeNull();
        expect(row!.revoke_reason, `${label}'s reason`).toMatch(/DEF-456/);
        const activeAtA = await sql<{ id: string }[]>`
          select id from person_grants where person_id = ${personId} and store_id = ${ids.storeA}
            and grant_source = 'grant' and revoked_at is null`;
        expect(activeAtA.length, `${label} must have exactly one active grant row at A`).toBe(1);
      }

      // Control — untouched.
      const [controlRow] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${ids.controlRowId}`;
      expect(controlRow!.revoked_at, 'the control row must still be untouched after 0166').toBeNull();

      // S1-S4 — none re-scoped, none revoked by 0166.
      for (const [label, personId, rowId] of [
        ['S1', ids.s1Id, ids.s1RowId],
        ['S2', ids.s2Id, ids.s2GrantRowId],
        ['S3', ids.s3Id, ids.s3RowId],
        ['S4', ids.s4Id, ids.s4RowId],
      ] as const) {
        const [row] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${rowId}`;
        expect(row!.revoked_at, `${label} must still be active after 0166 — it is a survival case`).toBeNull();
        const activeAtA = await sql<{ id: string }[]>`
          select id from person_grants where person_id = ${personId} and store_id = ${ids.storeA}
            and grant_source = 'grant' and revoked_at is null`;
        expect(activeAtA.length, `${label} must NOT gain an active grant row at A`).toBe(0);
      }
      const [s2ElevationRow] = await sql<{ revoked_at: string | null; revoke_reason: string | null }[]>`
        select revoked_at, revoke_reason from person_grants where id = ${ids.s2ElevationRowId}`;
      expect(s2ElevationRow!.revoked_at, 'S2\'s already-revoked elevation row must stay exactly as it was').not.toBeNull();
      expect(s2ElevationRow!.revoke_reason).toBe('Replaced by a hand grant of the same capability.');

      // No row at store B for anyone.
      const grantsAtB = await sql<{ id: string }[]>`select id from person_grants where store_id = ${ids.storeB}`;
      expect(grantsAtB.length, 'no row of any kind should exist at store B').toBe(0);

      void tag0166;
    },
    30_000,
  );

  it(
    '⛔ green — 0166\'s row_security wrapper: applied as `shareat_app` (an ordinary, FORCE-RLS-' +
      'filterable role — never `doadmin`) with app.org_id set to only ONE of two seeded orgs, 0166\'s ' +
      'own SQL body must reject loudly with Postgres\'s row-security error, not silently repair only ' +
      "the GUC's org and leave the other's matching row untouched with no error",
    async () => {
      // A second, independent org (this scratch DB's `ids.orgId` already has R1/R2 etc. from
      // beforeAll — already repaired by the previous `it`). A fresh widened row here, matching all
      // three S3 Amendment A1 conditions on its own.
      const [orgB] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('T349 S3 Org B', 'T349S3B') returning id`;
      const orgBId = orgB!.id;
      const [storeB2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgBId}, 'A', 'Store A', true) returning id`;
      const [adminB] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgBId}, 'Admin B') returning id`;
      const [cashierB] = await sql<{ id: string }[]>`
        insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgBId}, null, 'Cashier', true, true) returning id`;
      const [defB] = await sql<{ id: string }[]>`
        insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by, set_at)
        values (${orgBId}, ${cashierB!.id}, ${storeB2!.id}, 'record_sale', ${adminB!.id}, '2025-12-01T00:00:00Z')
        returning id`;
      const [personB] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgBId}, 'R-OrgB') returning id`;
      const [rB] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at)
        values (${personB!.id}, 'record_sale', 'grant', null, null, ${adminB!.id}, '2026-01-10T00:00:00Z')
        returning id`;
      await sql`
        insert into person_grants (person_id, grant_name, grant_source, store_id, source_ref, granted_by, granted_at)
        values (${personB!.id}, 'record_sale', 'position', ${storeB2!.id}, ${defB!.id}, ${adminB!.id}, '2026-01-01T00:00:00Z')`;

      // 0166's own SQL body, split on drizzle's statement-breakpoint marker — executed directly
      // (not through `migrate()`) so this leg tests exactly the mechanism the migration's own
      // header describes, independent of whether `shareat_app` even has grants on the migration
      // bookkeeping table.
      const migrationSql = readFileSync(join(REAL_MIGRATIONS_FOLDER, '0166_t349_def456_repair.sql'), 'utf8');
      const statements = migrationSql
        .split('--> statement-breakpoint')
        .map((s) => s.replace(/--.*$/gm, '').trim())
        .filter(Boolean);
      expect(statements.length, 'expected 0166 to have 4 statements (SET off, INSERT, UPDATE, SET on)').toBe(4);

      let caught: unknown;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE_FOR_RLS_TEST}`);
          await tx`select set_config('app.principal_kind', 'staff', true)`;
          await tx`select set_config('app.org_id', ${orgBId}, true)`;
          for (const statement of statements) {
            await tx.unsafe(statement);
          }
        });
      } catch (err) {
        caught = err;
      }

      expect(caught, 'expected 0166 to fail loudly under a filterable role, not silently under-repair').toBeInstanceOf(Error);
      const pgErr = caught as Error & { message: string };
      expect(pgErr.message).toMatch(/row-level security policy/i);

      // No row anywhere changed — the whole statement block ran inside one transaction that
      // failed, so it rolled back.
      const [rBRow] = await sql<{ revoked_at: string | null }[]>`select revoked_at from person_grants where id = ${rB!.id}`;
      expect(rBRow!.revoked_at, "org B's row must be untouched — the failed transaction rolled back").toBeNull();
      const grantsAtStoreB2 = await sql<{ id: string }[]>`
        select id from person_grants where store_id = ${storeB2!.id} and grant_source = 'grant'`;
      expect(grantsAtStoreB2.length, 'no store-scoped grant row should have been inserted for org B either').toBe(0);
    },
    30_000,
  );
});
