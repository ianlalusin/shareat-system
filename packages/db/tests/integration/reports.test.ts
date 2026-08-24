import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves invariants 1-6, 8, and a slice of 7/9/11 of
 * docs/tasks/110-reporting-views-and-screens.md against the three reporting VIEWS
 * directly, against real PostgreSQL (PROJECT_BIBLE.md §9 rule 3) — never a mock. The
 * fuller income-statement invariants (7 in full, 9, 10, 11's default-policy behaviour)
 * are proven at the SERVICE level in packages/domain/tests/integration/reports.test.ts,
 * matching the split packages/db/tests/integration/journal.test.ts (raw SQL/schema
 * correctness) vs packages/domain/tests/integration/post-entry.test.ts (service
 * composition) already uses.
 *
 * Written FIRST, before packages/db/schema/views.ts or migration 0010 existed, to confirm
 * the initial run fails for the right reason — "relation v_account_balance does not
 * exist" — not a typo or a wrong import.
 *
 * ⚠️ SPEC DEFECT, reported per docs/RULES.md ("report a spec defect; never silently work
 * around it"): invariant 6 asks to prove the tie "over the T-108 worked examples as a
 * corpus, not only over hand-made pairs." T-108 ("Worked examples as fixtures") is listed
 * in docs/plans/phase-1-accounting-spine.md but was never implemented — there is no
 * docs/tasks/108-*.md, and tests/worked-examples/ (repo root) is an empty placeholder
 * directory. T-110's own task header does not even list T-108 as a dependency (only
 * T-103, T-105, T-118). The WORKED_EXAMPLES corpus below is a SUBSTITUTE this task
 * authored to satisfy invariant 6's intent (a nontrivial, multi-entry, multi-store,
 * multi-period corpus, not just a hand-made pair) — it is NOT the T-108 corpus, because
 * that corpus does not exist in this codebase. See the task report.
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

import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

const sql = postgres(url, { max: 2 });

// ---------------------------------------------------------------------------------------
// Helpers — same shape as packages/db/tests/integration/journal.test.ts's own, extended
// with a store helper since these views group by store_id.
// ---------------------------------------------------------------------------------------

let orgSeq = 0;
async function insertOrg(hint: string): Promise<string> {
  const code = `rpt-${hint}-${++orgSeq}`;
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code})
    returning id
  `;
  return row!.id;
}

let storeSeq = 0;
async function insertStore(orgId: string, hint: string): Promise<string> {
  const code = `store-${hint}-${++storeSeq}`;
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${code}, ${`Store ${code}`})
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

type LineSpec = {
  accountId: string;
  debit: string;
  credit: string;
  storeId?: string | null;
  partyType?: string | null;
  partyId?: string | null;
};

type EntrySpec = {
  entryDate?: string;
  sourceType?: string;
  sourceId?: string;
  status?: 'draft' | 'posted' | 'reversed';
  reversalOfEntryId?: string | null;
};

/** Insert one entry plus its lines in a single real transaction — see journal.test.ts's
 * own identically-named helper for why this matters (the deferred balance trigger). */
async function insertEntryWithLines(
  orgId: string,
  periodId: string,
  lines: LineSpec[],
  opts: EntrySpec = {},
): Promise<string> {
  return sql.begin(async (trx) => {
    const [entry] = await trx<{ id: string }[]>`
      insert into journal_entries
        (org_id, entry_date, period_id, source_type, source_id, status, posted_at, reversal_of_entry_id)
      values
        (${orgId}, ${opts.entryDate ?? '2026-01-15'}, ${periodId},
         ${opts.sourceType ?? 'test'}, ${opts.sourceId ?? `test-${Date.now()}-${Math.random()}`},
         'draft', null, ${opts.reversalOfEntryId ?? null})
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
    const finalStatus = opts.status ?? 'draft';
    if (finalStatus !== 'draft') {
      await trx`update journal_entries set status = ${finalStatus}, posted_at = now() where id = ${entryId}`;
    }
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
  await sql.end({ timeout: 5 });
});

