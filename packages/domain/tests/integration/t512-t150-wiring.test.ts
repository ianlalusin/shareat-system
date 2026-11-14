import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-512 (T-511 S5c) TESTER - the T-150 channel-settlement variance tolerance reads the rule book. docs/tasks/512-business-rules-s5c-spec.md "Wiring" item 1.
 * Real Postgres. `previewChannelSettlement` and `recordChannelSettlement` are the public entry points; the tests drive those, never an internal.
 *
 *   DIFFERENTIAL (green today, must stay green): the T-150 tolerance as it stood at the S5b commit (bef7113: toleranceMillsFor / millsToMoney / pastTolerance, FROZEN below)
 *   against the new path at the DEFAULT rules, over a wide gross sweep that includes half-centavo edges and the floor/percent crossover. Same tolerance shown, same
 *   "short by" flag, same "needs acknowledgement" flag, for every figure.
 *   EFFECT (red today): a floor or percent set from a date changes the preview and the posting from that date, and not before; a future row is unused.
 *
 * Rules are put in force on past business dates with a RAW insert (the writer refuses backdating, rightly; a test has no other way to reach 2026-01).
 * Existing suites the builder must keep green UNCHANGED: channel-settlements, t351-review-followups, t440-s6-money-refusals, t507-platform-receivables.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { previewChannelSettlement, recordChannelSettlement } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { putRule } from './_fixtures/t512-rules';

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

async function fixture(hint: string, receivable: string) {
  const code = uid(`t512t150-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('malvar')}, 'Store malvar') returning id`;
  const storeId = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const [bank] = await sql<{ id: string }[]>`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${orgId}, ${storeId}, ${`Foodpanda ${uid('c')}`}, false, '1220', ${bank!.id}) returning id`;
  const [day] = await sql<{ id: string }[]>`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${storeId}, '2026-01-10', 0, 0, 0, ${p!.id}) returning id`;
  const f = { orgId, storeId, channelId: channel!.id, salesDayId: day!.id, personId: p!.id, manager: { personId: p!.id, orgId } as Actor };
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-10', sourceType: 'sales_day', sourceId: f.salesDayId, idempotencyKey: `sales_day:${f.salesDayId}:${receivable}`, memo: 'Channel day', postedBy: f.personId,
      lines: [
        { accountCode: '1220', storeId, debit: receivable, partyType: 'channel', partyId: f.channelId },
        { accountCode: '4150', storeId, credit: receivable },
      ],
    }),
  );
  return f;
}
type Fx = Awaited<ReturnType<typeof fixture>>;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/* ------------------------------------------------------------------ FROZEN: the T-150 tolerance at bef7113 (do not "fix" these) */
const oldToleranceMills = (grossCentavos: bigint): bigint => {
  const abs = grossCentavos < 0n ? -grossCentavos : grossCentavos;
  return abs > 50_000n ? abs : 50_000n;
};
const oldMillsToCentavos = (mills: bigint): bigint => (mills + 5n) / 10n;
const oldPastTolerance = (centavos: bigint, toleranceMills: bigint): boolean => centavos * 10n > toleranceMills + 5n;

const fmt = (c: bigint): string => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;

const preview = (f: Fx, o: { gross: bigint; net: bigint; businessDate?: string; acknowledge?: boolean }) =>
  asOrg(f.orgId, (tx) =>
    previewChannelSettlement(tx, f.manager, {
      storeId: f.storeId, channelId: f.channelId, businessDate: o.businessDate ?? '2026-01-10',
      grossAmount: fmt(o.gross), netDeposited: fmt(o.net), ...(o.acknowledge ? { acknowledgeDifference: { reason: 'checked against the statement' } } : {}),
    }),
  );
const record = (f: Fx, o: { gross: string; net: string; businessDate?: string; acknowledge?: boolean }) =>
  asOrg(f.orgId, (tx) =>
    recordChannelSettlement(tx, f.manager, {
      storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId, businessDate: o.businessDate ?? '2026-01-10',
      grossAmount: o.gross, netDeposited: o.net, settledOn: '2026-01-15', ...(o.acknowledge ? { acknowledgeDifference: { reason: 'checked against the statement' } } : {}),
    }),
  );

