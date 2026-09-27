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
 * ⛔ TESTER, not BUILDER. Migration `0165_t349_person_grants_store_grant.sql` does not exist yet —
 * every leg here runs against the CURRENT (pre-0165) `person_grants_store_shape_check` and the
 * CURRENT single `person_grants_active_position_store_unique` index (`packages/db/schema/
 * access.ts:221-223,255-259`, read at `1e98cd0`). No leg here "locates" a migration file — M1-M5 are
 * all behavioural: they assert what 0165 ships, and are expected red against TODAY's schema for the
 * stated reason. Once 0165 lands, this file is unchanged; the SAME `migrate()` call against the
 * SAME real folder simply includes it, and every leg flips to its `+`/`⛔` outcome.
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
      expect(row[0]!.store_id, 'today: the old shape CHECK (23514) refuses this insert outright').toBe(storeA);
    },
    30000,
  );

  it(
    "M2 — 'elevation'+store and 'owner'+store are refused (23514); 'position' with no store and no ref is refused (record which error); NULL source+store is the documented hole",
    async () => {
      const elevationPerson = await newPerson(uid('M2-elevation'));
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${elevationPerson}, 'confirm_receipt', 'elevation', null, ${storeA}, ${adminId})`,
        ),
      ).rejects.toMatchObject({ code: '23514' });

      const ownerPerson = await newPerson(uid('M2-owner'));
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${ownerPerson}, 'confirm_receipt', 'owner', null, ${storeA}, ${adminId})`,
        ),
      ).rejects.toMatchObject({ code: '23514' });

      // Record which error: the shape CHECK (23514) or the fill trigger's own named error (raised
      // BEFORE the CHECK on a 'position' row with no source_ref to derive a store from).
      const positionPerson = await newPerson(uid('M2-position'));
      let positionError: unknown;
      try {
        await asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${positionPerson}, 'confirm_receipt', 'position', null, null, ${adminId})`,
        );
      } catch (e) {
        positionError = e;
      }
      expect(positionError, "'position' with no store and no ref must be refused, by SOME mechanism").toBeDefined();
      const code = (positionError as { code?: string } | undefined)?.code;
      const message = positionError instanceof Error ? positionError.message : String(positionError);
      // eslint-disable-next-line no-console -- the spec explicitly asks the tester to RECORD which.
      console.log(`[T-349 M2] 'position' with no store/no ref → code=${code ?? '(none)'} message=${message}`);
      expect(
        code === '23514' || /no visible default for source_ref/.test(message),
        `expected either the shape CHECK (23514) or the fill trigger's own named error; got code=${code}, message=${message}`,
      ).toBe(true);

      // The documented hole: NULL grant_source + a store makes the CHECK's own expression
      // evaluate to NULL (neither branch is TRUE nor FALSE), and Postgres accepts a NULL CHECK
      // result. This assertion states the DESIRED (post-0165) behaviour — it is expected to fail
      // today because the insert actually SUCCEEDS. That resolution, not a rejection, IS today's
      // red for M2's fourth leg.
      const nullSourcePerson = await newPerson(uid('M2-nullsource'));
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${nullSourcePerson}, 'confirm_receipt', null, null, ${storeA}, ${adminId})`,
        ),
        'today: a NULL grant_source + a store SUCCEEDS (the NULL-blind hole §2/§3.1 step 1 closes) — the promise resolves instead of rejecting',
      ).rejects.toMatchObject({ code: '23514' });
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
      // Today: the old shape CHECK fires on the 'grant'+store insert itself, before the (not yet
      // split) per-store unique index would ever get a chance to.
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})`,
        ),
        'today: the old shape CHECK (23514) refuses the grant+store insert before both rows could ever coexist',
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
      // Seed the first, expected to succeed once 0165 lands — but expected to fail against today's
      // CHECK. Wrap in a try/catch so the SECOND (the actual leg under test) still runs regardless.
      try {
        await asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})`,
        );
      } catch {
        // expected today — see M1
      }
      await expect(
        asApp((tx) =>
          tx`insert into person_grants (person_id, grant_name, grant_source, source_ref, store_id, granted_by)
             values (${personId}, 'confirm_receipt', 'grant', null, ${storeA}, ${adminId})`,
        ),
        'today: 23514 (the old shape CHECK), not 23505 (the not-yet-split per-store unique index) — wrong reason, recorded',
      ).rejects.toMatchObject({ code: '23505' });
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
        'today: the old shape CHECK (23514) refuses the store-carrying grant before both slots could ever be proven separate',
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