async function baseFixture(hint: string) {
  const orgId = await insertOrg(hint);
  await seedChartOfAccounts(sql, orgId);
  const periodId = await insertPeriod(orgId, '2026-01-01', '2026-01-31', 'open');
  const cash = await accountId(orgId, '1110');
  const revenue = await accountId(orgId, '4100');
  const opex = await accountId(orgId, '6900');
  return { orgId, periodId, cash, revenue, opex };
}

// =========================================================================================
// Invariant 1 — v_account_balance signs by normal_balance
// =========================================================================================

describe('invariant 1 — v_account_balance signs net_balance by the account normal_balance', () => {
  it('a debit-normal account (cash) with net debits reads positive', async () => {
    const { orgId, periodId, cash, revenue } = await baseFixture('inv1a');
    await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: cash, debit: '1000.00', credit: '0' },
        { accountId: revenue, debit: '0', credit: '1000.00' },
      ],
      { status: 'posted' },
    );

    const [row] = await sql<{ net_balance: string; normal_balance: string }[]>`
      select net_balance, normal_balance from v_account_balance
      where org_id = ${orgId} and account_id = ${cash}
    `;
    expect(row!.normal_balance).toBe('debit');
    expect(row!.net_balance).toBe('1000.00');
  });

  it('a credit-normal account (revenue) with net credits reads positive', async () => {
    const { orgId, periodId, cash, revenue } = await baseFixture('inv1b');
    await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: cash, debit: '1000.00', credit: '0' },
        { accountId: revenue, debit: '0', credit: '1000.00' },
      ],
      { status: 'posted' },
    );

    const [row] = await sql<{ net_balance: string; normal_balance: string }[]>`
      select net_balance, normal_balance from v_account_balance
      where org_id = ${orgId} and account_id = ${revenue}
    `;
    expect(row!.normal_balance).toBe('credit');
    expect(row!.net_balance).toBe('1000.00');
  });

  it('a contra-revenue account (4900, debit-normal but type=income) with net debits reads positive too', async () => {
    const { orgId, periodId, cash } = await baseFixture('inv1c');
    const discounts = await accountId(orgId, '4900');
    await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: discounts, debit: '50.00', credit: '0' },
        { accountId: cash, debit: '0', credit: '50.00' },
      ],
      { status: 'posted' },
    );

    const [row] = await sql<{ net_balance: string }[]>`
      select net_balance from v_account_balance where org_id = ${orgId} and account_id = ${discounts}
    `;
    // Signed by the ACCOUNT's own normal_balance (debit) — positive, even though this
    // account's economic meaning is a REDUCTION. v_income_statement (not this view) is
    // what nets it against revenue — see that view's own invariant 9.
    expect(row!.net_balance).toBe('50.00');
  });
});

// =========================================================================================
// Invariant 2 — draft entries contribute nothing to any view
// =========================================================================================

describe('invariant 2 — a draft entry contributes nothing to any view', () => {
  it('a draft entry is invisible to v_account_balance, v_trial_balance, and v_income_statement', async () => {
    const { orgId, periodId, cash, revenue } = await baseFixture('inv2');
    await insertEntryWithLines(orgId, periodId, [
      { accountId: cash, debit: '5000.00', credit: '0' },
      { accountId: revenue, debit: '0', credit: '5000.00' },
    ]); // status defaults to 'draft'

    const ab = await sql`select 1 from v_account_balance where org_id = ${orgId}`;
    expect(ab).toHaveLength(0);
    const tb = await sql`select 1 from v_trial_balance where org_id = ${orgId}`;
    expect(tb).toHaveLength(0);
    const is = await sql`select 1 from v_income_statement where org_id = ${orgId}`;
    expect(is).toHaveLength(0);
  });
});

