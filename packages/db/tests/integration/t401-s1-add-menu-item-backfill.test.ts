/**
 * T-401 S1 (cleanup) - the OWNER BACKFILL for `add_menu_item`, the seventh super-admin-only capability
 * (docs/tasks/401-erp-menu-catalog-master.md section 3, capabilities: "add_menu_item ... super admin only").
 * Same shape as T-385 S3's `t385-s3-backfill.test.ts` for 0188 and T-382's for 0187: SUPER_ADMIN_ONLY_CAPABILITIES is
 * materialised as `person_grants` once, at createFirstAdmin, so an organisation created before today holds six and
 * would silently lose "super admin may add an item" the day the capability lands. Every existing OWNER (an admin who
 * holds all SIX current super-admin-only grants) must be granted the seventh.
 *
 * The block is read from the migration FILE between `-- B0196:begin` and `-- B0196:end` markers and run as the
 * migration role inside a transaction that is ALWAYS rolled back. Six people are seeded in one fresh org; the block
 * is global, so every assertion is scoped to the seeded person ids.
 *
 * ## State at HEAD
 * Red: migration 0196 carries no B0196 markers (the backfill is not written), so there is no block to run.
 *
 * ## Where the spec is silent (a question to the builder, not a test edit)
 *  - The marker name `B0196` follows B0187/B0188. If the backfill lives in another migration file, only MIGRATION below changes.
 *  - "Owner" = ACTIVE admin role + live grants of all six current ones, exactly as 0188 read "all five".
 *  - No other super-only menu capability exists (the seven new ones: only add_menu_item is super-only), so only one grant is written.
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

const SIX = ['approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos', 'verify_own_sales_day'] as const;
const NEW_GRANT = 'add_menu_item';

const MIGRATION = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations', '0196_t401_menu_catalog.sql');

/** The B0196 block, exactly as the migration carries it (statement-breakpoint comments removed). */
function backfillBlock(): string {
  const text = readFileSync(MIGRATION, 'utf8');
  const begin = text.indexOf('-- B0196:begin');
  const end = text.indexOf('-- B0196:end');
  expect(begin, 'the migration carries a "-- B0196:begin" marker (the add_menu_item owner backfill is not written)').toBeGreaterThanOrEqual(0);
  expect(end, 'the migration carries a "-- B0196:end" marker after it').toBeGreaterThan(begin);
  return text.slice(begin, end).replace(/-->\s*statement-breakpoint/g, '');
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Seeded {
  orgId: string;
  X: string; // admin + the six, all live
  Y: string; // admin + approve_item only
  Z: string; // admin + the six, one revoked
  V: string; // MANAGER (demoted) + the six
  S: string; // admin + the six, one of them store-scoped
  W: string; // admin + the six + an existing live add_menu_item
  all: string[];
}

async function seed(t: Tx): Promise<Seeded> {
  const code = uid('t401bf');
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
  for (const g of SIX) await grant(X, g);
  const Y = await person('Y', 'admin');
  await grant(Y, 'approve_item');
  const Z = await person('Z', 'admin');
  for (const g of SIX) await grant(Z, g, { revoked: g === 'view_franchise_sales' });
  const V = await person('V', 'manager');
  for (const g of SIX) await grant(V, g);
  const S = await person('S', 'admin');
  for (const g of SIX) await grant(S, g, { storeId: g === 'cross_org_access' ? store!.id : undefined });
  const W = await person('W', 'admin');
  for (const g of SIX) await grant(W, g);
  await grant(W, NEW_GRANT);
  return { orgId, X, Y, Z, V, S, W, all: [X, Y, Z, V, S, W] };
}

async function liveCounts(t: Tx, ids: string[]): Promise<Record<string, number>> {
  const rows = await t<{ person_id: string; n: number }[]>`
    select person_id, count(*)::int as n from person_grants
     where grant_name = ${NEW_GRANT} and revoked_at is null and person_id = any(${ids}) group by person_id`;
  return Object.fromEntries(rows.map((r) => [r.person_id, r.n]));
}

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

describe('B1 - the 0196 backfill: one live add_menu_item grant per existing owner, and nobody else', () => {
  it('as the migration role: X, S and W end with exactly one live grant; Y, Z and V with none; a second run adds nothing', async () => {
    const block = backfillBlock();
    await rolledBack(async (t) => {
      const p = await seed(t);

      await t.unsafe(block);
      const after1 = await liveCounts(t, p.all);
      expect(after1, 'X (admin + the six) -> one; S (one store-scoped) -> one; W (already held) -> still one').toMatchObject({ [p.X]: 1, [p.S]: 1, [p.W]: 1 });
      expect(after1[p.Y], 'Y holds approve_item only: no grant').toBeUndefined();
      expect(after1[p.Z], 'Z holds one of the six revoked: no grant').toBeUndefined();
      expect(after1[p.V], 'V is a manager (demoted) who still holds the six: no grant').toBeUndefined();

      const [row] = await t<{ grant_source: string | null; granted_by: string | null; store_id: string | null }[]>`
        select grant_source, granted_by, store_id from person_grants where person_id = ${p.X} and grant_name = ${NEW_GRANT} and revoked_at is null`;
      expect(row).toEqual({ grant_source: 'owner', granted_by: null, store_id: null });

      const [rs] = await t<{ v: string }[]>`select current_setting('row_security') as v`;
      expect(rs!.v, 'row_security is back ON after the block').toBe('on');

      const before = (await t<{ n: number }[]>`select count(*)::int as n from person_grants where grant_name = ${NEW_GRANT}`)[0]!.n;
      await t.unsafe(block);
      const afterN = (await t<{ n: number }[]>`select count(*)::int as n from person_grants where grant_name = ${NEW_GRANT}`)[0]!.n;
      expect(afterN, 'a second run inserts 0 rows').toBe(before);
      expect(await liveCounts(t, p.all)).toEqual(after1);
    });
  });

  it('nobody outside the seeded owners gains the grant: the block writes no other grant_name', async () => {
    const block = backfillBlock();
    await rolledBack(async (t) => {
      const p = await seed(t);
      const names = async () =>
        (await t<{ grant_name: string; n: number }[]>`select grant_name, count(*)::int n from person_grants where person_id = any(${p.all}) group by grant_name order by 1`);
      const before = await names();
      await t.unsafe(block);
      const after = await names();
      const added = after.filter((a) => (before.find((b) => b.grant_name === a.grant_name)?.n ?? 0) !== a.n).map((a) => a.grant_name);
      expect(added, 'only add_menu_item may be written').toEqual([NEW_GRANT]);
    });
  });

  it('as a role RLS filters, with no org: the block FAILS LOUDLY with the row-level-security error (never a silent zero)', async () => {
    const block = backfillBlock();
    let caught: unknown = null;
    try {
      await sql.begin(async (t) => {
        await seed(t);
        await t.unsafe(`set local role ${APP_ROLE}`);
        await t`select set_config('app.principal_kind', 'staff', true)`;
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
    expect(caught, 'expected Postgres to refuse the block for a role RLS filters, but it ran silently (SET LOCAL row_security = off missing)').not.toBeNull();
    const err = caught as { code?: string; message?: string };
    expect(err.code).toBe('42501');
    expect(err.message ?? '').toMatch(/row-level security/i);
  });
});
