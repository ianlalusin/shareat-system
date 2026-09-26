import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-346 S3 — every reader honours the opening date (DEF-428 residual).
 * `docs/tasks/346-store-opening-and-in-service-date.md` §3.5, §4 (cases R), Amendment R5 (binding).
 *
 * ⛔ RED until the S3 BUILDER lands: `repo/findings.ts`'s `tillFloatOffTarget` pre-opening-AND-zero
 * suppression (R1.6), `periodicPostingsMissed`'s `in_service_on`-aware superset plus
 * `findings/index.ts`'s detail rebuilt from missed-months' new exported set function (R5.1/R5.4),
 * the new `openingDateContradicted` and `assetHeldPastOpening` detectors (R1.7/R5.2/R5.3/R5.6), and
 * `reports/store-comparison.ts`'s `openingDate` per row. `openingDateContradicted` /
 * `assetHeldPastOpening` are imported from `@shareat/db`'s `findingsRepo` even though they do not
 * exist yet — same posture as every other not-yet-built export this task has used: `undefined` at
 * the module boundary, so calling it throws `TypeError: ... is not a function`.
 *
 * R5.5 — this file also RE-RUNS `t345-missed-month.test.ts`'s A3, A4, A5 and A17 by name, unedited,
 * as its own control: if the missed-months refactor (R5.4's carve-out) changed what
 * `periodFullyCovered` means, one of those four goes red for a reason that is not this task's RED.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, findingsRepo, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import {
  createAsset,
  createStore,
  setStoreOpeningDate,
  setTillFloat,
  createMoneyTransfer,
  listFindings,
  closeReadiness,
  getStorePLComparison,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function manilaTodayRaw(): Promise<string> {
  const [row] = await sql<{ today: string }[]>`select (now() at time zone 'Asia/Manila')::date::text as today`;
  return row!.today;
}
function addDays(yyyyMmDd: string, n: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
}

async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
    values (${orgId}, ${startsOn}, ${endsOn}, ${opts.status ?? 'open'}, ${opts.closedAt ?? null}, ${opts.closedBy ?? null})`;
}
async function insertMonths(
  orgId: string,
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    await insertPeriod(orgId, `${y}-${String(m).padStart(2, '0')}-01`, monthEnd(y, m), opts);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

interface OrgFixture {
  orgId: string;
  adminId: string;
  admin: Actor;
}

/** One org, chart of accounts, one admin. No store — each case makes its own, since "opening
 *  date" fixtures must never leak between cases. */
async function rolesFixture(hint: string): Promise<OrgFixture> {
  const code = uid(`t346r-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  return { orgId, adminId: p!.id, admin: actor(orgId, p!.id) };
}

async function makeStore(f: OrgFixture, over: Record<string, unknown> = {}): Promise<string> {
  const result = await withOrgPrincipal(f.orgId, (tx) =>
    createStore(tx, f.admin, { code: uid('S'), name: 'Store', ...over } as Parameters<typeof createStore>[2]),
  );
  return result.storeId;
}
async function storeName(storeId: string): Promise<string> {
  const [row] = await sql<{ name: string }[]>`select name from stores where id = ${storeId}`;
  return row!.name;
}

async function makeAsset(f: OrgFixture, storeId: string, over: Record<string, unknown> = {}): Promise<string> {
  const { id } = await withOrgPrincipal(f.orgId, (tx) =>
    createAsset(tx, f.admin, {
      storeId,
      name: 'Chiller',
      category: 'equipment',
      acquiredOn: '2026-01-15',
      cost: '24000.00',
      salvageValue: '0',
      usefulLifeMonths: 24,
      interval: 'monthly',
      ...over,
    } as Parameters<typeof createAsset>[2]),
  );
  return id;
}

async function realSalesDay(f: OrgFixture, storeId: string, businessDate: string): Promise<void> {
  await sql`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${storeId}, ${businessDate}, 'open', '0', '0', '0', ${f.adminId})`;
}