// =========================================================================================
// Invariant 3 — a posted entry and its reversal both appear and net to exactly zero
// =========================================================================================

describe('invariant 3 — a posted entry + its reversal net to exactly zero in v_account_balance', () => {
  it('both entries are visible (status posted/reversed) and their net_balance sums to 0', async () => {
    const { orgId, periodId, cash, revenue } = await baseFixture('inv3');

    const originalId = await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: cash, debit: '300.00', credit: '0' },
        { accountId: revenue, debit: '0', credit: '300.00' },
      ],
      { status: 'posted', sourceId: 'inv3-original' },
    );
    // The reversal — the exact mirror, debit/credit swapped — matching what
    // packages/domain/src/ledger/reverse-entry.ts writes. Original flips to 'reversed'.
    await insertEntryWithLines(
      orgId,
      periodId,
      [
        { accountId: cash, debit: '0', credit: '300.00' },
        { accountId: revenue, debit: '300.00', credit: '0' },
      ],
      { status: 'posted', sourceId: 'inv3-reversal', reversalOfEntryId: originalId },
    );
    await sql`update journal_entries set status = 'reversed' where id = ${originalId}`;

    // Both entries' lines are visible — invariant text: "the original and its reversal
    // both remain in the ledger". v_account_balance groups by account, so we prove this
    // via the underlying journal_lines row count for these two entries plus the NET.
    const lines = await sql`
      select id from journal_lines where entry_id in (
        select id from journal_entries where org_id = ${orgId} and source_id in ('inv3-original', 'inv3-reversal')
      )
    `;
    expect(lines).toHaveLength(4); // both entries' lines still exist, uncascaded

    const [cashBalance] = await sql<{ net_balance: string }[]>`
      select net_balance from v_account_balance where org_id = ${orgId} and account_id = ${cash}
    `;
    const [revenueBalance] = await sql<{ net_balance: string }[]>`
      select net_balance from v_account_balance where org_id = ${orgId} and account_id = ${revenue}
    `;
    expect(cashBalance!.net_balance).toBe('0.00');
    expect(revenueBalance!.net_balance).toBe('0.00');
  });
});

