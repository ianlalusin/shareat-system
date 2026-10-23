import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedCanonicalPositions, setPositionDefault } from '@shareat/domain';
import { gridDataForStore } from '../../src/app/admin/access-defaults/lib';

/**
 * T-318 D3 — `gridDataForStore` end to end against real Postgres: does the batched overlap query
 * actually wire up, not just the pure aggregation `apps/erp/tests/access-defaults-lib.test.ts`
 * already proves against synthetic rows. Placed here rather than under
 * `packages/domain/tests/integration/`: `gridDataForStore` lives in `apps/erp/src/app/...` —
 * presentation-layer code over domain tables, not domain business logic — and
 * `apps/erp/tests/integration/setup-lib.test.ts`'s own header makes this exact argument for a
 * different function (needs a real database, belongs in this app's own integration glob,
 * DEF-221/T-247).
 *
 * ⛔ Run ONLY via `it.mjs` against the lane database — never `npm run test:integration`:
 *   node C:\Users\ianla\.claude\skills\orchestrator\tools\it.mjs shareat_test_laneb \
 *     apps/erp/tests/integration/access-defaults-lib.test.ts --repo C:\Users\ianla\webapps\shareat-system
 */
const sql = postgres(url, { max: 5 });
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

beforeEach(async () => {
  await sql`
    truncate table person_grants, position_capability_defaults, employment_positions, employments,
      positions, person_store_scope, person_roles, person_identities, persons, stores, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`adg-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store') returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  const actor: Actor = { personId: admin!.id, orgId };
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  return { orgId, storeId, actor };
}

async function hire(orgId: string, storeId: string, name: string, positionIds: readonly string[]) {
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${person!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${person!.id}, ${storeId})`;
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${person!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  for (const [i, positionId] of positionIds.entries()) {
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${employment!.id}, ${positionId}, ${i === 0})`;
  }
  return { personId: person!.id, employmentId: employment!.id };
}

async function canonicalPositionId(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from positions where org_id = ${orgId} and store_id is null and name = ${name}`;
  return row!.id;
}

describe('gridDataForStore — the multi-position overlap disclosure, against real Postgres', () => {
  it('a Dishwasher who is also a Server sees the overlap credited to Dishwasher, not Server', async () => {
    const { orgId, storeId, actor } = await fixture('overlap');
    const dishwasherId = await canonicalPositionId(orgId, 'Dishwasher');
    const serverId = await canonicalPositionId(orgId, 'Server');

    // Server holds submit_sales_day; Dishwasher does not.
    await asOrg(orgId, (tx) =>
      setPositionDefault(tx, actor, { positionId: serverId, storeId, capability: 'submit_sales_day', on: true }),
    );

    await hire(orgId, storeId, 'Dual Holder', [dishwasherId, serverId]);
    // A second Dishwasher, NOT also a Server — must not be counted.
    await hire(orgId, storeId, 'Solo Dishwasher', [dishwasherId]);

    const data = await gridDataForStore(actor, storeId);

    expect(data.overlapCounts.get(dishwasherId)?.get('submit_sales_day')).toBe(1);
    // Server already holds it directly — no disclosure from Server's own column.
    expect(data.overlapCounts.get(serverId)?.get('submit_sales_day')).toBeUndefined();
    // holderCount still counts BOTH Dishwasher holders (§C5 — unaffected by the overlap feature).
    expect(data.positions.find((p) => p.id === dishwasherId)?.holderCount).toBe(2);
  });

  it('nobody holding two positions: overlapCounts is empty, not merely absent for the tested cell', async () => {
    const { orgId, storeId, actor } = await fixture('nooverlap');
    const cashierId = await canonicalPositionId(orgId, 'Cashier');
    await hire(orgId, storeId, 'Solo Cashier', [cashierId]);

    const data = await gridDataForStore(actor, storeId);
    expect(data.overlapCounts.size).toBe(0);
  });

  it('two positions holding the SAME capability directly: neither is credited an overlap', async () => {
    const { orgId, storeId, actor } = await fixture('bothhold');
    const dishwasherId = await canonicalPositionId(orgId, 'Dishwasher');
    const serverId = await canonicalPositionId(orgId, 'Server');
    await asOrg(orgId, (tx) =>
      setPositionDefault(tx, actor, { positionId: dishwasherId, storeId, capability: 'submit_sales_day', on: true }),
    );
    await asOrg(orgId, (tx) =>
      setPositionDefault(tx, actor, { positionId: serverId, storeId, capability: 'submit_sales_day', on: true }),
    );
    await hire(orgId, storeId, 'Dual Holder', [dishwasherId, serverId]);

    const data = await gridDataForStore(actor, storeId);
    expect(data.overlapCounts.get(dishwasherId)?.get('submit_sales_day')).toBeUndefined();
    expect(data.overlapCounts.get(serverId)?.get('submit_sales_day')).toBeUndefined();
  });
});