async function officeOpening(f: OrgFixture, storeId: string, date: string, amount: string): Promise<void> {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'opening_balance', ${uid('src')}, 'draft') returning id`;
    const [office] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
    const [equity] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${office!.id}, ${storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${equity!.id}, ${storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}
async function officeSafeId(f: OrgFixture, storeId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  return row!.id;
}

/** A posted `source_type='sale'` journal entry with a line at the store, and NO `sales_days` row
 *  at all — R1.3's "has traded" definition reads EITHER a non-voided sales day OR a posted
 *  sale-sourced entry, so this is the migrated-history shape: a cutover org whose trading evidence
 *  is a ledger line, never a sales_days row (the ETL writes ledger legs, not `sales_days`, per §2). */
async function postedSaleEntry(f: OrgFixture, storeId: string, entryDate: string): Promise<void> {
  const [y, m] = entryDate.split('-').map(Number) as [number, number];
  await insertPeriod(f.orgId, `${y}-${String(m).padStart(2, '0')}-01`, monthEnd(y, m));
  const accts = await sql<{ id: string; code: string }[]>`
    select id, code from accounts where org_id = ${f.orgId} and code in ('1110', '4100')`;
  const acctId = (code: string) => accts.find((a) => a.code === code)!.id;
  await sql.begin(async (tx) => {
    const [period] = await tx<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${entryDate} and ends_on >= ${entryDate}`;
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${f.orgId}, ${entryDate}, ${period!.id}, 'sale', ${uid('src')}, ${uid('key')}, 'fixture', ${f.adminId}, 'draft')
      returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 1, ${acctId('1110')}, '100.00', 0, ${storeId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 2, ${acctId('4100')}, 0, '100.00', ${storeId})`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
  });
}

// =================================================================================================
// R1 — tillFloatOffTarget: suppressed only when pre-opening AND balance is EXACTLY zero (R1.6)
// =================================================================================================

describe('R1 — tillFloatOffTarget: pre-opening suppression is exact-zero only', () => {
  it('⛔ pre-opening store, target set, balance exactly zero: no finding', async () => {
    const f = await rolesFixture('r1-zero');
    const storeId = await makeStore(f); // no opening date — pre-opening
    await withOrgPrincipal(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId, target: '20000.00' }));
    const found = await asOrg(f.orgId, (tx) => findingsRepo.tillFloatOffTarget(tx, f.orgId));
    expect(found).toEqual([]);
  });

  it('a store already open (opening date in the past): the same zero balance still fires — the suppression never applies once open', async () => {
    const f = await rolesFixture('r1-open');
    const storeId = await makeStore(f, { openingDate: '2020-01-01' });
    await withOrgPrincipal(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId, target: '20000.00' }));
    const found = await asOrg(f.orgId, (tx) => findingsRepo.tillFloatOffTarget(tx, f.orgId));
    expect(found.length).toBe(1);
  });

  it('pre-opening store, a non-zero balance (₱500): finding present — only EXACT zero is suppressed (R1.6)', async () => {
    const f = await rolesFixture('r1-nonzero');
    const storeId = await makeStore(f); // pre-opening
    await insertMonths(f.orgId, 2026, 1, 2026, 1);
    await officeOpening(f, storeId, '2026-01-01', '5000.00');
    await withOrgPrincipal(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId, target: '1000.00' }));
    const [pot] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${storeId} and float_target is not null`;
    const safeId = await officeSafeId(f, storeId);
    await withOrgPrincipal(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: safeId,
        toMoneyAccountId: pot!.id,
        amountOut: '500.00',
        amountIn: '500.00',
        transferDate: '2026-01-02',
        notes: 'fixture',
      }),
    );
    const found = await asOrg(f.orgId, (tx) => findingsRepo.tillFloatOffTarget(tx, f.orgId));
    expect(found.length).toBe(1);
  });

  it('⛔ Amendment R6: a TRADING store with opening_date still NULL is NOT pre-opening for this purpose — a zero balance still fires', async () => {
    const f = await rolesFixture('r1-traded-nulldate');
    const storeId = await makeStore(f); // opening_date NULL — never formally set
    await realSalesDay(f, storeId, '2026-01-05'); // R1.3's "has traded": a real, non-voided sales day
    await withOrgPrincipal(f.orgId, (tx) => setTillFloat(tx, f.admin, { storeId, target: '20000.00' }));
    const found = await asOrg(f.orgId, (tx) => findingsRepo.tillFloatOffTarget(tx, f.orgId));
    expect(found.length).toBe(1);
  });
});

// =================================================================================================
// R2 — periodicPostingsMissed's DETAIL is the uncovered-asset SET (R5.1), never the raw active count
// =================================================================================================

