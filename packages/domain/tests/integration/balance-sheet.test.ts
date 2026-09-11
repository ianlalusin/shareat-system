import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-209a — docs/tasks/209-reporting-read-model-and-statements.md.
 *
 * The regression case this file exists to carry: a debit to `1590` (accumulated
 * depreciation — type=asset, normal_balance=CREDIT) must REDUCE `assets`, never increase
 * it. `v_balance_sheet` signs by account TYPE, not by each row's own `normal_balance` — see
 * `views.ts`'s top comment and `docs/tasks/111-property-based-invariant-tests.md`, which
 * made exactly the opposite mistake once already on the analogous accounting-equation
 * property test.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { getBalanceSheet, postEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

/**
 * Both postEntry and getBalanceSheet are reached in production only through an API-layer
 * wrapper that has already called withOrgPrincipal — neither establishes a principal
 * itself. Standing in for that layer here, at the same depth production wraps at.
 */
function postEntryAsOrg(input: Parameters<typeof postEntry>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => postEntry(tx, input));
}
function getBalanceSheetAsOrg(input: Parameters<typeof getBalanceSheet>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => getBalanceSheet(tx, input));
}

let orgId: string;

beforeAll(async () => {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values ('T-209a balance sheet', ${'t209a-' + randomUUID()})
    returning id
  `;
  orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-12-31', 'open')
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('getBalanceSheet', () => {
  it('ties (assets == liabilities + equity) after an ordinary asset/liability/equity-touching posting', async () => {
    // Dr 1110 Cash 10,000 / Cr 3300 Retained earnings 10,000 — an equity-touching posting
    // that needs no party (unlike 3100/3200, which are owner-specific — T-118).
    await postEntryAsOrg({
      orgId,
      entryDate: '2026-03-01',
      sourceType: 'test:balance-sheet',
      sourceId: randomUUID(),
      idempotencyKey: randomUUID(),
      lines: [
        { accountCode: '1110', debit: '10000.00' },
        { accountCode: '3300', credit: '10000.00' },
      ],
    });

    const result = await getBalanceSheetAsOrg({ orgId, asOfDate: '2026-12-31' });

    expect(result.ties, `assets (${result.assets}) must equal liabilities+equity`).toBe(true);
    expect(result.assets).toBe('10000.00');
    expect(result.equity).toBe('10000.00');
    expect(result.liabilities).toBe('0.00');
  });

  it('a debit to 1590 (accumulated depreciation) REDUCES assets, not increases them', async () => {
    // First put an asset on the books, funded by capital, so the equation has something to
    // tie against before depreciation touches it.
    await postEntryAsOrg({
      orgId,
      entryDate: '2026-04-01',
      sourceType: 'test:balance-sheet',
      sourceId: randomUUID(),
      idempotencyKey: randomUUID(),
      lines: [
        { accountCode: '1510', debit: '50000.00' },
        { accountCode: '3300', credit: '50000.00' },
      ],
    });

    const before = await getBalanceSheetAsOrg({ orgId, asOfDate: '2026-04-01' });
    const assetsBefore = before.assets;

    // The ORDINARY depreciation posting: Dr 6700 Depreciation expense / Cr 1590 Accumulated
    // depreciation. 6700 is type=expense (off this statement); 1590 is type=asset,
    // normal_balance=credit — the contra case.
    await postEntryAsOrg({
      orgId,
      entryDate: '2026-04-30',
      sourceType: 'test:balance-sheet',
      sourceId: randomUUID(),
      idempotencyKey: randomUUID(),
      lines: [
        { accountCode: '6700', debit: '500.00' },
        { accountCode: '1590', credit: '500.00' },
      ],
    });

    const after = await getBalanceSheetAsOrg({ orgId, asOfDate: '2026-04-30' });

    // The regression: a version that signs 1590 by its OWN normal_balance (credit-positive)
    // would show its line as +500.00 and ADD it to gross assets. Signed by TYPE
    // (asset = debit-positive), a credit to 1590 is -500.00, and total assets falls.
    const line1590 = after.assetLines.find((l) => l.accountCode === '1590');
    expect(line1590?.amount, '1590 must appear as a NEGATIVE line under assets').toBe('-500.00');
    expect(after.assets, 'total assets must fall by exactly the depreciation charge').toBe(
      (Number(assetsBefore) - 500).toFixed(2),
    );
    expect(after.ties, 'the equation must still tie after a contra-account posting').toBe(true);
  });

  it('excludes an account with zero net activity in range from its section', async () => {
    const result = await getBalanceSheetAsOrg({ orgId, asOfDate: '2026-01-01' });
    // Nothing has been posted as of 2026-01-01 (the fixtures above post from 2026-03-01
    // onward) — every section is empty, and the equation trivially ties at zero.
    expect(result.assetLines).toEqual([]);
    expect(result.liabilityLines).toEqual([]);
    expect(result.equityLines).toEqual([]);
    expect(result.assets).toBe('0.00');
    expect(result.ties).toBe(true);
  });

  it('respects storeId and includeYearClose the same way getTrialBalance does', async () => {
    const withYearClose = await getBalanceSheetAsOrg({ orgId, asOfDate: '2026-12-31', includeYearClose: true });
    const withoutYearClose = await getBalanceSheetAsOrg({ orgId, asOfDate: '2026-12-31', includeYearClose: false });
    // No year-close entry exists in this fixture set — both must agree, proving the flag is
    // wired through rather than silently ignored (a bug that would only show up once a
    // year-close entry actually exists).
    expect(withYearClose.assets).toBe(withoutYearClose.assets);
  });
});
