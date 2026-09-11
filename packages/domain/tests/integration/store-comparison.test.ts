import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-209c — docs/tasks/209-reporting-read-model-and-statements.md.
 *
 * The proof this file carries: `getStorePLComparison` never re-derives a figure —
 * each store's numbers must match calling `getIncomeStatement` directly for that store alone.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { getIncomeStatement, getStorePLComparison, postEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

/**
 * Every one of these is reached in production only through an API-layer wrapper that has
 * already called withOrgPrincipal — none establishes a principal itself. Standing in for
 * that layer here, at the same depth production wraps at.
 */
function postEntryAsOrg(input: Parameters<typeof postEntry>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => postEntry(tx, input));
}
function getStorePLComparisonAsOrg(input: Parameters<typeof getStorePLComparison>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => getStorePLComparison(tx, input));
}
function getIncomeStatementAsOrg(input: Parameters<typeof getIncomeStatement>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => getIncomeStatement(tx, input));
}

async function fixture() {
  const code = `storecmp-${randomUUID()}`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [storeA] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${'A-' + randomUUID()}, 'Store A') returning id`;
  const [storeB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${'B-' + randomUUID()}, 'Store B') returning id`;
  return { orgId, storeAId: storeA!.id, storeBId: storeB!.id };
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('getStorePLComparison', () => {
  it("each store's figures match calling getIncomeStatement directly for that store alone", async () => {
    const { orgId, storeAId, storeBId } = await fixture();

    await postEntryAsOrg({
      orgId, entryDate: '2026-01-10', sourceType: 'test:store-a-sale', sourceId: randomUUID(), idempotencyKey: randomUUID(),
      lines: [
        { accountCode: '1110', storeId: storeAId, debit: '3000.00' },
        { accountCode: '4150', storeId: storeAId, credit: '3000.00' },
      ],
    });
    await postEntryAsOrg({
      orgId, entryDate: '2026-01-12', sourceType: 'test:store-b-sale', sourceId: randomUUID(), idempotencyKey: randomUUID(),
      lines: [
        { accountCode: '1110', storeId: storeBId, debit: '900.00' },
        { accountCode: '4150', storeId: storeBId, credit: '900.00' },
      ],
    });

    const comparison = await getStorePLComparisonAsOrg({
      orgId, storeIds: [storeAId, storeBId], fromDate: '2026-01-01', toDate: '2026-01-31',
    });

    const direct = await Promise.all(
      [storeAId, storeBId].map((storeId) =>
        getIncomeStatementAsOrg({ orgId, storeId, fromDate: '2026-01-01', toDate: '2026-01-31' }),
      ),
    );

    expect(comparison.stores.map((s) => s.statement.revenue)).toEqual(direct.map((d) => d.revenue));
    expect(comparison.stores.map((s) => s.statement.netIncome)).toEqual(direct.map((d) => d.netIncome));
    expect(comparison.stores[0]!.statement.revenue).toBe('3000.00');
    expect(comparison.stores[1]!.statement.revenue).toBe('900.00');
  });

  it('omitting a store excludes it without affecting the others', async () => {
    const { orgId, storeAId, storeBId } = await fixture();
    await postEntryAsOrg({
      orgId, entryDate: '2026-01-10', sourceType: 'test:store-a-sale', sourceId: randomUUID(), idempotencyKey: randomUUID(),
      lines: [
        { accountCode: '1110', storeId: storeAId, debit: '500.00' },
        { accountCode: '4150', storeId: storeAId, credit: '500.00' },
      ],
    });
    await postEntryAsOrg({
      orgId, entryDate: '2026-01-10', sourceType: 'test:store-b-sale', sourceId: randomUUID(), idempotencyKey: randomUUID(),
      lines: [
        { accountCode: '1110', storeId: storeBId, debit: '700.00' },
        { accountCode: '4150', storeId: storeBId, credit: '700.00' },
      ],
    });

    const onlyA = await getStorePLComparisonAsOrg({ orgId, storeIds: [storeAId], fromDate: '2026-01-01', toDate: '2026-01-31' });

    expect(onlyA.stores).toHaveLength(1);
    expect(onlyA.stores[0]!.statement.revenue).toBe('500.00');
  });
});