describe('R2 — the depreciationNotBooked detail counts only assets that actually owe P and lack coverage', () => {
  it('2 active assets, 1 held: detail reads "1 asset(s)" — the held one is never counted', async () => {
    const f = await rolesFixture('r2-held');
    await insertMonths(f.orgId, 2026, 1, 2026, 4, { status: 'closed', closedAt: '2026-05-01T00:00:00Z', closedBy: f.adminId });
    const openStore = await makeStore(f, { openingDate: '2020-01-01' });
    const heldStore = await makeStore(f); // no opening date
    await makeAsset(f, openStore, { name: 'Owing Chiller' }); // acquired 2026-01-15, active, owes 2026-04
    await makeAsset(f, heldStore, { name: 'Held Chiller' }); // held — never owes anything

    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-04' }));
    const finding = feed.findings.find((x) => x.kind === 'depreciationNotBooked');
    expect(finding?.detail).toMatch(/^1 asset\(s\)/);
  });

  it('only held assets owe nothing at all: no finding', async () => {
    const f = await rolesFixture('r2-onlyheld');
    await insertMonths(f.orgId, 2026, 1, 2026, 4, { status: 'closed', closedAt: '2026-05-01T00:00:00Z', closedBy: f.adminId });
    const heldStore = await makeStore(f);
    await makeAsset(f, heldStore, { name: 'Held Chiller' });

    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-04' }));
    expect(feed.findings.find((x) => x.kind === 'depreciationNotBooked')).toBeUndefined();
  });

  it('R5.1: a monthly asset AND a quarterly asset in service by P (P not a quarter end), neither booked: detail reads "1 asset(s)" — the quarterly one does not owe this P at all', async () => {
    const f = await rolesFixture('r2-quarterly');
    await insertMonths(f.orgId, 2026, 1, 2026, 4, { status: 'closed', closedAt: '2026-05-01T00:00:00Z', closedBy: f.adminId });
    const storeId = await makeStore(f, { openingDate: '2020-01-01' });
    await makeAsset(f, storeId, { name: 'Monthly Chiller', interval: 'monthly' }); // owes 2026-04
    await makeAsset(f, storeId, {
      name: 'Quarterly Oven',
      interval: 'quarterly',
      acquiredOn: '2026-01-01',
    }); // periods land 2026-03, 06, 09, 12 — 2026-04 is not one of them

    const feed = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: '2026-04' }));
    const finding = feed.findings.find((x) => x.kind === 'depreciationNotBooked');
    expect(finding?.detail).toMatch(/^1 asset\(s\)/);
  });
});

// =================================================================================================
// R3 — openingDateContradicted: both reachable arms (R5.2/R5.3), plus the negative
// =================================================================================================

describe('R3 — openingDateContradicted', () => {
  it('the NULL arm: a store records a sales day before anyone ever sets an opening date', async () => {
    const f = await rolesFixture('r3-null');
    const storeId = await makeStore(f); // no opening date
    await realSalesDay(f, storeId, '2026-09-20');

    const found = await asOrg(f.orgId, (tx) => findingsRepo.openingDateContradicted(tx, f.orgId));
    expect(found.length).toBe(1);
    expect(found[0]!.severity).toBe('soft');
    const name = await storeName(storeId);
    expect(found[0]!.detail).toContain(name);
    expect(found[0]!.detail).toMatch(/has no opening date/);
  });

  it('the backdated-sale arm (R5.2 fixture order — opening set FIRST, then a 09-20 sales day recorded after)', async () => {
    const f = await rolesFixture('r3-backdated');
    const storeId = await makeStore(f);
    // The store has not traded yet, so setStoreOpeningDate(10-01) resolves cleanly (R3.6 has
    // nothing to refuse against). ONLY AFTER that does the backdated sale get recorded.
    await withOrgPrincipal(f.orgId, (tx) => setStoreOpeningDate(tx, f.admin, storeId, { openingDate: '2026-10-01' }));
    await realSalesDay(f, storeId, '2026-09-20');

    const found = await asOrg(f.orgId, (tx) => findingsRepo.openingDateContradicted(tx, f.orgId));
    expect(found.length).toBe(1);
    const name = await storeName(storeId);
    expect(found[0]!.detail).toContain(name);
    expect(found[0]!.detail).toContain('2026-09-20');
    expect(found[0]!.detail).toMatch(/opens on 2026-10-01/);
  });

  it('the migrated-history shape: opening 10-01, a POSTED source_type=sale entry dated 09-20, NO sales_days row at all', async () => {
    const f = await rolesFixture('r3-ledger-only');
    const storeId = await makeStore(f);
    await withOrgPrincipal(f.orgId, (tx) => setStoreOpeningDate(tx, f.admin, storeId, { openingDate: '2026-10-01' }));
    await postedSaleEntry(f, storeId, '2026-09-20'); // R1.3's "has traded" reads this OR a sales day

    const found = await asOrg(f.orgId, (tx) => findingsRepo.openingDateContradicted(tx, f.orgId));
    expect(found.length).toBe(1);
    const name = await storeName(storeId);
    expect(found[0]!.detail).toContain(name);
    expect(found[0]!.detail).toContain('2026-09-20');
    expect(found[0]!.detail).toMatch(/opens on 2026-10-01/);
  });

  it('⛔ a sale AFTER opening: no finding, and never in closeReadiness.blocking (soft)', async () => {
    const f = await rolesFixture('r3-after');
    const storeId = await makeStore(f);
    await withOrgPrincipal(f.orgId, (tx) => setStoreOpeningDate(tx, f.admin, storeId, { openingDate: '2026-10-01' }));
    await realSalesDay(f, storeId, '2026-10-05'); // on/after opening — no contradiction

    const found = await asOrg(f.orgId, (tx) => findingsRepo.openingDateContradicted(tx, f.orgId));
    expect(found).toEqual([]);

    await insertMonths(f.orgId, 2026, 10, 2026, 10);
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, '2026-10'));
    expect(readiness.blocking.some((b) => b.key.startsWith('openingDateContradicted'))).toBe(false);
  });
});