// =========================================================================================
// Invariants 4-6 — v_trial_balance TIES, including across a worked-example corpus and
// within store/date-range filters.
//
// WORKED_EXAMPLES is this task's substitute for the missing T-108 corpus (see this file's
// top comment) — a realistic multi-entry, multi-store, multi-period, multi-account set:
// two cash sales, a discount, a purchase on credit, a partial AP payment, a wastage
// write-off, a rent expense, and a comp — spanning two stores and two fiscal periods.
// =========================================================================================

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

  const entries: { label: string; id: string }[] = [];

  // E1 — Store A, Jan 15 — cash sale, unli.
  entries.push({
    label: 'E1',
    id: await insertEntryWithLines(
      orgId,
      jan,
      [
        { accountId: cash, debit: '1000.00', credit: '0', storeId: storeA },
        { accountId: unli, debit: '0', credit: '1000.00', storeId: storeA },
      ],
      { status: 'posted', entryDate: '2026-01-15', sourceId: 'corpus-e1' },
    ),
  });

  // E2 — Store A, Jan 16 — cash sale, à la carte, with a senior/PWD discount.
  entries.push({
    label: 'E2',
    id: await insertEntryWithLines(
      orgId,
      jan,
      [
        { accountId: cash, debit: '950.00', credit: '0', storeId: storeA },
        { accountId: discounts, debit: '50.00', credit: '0', storeId: storeA },
        { accountId: alc, debit: '0', credit: '1000.00', storeId: storeA },
      ],
      { status: 'posted', entryDate: '2026-01-16', sourceId: 'corpus-e2' },
    ),
  });

  // E3 — Store A, Jan 17 — purchase on credit (a supplier).
  entries.push({
    label: 'E3',
    id: await insertEntryWithLines(
      orgId,
      jan,
      [
        { accountId: cogsFood, debit: '300.00', credit: '0', storeId: storeA },
        {
          accountId: ap,
          debit: '0',
          credit: '300.00',
          storeId: storeA,
          partyType: 'supplier',
          partyId: 'corpus-supplier-1',
        },
      ],
      { status: 'posted', entryDate: '2026-01-17', sourceId: 'corpus-e3' },
    ),
  });

  // E4 — Store A, Jan 18 — wastage write-off (reduces inventory).
  entries.push({
    label: 'E4',
    id: await insertEntryWithLines(
      orgId,
      jan,
      [
        { accountId: wastage, debit: '40.00', credit: '0', storeId: storeA },
        { accountId: inventory, debit: '0', credit: '40.00', storeId: storeA },
      ],
      { status: 'posted', entryDate: '2026-01-18', sourceId: 'corpus-e4' },
    ),
  });

  // E5 — Store A, Jan 20 — partial payment against the E3 payable.
  entries.push({
    label: 'E5',
    id: await insertEntryWithLines(
      orgId,
      jan,
      [
        {
          accountId: ap,
          debit: '100.00',
          credit: '0',
          storeId: storeA,
          partyType: 'supplier',
          partyId: 'corpus-supplier-1',
        },
        { accountId: cash, debit: '0', credit: '100.00', storeId: storeA },
      ],
      { status: 'posted', entryDate: '2026-01-20', sourceId: 'corpus-e5' },
    ),
  });

  // E6 — Store B, Jan 22 — cash sale, unli.
  entries.push({
    label: 'E6',
    id: await insertEntryWithLines(
      orgId,
      jan,
      [
        { accountId: cash, debit: '500.00', credit: '0', storeId: storeB },
        { accountId: unli, debit: '0', credit: '500.00', storeId: storeB },
      ],
      { status: 'posted', entryDate: '2026-01-22', sourceId: 'corpus-e6' },
    ),
  });

  // E7 — Store B, Feb 5 — rent.
  entries.push({
    label: 'E7',
    id: await insertEntryWithLines(
      orgId,
      feb,
      [
        { accountId: rent, debit: '200.00', credit: '0', storeId: storeB },
        { accountId: cash, debit: '0', credit: '200.00', storeId: storeB },
      ],
      { status: 'posted', entryDate: '2026-02-05', sourceId: 'corpus-e7' },
    ),
  });

  // E8 — Store A, Feb 10 — a cash sale later comped (partial cash refund against 4950).
  entries.push({
    label: 'E8',
    id: await insertEntryWithLines(
      orgId,
      feb,
      [
        { accountId: cash, debit: '300.00', credit: '0', storeId: storeA },
        { accountId: alc, debit: '0', credit: '300.00', storeId: storeA },
      ],
      { status: 'posted', entryDate: '2026-02-10', sourceId: 'corpus-e8' },
    ),
  });
  entries.push({
    label: 'E9',
    id: await insertEntryWithLines(
      orgId,
      feb,
      [
        { accountId: comps, debit: '80.00', credit: '0', storeId: storeA },
        { accountId: cash, debit: '0', credit: '80.00', storeId: storeA },
      ],
      { status: 'posted', entryDate: '2026-02-12', sourceId: 'corpus-e9' },
    ),
  });

  return { orgId, storeA, storeB, jan, feb, entries };
}

describe('invariant 4 — v_trial_balance ties across a multi-store, multi-period fixture', () => {
  it('SUM(debit_total) = SUM(credit_total) across the whole view for this org', async () => {
    const { orgId } = await postWorkedExamplesCorpus();

    const [row] = await sql<{ total_debit: string; total_credit: string }[]>`
      select
        coalesce(sum(debit_total), 0)::numeric(14,2) as total_debit,
        coalesce(sum(credit_total), 0)::numeric(14,2) as total_credit
      from v_trial_balance where org_id = ${orgId}
    `;
    expect(row!.total_debit).toBe(row!.total_credit);
    // Known total: E1 1000 + E2 1000 + E3 300 + E4 40 + E5 100 + E6 500 + E7 200 + E8 300 + E9 80
    expect(row!.total_debit).toBe('3520.00');
  });
});

