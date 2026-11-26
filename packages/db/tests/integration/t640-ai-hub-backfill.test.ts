/**
 * T-640 - the 0284 owner backfill for `manage_ai_hub` (the ninth super-admin-only capability), same shape as t510-s2-pair-backfill.test.ts.
 * The block between the B0284 markers runs as the migration role in a transaction that is ALWAYS rolled back.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

type Tx = postgres.TransactionSql;
class Rollback extends Error {}

const EIGHT = ['approve_item', 'post_journal_entry', 'cross_org_access', 'view_franchise_sales', 'unlink_store_from_pos', 'verify_own_sales_day', 'add_menu_item', 'pair_menu_dayparts'] as const;
const NEW_GRANT = 'manage_ai_hub';
const MIGRATION = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations', '0284_t640_ai_hub.sql');

function backfillBlock(): string {
  const text = readFileSync(MIGRATION, 'utf8');
  const begin = text.indexOf('-- B0284:begin');
  const end = text.indexOf('-- B0284:end');
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return text.slice(begin, end).replace(/-->\s*statement-breakpoint/g, '');
}

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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

describe('B0284 - one live manage_ai_hub grant per existing owner, and nobody else', () => {
  it('X (admin + the eight) and W (already held) end with exactly one; Y (one grant), Z (one revoked), V (demoted manager), U (only the old seven) with none; a second run adds nothing [kills: a wrong count in HAVING, a missing role check, a non-idempotent insert]', async () => {
    const block = backfillBlock();
    await rolledBack(async (t) => {
      const code = uid('t640bf');
      const [org] = await t<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
      const orgId = org!.id;
      const person = async (name: string, role: 'admin' | 'manager') => {
        const [p] = await t<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
        await t`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
        return p!.id;
      };
      const grant = (personId: string, name: string, revoked = false) =>
        revoked
          ? t`insert into person_grants (person_id, grant_name, grant_source, revoked_at, revoke_reason) values (${personId}, ${name}, 'owner', now(), 'fixture')`
          : t`insert into person_grants (person_id, grant_name, grant_source) values (${personId}, ${name}, 'owner')`;
      const X = await person('X', 'admin');
      for (const g of EIGHT) await grant(X, g);
      const Y = await person('Y', 'admin');
      await grant(Y, 'approve_item');
      const Z = await person('Z', 'admin');
      for (const g of EIGHT) await grant(Z, g, g === 'pair_menu_dayparts');
      const V = await person('V', 'manager');
      for (const g of EIGHT) await grant(V, g);
      const U = await person('U', 'admin');
      for (const g of EIGHT.slice(0, 7)) await grant(U, g);
      const W = await person('W', 'admin');
      for (const g of EIGHT) await grant(W, g);
      await grant(W, NEW_GRANT);
      const all = [X, Y, Z, V, U, W];
      const counts = async () =>
        Object.fromEntries(
          (
            await t<{ person_id: string; n: number }[]>`
              select person_id, count(*)::int as n from person_grants where grant_name = ${NEW_GRANT} and revoked_at is null and person_id = any(${all}) group by person_id`
          ).map((r) => [r.person_id, r.n]),
        );

      await t.unsafe(block);
      const after1 = await counts();
      expect(after1).toEqual({ [X]: 1, [W]: 1 });
      await t.unsafe(block);
      expect(await counts()).toEqual(after1);
      const [row] = await t<{ grant_source: string | null; granted_by: string | null; store_id: string | null }[]>`
        select grant_source, granted_by, store_id from person_grants where person_id = ${X} and grant_name = ${NEW_GRANT} and revoked_at is null`;
      expect(row).toEqual({ grant_source: 'owner', granted_by: null, store_id: null });
    });
  });
});
