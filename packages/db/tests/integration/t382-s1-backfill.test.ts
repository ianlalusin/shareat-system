/**
 * T-382 S1 - B1, the R6a backfill of migration 0187. `docs/tasks/382-pos-store-unlink.md`, section S1 (REV-3).
 *
 * The backfill is read from the migration FILE, between its `-- B0187:begin` and `-- B0187:end` markers, and run
 * here as the migration role (the owner connection, which RLS cannot filter), inside a transaction that is ALWAYS
 * rolled back. The six people are seeded in one fresh org; the block is global, so every assertion is scoped to the
 * seeded person ids.
 *
 * ## State at HEAD
 * Red: `0187_t382_pos_store_unlink.sql` does not exist (ENOENT), so there is no block to run. Once it exists, each
 * mutant named in the spec turns one leg red (listed beside the leg).
 *
 * ## Why the person table is read through the owner connection
 * `person_grants` is FORCE ROW LEVEL SECURITY (0014:84). The seeding connection is superuser/BYPASSRLS, the same
 * property `doadmin` has in production; the RLS leg below runs the SAME block as the (non-bypass) app role.
 *
 * ## Where the spec is silent (a question to the builder, not a test edit)
 *  - The seed row for S ("one of them store-scoped") is a `grant_source = 'grant'` row with `store_id` set (the only
 *    shape `person_grants_store_shape_check` admits for a store-scoped hand-grant, 0165).
 *  - The loud RLS failure is asserted as SQLSTATE 42501 with Postgres's own wording ("row-level security"), which is
 *    what `SET LOCAL row_security = off` produces for a role RLS filters (the 0166 pattern).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
class Rollback extends Error {}

const FOUR = ['approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales'] as const;
const NEW_GRANT = 'unlink_store_from_pos';

const MIGRATION = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations', '0187_t382_pos_store_unlink.sql');

/** The B0187 block, exactly as the migration carries it (statement-breakpoint comments removed). */
function backfillBlock(): string {
  const text = readFileSync(MIGRATION, 'utf8');
  const begin = text.indexOf('-- B0187:begin');
  const end = text.indexOf('-- B0187:end');
  expect(begin, 'the migration carries a "-- B0187:begin" marker').toBeGreaterThanOrEqual(0);
  expect(end, 'the migration carries a "-- B0187:end" marker after it').toBeGreaterThan(begin);
  return text.slice(begin, end).replace(/-->\s*statement-breakpoint/g, '');
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Seeded {
  orgId: string;
  X: string; // admin + the four, all live
  Y: string; // admin + approve_item only
  Z: string; // admin + the four, one revoked
  V: string; // MANAGER (demoted) + the four
  S: string; // admin + the four, one of them store-scoped
  W: string; // admin + the four + an existing live unlink_store_from_pos
  all: string[];
}

/** Seeds the six people inside `t` (rolled back by the caller). */
async function seed(t: Tx): Promise<Seeded> {
  const code = uid('t382s1b');
  const [org] = await t<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await t<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Lipa') returning id`;
  const person = async (name: string, role: 'admin' | 'manager') => {
    const [p] = await t<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await t`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return p!.id;
  };
  const grant = (personId: string, name: string, opts: { revoked?: boolean; storeId?: string } = {}) =>
    opts.storeId
      ? t`insert into person_grants (person_id, grant_name, grant_source, store_id) values (${personId}, ${name}, 'grant', ${opts.storeId})`
      : opts.revoked
        ? t`insert into person_grants (person_id, grant_name, grant_source, revoked_at, revoke_reason) values (${personId}, ${name}, 'owner', now(), 'fixture')`
        : t`insert into person_grants (person_id, grant_name, grant_source) values (${personId}, ${name}, 'owner')`;

  const X = await person('X', 'admin');
  for (const g of FOUR) await grant(X, g);
  const Y = await person('Y', 'admin');
  await grant(Y, 'approve_item');
  const Z = await person('Z', 'admin');
  for (const g of FOUR) await grant(Z, g, { revoked: g === 'view_franchise_sales' });
  const V = await person('V', 'manager');
  for (const g of FOUR) await grant(V, g);
  const S = await person('S', 'admin');
  for (const g of FOUR) await grant(S, g, { storeId: g === 'cross_org_access' ? store!.id : undefined });
  const W = await person('W', 'admin');
  for (const g of FOUR) await grant(W, g);
  await grant(W, NEW_GRANT);
  return { orgId, X, Y, Z, V, S, W, all: [X, Y, Z, V, S, W] };
}

/** Live `unlink_store_from_pos` rows per person (store-level or not), for the seeded people. */
async function liveCounts(t: Tx, ids: string[]): Promise<Record<string, number>> {
  const rows = await t<{ person_id: string; n: number }[]>`
    select person_id, count(*)::int as n from person_grants
     where grant_name = ${NEW_GRANT} and revoked_at is null and person_id = any(${ids}) group by person_id`;
  return Object.fromEntries(rows.map((r) => [r.person_id, r.n]));
}

/** Runs `fn` in a transaction that is ALWAYS rolled back; rethrows anything `fn` throws. */
async function rolledBack(fn: (t: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (t) => {
      await fn(t);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

describe('B1 - the R6a backfill: one live grant per person who passes the second branch of holdsSuperAdminAuthority', () => {
  it('as the migration role: X, S and W end with exactly one live grant; Y, Z and V with none; a second run adds nothing', async () => {
    const block = backfillBlock();
    await rolledBack(async (t) => {
      const p = await seed(t);

      await t.unsafe(block);
      const after1 = await liveCounts(t, p.all);
      expect(after1, 'X (admin + the four) -> exactly one; S (one of the four store-scoped, counted as personHasActiveGrant counts) -> one; W (already held) -> still one').toMatchObject({ [p.X]: 1, [p.S]: 1, [p.W]: 1 });
      // Y: HAVING count = 4 dropped -> Y red.  Z: revoked_at IS NULL dropped -> Z red.  V: the admin-role EXISTS dropped -> V red.
      expect(after1[p.Y], 'Y holds approve_item only: no grant').toBeUndefined();
      expect(after1[p.Z], 'Z holds one of the four revoked: no grant').toBeUndefined();
      expect(after1[p.V], 'V is a manager (demoted) who still holds the four: no grant').toBeUndefined();

      // the shape of the row written: an org-wide, system-granted owner row
      const [row] = await t<{ grant_source: string | null; granted_by: string | null; store_id: string | null }[]>`
        select grant_source, granted_by, store_id from person_grants where person_id = ${p.X} and grant_name = ${NEW_GRANT} and revoked_at is null`;
      expect(row).toEqual({ grant_source: 'owner', granted_by: null, store_id: null });

      // the SET LOCAL row_security = on after the block: the exemption must not leak into whatever runs next
      const [rs] = await t<{ v: string }[]>`select current_setting('row_security') as v`;
      expect(rs!.v, 'row_security is back ON after the block').toBe('on');

      // idempotent: a second run inserts nothing at all (NOT EXISTS dropped -> the person-level unique index, 23505)
      const before = (await t<{ n: number }[]>`select count(*)::int as n from person_grants where grant_name = ${NEW_GRANT}`)[0]!.n;
      await t.unsafe(block);
      const afterN = (await t<{ n: number }[]>`select count(*)::int as n from person_grants where grant_name = ${NEW_GRANT}`)[0]!.n;
      expect(afterN, 'a second run inserts 0 rows').toBe(before);
      expect(await liveCounts(t, p.all)).toEqual(after1);
    });
  });

  it('as a role RLS filters, with no org: the block FAILS LOUDLY with the row-level-security error (never a silent zero)', async () => {
    const block = backfillBlock();
    let seedIds: Seeded | undefined;
    let caught: unknown = null;
    try {
      await sql.begin(async (t) => {
        seedIds = await seed(t); // as the owner
        await t.unsafe(`set local role ${APP_ROLE}`);
        await t`select set_config('app.principal_kind', 'staff', true)`;
        // app.org_id deliberately NOT set: RLS filters person_grants to zero rows for this role
        try {
          await t.unsafe(block);
        } catch (e) {
          caught = e;
        }
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    expect(seedIds, 'the fixture was seeded').toBeDefined();
    expect(caught, 'expected Postgres to refuse the block for a role RLS filters, but it ran silently (SET LOCAL row_security = off missing)').not.toBeNull();
    const err = caught as { code?: string; message?: string };
    expect(err.code).toBe('42501');
    expect(err.message ?? '').toMatch(/row-level security/i);
  });
});
