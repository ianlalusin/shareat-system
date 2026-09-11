import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-209c — docs/tasks/209-reporting-read-model-and-statements.md.
 *
 * The regression case this file exists to carry: `operating + investing + financing` must equal
 * the actual change in cash & cash-equivalent balances, across a mixed set of postings — a cash
 * sale, a credit sale, a depreciation entry (the account-delta add-back), a loan disbursement, an
 * owner's drawing, and an asset purchase. Each one was verified by hand against the design in the
 * task doc before this file was written; this proves the implementation matches that by-hand math,
 * not merely that it runs.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { getCashFlow, postEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

/**
 * Both postEntry and getCashFlow are reached in production only through an API-layer
 * wrapper that has already called withOrgPrincipal (apps/erp/src/app/reports/cash-flow's
 * page.tsx and export/route.ts are the pattern for the read side; expenses/lib.ts for the
 * write side) — neither function establishes a principal itself. Standing in for that
 * layer here, at the same depth production wraps at, rather than passing `db`/`null`
 * directly and running as the bare restricted-role connection with no org context.
 */
function getCashFlowAsOrg(input: Parameters<typeof getCashFlow>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => getCashFlow(tx, input));
}

async function fixture(hint: string) {
  const code = `cashflow-${hint}-${randomUUID()}`;
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')
  `;
  return orgId;
}

async function post(orgId: string, entryDate: string, sourceType: string, lines: Parameters<typeof postEntry>[1]['lines']) {
  return withOrgPrincipal(orgId, (tx) =>
    postEntry(tx, {
      orgId,
      entryDate,
      sourceType,
      sourceId: randomUUID(),
      idempotencyKey: randomUUID(),
      lines,
    }),
  );
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('getCashFlow', () => {
  it('a pure cash sale reconciles — net income alone explains the cash increase', async () => {
    const orgId = await fixture('cash-sale');
    await post(orgId, '2026-01-10', 'test:cash-sale', [
      { accountCode: '1110', debit: '1000.00' },
      { accountCode: '4150', credit: '1000.00' },
    ]);

    const result = await getCashFlowAsOrg({ orgId, fromDate: '2026-01-01', toDate: '2026-01-31' });

    expect(result.reconciles, `netChangeInCash (${result.netChangeInCash}) must equal actualCashChange (${result.actualCashChange})`).toBe(true);
    expect(result.netIncome).toBe('1000.00');
    expect(result.operating).toBe('1000.00');
    expect(result.actualCashChange).toBe('1000.00');
  });

  it('a credit sale (no cash movement) reconciles to zero net change', async () => {
    const orgId = await fixture('credit-sale');
    await post(orgId, '2026-01-10', 'test:credit-sale', [
      { accountCode: '1210', debit: '500.00', partyType: 'customer', partyId: randomUUID() },
      { accountCode: '4150', credit: '500.00' },
    ]);

    const result = await getCashFlowAsOrg({ orgId, fromDate: '2026-01-01', toDate: '2026-01-31' });

    expect(result.reconciles).toBe(true);
    expect(result.netIncome).toBe('500.00');
    // The AR increase is a use of cash that exactly offsets the revenue recognised.
    expect(result.operating).toBe('0.00');
    expect(result.actualCashChange).toBe('0.00');
  });

  it('depreciation nets to zero cash effect via the account-delta add-back, no separate line needed', async () => {
    const orgId = await fixture('depreciation');
    // Put an asset on the books first so 1590 has something to depreciate against.
    await post(orgId, '2026-01-01', 'test:seed-asset', [
      { accountCode: '1510', debit: '50000.00' },
      { accountCode: '3300', credit: '50000.00' },
    ]);
    await post(orgId, '2026-02-15', 'test:depreciation', [
      { accountCode: '6700', debit: '500.00' },
      { accountCode: '1590', credit: '500.00' },
    ]);

    const result = await getCashFlowAsOrg({ orgId, fromDate: '2026-02-01', toDate: '2026-02-28' });

    expect(result.reconciles).toBe(true);
    expect(result.netIncome).toBe('-500.00');
    // netIncome (-500) + the 1590 add-back (+500, falling out of the universal asset-delta rule
    // since 1590's type-signed balance became MORE NEGATIVE) = 0.00.
    expect(result.operating).toBe('0.00');
    expect(result.actualCashChange).toBe('0.00');
    const line1590 = result.operatingLines.find((l) => l.accountCode === '1590');
    expect(line1590?.amount, 'the depreciation add-back must be POSITIVE').toBe('500.00');
  });

  it('a loan disbursement into cash appears under financing', async () => {
    const orgId = await fixture('loan');
    await post(orgId, '2026-01-15', 'test:loan-disbursement', [
      { accountCode: '1110', debit: '20000.00' },
      { accountCode: '2400', credit: '20000.00', partyType: 'loan', partyId: randomUUID() },
    ]);

    const result = await getCashFlowAsOrg({ orgId, fromDate: '2026-01-01', toDate: '2026-01-31' });

    expect(result.reconciles).toBe(true);
    expect(result.financing).toBe('20000.00');
    expect(result.operating).toBe('0.00');
    expect(result.investing).toBe('0.00');
    expect(result.actualCashChange).toBe('20000.00');
  });

  it('an owner drawing appears under financing as negative, and an asset purchase under investing', async () => {
    const orgId = await fixture('drawing-and-capex');
    // Fund the drawer first so it can go negative-neutral overall — cash flow doesn't require a
    // positive running cash balance, only that the accounting identity holds.
    await post(orgId, '2026-01-01', 'test:seed-cash', [
      { accountCode: '1110', debit: '100000.00' },
      { accountCode: '3300', credit: '100000.00' },
    ]);
    await post(orgId, '2026-01-10', 'test:drawing', [
      { accountCode: '3200', debit: '2000.00', partyType: 'owner', partyId: randomUUID() },
      { accountCode: '1110', credit: '2000.00' },
    ]);
    await post(orgId, '2026-01-20', 'test:asset-purchase', [
      { accountCode: '1510', debit: '15000.00' },
      { accountCode: '1110', credit: '15000.00' },
    ]);

    const result = await getCashFlowAsOrg({ orgId, fromDate: '2026-01-01', toDate: '2026-01-31' });

    expect(result.reconciles).toBe(true);
    const drawingLine = result.financingLines.find((l) => l.accountCode === '3200');
    expect(drawingLine?.amount).toBe('-2000.00');
    const assetLine = result.investingLines.find((l) => l.accountCode === '1510');
    expect(assetLine?.amount).toBe('-15000.00');
    expect(result.financing).toBe('-2000.00');
    expect(result.investing).toBe('-15000.00');
  });

  it('excludes a year-close entry from both netIncome and the account deltas together', async () => {
    const orgId = await fixture('year-close');
    await post(orgId, '2026-01-10', 'test:cash-sale', [
      { accountCode: '1110', debit: '1000.00' },
      { accountCode: '4150', credit: '1000.00' },
    ]);
    // Simulate a year-close entry moving net income into retained earnings.
    await post(orgId, '2026-01-31', 'year_close', [
      { accountCode: '4150', debit: '1000.00' },
      { accountCode: '3300', credit: '1000.00' },
    ]);

    const withoutYearClose = await getCashFlowAsOrg({ orgId, fromDate: '2026-01-01', toDate: '2026-01-31', includeYearClose: false });
    expect(withoutYearClose.reconciles, 'excluding the year-close entry must still reconcile').toBe(true);
    expect(withoutYearClose.netIncome).toBe('1000.00');

    const withYearClose = await getCashFlowAsOrg({ orgId, fromDate: '2026-01-01', toDate: '2026-01-31', includeYearClose: true });
    expect(withYearClose.reconciles, 'including the year-close entry must still reconcile — no double count').toBe(true);
    // The year-close entry zeroes 4150 back to 0 for the period, so recognised revenue for THIS
    // range becomes 0 once it's included.
    expect(withYearClose.netIncome).toBe('0.00');
  });

  it('no activity produces a reconciling zero, not a crash', async () => {
    const orgId = await fixture('empty');
    const result = await getCashFlowAsOrg({ orgId, fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.reconciles).toBe(true);
    expect(result.netChangeInCash).toBe('0.00');
    expect(result.actualCashChange).toBe('0.00');
  });
});