describe('T-512 T-150 - DIFFERENTIAL: at the default rules the tolerance is exactly what S5b computed (green today, must stay green)', () => {
  // centavo figures: below the floor, on it, either side of the crossover at 500.00 (gross 50_000 centavos = 50_000 mills), half-centavo tolerances (odd last digit), big
  const GROSSES = [1n, 49n, 99n, 500n, 4_999n, 5_000n, 5_001n, 12_345n, 49_999n, 50_000n, 50_001n, 50_009n, 50_011n, 99_999n, 100_000n, 123_457n, 1_234_567n, 1_234_569n, 5_000_001n, 100_000_001n];

  it('for every gross: the tolerance shown, the "short by" flag and the "needs acknowledgement" flag equal the frozen S5b answers, one centavo either side of the edge, shortfall AND gain [kills: a changed rounding; a crossover that moved; a half-centavo edge lost]', async () => {
    const f = await fixture('diff', '2000000.00');
    let checked = 0;
    for (const gross of GROSSES) {
      const tm = oldToleranceMills(gross);
      const edge = (tm + 5n) / 10n + 1n; // the least centavo variance the old rule refuses
      const wantTolerance = fmt(oldMillsToCentavos(tm));
      for (const v of new Set([0n, 1n, edge - 1n, edge, edge + 1n])) {
        if (v < 0n) continue;
        // shortfall v: net = gross - v   (net cannot be negative)
        if (v <= gross) {
          const p = await preview(f, { gross, net: gross - v });
          expect(String(p.tolerance), `gross ${fmt(gross)} short ${fmt(v)}: tolerance shown`).toBe(wantTolerance);
          expect(String(p.variance)).toBe(fmt(v));
          const flagged = p.blockers.some((b) => /short by/.test(b));
          expect(flagged, `gross ${fmt(gross)} short ${fmt(v)}: flagged`).toBe(oldPastTolerance(v, tm));
          checked++;
        }
        // gain v: net = gross + v
        const g = await preview(f, { gross, net: gross + v });
        expect(String(g.tolerance), `gross ${fmt(gross)} gain ${fmt(v)}: tolerance shown`).toBe(wantTolerance);
        expect(g.needsAcknowledgement, `gross ${fmt(gross)} gain ${fmt(v)}: needs acknowledgement`).toBe(oldPastTolerance(v, tm));
        expect(g.blockers.some((b) => /acknowledgeDifference/.test(b))).toBe(oldPastTolerance(v, tm));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('the recorded posting agrees with the preview at the edge: the largest passing shortfall posts, one centavo more is refused [kills: preview and posting reading different tolerances]', async () => {
    const f = await fixture('diff-record', '20000.00');
    // gross 10,000.00: tolerance 1,000.00 (10%); 1,000.00 short passes, 1,000.01 short does not
    const ok = await record(f, { gross: '10000.00', net: '9000.00' });
    expect(ok.variance).toBe('1000.00');
    const g2 = await fixture('diff-record2', '20000.00');
    await expect(record(g2, { gross: '10000.00', net: '8999.99' })).rejects.toThrow(/past the/);
  });
});

describe('T-512 T-150 - EFFECT: a floor or percent set from a date moves the tolerance from that date (red today)', () => {
  it('a variance floor of 200.00 from 5 Jan: on 10 Jan a 150.00 shortfall on a 1,000.00 day passes (tolerance 200.00); on 3 Jan, before it, the old 100.00 applies and the same shortfall is refused [kills: the floor read as a constant; the date ignored]', async () => {
    const f = await fixture('floor', '5000.00');
    await putRule(sql, f.orgId, 'settlement.variance_floor_amount', '200.000000', '2026-01-05');
    const after = await preview(f, { gross: 100_000n, net: 100_000n - 15_000n, businessDate: '2026-01-10' });
    expect(String(after.tolerance)).toBe('200.00');
    expect(after.blockers.some((b) => /short by/.test(b))).toBe(false);
    const before = await preview(f, { gross: 100_000n, net: 100_000n - 15_000n, businessDate: '2026-01-03' });
    expect(String(before.tolerance)).toBe('100.00');
    expect(before.blockers.some((b) => /short by/.test(b))).toBe(true);
    // the day the row starts is already its day
    const onDay = await preview(f, { gross: 100_000n, net: 100_000n, businessDate: '2026-01-05' });
    expect(String(onDay.tolerance)).toBe('200.00');
  });

  it('the same figure decides the POSTING: with the floor at 200.00 the 150.00 shortfall posts and sweeps to variance; with the defaults it is refused [kills: only the preview wired]', async () => {
    const withRule = await fixture('floor-post', '5000.00');
    await putRule(sql, withRule.orgId, 'settlement.variance_floor_amount', '200.000000', '2026-01-05');
    const r = await record(withRule, { gross: '1000.00', net: '850.00' });
    expect(r.variance).toBe('150.00');
    const plain = await fixture('floor-post-default', '5000.00');
    await expect(record(plain, { gross: '1000.00', net: '850.00' })).rejects.toThrow(/past the/);
  });

  it('a variance percent of 20 from 5 Jan makes the tolerance 2,000.00 on a 10,000.00 day; 12.5 makes it 1,250.00 and the edge is at 1,250.00 / 1,250.01 [kills: percent fixed at 10; basis points lost below a whole percent step]', async () => {
    const f = await fixture('pct', '50000.00');
    await putRule(sql, f.orgId, 'settlement.variance_percent', '20.000000', '2026-01-05');
    const p = await preview(f, { gross: 1_000_000n, net: 1_000_000n - 150_000n });
    expect(String(p.tolerance)).toBe('2000.00');
    expect(p.blockers.some((b) => /short by/.test(b)), '1,500.00 is inside 20%').toBe(false);
    const was = await preview(f, { gross: 1_000_000n, net: 1_000_000n - 150_000n, businessDate: '2026-01-04' });
    expect(String(was.tolerance)).toBe('1000.00');
    expect(was.blockers.some((b) => /short by/.test(b))).toBe(true);

    const g = await fixture('pct125', '50000.00');
    await putRule(sql, g.orgId, 'settlement.variance_percent', '12.500000', '2026-01-05');
    const at = await preview(g, { gross: 1_000_000n, net: 1_000_000n - 125_000n });
    expect(String(at.tolerance)).toBe('1250.00');
    expect(at.blockers.some((b) => /short by/.test(b))).toBe(false);
    const over = await preview(g, { gross: 1_000_000n, net: 1_000_000n - 125_001n });
    expect(over.blockers.some((b) => /short by/.test(b))).toBe(true);
  });

  it('floor 0 and percent 0: no tolerance at all, a centavo is already refused and an exact day is not [kills: zero read as "unset"]', async () => {
    const f = await fixture('zero', '5000.00');
    await putRule(sql, f.orgId, 'settlement.variance_floor_amount', '0.000000', '2026-01-05');
    await putRule(sql, f.orgId, 'settlement.variance_percent', '0.000000', '2026-01-05');
    const exact = await preview(f, { gross: 100_000n, net: 100_000n });
    expect(String(exact.tolerance)).toBe('0.00');
    expect(exact.blockers).toEqual([]);
    const cent = await preview(f, { gross: 100_000n, net: 100_000n - 1n });
    expect(cent.blockers.some((b) => /short by/.test(b))).toBe(true);
  });

  it('a row that starts AFTER the business date is not used; another org\'s row is not used [kills: the latest row regardless of date; a cross-org read]', async () => {
    const f = await fixture('future', '5000.00');
    const other = await fixture('future-other', '5000.00');
    await putRule(sql, f.orgId, 'settlement.variance_floor_amount', '900.000000', '2026-01-20');
    await putRule(sql, other.orgId, 'settlement.variance_floor_amount', '900.000000', '2026-01-01');
    const p = await preview(f, { gross: 100_000n, net: 100_000n, businessDate: '2026-01-10' });
    expect(String(p.tolerance)).toBe('100.00');
    const q = await preview(f, { gross: 100_000n, net: 100_000n, businessDate: '2026-01-25' });
    expect(String(q.tolerance)).toBe('900.00');
  });

  it('the gain side follows the same rule: a gain of 150.00 on a 1,000.00 day needs acknowledgement by default and not once the floor is 200.00 [kills: only the shortfall side wired]', async () => {
    const f = await fixture('gain', '5000.00');
    const before = await preview(f, { gross: 100_000n, net: 100_000n + 15_000n });
    expect(before.needsAcknowledgement).toBe(true);
    await putRule(sql, f.orgId, 'settlement.variance_floor_amount', '200.000000', '2026-01-05');
    const after = await preview(f, { gross: 100_000n, net: 100_000n + 15_000n });
    expect(after.needsAcknowledgement).toBe(false);
  });
});
