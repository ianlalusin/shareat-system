import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-253 / DEF-220. The default-store selector (`apps/erp/src/app/commissary/catalogue/
 * default-store.ts`) is a pure function tested against fabricated arrays in
 * `apps/erp/tests/commissary-catalogue-default.test.ts`. This file covers the one line that
 * function's own unit test cannot reach: deriving "which stores ARE commissaries" from a real
 * `commissary_links` table via `commissaryCatalogueRepo.listLinks` — proving the property (a
 * store with an outgoing link is IN the set; one without is NOT) against real Postgres rows
 * rather than a hand-built array. `listLinks`' read side was previously pinned by no test;
 * `packages/domain/tests/integration/commissary-catalogue.test.ts` exercises only the write
 * paths and role gates.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { closeDb, commissaryCatalogueRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture() {
  const code = uid('org');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Fixture Person') returning id`;

  return { orgId, mkStore, createdBy: person!.id };
}

describe('T-253 / DEF-220 — commissaryCatalogueRepo.listLinks feeds the default-store property', () => {
  it('a store holding an outgoing link IS in the derived set; a store with none is NOT', async () => {
    const f = await fixture();
    const commissaryId = await f.mkStore('commissary');
    const branchId = await f.mkStore('branch-with-no-links'); // DEF-220's shape: this is the store
    // that `stores[0]` used to pick by pure luck of ordering — proving it is absent by construction,
    // not by an ordering assumption, is the point of this test.

    await asOrg(f.orgId, (tx) =>
      commissaryCatalogueRepo.upsertLink(tx, {
        orgId: f.orgId,
        commissaryStoreId: commissaryId,
        branchStoreId: branchId,
        status: 'active',
        createdBy: f.createdBy,
      }),
    );

    const links = await asOrg(f.orgId, (tx) => commissaryCatalogueRepo.listLinks(tx, f.orgId));
    const commissaryStoreIds = new Set(links.map((l) => l.commissaryStoreId));

    expect(commissaryStoreIds.has(commissaryId)).toBe(true);
    expect(commissaryStoreIds.has(branchId)).toBe(false);
  });

  it('an inactive link still counts — "IS a commissary" is status-agnostic, matching this screen elsewhere', async () => {
    const f = await fixture();
    const commissaryId = await f.mkStore('commissary-retired');
    const branchId = await f.mkStore('branch');

    await asOrg(f.orgId, (tx) =>
      commissaryCatalogueRepo.upsertLink(tx, {
        orgId: f.orgId,
        commissaryStoreId: commissaryId,
        branchStoreId: branchId,
        status: 'inactive',
        createdBy: f.createdBy,
      }),
    );

    const links = await asOrg(f.orgId, (tx) => commissaryCatalogueRepo.listLinks(tx, f.orgId));
    const commissaryStoreIds = new Set(links.map((l) => l.commissaryStoreId));

    expect(commissaryStoreIds.has(commissaryId)).toBe(true);
  });

  it('zero links in the org yields an empty set — the "no commissary at all" state, on real data', async () => {
    const f = await fixture();
    await f.mkStore('branch-1');
    await f.mkStore('branch-2');

    const links = await asOrg(f.orgId, (tx) => commissaryCatalogueRepo.listLinks(tx, f.orgId));
    const commissaryStoreIds = new Set(links.map((l) => l.commissaryStoreId));

    expect(commissaryStoreIds.size).toBe(0);
  });
});