describe('invariant 5 — store and date-range filters restrict correctly and STILL tie', () => {
  it('ties within a single-store filter (store A only)', async () => {
    const { orgId, storeA } = await postWorkedExamplesCorpus();

    const [row] = await sql<{ total_debit: string; total_credit: string }[]>`
      select
        coalesce(sum(debit_total), 0)::numeric(14,2) as total_debit,
        coalesce(sum(credit_total), 0)::numeric(14,2) as total_credit
      from v_trial_balance where org_id = ${orgId} and store_id = ${storeA}
    `;
    expect(row!.total_debit).toBe(row!.total_credit);
    // Store A only: E1 1000 + E2 1000 + E3 300 + E4 40 + E5 100 + E8 300 + E9 80 = 2820
    expect(row!.total_debit).toBe('2820.00');
  });

  it('ties within a single-store filter (store B only)', async () => {
    const { orgId, storeB } = await postWorkedExamplesCorpus();

    const [row] = await sql<{ total_debit: string; total_credit: string }[]>`
      select
        coalesce(sum(debit_total), 0)::numeric(14,2) as total_debit,
        coalesce(sum(credit_total), 0)::numeric(14,2) as total_credit
      from v_trial_balance where org_id = ${orgId} and store_id = ${storeB}
    `;
    expect(row!.total_debit).toBe(row!.total_credit);
    // Store B only: E6 500 + E7 200 = 700
    expect(row!.total_debit).toBe('700.00');
  });

  it('ties within a date-range filter that covers only January', async () => {
    const { orgId } = await postWorkedExamplesCorpus();

    const [row] = await sql<{ total_debit: string; total_credit: string }[]>`
      select
        coalesce(sum(debit_total), 0)::numeric(14,2) as total_debit,
        coalesce(sum(credit_total), 0)::numeric(14,2) as total_credit
      from v_trial_balance
      where org_id = ${orgId} and entry_date between '2026-01-01' and '2026-01-31'
    `;
    expect(row!.total_debit).toBe(row!.total_credit);
    // January only: E1..E6 = 1000+1000+300+40+100+500 = 2940
    expect(row!.total_debit).toBe('2940.00');
  });

  it('ties within a combined store + date-range filter that matches nothing (empty is still tied: 0=0)', async () => {
    const { orgId, storeB } = await postWorkedExamplesCorpus();

    const [row] = await sql<{ total_debit: string; total_credit: string }[]>`
      select
        coalesce(sum(debit_total), 0)::numeric(14,2) as total_debit,
        coalesce(sum(credit_total), 0)::numeric(14,2) as total_credit
      from v_trial_balance
      where org_id = ${orgId} and store_id = ${storeB} and entry_date between '2026-01-01' and '2026-01-21'
    `;
    expect(row!.total_debit).toBe(row!.total_credit);
    expect(row!.total_debit).toBe('0.00');
  });
});

