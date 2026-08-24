import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves invariants 7, 8, 9, 10, 11 (the income-statement SERVICE behaviour) plus a
 * service-level re-proof of 4-6 (the trial-balance "ties" boolean end-to-end) of
 * docs/tasks/110-reporting-views-and-screens.md, against real PostgreSQL
 * (PROJECT_BIBLE.md §9 rule 3). The view-level invariants (1-6, 8's mechanism, a slice of
 * 7/9/11) are proven directly against the views in
 * packages/db/tests/integration/reports.test.ts — see that file's own top comment for the
 * split rationale (mirrors journal.test.ts vs post-entry.test.ts).
 *
 * Written FIRST, before packages/domain/src/reports/{trial-balance,income-statement}.ts
 * existed, to confirm the initial run fails for the right reason — "Cannot find module".
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
import { closeDb, getDb } from '@shareat/db';
import { getTrialBalance, getIncomeStatement } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
const db = getDb();

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

let seq = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++seq}`;
}

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`reports-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

async function insertStore(orgId: string, hint: string): Promise<string> {
  const code = uid(`store-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${code}, ${`Store ${code}`})
    returning id
  `;
  return row!.id;
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  status: 'open' | 'closed' | 'locked' = 'open',
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, ${status})
    returning id
  `;
  return row!.id;
}

async function accountId(orgId: string, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from accounts where org_id = ${orgId} and code = ${code}
  `;
  if (!row) throw new Error(`seeded account ${code} not found for org ${orgId}`);
  return row.id;
}

type LineSpec = {
  accountId: string;
  debit: string;
  credit: string;
  storeId?: string | null;
  partyType?: string | null;
  partyId?: string | null;
};

async function insertPostedEntry(
  orgId: string,
  periodId: string,
  entryDate: string,
  lines: LineSpec[],
  opts: { sourceType?: string; sourceId?: string } = {},
): Promise<string> {
  return sql.begin(async (trx) => {
    const [entry] = await trx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, ${entryDate}, ${periodId}, ${opts.sourceType ?? 'test'}, ${opts.sourceId ?? uid('src')}, 'draft')
      returning id
    `;
    const entryId = entry!.id;
    let lineNo = 1;
    for (const line of lines) {
      await trx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
        values (${entryId}, ${lineNo}, ${line.accountId}, ${line.storeId ?? null}, ${line.debit}, ${line.credit}, ${line.partyType ?? null}, ${line.partyId ?? null})
      `;
      lineNo++;
    }
    await trx`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`;
    return entryId;
  });
}

