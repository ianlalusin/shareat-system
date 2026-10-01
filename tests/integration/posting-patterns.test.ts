import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-108 — proves the 11 database-checkable invariants of docs/tasks/108-worked-examples.md
 * (invariant 6, the document/fixture parity check, needs no database and lives in
 * tests/unit/posting-patterns-doc.test.ts instead — invariant 12, no floats, lives there
 * too for the same reason).
 *
 * Every fixture in tests/worked-examples/fixtures.ts posts through the REAL `postEntry`
 * against real Postgres, is read back from `journal_lines` and asserted line-for-line
 * (account, side, amount, party, in order — invariant 2), then reversed through the REAL
 * `reverseEntry` and asserted to net to exactly zero (invariant 4). This is what makes these
 * WORKED EXAMPLES rather than hand-written assertions: each one proves the database
 * accepted it, the triggers permitted it, the balance rule passed at COMMIT, and the party
 * requirement was satisfied in both directions.
 *
 * Lives under tests/integration/ (vitest.config.mts's "integration" project, matching every
 * other DB-touching suite in this repo) — CI runs "unit" BEFORE migrations, so a
 * database-touching test outside a tests/integration/ directory fails on a fresh database.
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

import { seedChartOfAccounts } from '../../packages/db/seed/chart-of-accounts';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { postEntry, reverseEntry } from '@shareat/domain';
import { getIncomeStatement, getTrialBalance } from '@shareat/domain';
import { REQUIRES_PARTY_CODES as REQUIRES_PARTY_CODES_FROM_CHART } from '../../packages/db/seed/chart-of-accounts';
import { WORKED_EXAMPLES, WORKED_EXAMPLE_IDS, type FixtureLine, type WorkedExample } from '../worked-examples/fixtures';

const sql = postgres(url, { max: 5 });

/**
 * postEntry, reverseEntry, getIncomeStatement and getTrialBalance are all reached in
 * production only through an API-layer wrapper that has already called withOrgPrincipal —
 * none of them establishes a principal itself. Standing in for that layer here, at the same
 * depth production wraps at, rather than passing `null`/the raw db handle directly.
 */
function postEntryAsOrg(input: Parameters<typeof postEntry>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => postEntry(tx, input));
}
function reverseEntryAsOrg(orgIdArg: string, input: Parameters<typeof reverseEntry>[1]) {
  return withOrgPrincipal(orgIdArg, (tx) => reverseEntry(tx, input));
}
function getIncomeStatementAsOrg(input: Parameters<typeof getIncomeStatement>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => getIncomeStatement(tx, input));
}
function getTrialBalanceAsOrg(input: Parameters<typeof getTrialBalance>[1]) {
  return withOrgPrincipal(input.orgId, (tx) => getTrialBalance(tx, input));
}

// ---------------------------------------------------------------------------------------
// One shared org for the whole corpus — deliberately, so invariant 7 (the trial balance
// ties over the WHOLE corpus) and invariant 9 (the commissary pair eliminates at entity
// level) are checking the property they claim to check: many different fixtures sharing one
// ledger, not 41 isolated single-entry databases that would trivially "tie" alone.
// ---------------------------------------------------------------------------------------
let orgId: string;
let storeIds: Record<'commissary' | 'branch1', string>;
/** fixture id -> the posted entry id, so later invariant checks (8, 9, 10, 11) can look up
 * specific fixtures' own postings without re-deriving amounts by hand. */
const postedEntryIdByFixtureId = new Map<string, string>();

async function insertPeriod(startsOn: string, endsOn: string): Promise<void> {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, m::date, (m + interval '1 month - 1 day')::date, 'open'
    from generate_series(${startsOn}::date, ${endsOn}::date, interval '1 month') m
  `;
}

async function insertStore(code: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${code}, ${name})
    returning id
  `;
  return row!.id;
}

function toPostEntryLine(line: FixtureLine): {
  accountCode: string;
  debit?: string;
  credit?: string;
  partyType?: string | null;
  partyId?: string | null;
  storeId?: string | null;
  channelId?: string | null;
  lineMemo?: string | null;
} {
  return {
    accountCode: line.accountCode,
    debit: line.debit,
    credit: line.credit,
    partyType: line.party?.type ?? null,
    partyId: line.party?.id ?? null,
    storeId: line.storeRef ? storeIds[line.storeRef] : null,
    channelId: line.channelId ?? null,
    lineMemo: line.lineMemo ?? null,
  };
}