describe('invariant 6 — the trial balance ties over the worked-example corpus AS A CORPUS (see the top-of-file spec-defect note)', () => {
  it('every individual account in the corpus reconciles to a sane balance and the grand total ties', async () => {
    const { orgId } = await postWorkedExamplesCorpus();

    const rows = await sql<{ account_code: string; net_balance: string }[]>`
      select account_code, sum(net_balance)::numeric(14,2) as net_balance
      from v_trial_balance where org_id = ${orgId}
      group by account_code
      order by account_code
    `;
    const byCode = Object.fromEntries(rows.map((r) => [r.account_code, r.net_balance]));

    // Cash: +1000 +950 +500 -100 -200 +300 -80 -40(wastage doesn't touch cash) ... compute:
    // E1 +1000, E2 +950, E3 0, E4 0 (inventory not cash), E5 -100, E6 +500, E7 -200, E8 +300, E9 -80
    expect(byCode['1110']).toBe('2370.00');
    expect(byCode['4100']).toBe('1500.00'); // E1 1000 + E6 500
    expect(byCode['4150']).toBe('1300.00'); // E2 1000 + E8 300
    expect(byCode['4900']).toBe('50.00'); // E2 discount
    expect(byCode['4950']).toBe('80.00'); // E9 comp
    expect(byCode['5100']).toBe('300.00'); // E3
    expect(byCode['5300']).toBe('40.00'); // E4
    expect(byCode['1310']).toBe('-40.00'); // E4 (credit-side reduction on a debit-normal account)
    expect(byCode['2110']).toBe('200.00'); // E3 300 - E5 100
    expect(byCode['6200']).toBe('200.00'); // E7

    const [total] = await sql<{ total_debit: string; total_credit: string }[]>`
      select
        coalesce(sum(debit_total), 0)::numeric(14,2) as total_debit,
        coalesce(sum(credit_total), 0)::numeric(14,2) as total_credit
      from v_trial_balance where org_id = ${orgId}
    `;
    expect(total!.total_debit).toBe(total!.total_credit);
  });
});

// =========================================================================================
// v_income_statement — a slice of invariants 7, 9 at the raw-view level (the fuller
// service-level proof, including 8, 10, 11, lives in
// packages/domain/tests/integration/reports.test.ts).
// =========================================================================================

describe('invariant 7 (view-level) — GROUP BY account_type returns income and expense totals', () => {
  it('two rows, income and expense, each with a sane net total', async () => {
    const { orgId } = await postWorkedExamplesCorpus();

    const rows = await sql<{ account_type: string; total: string }[]>`
      select account_type, sum(net_amount)::numeric(14,2) as total
      from v_income_statement where org_id = ${orgId}
      group by account_type
      order by account_type
    `;
    expect(rows.map((r) => r.account_type)).toEqual(['expense', 'income']);
    const income = rows.find((r) => r.account_type === 'income')!;
    const expense = rows.find((r) => r.account_type === 'expense')!;
    // income: (4100 1500 + 4150 1300) - (4900 50 + 4950 80) = 2670, all net_amount-signed
    expect(income.total).toBe('2670.00');
    // expense: 5100 300 + 5300 40 + 6200 200 = 540
    expect(expense.total).toBe('540.00');
  });
});

describe('invariant 9 (view-level) — contra-revenue reduces the revenue CATEGORY total; it never touches an expense category', () => {
  it('category=revenue nets the 4900/4950 contra lines; category=cost_of_sales/operating_expense are unaffected', async () => {
    const { orgId } = await postWorkedExamplesCorpus();

    const rows = await sql<{ category: string; total: string }[]>`
      select category, sum(net_amount)::numeric(14,2) as total
      from v_income_statement where org_id = ${orgId}
      group by category
      order by category
    `;
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, r.total]));
    // revenue: 1500 + 1300 - 50 - 80 = 2670 (net of BOTH contra accounts)
    expect(byCategory.revenue).toBe('2670.00');
    // cost_of_sales: 300 (5100) + 40 (5300) = 340 — untouched by the 4900/4950 contra lines
    expect(byCategory.cost_of_sales).toBe('340.00');
    // operating_expense: 200 (6200) — untouched
    expect(byCategory.operating_expense).toBe('200.00');
  });
});

// =========================================================================================
// Invariant 8 (view-level, THE exit-gate mechanism) — a brand-new P&L account, inserted
// AFTER the corpus is posted, appears in v_income_statement with NO code change, correctly
// bucketed by its parent header alone.
// =========================================================================================