async function resetTables() {
  await sql`
    truncate table
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
}

beforeEach(async () => {
  await resetTables();
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/**
 * The same worked-example corpus as packages/db/tests/integration/reports.test.ts's
 * `postWorkedExamplesCorpus` (see that file's top-of-file spec-defect note re: T-108).
 * Duplicated deliberately rather than imported cross-package: this file proves the
 * SERVICE layer end-to-end and must not depend on the other file's private helpers.
 */
async function postWorkedExamplesCorpus() {
  const orgId = await insertOrg('corpus');
  await seedChartOfAccounts(sql, orgId);
  const storeA = await insertStore(orgId, 'a');
  const storeB = await insertStore(orgId, 'b');
  const jan = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
  const feb = await insertPeriod(orgId, '2026-02-01', '2026-02-28', 'open');

  const cash = await accountId(orgId, '1110');
  const unli = await accountId(orgId, '4100');
  const alc = await accountId(orgId, '4150');
  const discounts = await accountId(orgId, '4900');
  const comps = await accountId(orgId, '4950');
  const cogsFood = await accountId(orgId, '5100');
  const wastage = await accountId(orgId, '5300');
  const inventory = await accountId(orgId, '1310');
  const ap = await accountId(orgId, '2110');
  const rent = await accountId(orgId, '6200');

  await insertPostedEntry(orgId, jan, '2026-01-15', [
    { accountId: cash, debit: '1000.00', credit: '0', storeId: storeA },
    { accountId: unli, debit: '0', credit: '1000.00', storeId: storeA },
  ]);
  await insertPostedEntry(orgId, jan, '2026-01-16', [
    { accountId: cash, debit: '950.00', credit: '0', storeId: storeA },
    { accountId: discounts, debit: '50.00', credit: '0', storeId: storeA },
    { accountId: alc, debit: '0', credit: '1000.00', storeId: storeA },
  ]);
  await insertPostedEntry(orgId, jan, '2026-01-17', [
    { accountId: cogsFood, debit: '300.00', credit: '0', storeId: storeA },
    { accountId: ap, debit: '0', credit: '300.00', storeId: storeA, partyType: 'supplier', partyId: 'supplier-1' },
  ]);
  await insertPostedEntry(orgId, jan, '2026-01-18', [
    { accountId: wastage, debit: '40.00', credit: '0', storeId: storeA },
    { accountId: inventory, debit: '0', credit: '40.00', storeId: storeA },
  ]);
  await insertPostedEntry(orgId, jan, '2026-01-20', [
    { accountId: ap, debit: '100.00', credit: '0', storeId: storeA, partyType: 'supplier', partyId: 'supplier-1' },
    { accountId: cash, debit: '0', credit: '100.00', storeId: storeA },
  ]);
  await insertPostedEntry(orgId, jan, '2026-01-22', [
    { accountId: cash, debit: '500.00', credit: '0', storeId: storeB },
    { accountId: unli, debit: '0', credit: '500.00', storeId: storeB },
  ]);
  await insertPostedEntry(orgId, feb, '2026-02-05', [
    { accountId: rent, debit: '200.00', credit: '0', storeId: storeB },
    { accountId: cash, debit: '0', credit: '200.00', storeId: storeB },
  ]);
  await insertPostedEntry(orgId, feb, '2026-02-10', [
    { accountId: cash, debit: '300.00', credit: '0', storeId: storeA },
    { accountId: alc, debit: '0', credit: '300.00', storeId: storeA },
  ]);
  await insertPostedEntry(orgId, feb, '2026-02-12', [
    { accountId: comps, debit: '80.00', credit: '0', storeId: storeA },
    { accountId: cash, debit: '0', credit: '80.00', storeId: storeA },
  ]);

  return { orgId, storeA, storeB };
}

// =========================================================================================
// Trial balance service — re-proves invariants 4-6 end to end (the "ties" boolean the
// screen actually renders), plus invariant 5's filter behaviour through the service.
// =========================================================================================

describe('getTrialBalance — invariants 4-6 end to end', () => {
  it('ties over the whole corpus with ties=true and matching known totals', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const result = await getTrialBalance(db, {
      orgId,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });

    expect(result.ties).toBe(true);
    expect(result.totalDebit).toBe(result.totalCredit);
    expect(result.totalDebit).toBe('3520.00');
    expect(result.basis.orgId).toBe(orgId);
    expect(result.basis.fromDate).toBe('2026-01-01');
    expect(result.basis.toDate).toBe('2026-12-31');
  });

  it('ties within a store filter too (invariant 5)', async () => {
    const { orgId, storeA } = await postWorkedExamplesCorpus();
    const result = await getTrialBalance(db, {
      orgId,
      storeId: storeA,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });

    expect(result.ties).toBe(true);
    expect(result.totalDebit).toBe('2820.00');
    expect(result.basis.storeId).toBe(storeA);
  });

  it('an empty range still ties (0.00 = 0.00) and returns no lines — the empty-state case', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const result = await getTrialBalance(db, {
      orgId,
      fromDate: '2030-01-01',
      toDate: '2030-01-31',
    });

    expect(result.lines).toEqual([]);
    expect(result.totalDebit).toBe('0.00');
    expect(result.totalCredit).toBe('0.00');
    expect(result.ties).toBe(true);
  });

  it('a genuinely empty database (no org data at all) still returns a tied, empty result', async () => {
    const orgId = await insertOrg('empty-db');
    const result = await getTrialBalance(db, {
      orgId,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });
    expect(result.lines).toEqual([]);
    expect(result.ties).toBe(true);
  });
});

// =========================================================================================
// Income statement service — invariants 7, 8, 9, 10, 11.
// =========================================================================================

describe('invariant 7 — getIncomeStatement returns income and expense totals for a range', () => {
  it('revenue, cost of sales, and operating expenses each reflect the corpus', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const result = await getIncomeStatement(db, {
      orgId,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });

    expect(result.revenue).toBe('2670.00');
    expect(result.costOfSales).toBe('340.00');
    expect(result.operatingExpenses).toBe('200.00');
  });
});

describe('invariant 8 — a newly inserted P&L account appears in the income statement with NO code change', () => {
  it('a new account under 6000 shows up in operatingExpenseLines and moves operatingExpenses', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const jan = (
      await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} and starts_on = '2026-01-01'`
    )[0]!.id;

    const [opexHeader] = await sql<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '6000'`;
    const [newAccount] = await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, status)
      values (${orgId}, '6996', 'Brand-new OPEX account', 'expense', 'debit', ${opexHeader!.id}, true, false, 'active')
      returning id
    `;
    const cash = await accountId(orgId, '1110');
    await insertPostedEntry(orgId, jan, '2026-01-26', [
      { accountId: newAccount!.id, debit: '15.00', credit: '0' },
      { accountId: cash, debit: '0', credit: '15.00' },
    ]);

    const before = await getIncomeStatement(db, { orgId, fromDate: '2026-01-01', toDate: '2026-01-25' });
    const after = await getIncomeStatement(db, { orgId, fromDate: '2026-01-01', toDate: '2026-12-31' });

    expect(before.operatingExpenseLines.some((l) => l.accountCode === '6996')).toBe(false);
    const newLine = after.operatingExpenseLines.find((l) => l.accountCode === '6996');
    expect(newLine).toBeDefined();
    expect(newLine!.amount).toBe('15.00');
    // 200 (rent, corpus) + 15 (the new account) = 215 — no repo/domain/view code changed
    // to make this account appear; it exists purely because it is a leaf under 6000.
    expect(after.operatingExpenses).toBe('215.00');
  });
});