async function postFixtureEntry(
  fixture: WorkedExample,
  lines: FixtureLine[],
  entryDate: string,
  idempotencyKey: string,
  sourceType: string = fixture.sourceType,
): Promise<string> {
  const result = await postEntryAsOrg({
    orgId,
    entryDate,
    sourceType,
    sourceId: fixture.id,
    idempotencyKey,
    memo: fixture.title,
    lines: lines.map(toPostEntryLine),
  });
  expect(result.created, `fixture ${fixture.id}: postEntry did not create a new entry`).toBe(true);
  return result.entryId;
}

interface ReadBackLine {
  line_no: number;
  account_code: string;
  debit: string;
  credit: string;
  party_type: string | null;
  party_id: string | null;
  store_id: string | null;
  channel_id: string | null;
}

async function readBackLines(entryId: string): Promise<ReadBackLine[]> {
  return sql<ReadBackLine[]>`
    select jl.line_no, a.code as account_code, jl.debit, jl.credit,
           jl.party_type, jl.party_id, jl.store_id, jl.channel_id
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId}
    order by jl.line_no
  `;
}

async function netByAccount(accountCode: string, entryIds: string[]): Promise<number> {
  const [row] = await sql<{ net: string }[]>`
    select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2) as net
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    where a.code = ${accountCode} and jl.entry_id = any(${entryIds})
  `;
  return Number(row!.net);
}