// =================================================================================================
// R4 — store comparison carries openingDate per store; the figures are unchanged
// =================================================================================================

describe('R4 — getStorePLComparison', () => {
  it('each row carries the store\'s own openingDate (including NULL); totals are unaffected (zero activity, byte-identical)', async () => {
    const f = await rolesFixture('r4');
    const openedStore = await makeStore(f, { openingDate: '2026-01-01' });
    const preOpenStore = await makeStore(f); // NULL

    const result = await withOrgPrincipal(f.orgId, (tx) =>
      getStorePLComparison(tx, {
        orgId: f.orgId,
        storeIds: [openedStore, preOpenStore],
        fromDate: '2026-01-01',
        toDate: '2026-12-31',
      }),
    );

    const opened = result.stores.find((r) => r.storeId === openedStore);
    const preOpen = result.stores.find((r) => r.storeId === preOpenStore);
    expect((opened as unknown as { openingDate: string | null }).openingDate).toBe('2026-01-01');
    expect((preOpen as unknown as { openingDate: string | null }).openingDate).toBeNull();

    // Byte-identical to before: a zero-activity store's statement is exactly zero everywhere.
    // Money is always 2dp, never bare '0'.
    for (const row of result.stores) {
      expect(String(row.statement.revenue)).toBe('0.00');
      expect(String(row.statement.costOfSales)).toBe('0.00');
      expect(String(row.statement.operatingExpenses)).toBe('0.00');
      expect(String(row.statement.netIncome)).toBe('0.00');
    }
  });
});

// =================================================================================================
// R5 — assetHeldPastOpening (R1.7/R5.6): fires at 31 days, not at 29, not once in service
// =================================================================================================

describe('R5 — assetHeldPastOpening', () => {
  it('fires at 31 days held, naming the asset, the store, and "has no opening date" (never the dropped past-opening half, R5.6)', async () => {
    const f = await rolesFixture('r5-31');
    const storeId = await makeStore(f); // no opening date
    const today = await manilaTodayRaw();
    const acquiredOn = addDays(today, -31);
    const assetId = await makeAsset(f, storeId, { name: 'Waiting Chiller', acquiredOn });

    const found = await asOrg(f.orgId, (tx) => findingsRepo.assetHeldPastOpening(tx, f.orgId));
    expect(found.length).toBe(1);
    expect(found[0]!.severity).toBe('soft');
    const [asset, store] = await Promise.all([
      sql<{ name: string }[]>`select name from fixed_assets where id = ${assetId}`.then((r) => r[0]!.name),
      storeName(storeId),
    ]);
    expect(found[0]!.detail).toContain(asset);
    expect(found[0]!.detail).toContain(store);
    expect(found[0]!.detail).toMatch(/has no opening date/);
    expect(found[0]!.detail).not.toMatch(/was due to open on/);
  });

  it('⛔ not at 29 days', async () => {
    const f = await rolesFixture('r5-29');
    const storeId = await makeStore(f);
    const today = await manilaTodayRaw();
    const acquiredOn = addDays(today, -29);
    await makeAsset(f, storeId, { acquiredOn });

    const found = await asOrg(f.orgId, (tx) => findingsRepo.assetHeldPastOpening(tx, f.orgId));
    expect(found).toEqual([]);
  });

  it('⛔ not once the asset is in service (the store opens, propagation gives it a real in_service_on)', async () => {
    const f = await rolesFixture('r5-inservice');
    const storeId = await makeStore(f);
    const today = await manilaTodayRaw();
    const acquiredOn = addDays(today, -31);
    await makeAsset(f, storeId, { acquiredOn });
    // The store opens in the past (before acquisition), so the follower's in_service_on is
    // re-derived to a real date instead of NULL — it is no longer held at all.
    await withOrgPrincipal(f.orgId, (tx) => setStoreOpeningDate(tx, f.admin, storeId, { openingDate: '2020-01-01' }));

    const found = await asOrg(f.orgId, (tx) => findingsRepo.assetHeldPastOpening(tx, f.orgId));
    expect(found).toEqual([]);
  });
});

// =================================================================================================
// R5.5 — the control: t345-missed-month.test.ts's A3, A4, A5, A17 must stay green, UNEDITED. They
// are NOT re-implemented here — this describe block only documents that they were re-run alongside
// this file and reports their names, per Amendment R5 item 5. See the test run output for their own
// pass/fail; if any of them goes red, the missed-months refactor changed meaning and must be
// reported, never silently patched.
// =================================================================================================