describe('invariant 9 — contra-revenue (4900, 4950) reduces revenue; it never increases expense', () => {
  it('revenue is net of the 50 discount and 80 comp; cost of sales and opex are untouched by them', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const result = await getIncomeStatement(db, { orgId, fromDate: '2026-01-01', toDate: '2026-12-31' });

    // Gross revenue would be 1500 (4100) + 1300 (4150) = 2800; net of 50 + 80 contra = 2670.
    expect(result.revenue).toBe('2670.00');
    expect(result.revenueLines.some((l) => l.accountCode === '4900')).toBe(true);
    expect(result.revenueLines.some((l) => l.accountCode === '4950')).toBe(true);
    // Neither contra-revenue account leaks into cost-of-sales or operating-expense lines.
    expect(result.costOfSalesLines.some((l) => l.accountCode === '4900' || l.accountCode === '4950')).toBe(false);
    expect(result.operatingExpenseLines.some((l) => l.accountCode === '4900' || l.accountCode === '4950')).toBe(
      false,
    );
    expect(result.costOfSales).toBe('340.00');
    expect(result.operatingExpenses).toBe('200.00');
  });
});

describe('invariant 10 — net income = revenue − contra − COGS − opex, on a worked fixture with a known answer', () => {
  it('operatingIncome (and, with no other-income/expense postings, netIncome) matches the hand-computed figure', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const result = await getIncomeStatement(db, { orgId, fromDate: '2026-01-01', toDate: '2026-12-31' });

    // revenue 2670 (already net of the 50 + 80 contra) − COGS 340 − opex 200 = 2130.
    const expected = '2130.00';
    expect(result.grossProfit).toBe('2330.00'); // 2670 - 340
    expect(result.operatingIncome).toBe(expected);
    // No 7xxx (other income/expense) postings exist in this corpus, so netIncome must
    // equal operatingIncome exactly — proving the extra other-income-expense layer this
    // implementation adds (see the task report) does not change the literal invariant-10
    // figure when there is nothing non-operating to fold in.
    expect(result.otherIncomeExpense).toBe('0.00');
    expect(result.netIncome).toBe(expected);
  });
});

describe('invariant 11 — a year_close entry is excluded by default and included when asked for', () => {
  it('the income statement excludes year_close by default; the trial balance includes it by default', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const revenue = await accountId(orgId, '4100');
    const retainedEarnings = await accountId(orgId, '3300');
    const y2027 = await insertPeriod(orgId, '2027-01-01', '2027-01-31', 'open');
    await insertPostedEntry(
      orgId,
      y2027,
      '2027-01-01',
      [
        { accountId: revenue, debit: '1500.00', credit: '0' },
        { accountId: retainedEarnings, debit: '0', credit: '1500.00' },
      ],
      { sourceType: 'year_close', sourceId: 'year-close-1' },
    );

    const wideRange = { orgId, fromDate: '2026-01-01', toDate: '2027-12-31' };

    // Income statement: DEFAULT excludes it — 4100's contribution stays 1500 (E1+E6),
    // not zeroed by the year-close debit.
    const isDefault = await getIncomeStatement(db, wideRange);
    const revenueLine = isDefault.revenueLines.find((l) => l.accountCode === '4100');
    expect(revenueLine!.amount).toBe('1500.00');

    // Income statement: explicitly INCLUDING it zeroes 4100's NET contribution for the
    // range — the account still HAS activity (E1, E6, and the year-close entry all
    // contributed), so the line is still present, just netted to 0.00. A row disappearing
    // entirely would mean "never touched"; that is not what happened here.
    const isIncluded = await getIncomeStatement(db, { ...wideRange, includeYearClose: true });
    const revenueLineIncluded = isIncluded.revenueLines.find((l) => l.accountCode === '4100');
    expect(revenueLineIncluded!.amount).toBe('0.00');

    // Trial balance: DEFAULT includes it (balance-sheet-as-of semantics, ADR-006) — 4100
    // nets to 0.00 in the default trial balance over this same wide range, same reasoning.
    const tbDefault = await getTrialBalance(db, wideRange);
    const tbLine = tbDefault.lines.find((l) => l.accountCode === '4100');
    expect(tbLine!.balance).toBe('0.00');

    // Trial balance: explicitly EXCLUDING it restores 4100's un-zeroed balance.
    const tbExcluded = await getTrialBalance(db, { ...wideRange, includeYearClose: false });
    const tbLineExcluded = tbExcluded.lines.find((l) => l.accountCode === '4100');
    expect(tbLineExcluded!.balance).toBe('1500.00');

    // And the trial balance still ties either way (invariant 5's own guarantee).
    expect(tbDefault.ties).toBe(true);
    expect(tbExcluded.ties).toBe(true);
  });
});