describe('invariant 8 — a newly inserted P&L account appears in v_income_statement with no code change', () => {
  it('a new account under the EXISTING 6000 (Operating expenses) header buckets as operating_expense automatically', async () => {
    const { orgId, jan } = await postWorkedExamplesCorpus();

    const [opexHeader] = await sql<{ id: string }[]>`
      select id from accounts where org_id = ${orgId} and code = '6000'
    `;
    const [newAccount] = await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, parent_id, is_postable, is_system, status)
      values (${orgId}, '6995', 'Freshly invented OPEX account', 'expense', 'debit', ${opexHeader!.id}, true, false, 'active')
      returning id
    `;

    await insertEntryWithLines(
      orgId,
      jan,
      [
        { accountId: newAccount!.id, debit: '77.00', credit: '0' },
        { accountId: (await accountId(orgId, '1110')), debit: '0', credit: '77.00' },
      ],
      { status: 'posted', entryDate: '2026-01-25', sourceId: 'inv8-new-account' },
    );

    // No view, no repo, no domain code was touched between account creation and this
    // query — this IS the exit-gate condition 3 mechanism, proven directly.
    const [row] = await sql<{ category: string; net_amount: string }[]>`
      select category, net_amount::numeric(14,2)::text as net_amount
      from v_income_statement where org_id = ${orgId} and account_code = '6995'
    `;
    expect(row).toBeDefined();
    expect(row!.category).toBe('operating_expense');
    expect(row!.net_amount).toBe('77.00');
  });
});

// =========================================================================================
// Invariant 11 (mechanism only) — the year-close entry carries a distinct source_type, so
// a caller CAN filter it out or in. The default-policy assertion (excluded by default for
// the income statement, included by default for the trial balance) lives in the
// domain-level test — that is a SERVICE decision, not a view-shape one.
// =========================================================================================

describe('invariant 11 (mechanism) — a year_close-tagged entry is filterable via source_type', () => {
  it('excluding source_type = year_close changes the total; including it changes it back', async () => {
    const { orgId } = await postWorkedExamplesCorpus();
    const revenue = await accountId(orgId, '4100');
    const retainedEarnings = await accountId(orgId, '3300');

    // entryDate 2027-01-01 (ADR-006's own convention for the year-close entry's date)
    // falls outside every fiscal_periods row postWorkedExamplesCorpus() created — insert
    // a period covering it so the entry can post at all.
    const y2027 = await insertPeriod(orgId, '2027-01-01', '2027-01-31', 'open');
    await insertEntryWithLines(
      orgId,
      y2027,
      [
        { accountId: revenue, debit: '1500.00', credit: '0' },
        { accountId: retainedEarnings, debit: '0', credit: '1500.00' },
      ],
      { status: 'posted', entryDate: '2027-01-01', sourceType: 'year_close', sourceId: 'inv11-year-close' },
    );

    const [withIt] = await sql<{ total: string }[]>`
      select coalesce(sum(net_amount), 0)::numeric(14,2) as total
      from v_income_statement where org_id = ${orgId} and account_code = '4100'
    `;
    const [withoutIt] = await sql<{ total: string }[]>`
      select coalesce(sum(net_amount), 0)::numeric(14,2) as total
      from v_income_statement
      where org_id = ${orgId} and account_code = '4100' and source_type <> 'year_close'
    `;
    // 4100 before year-close: E1 credit 1000 + E6 credit 500 = net +1500. The year-close
    // entry DEBITS 4100 by 1500 to zero it out (ADR-006: "every income and expense
    // balance for the year zeroes into 3300"), net -1500. WITH it: 1500 - 1500 = 0 (the
    // account is correctly zeroed for the next year). WITHOUT it: back to 1500. The
    // mechanism (source_type is a real, filterable column) is the point, not the figure.
    expect(withIt!.total).toBe('0.00');
    expect(withoutIt!.total).toBe('1500.00');
  });
});
