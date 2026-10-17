/**
 * T-439 - bible row 362: the built-in position "Cook" is renamed "Kitchen Staff" (same id, same grants).
 * Migration 0208 renames existing canonical rows in place; new orgs are seeded with the new name.
 *
 * RED until the builder writes 0208 (no 0208_*.sql file) and renames the seed constant in schema/employment.ts.
 * The before/after of a live rename cannot be observed on a fresh DB, so the 0208 statements are run by hand
 * inside a rolled-back transaction against hand-made rows.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import { seedCanonicalPositions } from '@shareat/domain';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string): Promise<string> {
  const code = uid(`t439-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return org!.id;
}

describe('T-439 - Cook becomes Kitchen Staff', () => {
  it('a freshly seeded org has canonical "Kitchen Staff" and no canonical "Cook"', async () => {
    const orgId = await newOrg('seed');
    await transaction(async (tx: Tx) => {
      await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
      await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
      await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
      await seedCanonicalPositions(tx, orgId);
    });
    const names = (await sql<{ name: string }[]>`select name from positions where org_id = ${orgId} and is_canonical`).map((r) => r.name).sort();
    expect(names).toContain('Kitchen Staff');
    expect(names).not.toContain('Cook');
    expect(names).toEqual(['Cashier', 'Dishwasher', 'Inventory Staff', 'Kitchen Staff', 'Server', 'Slicer']);
  });

  it('0208 renames only canonical "Cook" rows, keeps the id, and leaves a store-made "Cook" untouched', async () => {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const f = readdirSync(dir).find((x) => /^0208_.*\.sql$/.test(x));
    expect(f, 'migration 0208_*.sql does not exist yet').toBeDefined();
    const text = readFileSync(dir + f!, 'utf8');
    const statements = text.split('--> statement-breakpoint').map((x) => x.trim()).filter((x) => x.length > 0);
    expect(statements.length).toBeGreaterThanOrEqual(1);

    const orgId = await newOrg('mig');
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Lipa') returning id`;
    const ROLLBACK = new Error('rollback');
    let seen: { canon: { id: string; name: string }; storeMade: { id: string; name: string }; canonId: string; storeMadeId: string } | null = null;
    await sql
      .begin(async (tx) => {
        const [c] = await tx<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Cook', true, true) returning id`;
        const [s] = await tx<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, ${store!.id}, 'Cook', false, true) returning id`;
        for (const st of statements) await tx.unsafe(st);
        const [canon] = await tx<{ id: string; name: string }[]>`select id, name from positions where id = ${c!.id}`;
        const [storeMade] = await tx<{ id: string; name: string }[]>`select id, name from positions where id = ${s!.id}`;
        seen = { canon: canon!, storeMade: storeMade!, canonId: c!.id, storeMadeId: s!.id };
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen).not.toBeNull();
    expect(seen!.canon).toEqual({ id: seen!.canonId, name: 'Kitchen Staff' });
    expect(seen!.storeMade).toEqual({ id: seen!.storeMadeId, name: 'Cook' });
  });

  it('0208 also renames a canonical " cook " row (case and padding), and leaves a store-made one alone', async () => {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const f = readdirSync(dir).find((x) => /^0208_.*\.sql$/.test(x));
    expect(f, 'migration 0208_*.sql does not exist yet').toBeDefined();
    const text = readFileSync(dir + f!, 'utf8');
    const statements = text.split('--> statement-breakpoint').map((x) => x.trim()).filter((x) => x.length > 0);
    expect(statements.length).toBeGreaterThanOrEqual(1);

    const orgId = await newOrg('mig');
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Lipa') returning id`;
    const ROLLBACK = new Error('rollback');
    let seen: { canon: { id: string; name: string }; storeMade: { id: string; name: string }; canonId: string; storeMadeId: string } | null = null;
    await sql
      .begin(async (tx) => {
        const [c] = await tx<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, ' cook ', true, true) returning id`;
        const [s] = await tx<{ id: string }[]>`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, ${store!.id}, 'Cook', false, true) returning id`;
        for (const st of statements) await tx.unsafe(st);
        const [canon] = await tx<{ id: string; name: string }[]>`select id, name from positions where id = ${c!.id}`;
        const [storeMade] = await tx<{ id: string; name: string }[]>`select id, name from positions where id = ${s!.id}`;
        seen = { canon: canon!, storeMade: storeMade!, canonId: c!.id, storeMadeId: s!.id };
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen).not.toBeNull();
    expect(seen!.canon).toEqual({ id: seen!.canonId, name: 'Kitchen Staff' });
    expect(seen!.storeMade).toEqual({ id: seen!.storeMadeId, name: 'Cook' });
  });
});