beforeAll(async () => {
  // Sanity fixed before anything else runs — a duplicate fixture id would silently collide
  // in postedEntryIdByFixtureId and every assertion after it would be checking the wrong
  // fixture's own posting.
  expect(new Set(WORKED_EXAMPLE_IDS).size, 'duplicate fixture id in tests/worked-examples/fixtures.ts').toBe(
    WORKED_EXAMPLE_IDS.length,
  );

  await sql`
    truncate table
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;

  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values ('T-108 worked examples', 't108-worked-examples')
    returning id
  `;
  orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);

  // Three wide-open periods cover every fixture's entryDate/setupEntryDates: 2026 (every
  // ordinary business-event fixture), 2027 (opening_balance + year_close's own setup
  // activity), 2028 (the year-close entry itself, dated the following January per ADR-006).
  await insertPeriod('2026-01-01', '2026-12-31');
  await insertPeriod('2027-01-01', '2027-12-31');
  await insertPeriod('2028-01-01', '2028-12-31');

  storeIds = {
    commissary: await insertStore('STORE-COMMISSARY', 'Malvar Commissary'),
    branch1: await insertStore('STORE-BRANCH1', 'Lipa Branch'),
  };
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================
// Invariants 1, 2, 3, 5 — every fixture, individually. Deliberately NOT invariant 4
// (reversal) in this same pass: every fixture shares ONE corpus org (so invariants 7-11
// below can prove something real about many fixtures coexisting in one ledger), and
// reversing a fixture the moment it posts would net its own balances back to zero before
// the corpus-wide checks ever see them — the commissary pair, the contra-revenue sales, the
// opening-balance load/reconcile pair, and the year-close entry all specifically need their
// UN-reversed effect to still be present for invariants 8-11 to prove anything. Invariant 4
// runs in its own later pass, once, after every corpus-wide check below has already read the
// intact corpus — see that pass for the reasoning spelled out again at its own definition.
// =========================================================================================

describe.each(WORKED_EXAMPLES)('$id — $title', (fixture) => {
  it('invariant 1 — posts successfully through the real postEntry', async () => {
    if (fixture.setup) {
      for (let i = 0; i < fixture.setup.length; i++) {
        const setupDate = fixture.setupEntryDates?.[i] ?? fixture.entryDate;
        const setupSourceType = fixture.setupSourceTypes?.[i] ?? fixture.sourceType;
        await postFixtureEntry(fixture, fixture.setup[i]!, setupDate, `${fixture.id}:setup:${i}`, setupSourceType);
      }
    }
    const entryId = await postFixtureEntry(fixture, fixture.expect, fixture.entryDate, fixture.id);
    postedEntryIdByFixtureId.set(fixture.id, entryId);
  });

  it('invariant 2 — produces exactly the declared lines, in order: account, side, amount, party', async () => {
    const entryId = postedEntryIdByFixtureId.get(fixture.id);
    expect(entryId, 'fixture must have posted in invariant 1 above').toBeDefined();
    const actual = await readBackLines(entryId!);
    expect(actual, `${fixture.id}: line count`).toHaveLength(fixture.expect.length);

    fixture.expect.forEach((expected, i) => {
      const row = actual[i]!;
      expect(row.account_code, `${fixture.id} line ${i + 1}: account`).toBe(expected.accountCode);
      expect(row.debit, `${fixture.id} line ${i + 1}: debit`).toBe(expected.debit ?? '0.00');
      expect(row.credit, `${fixture.id} line ${i + 1}: credit`).toBe(expected.credit ?? '0.00');
      expect(row.party_type, `${fixture.id} line ${i + 1}: party_type`).toBe(expected.party?.type ?? null);
      expect(row.party_id, `${fixture.id} line ${i + 1}: party_id`).toBe(expected.party?.id ?? null);
      if (expected.channelId !== undefined) {
        expect(row.channel_id, `${fixture.id} line ${i + 1}: channel_id`).toBe(expected.channelId);
      }
    });
  });

  it('invariant 3 — balances at COMMIT (implied by invariant 1; asserted explicitly)', async () => {
    const entryId = postedEntryIdByFixtureId.get(fixture.id)!;
    const [row] = await sql<{ total_debit: string; total_credit: string }[]>`
      select sum(debit)::numeric(14,2) as total_debit, sum(credit)::numeric(14,2) as total_credit
      from journal_lines where entry_id = ${entryId}
    `;
    expect(row!.total_debit, `${fixture.id}: total debit must equal total credit`).toBe(row!.total_credit);
  });

  it('invariant 5 — every requires_party line carries its party; every other line carries none', async () => {
    // ⚠️ Read from the CHART, never retyped here. This line used to be a hardcoded set, and it
    // went stale the moment ADR-010 made 1140 party-bearing — the invariant then asserted the
    // opposite of the truth and failed three fixtures that were correct. A guard carrying its own
    // copy of the thing it guards is a guard that eventually disagrees with it.
    const REQUIRES_PARTY_CODES = new Set(REQUIRES_PARTY_CODES_FROM_CHART);
    for (const line of fixture.expect) {
      if (REQUIRES_PARTY_CODES.has(line.accountCode)) {
        expect(line.party, `${fixture.id}: ${line.accountCode} requires a party but the fixture declares none`).not.toBeNull();
      } else {
        expect(line.party, `${fixture.id}: ${line.accountCode} must NOT carry a party`).toBeNull();
      }
    }
  });
});

// =========================================================================================
// Invariant 7 — the trial balance ties over the WHOLE corpus (closes T-110's own invariant
// 6, which referenced this corpus before it existed — see docs/tasks/110's own
// "Implementation notes" §2).
// =========================================================================================

describe('invariant 7 — the trial balance ties over the whole T-108 corpus', () => {
  it('SUM(debit) = SUM(credit) across every fixture (and every reversal) posted for this org', async () => {
    const result = await getTrialBalanceAsOrg({
      orgId,
      fromDate: '2020-01-01',
      toDate: '2030-12-31',
      includeYearClose: true,
    });
    expect(result.ties, 'trial balance must tie over the whole corpus').toBe(true);
    expect(result.totalDebit).toBe(result.totalCredit);
    // Sanity: this is checking something real, not an empty result set.
    expect(result.lines.length).toBeGreaterThan(10);
  });
});

// =========================================================================================
// Invariant 8 — contra-revenue reduces revenue; the income statement shows revenue NET, not
// expense inflated. Uses sale.discount.senior-pwd (4900) and sale.comps (4950), both already
// posted above.
// =========================================================================================

describe('invariant 8 — contra-revenue reduces revenue, never inflates expense', () => {
  it('the income statement nets 4900/4950 against gross 4100/4150, not against any expense line', async () => {
    const result = await getIncomeStatementAsOrg({
      orgId,
      fromDate: '2026-01-01',
      toDate: '2026-12-31',
    });

    // sale.discount.senior-pwd: gross 1000.00 unli, 200.00 discount.
    // sale.comps: gross 500.00 unli, 100.00 comp.
    // Both fold into 4100's own net line via v_income_statement's credit-positive-for-income
    // signing (packages/db/schema/views.ts) — a debit against a type=income,
    // normal_balance=debit contra account produces a NEGATIVE net_amount that SUBTRACTS when
    // summed with ordinary revenue's positive net_amount. No account-specific "is this
    // contra" branch exists anywhere in that view; the sign is a pure function of type.
    const revenue4100 = result.revenueLines.find((l) => l.accountCode === '4100');
    const contra4900 = result.revenueLines.find((l) => l.accountCode === '4900');
    const contra4950 = result.revenueLines.find((l) => l.accountCode === '4950');
    expect(revenue4100, '4100 must appear in revenue').toBeDefined();
    expect(contra4900, '4900 must appear in revenue (as a NEGATIVE line), not in expense').toBeDefined();
    expect(contra4950, '4950 must appear in revenue (as a NEGATIVE line), not in expense').toBeDefined();
    expect(Number(contra4900!.amount)).toBeLessThan(0);
    expect(Number(contra4950!.amount)).toBeLessThan(0);

    // Neither contra account leaks into cost of sales or operating expenses.
    expect(result.costOfSalesLines.some((l) => l.accountCode === '4900' || l.accountCode === '4950')).toBe(false);
    expect(result.operatingExpenseLines.some((l) => l.accountCode === '4900' || l.accountCode === '4950')).toBe(false);
  });
});

// =========================================================================================
// Invariant 9 — the commissary pair eliminates: total 1250 (Due from related store) equals
// total 2150 (Due to related store) at entity level. Bible invariant 6's reciprocal check.
// =========================================================================================

describe('invariant 9 — the commissary dispatch/receipt pair eliminates at entity level', () => {
  it('total 1250 across all stores equals total 2150 across all stores', async () => {
    const [row] = await sql<{ due_from: string; due_to: string }[]>`
      select
        coalesce(sum(case when a.code = '1250' then jl.debit - jl.credit else 0 end), 0)::numeric(14,2) as due_from,
        coalesce(sum(case when a.code = '2150' then jl.credit - jl.debit else 0 end), 0)::numeric(14,2) as due_to
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and a.code in ('1250', '2150')
    `;
    expect(row!.due_from, 'total Due-from must equal total Due-to — a mismatch means a transfer went missing').toBe(row!.due_to);
    expect(Number(row!.due_from)).toBeGreaterThan(0); // sanity — proves this checked something real
  });
});

// =========================================================================================
// Invariant 10 — the opening-balance fixture nets 3900 to exactly zero (ADR-005; a residual
// halts). Only true once BOTH opening_balance.load and opening_balance.reconcile have
// posted, which invariant 1's describe.each loop above already did for every fixture,
// including this pair, in fixture-array order (load before reconcile).
// =========================================================================================

describe('invariant 10 — the opening-balance fixture nets 3900 to exactly zero', () => {
  it('3900 (Opening balance equity) has a zero net balance for this org once loaded and reconciled', async () => {
    const [row] = await sql<{ net: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::numeric(14,2) as net
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and a.code = '3900'
        -- Excludes each fixture's own REVERSAL (invariant 4 reverses every fixture,
        -- including this one) — the reversal is a separate, later correction posting, not
        -- part of the load-then-reconcile pair this invariant is about. The reversal's own
        -- net-to-zero-with-its-original is already proved by invariant 4 above.
        and je.source_type = 'opening_balance' and je.status = 'posted'
    `;
    expect(row!.net, '3900 must net to exactly zero once opening_balance.load and .reconcile have both posted').toBe('0.00');
  });
});

// =========================================================================================
// Invariant 11 — the year-close entry carries source_type = 'year_close' and is excluded
// from a date-range P&L while included in a balance-sheet-as-of (ADR-006).
// =========================================================================================

describe("invariant 11 — the year-close entry is excluded from a date-range P&L, included in a balance-sheet-as-of", () => {
  it("carries source_type = 'year_close'", async () => {
    const entryId = postedEntryIdByFixtureId.get('year_close.annual');
    expect(entryId).toBeDefined();
    const [row] = await sql<{ source_type: string }[]>`select source_type from journal_entries where id = ${entryId!}`;
    expect(row!.source_type).toBe('year_close');
  });

  it('a date-range P&L over 2027 EXCLUDES it by default (income statement)', async () => {
    const result = await getIncomeStatementAsOrg({ orgId, fromDate: '2027-01-01', toDate: '2027-12-31' });
    // year_close.annual's setup posts 20,000.00 to 4100 within 2027; the close entry itself
    // (dated 2028-01-01) zeroes 4100 back out. If the close entry leaked into this range, net
    // 4100 for 2027 would read 0.00 instead of the setup's own 20,000.00.
    const line4100 = result.revenueLines.find((l) => l.accountCode === '4100');
    expect(line4100, '4100 must show the setup revenue for 2027').toBeDefined();
    expect(Number(line4100!.amount)).toBeGreaterThanOrEqual(20000);
  });

  it('a balance-sheet-as-of on/after 2028-01-01 INCLUDES it by default (trial balance)', async () => {
    const result = await getTrialBalanceAsOrg({ orgId, fromDate: '2020-01-01', toDate: '2028-12-31' });
    const line3300 = result.lines.find((l) => l.accountCode === '3300');
    expect(line3300, '3300 (Retained earnings) must show the year-close entry by default').toBeDefined();
    expect(line3300!.balance).toBe('12000.00');
  });

  it('explicitly excluding year_close from the trial balance drops 3300 back to zero movement', async () => {
    const result = await getTrialBalanceAsOrg({
      orgId,
      fromDate: '2020-01-01',
      toDate: '2028-12-31',
      includeYearClose: false,
    });
    const line3300 = result.lines.find((l) => l.accountCode === '3300');
    expect(line3300 === undefined || line3300.balance === '0.00').toBe(true);
  });
});

// =========================================================================================
// Invariant 4 — every fixture is reversible, and original + reversal net to exactly zero
// per account. Deliberately its OWN, LAST pass over every fixture: it runs only after every
// corpus-wide invariant above (7-11) has already read the intact, un-reversed corpus. See
// this file's earlier comment on the first describe.each block for the full reasoning —
// reversing a fixture the moment it posts would have zeroed out exactly the balances
// invariants 8, 9, 10 and 11 exist to check.
// =========================================================================================

describe.each(WORKED_EXAMPLES)('$id — $title (reversal)', (fixture) => {
  it('invariant 4 — reversible, and original + reversal net to exactly zero per account', async () => {
    const entryId = postedEntryIdByFixtureId.get(fixture.id);
    expect(entryId, `${fixture.id}: must already be posted from the earlier pass`).toBeDefined();
    const result = await reverseEntryAsOrg(orgId, { entryId: entryId!, reason: `T-108 reversibility proof: ${fixture.id}` });
    expect(result.created, `${fixture.id}: reversal must be newly created`).toBe(true);

    const reversalLines = await readBackLines(result.reversalEntryId);
    const originalLines = fixture.expect;
    expect(reversalLines, `${fixture.id}: reversal line count`).toHaveLength(originalLines.length);
    originalLines.forEach((original, i) => {
      const rev = reversalLines[i]!;
      expect(rev.account_code, `${fixture.id} reversal line ${i + 1}: same account`).toBe(original.accountCode);
      // The mirror: debit and credit swapped, party carried through unchanged (DEF-049).
      expect(rev.debit, `${fixture.id} reversal line ${i + 1}: debit = original credit`).toBe(original.credit ?? '0.00');
      expect(rev.credit, `${fixture.id} reversal line ${i + 1}: credit = original debit`).toBe(original.debit ?? '0.00');
      expect(rev.party_type, `${fixture.id} reversal line ${i + 1}: party_type unchanged`).toBe(original.party?.type ?? null);
      expect(rev.party_id, `${fixture.id} reversal line ${i + 1}: party_id unchanged`).toBe(original.party?.id ?? null);
    });

    const touchedAccounts = new Set(originalLines.map((l) => l.accountCode));
    for (const code of touchedAccounts) {
      const net = await netByAccount(code, [entryId!, result.reversalEntryId]);
      expect(net, `${fixture.id}: account ${code} must net to exactly zero after reversal`).toBe(0);
    }
  });
});
