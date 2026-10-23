/**
 * T-341 / DEF-414 — `docs/tasks/341-def-414-person-grants-store.md` §5 (M1-M4) + Amendment R1
 * items 1/2 (upgraded-row twins; already-revoked §2.2 victims).
 *
 * Modelled on `position-access-backfill.test.ts` / `t339-attendance-revoke-reason-migration.test.ts`:
 * a temp copy of `migrations/` with the target AND everything after it removed (filtered by journal
 * `when`, never filename prefix), applied to a scratch database, fixtures seeded with raw SQL
 * against the PRE-T-341 shape (no `store_id` column, single row per person/capability), then the
 * real migrations folder applied on top.
 *
 * ⛔ Locates the migration by the SUBSTRING `t341` in its journal tag, not a hardcoded slot number
 * (orchestrator, 2026-09-25 — the exact slot may move if another lane's migration lands first this
 * cycle). Red before the file exists: `expected 1 migration tagged t341, found 0`.
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

function findTargetTag(): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const candidates = journal.entries.filter((e) => e.tag.includes('t341'));
  expect(candidates.length, `expected 1 migration tagged t341, found ${candidates.length}`).toBe(1);
  return candidates[0]!.tag;
}

function buildFolderWithoutTarget(targetTag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-t341-'));
  const metaDir = join(dir, 'meta');
  mkdirSync(metaDir, { recursive: true });

  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => e.tag === targetTag);
  if (!target) throw new Error(`journal entry for "${targetTag}" vanished between lookup and use`);
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
async function applyEverythingExceptTarget(sql: ReturnType<typeof postgres>, targetTag: string): Promise<void> {
  const dir = buildFolderWithoutTarget(targetTag);
  try {
    await migrate(drizzle(sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function applyTarget(sql: ReturnType<typeof postgres>): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

describe('T-341 / DEF-414 M1-M4 — the person_grants store backfill migration', () => {
  const dbName = `shareat_scratch_t341_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let targetTag: string;

  // Fixture ids, populated in beforeAll. A named interface, not `Record<string, string>` — this
  // repo runs `noUncheckedIndexedAccess`, which would make every `ids.x` read `string | undefined`
  // through an index signature; a fixed set of named properties reads as plain `string` instead.
  interface FixtureIds {
    orgId: string; storeA: string; storeB: string; adminId: string; cashierId: string;
    defA: string; defB: string;
    pId: string; pRowId: string;
    qId: string; qRowId: string;
    rId: string; rRowId: string;
    eId: string; eRowId: string;
    grantHistoryId: string; grantHistoryRowId: string;
    nullSourceId: string; nullSourceRowId: string;
    exNullId: string; exNullRowId: string;
    exElevationId: string; exElevationRowId: string;
    victimId: string; victimRevokedRowId: string;
    deliberateRevokeId: string; deliberateRevokeRowId: string;
  }
  const ids = {} as FixtureIds;

  beforeAll(async () => {
    targetTag = findTargetTag();
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    await applyEverythingExceptTarget(sql, targetTag);

    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('T341 Migration Org', 'T341MIG') returning id`;
    const orgId = org!.id;
    ids.orgId = orgId;
    const [storeA] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'A', 'Store A', true) returning id`;
    const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'B', 'Store B', true) returning id`;
    ids.storeA = storeA!.id;
    ids.storeB = storeB!.id;
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    ids.adminId = admin!.id;

    // One org-wide 'Cashier' position, used by every seeded person below by default. 'Kitchen Staff' exists
    // only so R (below) can hold a DIFFERENT position at B than the one the shared active default
    // is on — the fixture that proves step 5 checks WHICH position is held, not merely that some
    // open employment exists (builder's self-report, orchestrator CHANGES 2026-09-25).
    const [cashier] = await sql<{ id: string }[]>`
      insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Cashier', true, true) returning id`;
    ids.cashierId = cashier!.id;
    const [cook] = await sql<{ id: string }[]>`
      insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Kitchen Staff', true, true) returning id`;

    async function defaultAt(
      storeId: string,
      capability: string,
      opts: { revoked?: boolean; setAt?: string; positionId?: string } = {},
    ) {
      const [d] = await sql<{ id: string }[]>`
        insert into position_capability_defaults
          (org_id, position_id, store_id, capability, set_by, set_at, revoked_at, revoked_by, revoke_reason)
        values (${orgId}, ${opts.positionId ?? cashier!.id}, ${storeId}, ${capability},
                ${ids.adminId}, ${opts.setAt ?? new Date().toISOString()},
                ${opts.revoked ? new Date().toISOString() : null},
                ${opts.revoked ? ids.adminId : null},
                ${opts.revoked ? 'Revoked for T-341 migration test fixture' : null})
        returning id`;
      return d!.id;
    }
    // Every open/ended employment also links `employment_positions` (default Cashier) — step 5's
    // own wording is "holding a position with an active default", so a fixture with no position
    // link cannot exercise that half of the check at all.
    async function openEmployment(personId: string, storeId: string, positionId: string = cashier!.id) {
      const [emp] = await sql<{ id: string }[]>`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
      await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, 'employment')`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${positionId}, true)`;
    }
    async function endedEmployment(personId: string, storeId: string, positionId: string = cashier!.id) {
      const [emp] = await sql<{ id: string }[]>`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
        values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'resigned', '2025-01-01', '2025-06-01') returning id`;
      await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${storeId}, 'employment')`;
      await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${positionId}, true)`;
    }
    async function positionRow(
      personId: string,
      sourceRef: string,
      opts: { revoked?: boolean; grantedAt?: string; grantName?: string } = {},
    ) {
      const [g] = await sql<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by, granted_at, revoked_at, revoke_reason)
        values (${personId}, ${opts.grantName ?? 'record_sale'}, 'position', ${sourceRef}, ${ids.adminId},
                ${opts.grantedAt ?? new Date().toISOString()},
                ${opts.revoked ? new Date().toISOString() : null},
                ${opts.revoked ? 'Revoked for T-341 migration test fixture' : null})
        returning id`;
      return g!.id;
    }

    const defA = await defaultAt(ids.storeA, 'record_sale');
    const defB = await defaultAt(ids.storeB, 'record_sale');
    ids.defA = defA;
    ids.defB = defB;

    // P — open Cashier at A and B, record_sale defaulted (active) at both, ONE active row ref A.
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'P') returning id`;
    ids.pId = p!.id;
    await openEmployment(p!.id, ids.storeA);
    await openEmployment(p!.id, ids.storeB);
    ids.pRowId = await positionRow(p!.id, defA);

    // Q — Cashier at B only, manual scope at A (the pre-DEF-414 leak vector), one row ref B.
    const [q] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Q') returning id`;
    ids.qId = q!.id;
    await openEmployment(q!.id, ids.storeB);
    await sql`insert into person_store_scope (person_id, store_id, source) values (${q!.id}, ${ids.storeA}, 'manual')`;
    ids.qRowId = await positionRow(q!.id, defB);

    // R — Cashier at A (gets an A row, like P); at B holds COOK, not Cashier, and Cook's own
    // record_sale default at B is genuinely revoked. Cashier's record_sale default at B (defB)
    // stays ACTIVE throughout, shared with P/Q — a migration that materialises on "open
    // employment + SOME active default for this store/capability" without checking WHICH
    // position the person holds would wrongly grab defB for R. No B row must be materialised
    // either way (orchestrator CHANGES 2026-09-25 — R previously revoked an unrelated
    // 'adjust_inventory' default, leaving defB active and making R behaviourally identical to P).
    const [r] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'R') returning id`;
    ids.rId = r!.id;
    await openEmployment(r!.id, ids.storeA);
    await openEmployment(r!.id, ids.storeB, cook!.id);
    await defaultAt(ids.storeB, 'record_sale', { revoked: true, positionId: cook!.id });
    ids.rRowId = await positionRow(r!.id, defA);

    // E — Cashier at A (open) and B (ENDED) — no B row must be materialised.
    const [e] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'E') returning id`;
    ids.eId = e!.id;
    await openEmployment(e!.id, ids.storeA);
    await endedEmployment(e!.id, ids.storeB);
    ids.eRowId = await positionRow(e!.id, defA);

    // One 'grant' row with a HISTORY source_ref (a hand-grant that once upgraded a position row —
    // T-289 §C3/§C5 transition 1 shape) — must end up store_id NULL, never pinned to defA's store.
    const [g1] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'GrantHistory') returning id`;
    ids.grantHistoryId = g1!.id;
    await openEmployment(g1!.id, ids.storeA);
    const [historyRow] = await sql<{ id: string }[]>`
      insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
      values (${g1!.id}, 'adjust_inventory', 'grant', ${defA}, ${ids.adminId}) returning id`;
    ids.grantHistoryRowId = historyRow!.id;

    // One null-source row (an ordinary hand-grant, never touched a position) — store_id NULL.
    const [g2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'NullSource') returning id`;
    ids.nullSourceId = g2!.id;
    const [nullRow] = await sql<{ id: string }[]>`
      insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
      values (${g2!.id}, 'manage_items', 'grant', null, ${ids.adminId}) returning id`;
    ids.nullSourceRowId = nullRow!.id;

    // Amendment R1 item 1 — an "ex-NULL" row: grant_source is 'position' but granted BEFORE the
    // default's own set_at (the tell that an old reconcile REWROTE a pre-0140 NULL-source row
    // in place, rather than this row ever having been created by today's position machinery).
    const [exNull] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'ExNull') returning id`;
    ids.exNullId = exNull!.id;
    await openEmployment(exNull!.id, ids.storeA);
    const lateDefA = await defaultAt(ids.storeA, 'void_expense', { setAt: '2026-06-01T00:00:00Z' });
    ids.exNullRowId = await positionRow(exNull!.id, lateDefA, { grantedAt: '2026-01-01T00:00:00Z', grantName: 'void_expense' });

    // Amendment R1 item 1 (twin #2) — an "ex-elevation" row: same upgraded-row tell
    // (`granted_at` predates the default's `set_at`), but for 'manage_users' — admin:true,
    // manager:false, the same capability case 12 grants via the real auto-elevation fallback —
    // on a person who holds NO admin role in this org (no `person_roles` row at all) and has
    // open employment at BOTH stores, so "both stores still resolve" has two stores to check.
    // This is the shape that must infer the pre-upgrade source as 'elevation', not NULL.
    const [exElevation] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'ExElevation') returning id`;
    ids.exElevationId = exElevation!.id;
    await openEmployment(exElevation!.id, ids.storeA);
    await openEmployment(exElevation!.id, ids.storeB);
    const lateDefManageUsers = await defaultAt(ids.storeA, 'manage_users', { setAt: '2026-06-01T00:00:00Z' });
    ids.exElevationRowId = await positionRow(exElevation!.id, lateDefManageUsers, {
      grantedAt: '2026-01-01T00:00:00Z',
      grantName: 'manage_users',
    });

    // Amendment R3 (supersedes R1 item 2 / R2 item 2) — the REAL §2.2 victim shape: their A
    // employment has ENDED (that's how the A row came to be revoked — T-289's own reconcile-on-
    // endEmployment, not a deliberate admin act), and they're ALSO wanted at B (open employment,
    // active default) with no active row there. R3's ruling: this must NOT be materialised — they
    // lack B access today, so leaving them alone loses nothing; they go into the §8 cutover count.
    const [victim] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Victim22') returning id`;
    ids.victimId = victim!.id;
    await endedEmployment(victim!.id, ids.storeA);
    await openEmployment(victim!.id, ids.storeB);
    ids.victimRevokedRowId = await positionRow(victim!.id, defA, { revoked: true });

    // Amendment R3 item 2 — the deliberate-revocation case: open Cashier at A AND B, both defaults
    // ACTIVE, but an admin deliberately revoked the A row (not an ended employment, not a toggled-
    // off default — the person is still fully wanted at A). Materialising a B row here would be a
    // genuine WIDENING (step 5 must never treat a revoked row as evidence of anything). Expect RED
    // against the current 0159, per the orchestrator.
    const [deliberate] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'DeliberateRevoke') returning id`;
    ids.deliberateRevokeId = deliberate!.id;
    await openEmployment(deliberate!.id, ids.storeA);
    await openEmployment(deliberate!.id, ids.storeB);
    ids.deliberateRevokeRowId = await positionRow(deliberate!.id, defA, { revoked: true });
  });

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  it('M1 — P\'s original row gets store_id=A (same id); a new active B row exists with the same granted_by', async () => {
    await applyTarget(sql);

    const [original] = await sql<{ store_id: string; granted_by: string }[]>`
      select store_id, granted_by from person_grants where id = ${ids.pRowId}`;
    expect(original!.store_id).toBe(ids.storeA);

    const rows = await sql<{ id: string; store_id: string; granted_by: string }[]>`
      select id, store_id, granted_by from person_grants
      where person_id = ${ids.pId} and grant_name = 'record_sale' and revoked_at is null`;
    expect(rows.length).toBe(2);
    const bRow = rows.find((r) => r.store_id === ids.storeB);
    expect(bRow, 'a new active B row must exist').toBeDefined();
    expect(bRow!.granted_by).toBe(original!.granted_by);
  });

  it('M2 — Q has no A row; R has no B row; E has no B row (nothing materialised beyond what is justified)', async () => {
    const q = await sql<{ store_id: string }[]>`
      select store_id from person_grants where person_id = ${ids.qId} and grant_name = 'record_sale' and revoked_at is null`;
    expect(q.some((r) => r.store_id === ids.storeA), 'Q — leak not materialised at A').toBe(false);

    const r = await sql<{ store_id: string }[]>`
      select store_id from person_grants where person_id = ${ids.rId} and grant_name = 'record_sale' and revoked_at is null`;
    expect(
      r.some((row) => row.store_id === ids.storeB),
      "R — holds Cook (not Cashier) at B; Cashier's own active record_sale default there (defB) must not be wrongly materialised via a position R does not hold",
    ).toBe(false);

    const e = await sql<{ store_id: string }[]>`
      select store_id from person_grants where person_id = ${ids.eId} and grant_name = 'record_sale' and revoked_at is null`;
    expect(e.some((row) => row.store_id === ids.storeB), 'E — B employment ended, no B row').toBe(false);
  });

  it('M3 — the grant-history row and the null-source row both have store_id NULL', async () => {
    const [h] = await sql<{ store_id: string | null }[]>`select store_id from person_grants where id = ${ids.grantHistoryRowId}`;
    expect(h!.store_id).toBeNull();
    const [n] = await sql<{ store_id: string | null }[]>`select store_id from person_grants where id = ${ids.nullSourceRowId}`;
    expect(n!.store_id).toBeNull();
  });

  it('Amendment R1 item 1 — the ex-NULL row gets a person-level twin (store_id NULL); both stores still resolve access-wise (row existence)', async () => {
    const rows = await sql<{ store_id: string | null; grant_source: string | null }[]>`
      select store_id, grant_source from person_grants where person_id = ${ids.exNullId} and grant_name = 'void_expense' and revoked_at is null`;
    expect(rows.length, 'the original (now store-pinned) row plus a person-level twin').toBe(2);
    expect(rows.some((r) => r.store_id === null), 'a person-level twin (store_id null) preserves pre-upgrade access').toBe(true);
    expect(rows.some((r) => r.store_id === ids.storeA), 'the original row is pinned to A').toBe(true);
  });

  it("Amendment R1 item 1 (twin #2) — the ex-elevation row's twin carries grant_source='elevation'; both stores still resolve (row existence)", async () => {
    const rows = await sql<{ store_id: string | null; grant_source: string | null }[]>`
      select store_id, grant_source from person_grants where person_id = ${ids.exElevationId} and grant_name = 'manage_users' and revoked_at is null`;
    expect(rows.length, 'the original (now store-pinned) row plus a person-level elevation twin').toBe(2);
    const twin = rows.find((r) => r.store_id === null);
    expect(twin, 'a person-level twin (store_id null) preserves pre-upgrade access').toBeDefined();
    expect(
      twin!.grant_source,
      "the twin carries the ORIGINAL pre-upgrade source — 'elevation', not NULL — because this person holds no admin role and manage_users is elevation-eligible",
    ).toBe('elevation');
    expect(rows.some((r) => r.store_id === ids.storeA), 'the original row is pinned to A').toBe(true);

    // "Both stores still resolve" (row existence): the twin is store_id NULL, which
    // `personHasActiveGrant`'s `store_id IS NULL OR store_id = atStoreId` matches at ANY store
    // the person has scope at — and this person has open employment (hence store scope) at both.
    const scopes = await sql<{ store_id: string }[]>`
      select store_id from person_store_scope where person_id = ${ids.exElevationId}`;
    expect(scopes.map((s) => s.store_id).sort()).toEqual([ids.storeA, ids.storeB].sort());
  });

  it('Amendment R3 — the already-hit §2.2 victim (ended A employment) gets NO B row materialised', async () => {
    const rows = await sql<{ store_id: string | null; revoked_at: string | null }[]>`
      select store_id, revoked_at from person_grants where person_id = ${ids.victimId} and grant_name = 'record_sale'`;
    const activeB = rows.find((r) => r.store_id === ids.storeB && r.revoked_at === null);
    expect(
      activeB,
      'R3: a revoked row is never evidence — this person is wanted at B today with no active row, which is the §8 cutover shape, not something step 5 may materialise',
    ).toBeUndefined();
  });

  it('Amendment R3 item 2 — a DELIBERATE admin revocation at A gets NO B row materialised either (still open, still wanted at A)', async () => {
    const rows = await sql<{ store_id: string | null; revoked_at: string | null }[]>`
      select store_id, revoked_at from person_grants where person_id = ${ids.deliberateRevokeId} and grant_name = 'record_sale'`;
    const activeB = rows.find((r) => r.store_id === ids.storeB && r.revoked_at === null);
    expect(
      activeB,
      'a revoked row is never evidence, even when the person is still fully wanted at A — materialising B here would be a genuine widening',
    ).toBeUndefined();
  });

  /** Amendment R2 item 4 — every M4 raw insert runs as the APP role with the org set (never only as
   *  superuser), so the fill trigger is exercised under the SAME RLS the app itself runs under. */
  async function asApp<T>(orgId: string | null, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js's TransactionSql
    // generic does not structurally match plain Sql in every overload; a test-only helper, not the
    // production client, so a loose cast here is the pragmatic trade, not a real type hole.
    return sql.begin(async (tx: any) => {
      await tx`set local role shareat_app`;
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      if (orgId) await tx`select set_config('app.org_id', ${orgId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  it('M4 — the fill trigger, the shape CHECK, and the partial uniques all enforce going forward (as the app role)', async () => {
    const fresh = await asApp(ids.orgId, async (tx) => {
      const [p] = await tx<{ id: string }[]>`insert into persons (org_id, display_name) values (${ids.orgId}, 'M4 Fresh') returning id`;
      return p!.id;
    });

    // Raw position insert without a store — the fill trigger derives it from the default.
    const filled = await asApp(ids.orgId, async (tx) => {
      const [row] = await tx<{ id: string; store_id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
        values (${fresh}, 'record_sale', 'position', ${ids.defA}, ${ids.adminId})
        returning id, store_id`;
      return row!;
    });
    expect(filled.store_id, 'the fill trigger derives store_id from the default').toBe(ids.storeA);

    // Mismatched store -> 23503 (composite FK).
    await expect(
      asApp(ids.orgId, (tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
           values (${fresh}, 'record_wastage', 'position', ${ids.defA}, ${ids.storeB}, ${ids.adminId})`,
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // T-349 S1 (DEF-456) ruled edit, orchestrator 2026-09-27: 0165 widens the shape CHECK so
    // 'grant' MAY carry a store (a T-349 "hold in their own right" at that store) — this row now
    // succeeds instead of throwing, and is covered by T-349's own M1. 'elevation' with a store is
    // the sibling case the CHECK still refuses.
    await expect(
      asApp(ids.orgId, (tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
           values (${fresh}, 'manage_items', 'elevation', null, ${ids.storeA}, ${ids.adminId})`,
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Second active position row, same (person, cap, store) -> 23505 (partial unique).
    await expect(
      asApp(ids.orgId, (tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
           values (${fresh}, 'record_sale', 'position', ${ids.defA}, ${ids.adminId})`,
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Same (person, cap), OTHER store -> succeeds.
    const otherStoreId = await asApp(ids.orgId, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
        values (${fresh}, 'record_sale', 'position', ${ids.defB}, ${ids.adminId})
        returning id`;
      return row!.id;
    });
    expect(otherStoreId).toBeDefined();

    // Second active person-level row (grant, store_id null) -> 23505.
    await asApp(ids.orgId, (tx) =>
      tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
         values (${fresh}, 'manage_items', 'grant', null, ${ids.adminId})`,
    );
    await expect(
      asApp(ids.orgId, (tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
           values (${fresh}, 'manage_items', 'grant', null, ${ids.adminId})`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('Amendment R2 item 4 — with no org set, the fill trigger raises its own named error rather than leaving a NULL', async () => {
    const fresh = await asApp(ids.orgId, async (tx) => {
      const [p] = await tx<{ id: string }[]>`insert into persons (org_id, display_name) values (${ids.orgId}, 'M4 NoOrg') returning id`;
      return p!.id;
    });
    // No `app.org_id` set in THIS transaction — RLS hides the default from the fill trigger's own
    // read, and it must raise its own named error, never silently leave store_id NULL for the CHECK.
    await expect(
      asApp(null, (tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
           values (${fresh}, 'record_sale', 'position', ${ids.defA}, ${ids.adminId})`,
      ),
    ).rejects.toThrow(/no visible default for source_ref/);
  });
});
