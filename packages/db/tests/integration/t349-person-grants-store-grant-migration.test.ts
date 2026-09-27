/**
 * T-349 / DEF-456 — `docs/tasks/349-def-456-store-scoped-hold-own-right.md` §4 (M1-M5). S1 only:
 * M6 (the S3 data-repair migration) is a separate slice and a separate file
 * (`t349-s3-def456-repair-migration.test.ts`, not written here).
 *
 * Modelled on `t341-person-grants-store-migration.test.ts`: a scratch database, the REAL migrations
 * folder applied in full (`drizzle-orm/postgres-js/migrator`'s `migrate()`), fixtures seeded with
 * raw SQL, mutations run as the APP role (`asApp`) so both RLS and every trigger/CHECK/index fire
 * exactly as production would.
 *
 * Post-commit review (orchestrator, 2026-09-27): migration `0165_t349_person_grants_store_grant.sql`
 * has landed (`3d601ab`) and every leg below now runs against the SHIPPED shape — the widened
 * `person_grants_store_shape_check` (re-added under the same name) and the split
 * `person_grants_active_position_store_unique` / `person_grants_active_grant_store_unique` indexes
 * (`packages/db/schema/access.ts`). No leg here "locates" a migration file — the full real folder is
 * applied to a scratch database each run, so this file needed no edit when 0165 landed and needs
 * none for any later migration either.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { config } from 'dotenv';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(`Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
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

describe('T-349 / DEF-456 S1 M1-M5 — the person_grants store-scoped grant shape', () => {
  const dbName = `shareat_scratch_t349_${Date.now()}`;
  let sql: ReturnType<typeof postgres>;
  let orgId: string;
  let storeA: string;
  let storeB: string;
  let adminId: string;
  let defAId: string; // a position_capability_defaults row at storeA, for 'position'-sourced rows

  beforeAll(async () => {
    await createScratchDatabase(dbName);
    sql = postgres(scratchUrl(dbName), { max: 1 });
    // Full current folder — 0165 does not exist yet, so this applies everything up to and
    // including whatever is on disk today. No target-exclusion step (unlike t341's harness):
    // there is nothing yet to exclude.
    await migrate(drizzle(sql), { migrationsFolder: REAL_MIGRATIONS_FOLDER });

    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('T349 Migration Org', 'T349MIG') returning id`;
    orgId = org!.id;
    const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'A', 'Store A', true) returning id`;
    const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, 'B', 'Store B', true) returning id`;
    storeA = a!.id;
    storeB = b!.id;
    const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
    adminId = admin!.id;
    const [cashier] = await sql<{ id: string }[]>`
      insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Cashier', true, true) returning id`;
    const [defA] = await sql<{ id: string }[]>`
      insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by, set_at)
      values (${orgId}, ${cashier!.id}, ${storeA}, 'confirm_receipt', ${adminId}, now()) returning id`;
    defAId = defA!.id;
  });

  afterAll(async () => {
    await sql?.end();
    await dropScratchDatabase(dbName);
  }, 120_000);

  /** Every insert runs as the APP role with the org set — the same RLS/trigger/CHECK context
   *  production writes under (t341's own `asApp`, Amendment R2 item 4's reasoning). */
  async function asApp<T>(fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js's TransactionSql
    // generic does not structurally match plain Sql in every overload; test-only.
    return sql.begin(async (tx: any) => {
      await tx`set local role shareat_app`;
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  async function newPerson(name: string): Promise<string> {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    return p!.id;
  }

  it(
    'M1 — a \'grant\' row at store A, source_ref NULL, succeeds and reads back with store A',
    async () => {
      const personId = await newPerson(uid('M1'));
      const row = await asApp((tx) =>
        tx<{ id: string; store_id: string | null }[]>`
          insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
          values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})
          returning id, store_id`,
      );
      expect(row[0]!.store_id, "0165's widened shape CHECK admits 'grant'+store; the row reads back with the store it was given").toBe(storeA);
    },
    30000,
  );

  it(
    "M2 — 'elevation'+store and 'owner'+store are refused by the widened shape check; the source_ref check (pre-existing, untouched by 0165) still refuses a store-less 'position' row; the NULL-blind hole is closed",
    async () => {
      const elevationPerson = await newPerson(uid('M2-elevation'));
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${elevationPerson}, 'confirm_receipt', 'elevation', null, ${storeA}, ${adminId})`,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'person_grants_store_shape_check' });

      const ownerPerson = await newPerson(uid('M2-owner'));
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${ownerPerson}, 'confirm_receipt', 'owner', null, ${storeA}, ${adminId})`,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'person_grants_store_shape_check' });

      // Re-aimed (post-commit review): a 'position' row with no source_ref was always refused by
      // `person_grants_position_source_ref_check` (migration 0146, T-289) — a constraint 0165 does
      // not touch. This leg no longer proves anything about T-349; it is a baseline confirmation
      // that 0165's widened shape check did not accidentally loosen an unrelated one. Confirmed by
      // running it: the source_ref check fires, not the fill trigger (there is no source_ref to
      // derive a store FROM, so the trigger's own "no visible default" path is never reached either
      // — the source_ref check rejects the row before the trigger would run).
      const positionPerson = await newPerson(uid('M2-position'));
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${positionPerson}, 'confirm_receipt', 'position', null, null, ${adminId})`,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'person_grants_position_source_ref_check' });

      // The documented NULL-blind hole (§2): before 0165, `grant_source IS NULL` made the old
      // CHECK's expression evaluate to NULL (neither branch TRUE nor FALSE) and Postgres accepted a
      // NULL CHECK result — a NULL-source row could carry a store. 0165's `IS NOT DISTINCT FROM`
      // rewrite closes it: a NULL source now falls into the "never a store" branch explicitly.
      const nullSourcePerson = await newPerson(uid('M2-nullsource'));
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${nullSourcePerson}, 'confirm_receipt', null, null, ${storeA}, ${adminId})`,
        ),
      ).rejects.toMatchObject({ code: '23514', constraint_name: 'person_grants_store_shape_check' });
    },
    30000,
  );

  it(
    'M3 — an active \'position\' row at A and an active \'grant\' row at A, same person/cap, coexist',
    async () => {
      const personId = await newPerson(uid('M3'));
      await asApp((tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
           values (${personId}, 'confirm_receipt', 'position', ${defAId}, ${storeA}, ${adminId})`,
      );
      // 0165's widened shape check admits the 'grant'+store insert, and the per-store unique index
      // is split by source (`person_grants_active_position_store_unique` /
      // `..._active_grant_store_unique`), so this 'grant' row does not collide with the 'position'
      // row already at the same (person, cap, store).
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})`,
        ),
        "the 'grant' row must be able to coexist with the 'position' row at the same (person, cap, store)",
      ).resolves.toBeDefined();

      const rows = await sql<{ grant_source: string | null; store_id: string | null }[]>`
        select grant_source, store_id from person_grants
        where person_id = ${personId} and grant_name = 'confirm_receipt' and revoked_at is null`;
      expect(rows.some((r) => r.grant_source === 'position' && r.store_id === storeA)).toBe(true);
      expect(rows.some((r) => r.grant_source === 'grant' && r.store_id === storeA)).toBe(true);
    },
    30000,
  );

  it(
    'M4 — a second active \'grant\' row at A is refused (person_grants_active_grant_store_unique — 23505)',
    async () => {
      const personId = await newPerson(uid('M4'));
      // The seed insert now succeeds outright (0165 admits 'grant'+store) — no try/catch swallow;
      // if it throws, the test fails loudly here rather than silently letting a real regression
      // through to the (then-meaningless) second insert.
      await asApp((tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
           values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})`,
      );
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})`,
        ),
        "a second active 'grant' at the same (person, cap, store) must be refused by its own partial unique index",
      ).rejects.toMatchObject({ code: '23505', constraint_name: 'person_grants_active_grant_store_unique' });
    },
    30000,
  );

  it(
    "M5 — a 'grant' at A and a NULL-store 'grant', same person/cap, occupy separate slots and both exist",
    async () => {
      const personId = await newPerson(uid('M5'));
      await asApp((tx) =>
        tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, granted_by)
           values (${personId}, 'confirm_receipt', 'grant', null, ${adminId})`,
      );
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})`,
        ),
        'the store-carrying slot and the person-level (NULL-store) slot are separate — this grant must not collide with the existing NULL-store one',
      ).resolves.toBeDefined();

      const rows = await sql<{ store_id: string | null }[]>`
        select store_id from person_grants
        where person_id = ${personId} and grant_name = 'confirm_receipt' and revoked_at is null`;
      expect(rows.some((r) => r.store_id === null)).toBe(true);
      expect(rows.some((r) => r.store_id === storeA)).toBe(true);
    },
    30000,
  );
});
