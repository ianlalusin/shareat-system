import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-135 — integrity findings. `docs/tasks/135-integrity-findings.md`.
 *
 * ⭐ Invariants 1 and 2 of the spec are the shape of this file: **every kind has a test that makes
 * its condition true and proves it fires, AND a test proving it stays quiet otherwise.** A detector
 * with no firing test is a detector nobody knows works.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  acknowledgeFinding,
  closeReadiness,
  createCashRequest,
  createEmployment,
  decideCashRequest,
  listFindings,
  releaseCashRequest,
  seedAttendanceConfig,
  seedCanonicalPositions,
} from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD = '2026-01';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`fi-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  // T-346 S2/S3: opening_date before the fixed-asset fixtures' 2026-01-01 acquired_on below, so
  // once the S2 in-service fill trigger and S3's `periodicPostingsMissed` land, these assets read
  // as in-service (not HELD) and the depreciationNotBooked cases still fire/clear as before.
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  // T-339 (DEF-412) — every SUPPORTED store creator (`stores/service.ts:129`) seeds a live
  // attendance config; this fixture inserts by raw SQL and must match that, or
  // `attendanceConfigMissing` rightly fires for a store no real path could ever produce.
  await asOrg(orgId, (tx) =>
    seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }),
  );
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${store!.id}, 'manual')`;
  return { orgId, storeId: store!.id, admin: actor(orgId, p!.id), personId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * T-264 / DEF-284 slice 1 — gives an org enough FORWARD fiscal-period runway that
 * `fiscalPeriodRunwayLow` (wired into every `listFindings` call from this task onward) stays
 * quiet, without touching the shared January 2026 period other fixtures and tests post into.
 * Disjoint from it on purpose — real "today" is long past January, so `daysAgo(5)..daysAhead(400)`
 * cannot overlap it, the same way `openRecentPeriod` near the T-152 tests below stays disjoint for
 * its own real-clock detectors.
 */
async function openFarFutureCoverage(f: Fixture): Promise<void> {
  const now = Date.now();
  const starts = new Date(now - 5 * 86_400_000).toISOString().slice(0, 10);
  const ends = new Date(now + 400 * 86_400_000).toISOString().slice(0, 10);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${f.orgId}, ${starts}, ${ends}, 'open')`;
}

/** Post a raw pair of legs. Used to MAKE a condition true. */
async function post(f: Fixture, legs: { code: string; debit?: string; credit?: string; party?: { t: string; id: string } }[], key: string) {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: '2026-01-10',
      sourceType: 'manual_journal',
      sourceId: key,
      idempotencyKey: key,
      memo: 'fixture',
      postedBy: f.personId,
      lines: legs.map((l) => ({
        accountCode: l.code,
        storeId: f.storeId,
        ...(l.debit ? { debit: l.debit } : {}),
        ...(l.credit ? { credit: l.credit } : {}),
        ...(l.party ? { partyType: l.party.t, partyId: l.party.id } : {}),
      })),
    }),
  );
}

const feed = (f: Fixture) => asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
const kinds = async (f: Fixture) => (await feed(f)).findings.map((x) => x.kind);

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('a clean ledger reports nothing', () => {
  it('⭐ no findings at all — every detector stays quiet when its condition is absent', async () => {
    const f = await fixture('clean');
    // T-264/DEF-284 slice 1: without this, `fiscalPeriodRunwayLow` fires for every fixture here
    // (their only period, January 2026, is long past 60 days' runway by real "today") — genuinely
    // true of this org's periods, so giving it real coverage is the right fix, not a workaround.
    await openFarFutureCoverage(f);
    await post(f, [{ code: '6300', debit: '100.00' }, { code: '1110', credit: '100.00' }], uid('k'));
    const result = await feed(f);
    expect(result.findings).toEqual([]);
    expect(result.openCount).toBe(0);
    expect(result.hardCount).toBe(0);
  });

  // T-339 (DEF-412) negative half — the clean fixture's `[]` above is not vacuous proof that
  // `attendanceConfigMissing` works: `fixture()` itself now seeds a live config for its own
  // store (the slice 1 fix), so THAT store stays quiet. It is the SECOND store, inserted here by
  // raw SQL with no config of its own, that must fire — proving the detector actually fires on an
  // unconfigured store rather than never firing at all.
  it('⭐ a second, unconfigured store DOES fire attendanceConfigMissing — the clean [] above is not vacuous', async () => {
    const f = await fixture('clean2');
    await openFarFutureCoverage(f);
    const [second] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('clean2-second')}, 'Second store')
      returning id`;
    const result = await feed(f);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.kind).toBe('attendanceConfigMissing');
    expect(result.findings[0]!.storeId).toBe(second!.id);
    // Documentation only, not an independent assertion — `toHaveLength(1)` plus the `kind` check
    // above already exclude every other kind, `payoutIntervalTooLong` included. Kept because
    // DEF-412 asked this exact question by name (no config -> `liveCadenceConfigs` returns
    // nothing -> `payoutIntervalTooLong` cannot have fired) and this line is that answer, in code.
    expect(result.findings.some((x) => x.kind === 'payoutIntervalTooLong')).toBe(false);
  });
});

describe('each detector fires when its condition holds', () => {
  it('the reciprocal pair: 1250 without its 2150', async () => {
    const f = await fixture('recip');
    await post(
      f,
      [
        { code: '1250', debit: '500.00', party: { t: 'store', id: 'STORE-X' } },
        { code: '1110', credit: '500.00' },
      ],
      uid('k'),
    );
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'dueFromDueToNotReciprocal');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('hard');
    expect(finding!.detail).toMatch(/went missing/);
  });

  it('⭐ a control account line with no party — money owed by nobody', async () => {
    const f = await fixture('noparty');
    // 1210 requires a party. Posting without one is exactly the shape that makes ageing lie.
    await sql`update accounts set requires_party = false where org_id = ${f.orgId} and code = '1210'`;
    await post(f, [{ code: '1210', debit: '250.00' }, { code: '4150', credit: '250.00' }], uid('k'));
    await sql`update accounts set requires_party = true where org_id = ${f.orgId} and code = '1210'`;

    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'subledgerDoesNotMatchControl');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe('subledgerDoesNotMatchControl:1210');
    expect(finding!.detail).toMatch(/belongs to nobody/);
  });

  it('opening balance equity that does not net to zero', async () => {
    const f = await fixture('obe');
    await post(f, [{ code: '1110', debit: '900.00' }, { code: '3900', credit: '900.00' }], uid('k'));
    expect(await kinds(f)).toContain('openingBalanceEquityNonZero');
  });

  it('a channel clearing account that is not zero at rest', async () => {
    const f = await fixture('clearing');
    await post(f, [{ code: '1222', debit: '75.00' }, { code: '1110', credit: '75.00' }], uid('k'));
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'clearingAccountNotAtRest');
    expect(finding).toBeDefined();
    // ⚠️ Soft: mid-flight is normal for a moment. It is the STANDING balance that is wrong.
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/did not finish/);
  });

  it('⭐ depreciation not booked — DEF-044, which cost two silent months in v1', async () => {
    const f = await fixture('depr');
    await sql`
      insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost,
                                useful_life_months, salvage_value, status, created_by)
      values (${f.orgId}, ${f.storeId}, 'Chiller', 'equipment', '2026-01-01', 50000, 60, 0, 'active', ${f.personId})`;
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'depreciationNotBooked');
    expect(finding).toBeDefined();
    expect(finding!.detail).toMatch(/DEF-044/);
  });

  it('⚠️ and it stays quiet once the run is recorded — a no-op run still counts as having run', async () => {
    const f = await fixture('deprok');
    await sql`
      insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost,
                                useful_life_months, salvage_value, status, created_by)
      values (${f.orgId}, ${f.storeId}, 'Chiller', 'equipment', '2026-01-01', 50000, 60, 0, 'active', ${f.personId})`;
    await sql`
      insert into scheduler_runs (org_id, job, period, trigger, outcome)
      values (${f.orgId}, 'depreciation', ${PERIOD}, 'cron', 'ok')`;
    expect(await kinds(f)).not.toContain('depreciationNotBooked');
  });

  it('⛔ and it does NOT fire when there is nothing to depreciate', async () => {
    const f = await fixture('noassets');
    expect(await kinds(f)).not.toContain('depreciationNotBooked');
  });

  it('⭐ DEF-157 — a reimbursement owed to an employee, unpaid for over 30 days', async () => {
    const f = await fixture('reimb');
    await post(
      f,
      [
        { code: '6300', debit: '650.00' },
        { code: '2130', credit: '650.00', party: { t: 'employee', id: f.personId } },
      ],
      uid('k'),
    );
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'reimbursablePayableAgeing');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`reimbursablePayableAgeing:${f.personId}`);
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/₱650\.00/);
  });

  it('⚠️ and it stays quiet once the reimbursement is paid', async () => {
    const f = await fixture('reimbpaid');
    await post(
      f,
      [
        { code: '6300', debit: '650.00' },
        { code: '2130', credit: '650.00', party: { t: 'employee', id: f.personId } },
      ],
      uid('k1'),
    );
    await post(
      f,
      [
        { code: '2130', debit: '650.00', party: { t: 'employee', id: f.personId } },
        { code: '1110', credit: '650.00' },
      ],
      uid('k2'),
    );
    expect(await kinds(f)).not.toContain('reimbursablePayableAgeing');
  });

  it('⭐ DEF-159 — a cash-request float released and never liquidated, past 30 days', async () => {
    const f = await fixture('floatold');
    const [till] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId}
        and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.admin, {
        storeId: f.storeId, requestedFor: f.personId, purpose: 'Market run', amount: '2000.00', on: '2026-01-05',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.admin, { requestId: req.id, decision: 'approve', amount: '2000.00', on: '2026-01-05' }),
    );
    await asOrg(f.orgId, (tx) =>
      releaseCashRequest(tx, f.admin, { requestId: req.id, amount: '2000.00', fromMoneyAccountId: till!.id, on: '2026-01-05' }),
    );

    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'cashRequestFloatAgeing');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`cashRequestFloatAgeing:${req.id}`);
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/₱2,000\.00/);
  });

  it('⛔ and it does NOT fire while the float is recent', async () => {
    const f = await fixture('floatrecent');
    // A period covering TODAY, so a float "released" a couple of days ago is genuinely recent
    // relative to the detector's real wall-clock threshold — fixture()'s own period only covers
    // January 2026.
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const lastDay = new Date(Date.UTC(yyyy, today.getUTCMonth() + 1, 0)).getUTCDate();
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${f.orgId}, ${`${yyyy}-${mm}-01`}, ${`${yyyy}-${mm}-${lastDay}`}, 'open')
      on conflict do nothing`;
    const recentDate = new Date(today.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);

    const [till] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${f.storeId}
        and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
    const req = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.admin, {
        storeId: f.storeId, requestedFor: f.personId, purpose: 'Market run', amount: '500.00', on: recentDate,
      }),
    );
    await asOrg(f.orgId, (tx) =>
      decideCashRequest(tx, f.admin, { requestId: req.id, decision: 'approve', amount: '500.00', on: recentDate }),
    );
    await asOrg(f.orgId, (tx) =>
      releaseCashRequest(tx, f.admin, { requestId: req.id, amount: '500.00', fromMoneyAccountId: till!.id, on: recentDate }),
    );
    expect(await kinds(f)).not.toContain('cashRequestFloatAgeing');
  });
});

describe('T-218 / DEF-176 — receivingDisputeOverdue, the backstop receiving never got', () => {
  /**
   * A dispute needs an order and a line to hang off. ⚠️ A **draft** order is enough —
   * `trade_orders_dispatch_shape_check` only demands a journal entry once an order reaches
   * `dispatched`/`received`, and this detector reads `trade_discrepancies` and `stores` only.
   *
   * ⛔ `created_at` is stamped at **Manila noon**, N days back, never `now() - interval N days`:
   * the detector floors a date difference, so a fixture stamped at the current instant sits on the
   * boundary and flips with the clock. That is DEF-178 exactly, and it is the bug this whole task
   * is about — reproducing it in the test that proves the fix would be a poor joke.
   */
  async function dispute(
    f: Fixture,
    opts: { ageDays: number; value?: string; status?: 'open' | 'deferred' | 'resolved' },
  ) {
    const tag = uid('disp');
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (org_id, name, created_by)
      values (${f.orgId}, ${`Branch ${tag}`}, ${f.personId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${tag}, 'Pork', 'raw_material', 'kg', ${f.personId}) returning id`;
    const [ord] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${f.orgId}, ${f.storeId}, ${cust!.id}, '2026-01-10', 'draft', '1000.00', ${f.personId})
      returning id`;
    const [line] = await sql<{ id: string }[]>`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total)
      values (${f.orgId}, ${ord!.id}, ${item!.id}, '10', 'kg', '100.00', '1000.00') returning id`;

    const status = opts.status ?? 'open';
    const [d] = await sql<{ id: string }[]>`
      insert into trade_discrepancies (
        org_id, store_id, order_id, order_line_id, quantity, value, status,
        disposition, resolved_at, resolved_by, deferred_to, created_at)
      values (
        ${f.orgId}, ${f.storeId}, ${ord!.id}, ${line!.id}, '1', ${opts.value ?? '90.00'}, ${status},
        ${status === 'resolved' ? 'loss' : null},
        ${status === 'resolved' ? new Date() : null},
        ${status === 'resolved' ? f.personId : null},
        ${status === 'deferred' ? '2026-12-31' : null},
        ((((now() at time zone 'Asia/Manila')::date - ${opts.ageDays}::int)::timestamp
          + interval '12 hours') at time zone 'Asia/Manila'))
      returning id`;
    return d!.id;
  }

  it('⭐ fires on a dispute unresolved past 15 days, and says the age and the basis', async () => {
    const f = await fixture('dispold');
    await dispute(f, { ageDays: 20, value: '3000.00' });

    const finding = (await feed(f)).findings.find((x) => x.kind === 'receivingDisputeOverdue');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`receivingDisputeOverdue:${f.storeId}`);
    expect(finding!.storeId).toBe(f.storeId);
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/20 days old/);
    // ⚠️ DEF-175 — the figure is AT COST, and the wording has to say so.
    expect(finding!.detail).toMatch(/₱3,000\.00 at cost/);
  });

  it('⛔ does NOT fire while the dispute is inside the threshold', async () => {
    const f = await fixture('dispnew');
    await dispute(f, { ageDays: 3 });
    expect(await kinds(f)).not.toContain('receivingDisputeOverdue');
  });

  it('⛔ does NOT fire once the dispute is resolved, however old', async () => {
    const f = await fixture('dispdone');
    await dispute(f, { ageDays: 90, status: 'resolved' });
    expect(await kinds(f)).not.toContain('receivingDisputeOverdue');
  });

  it('⭐ a DEFERRED dispute still fires — a deferral is a promise to decide, not an exemption', async () => {
    const f = await fixture('dispdefer');
    await dispute(f, { ageDays: 40, status: 'deferred' });

    const finding = (await feed(f)).findings.find((x) => x.kind === 'receivingDisputeOverdue');
    expect(finding).toBeDefined();
    expect(finding!.detail).toMatch(/1 of them deferred/);
  });

  it('⚠️ exactly at the threshold it is not yet overdue; a day past it is', async () => {
    const at = await fixture('dispat15');
    await dispute(at, { ageDays: 15 });
    expect(await kinds(at)).not.toContain('receivingDisputeOverdue');

    const past = await fixture('dispat16');
    await dispute(past, { ageDays: 16 });
    expect(await kinds(past)).toContain('receivingDisputeOverdue');
  });
});

describe('T-220 / DEF-184 — commissaryUnitMismatch: goods signed for that never reached a balance', () => {
  /**
   * A received internal order line, with or without the stock movement `confirmReceipt` would have
   * written. ⚠️ Inserted directly: the detector is a pure READ, and driving the real
   * `confirmReceipt` here would test T-173's skip rather than this task's surfacing of it.
   */
  async function receivedLine(
    f: Fixture,
    opts: { withMovement: boolean; ledgerOnly?: boolean; receivedQty?: string | null; makeRoom?: boolean },
  ) {
    const tag = uid('umm');
    const [branch] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${tag}, ${'Branch ' + tag}) returning id`;
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (org_id, name, counterparty_store_id, created_by)
      values (${f.orgId}, ${'Branch ' + tag}, ${branch!.id}, ${f.personId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${tag}, 'Pork', 'raw_material', 'kg', ${f.personId}) returning id`;

    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
    const entryId = (await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, memo)
        values (${f.orgId},'2026-01-10',${period!.id},'trade_order_dispatch',${crypto.randomUUID()},'draft','fx')
        returning id`;
      const [a1] = await tx<{ id: string }[]>`select id from accounts where org_id=${f.orgId} and code='1340'`;
      const [a2] = await tx<{ id: string }[]>`select id from accounts where org_id=${f.orgId} and code='1310'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
               values (${e!.id},1,${a1!.id},${f.storeId},'1.00','0'),
                      (${e!.id},2,${a2!.id},${f.storeId},'0','1.00')`;
      await tx`update journal_entries set status='posted', posted_at=now(), posted_by=${f.personId} where id=${e!.id}`;
      return e!.id;
    })) as unknown as string;

    const [ord] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount,
        dispatched_at, dispatched_by, journal_entry_id, received_at, received_by, created_by)
      values (${f.orgId}, ${f.storeId}, ${cust!.id}, '2026-01-10', 'received', '1000.00',
        now(), ${f.personId}, ${entryId}, now(), ${f.personId}, ${f.personId}) returning id`;
    const [line] = await sql<{ id: string }[]>`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total,
        fulfilled_quantity, received_quantity, is_ledger_only)
      values (${f.orgId}, ${ord!.id}, ${item!.id}, '10', 'kg', '100.00', '1000.00', '10',
        ${opts.receivedQty === undefined ? '10' : opts.receivedQty}, ${opts.ledgerOnly ?? false})
      returning id`;

    let roomId: string | null = null;
    if (opts.withMovement || opts.makeRoom) {
      const [lt] = await sql<{ id: string }[]>`
        insert into location_types (org_id, code, name) values (${f.orgId}, ${tag}, 'Stockroom') returning id`;
      const [room] = await sql<{ id: string }[]>`
        insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
        values (${f.orgId}, ${branch!.id}, ${tag}, 'Kitchen', ${lt!.id}, 'operating', true, ${f.personId})
        returning id`;
      roomId = room!.id;
    }
    if (opts.withMovement) {
      await sql`
        insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind,
          source_type, source_id, created_by)
        values (${f.orgId}, ${branch!.id}, ${roomId}, ${item!.id}, now(), '10', 'transfer_in',
          'trade_order_receipt', ${line!.id}, ${f.personId})`;
    }
    return { branchId: branch!.id, lineId: line!.id, orderId: ord!.id, itemId: item!.id, roomId: roomId };
  }

  /** Same fixture, named for the DEF-188 tests that need the order and room ids too. */
  const receivedLineDetailed = (f: Fixture) => receivedLine(f, { withMovement: false, makeRoom: true });

  it('⭐ fires when a received line moved no stock — the state T-173 refused to corrupt and nobody surfaced', async () => {
    const f = await fixture('ummfire');
    const { branchId } = await receivedLine(f, { withMovement: false });

    const finding = (await feed(f)).findings.find((x) => x.kind === 'commissaryUnitMismatch');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`commissaryUnitMismatch:${branchId}`);
    expect(finding!.storeId).toBe(branchId);
    expect(finding!.severity).toBe('hard');
    expect(finding!.detail).toMatch(/never reached its stock ledger/);
    expect(finding!.detail).toMatch(/10\.000 in base units short/);
  });

  it('⛔ DEF-188 — does NOT fire when the receipt movement is sourced by the ORDER id, not the line id', async () => {
    // ⭐ The regression test for the false positive this detector shipped with. `confirmReceipt`
    // writes `source_id = orderLineIdByLineId[lineId] ?? orderId`, and DEF-140's comment claims
    // "every real path" supplies the map — dev data disproved it. Two Lipa orders carried
    // `trade_order_receipt` movements under the ORDER id, the stock had genuinely arrived, and a
    // line-id-only lookup reported them as never received. At `hard` severity that blocks
    // period-close readiness on a store whose books are fine.
    const f = await fixture('ummorderid');
    const { branchId, orderId, lineId, itemId, roomId } = await receivedLineDetailed(f);
    void lineId;
    await sql`
      insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind,
        source_type, source_id, created_by)
      values (${f.orgId}, ${branchId}, ${roomId}, ${itemId}, now(), '10', 'transfer_in',
        'trade_order_receipt', ${orderId}, ${f.personId})`;

    expect(await kinds(f)).not.toContain('commissaryUnitMismatch');
  });

  it('⚠️ DEF-188 — the amount is the goods at TRANSFER RATE, and the wording must not claim 1340', async () => {
    // ⛔ `1340` is carried at COST. The first version of this detail said the figure was "sitting in
    // 1340 Inventory in transit" while reporting a transfer-rate number — on dev data that read
    // ₱1,400.00 against a `1340` balance of ₱180.00. Same wrong-basis mistake as DEF-175, made in a
    // detector written after DEF-175 was filed. The assertion pins the wording, not just the number.
    const f = await fixture('ummbasis');
    await receivedLine(f, { withMovement: false });

    const finding = (await feed(f)).findings.find((x) => x.kind === 'commissaryUnitMismatch');
    expect(finding).toBeDefined();
    expect(finding!.detail).toMatch(/in base units short/);
    expect(finding!.detail).not.toMatch(/1340/);
  });

  it('⛔ does NOT fire when the line moved stock normally', async () => {
    const f = await fixture('ummok');
    await receivedLine(f, { withMovement: true });
    expect(await kinds(f)).not.toContain('commissaryUnitMismatch');
  });

  it('⛔ does NOT fire on a LEDGER-ONLY line — it is meant to move no stock', async () => {
    const f = await fixture('ummledger');
    await receivedLine(f, { withMovement: false, ledgerOnly: true });
    expect(await kinds(f)).not.toContain('commissaryUnitMismatch');
  });

  it('⛔ does NOT fire on a line nobody signed for — a NULL received_quantity is "not received", not "lost"', async () => {
    const f = await fixture('ummnull');
    await receivedLine(f, { withMovement: false, receivedQty: null });
    expect(await kinds(f)).not.toContain('commissaryUnitMismatch');
  });
});

describe('T-220 — grniNotAtRest: a receipt whose invoice never arrived', () => {
  /** Posts a `2120` GRNI credit dated `daysAgo`, partied to a supplier. */
  async function grni(f: Fixture, daysAgo: number, amount = '5000.00') {
    const tag = uid('grni');
    const [sup] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by)
      values (${f.orgId}, ${'Supplier ' + tag}, ${f.personId}) returning id`;
    const on = await sql<{ d: string }[]>`
      select (((now() at time zone 'Asia/Manila')::date - ${daysAgo}::int))::text as d`;
    const entryDate = on[0]!.d;
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${f.orgId}, ${entryDate}, ${entryDate}, 'open') on conflict do nothing`;
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${entryDate}
        and ends_on >= ${entryDate} limit 1`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, memo)
        values (${f.orgId}, ${entryDate}, ${period!.id}, 'delivery_receipt', ${crypto.randomUUID()}, 'draft', 'fx')
        returning id`;
      const [g] = await tx<{ id: string }[]>`select id from accounts where org_id=${f.orgId} and code='2120'`;
      const [stock] = await tx<{ id: string }[]>`select id from accounts where org_id=${f.orgId} and code='1310'`;
      // ⚠️ NO party on the 2120 leg — it is not a party-requiring account, and
      // journal_lines_check_party_requirement refuses one outright.
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
               values (${e!.id},1,${stock!.id},${f.storeId},${amount},'0'),
                      (${e!.id},2,${g!.id},${f.storeId},'0',${amount})`;
      await tx`update journal_entries set status='posted', posted_at=now(), posted_by=${f.personId} where id=${e!.id}`;
    });
    void sup;
    return f.storeId;
  }

  it('⭐ fires on a GRNI balance older than the threshold, naming the age', async () => {
    const f = await fixture('grniold');
    const storeId = await grni(f, 45);

    const finding = (await feed(f)).findings.find((x) => x.kind === 'grniNotAtRest');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`grniNotAtRest:${storeId}`);
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/45 days/);
    expect(finding!.detail).toMatch(/5,000\.00/);
  });

  it('⛔ does NOT fire inside the threshold', async () => {
    const f = await fixture('grninew');
    await grni(f, 5);
    expect(await kinds(f)).not.toContain('grniNotAtRest');
  });
});

describe('T-224 / DEF-186 — lowStockOrderNotProposed: low, able to order, nothing on order', () => {
  /** A branch linked to a commissary, an item with a threshold, and optional stock. */
  async function lowItem(f: Fixture, opts: { linked?: boolean; onHand?: string; threshold?: string } = {}) {
    const tag = uid('lsonp');
    const [branch] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${tag}, ${'Branch ' + tag}) returning id`;
    const [commissary] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${tag + 'C'}, ${'Com ' + tag}) returning id`;
    if (opts.linked !== false) {
      await sql`
        insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by)
        values (${f.orgId}, ${commissary!.id}, ${branch!.id}, ${f.personId})`;
    }
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${tag}, ${'Pork ' + tag}, 'raw_material', 'kg', ${f.personId}) returning id`;
    await sql`
      insert into store_item_thresholds (org_id, store_id, item_id, low_stock_threshold, set_by)
      values (${f.orgId}, ${branch!.id}, ${item!.id}, ${opts.threshold ?? '20'}, ${f.personId})`;

    if (opts.onHand) {
      const [lt] = await sql<{ id: string }[]>`
        insert into location_types (org_id, code, name) values (${f.orgId}, ${tag}, 'Stockroom') returning id`;
      const [room] = await sql<{ id: string }[]>`
        insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
        values (${f.orgId}, ${branch!.id}, ${tag}, 'Kitchen', ${lt!.id}, 'operating', true, ${f.personId})
        returning id`;
      await sql`
        insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind,
          source_type, source_id, created_by)
        values (${f.orgId}, ${branch!.id}, ${room!.id}, ${item!.id}, now(), ${opts.onHand},
          'transfer_in', 'opening', ${crypto.randomUUID()}, ${f.personId})`;
    }
    return { branchId: branch!.id, commissaryId: commissary!.id, itemId: item!.id };
  }

  /** An order from branch to commissary carrying `itemId` as the BRANCH's ask. */
  async function orderFor(
    f: Fixture,
    o: { branchId: string; commissaryId: string; itemId: string; status: string; requested?: boolean },
  ) {
    const [cust] = await sql<{ id: string }[]>`
      insert into customers (org_id, name, counterparty_store_id, created_by)
      values (${f.orgId}, ${'Cust ' + uid('c')}, ${o.branchId}, ${f.personId}) returning id`;

    let entryId: string | null = null;
    if (o.status === 'dispatched' || o.status === 'received') {
      const [period] = await sql<{ id: string }[]>`
        select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
      entryId = (await sql.begin(async (tx) => {
        const [e] = await tx<{ id: string }[]>`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, memo)
          values (${f.orgId},'2026-01-10',${period!.id},'trade_order_dispatch',${crypto.randomUUID()},'draft','fx')
          returning id`;
        const [a1] = await tx<{ id: string }[]>`select id from accounts where org_id=${f.orgId} and code='1340'`;
        const [a2] = await tx<{ id: string }[]>`select id from accounts where org_id=${f.orgId} and code='1310'`;
        await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
                 values (${e!.id},1,${a1!.id},${f.storeId},'1.00','0'),
                        (${e!.id},2,${a2!.id},${f.storeId},'0','1.00')`;
        await tx`update journal_entries set status='posted', posted_at=now(), posted_by=${f.personId} where id=${e!.id}`;
        return e!.id;
      })) as unknown as string;
    }

    const [ord] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount,
        requested_by_store_id, dispatched_at, dispatched_by, journal_entry_id, created_by)
      values (${f.orgId}, ${o.commissaryId}, ${cust!.id}, '2026-01-10', ${o.status}, '500.00',
        ${o.branchId},
        ${o.status === 'dispatched' ? sql`now()` : null},
        ${o.status === 'dispatched' ? f.personId : null},
        ${entryId}, ${f.personId}) returning id`;
    await sql`
      insert into trade_order_lines (org_id, order_id, item_id, quantity, unit, rate, line_total,
        requested_quantity, origin, approval)
      values (${f.orgId}, ${ord!.id}, ${o.itemId}, '5', 'kg', '100.00', '500.00',
        ${o.requested === false ? null : '5'},
        ${o.requested === false ? 'commissary_added' : 'requested'},
        ${o.requested === false ? 'pending' : 'not_required'})`;
    return ord!.id;
  }

  const find = async (f: Fixture) =>
    (await feed(f)).findings.find((x) => x.kind === 'lowStockOrderNotProposed');

  it('⭐ fires when a linked store is below threshold with NOTHING on order', async () => {
    const f = await fixture('lsfire');
    const { branchId } = await lowItem(f, { onHand: '4' });

    const finding = await find(f);
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`lowStockOrderNotProposed:${branchId}`);
    expect(finding!.storeId).toBe(branchId);
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/at or below threshold with nothing on order/);
  });

  it('⛔ silent when the item is on a DRAFT order', async () => {
    const f = await fixture('lsdraft');
    const ctx = await lowItem(f, { onHand: '4' });
    await orderFor(f, { ...ctx, status: 'draft' });
    expect(await find(f)).toBeUndefined();
  });

  it('⛔ silent when the item is on a DISPATCHED order — goods in a truck are ordered', async () => {
    // ⚠️ THE noise case. A detector checking only `draft` fires on every item currently in transit
    // — stock already ordered and physically on its way. openOrderFor treats dispatched as open for
    // exactly this reason, and so must this.
    const f = await fixture('lsdisp');
    const ctx = await lowItem(f, { onHand: '4' });
    await orderFor(f, { ...ctx, status: 'dispatched' });
    expect(await find(f)).toBeUndefined();
  });

  it('⛔ silent for a store with NO commissary link — it cannot order', async () => {
    const f = await fixture('lsnolink');
    await lowItem(f, { onHand: '4', linked: false });
    expect(await find(f)).toBeUndefined();
  });

  it('⛔ silent when on-hand is above threshold', async () => {
    const f = await fixture('lsok');
    await lowItem(f, { onHand: '50', threshold: '20' });
    expect(await find(f)).toBeUndefined();
  });

  it('⚠️ fires when the open order carries a DIFFERENT item — an open order is not blanket cover', async () => {
    const f = await fixture('lsother');
    const ctx = await lowItem(f, { onHand: '4' });
    const [other] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${uid('oth')}, 'Beef', 'raw_material', 'kg', ${f.personId}) returning id`;
    await orderFor(f, { ...ctx, itemId: other!.id, status: 'draft' });
    expect(await find(f)).toBeDefined();
  });

  it('⚠️ fires when the only line is a commissary_added proposal — that is not the branch ordering', async () => {
    // requested_quantity is null on a substitution the commissary offered. itemsAlreadyOnOrder
    // filters on it for the same reason: the branch has not asked for this.
    const f = await fixture('lsadded');
    const ctx = await lowItem(f, { onHand: '4' });
    await orderFor(f, { ...ctx, status: 'draft', requested: false });
    expect(await find(f)).toBeDefined();
  });

  it('one finding per STORE, not per item — 20 low items is one operational problem', async () => {
    const f = await fixture('lsagg');
    const { branchId, commissaryId } = await lowItem(f, { onHand: '4' });
    for (let i = 0; i < 2; i++) {
      const [extra] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by)
        values (${f.orgId}, ${uid('x' + i)}, ${'Extra ' + i}, 'raw_material', 'kg', ${f.personId}) returning id`;
      await sql`
        insert into store_item_thresholds (org_id, store_id, item_id, low_stock_threshold, set_by)
        values (${f.orgId}, ${branchId}, ${extra!.id}, '10', ${f.personId})`;
    }
    void commissaryId;

    const all = (await feed(f)).findings.filter((x) => x.kind === 'lowStockOrderNotProposed');
    expect(all).toHaveLength(1);
    expect(all[0]!.detail).toMatch(/3 items/);
  });
});

describe('acknowledgement accepts a risk without pretending it is fixed', () => {
  async function withFinding(hint: string) {
    const f = await fixture(hint);
    // T-264/DEF-284 slice 1 — see `openFarFutureCoverage`'s own comment: the exact-count
    // assertions below (`openCount`) would otherwise also count `fiscalPeriodRunwayLow`.
    await openFarFutureCoverage(f);
    await post(
      f,
      [
        { code: '1250', debit: '500.00', party: { t: 'store', id: 'STORE-X' } },
        { code: '1110', credit: '500.00' },
      ],
      uid('k'),
    );
    return f;
  }

  it('⭐ an acknowledged finding is off the attention list but STILL COUNTED', async () => {
    const f = await withFinding('ack');
    await asOrg(f.orgId, (tx) =>
      acknowledgeFinding(tx, f.admin, {
        findingKey: 'dueFromDueToNotReciprocal',
        note: 'Chasing the missing transfer with Malvar.',
        period: PERIOD,
      }),
    );
    const result = await feed(f);
    const finding = result.findings.find((x) => x.kind === 'dueFromDueToNotReciprocal')!;
    expect(finding.status).toBe('acknowledged');
    expect(finding.acknowledgedBy).toBe(f.personId);
    expect(finding.acknowledgementAgeDays).toBe(0);
    // ⭐ The difference from "resolved": it is still there, still counted.
    expect(result.openCount).toBe(0);
    expect(result.acknowledgedCount).toBe(1);
  });

  it('⭐ the finding VANISHES when the condition is fixed, with nobody touching it', async () => {
    const f = await withFinding('fixed');
    expect(await kinds(f)).toContain('dueFromDueToNotReciprocal');

    // Post the missing other half.
    await post(
      f,
      [
        { code: '1110', debit: '500.00' },
        { code: '2150', credit: '500.00', party: { t: 'store', id: 'STORE-Y' } },
      ],
      uid('k'),
    );
    expect(await kinds(f)).not.toContain('dueFromDueToNotReciprocal');
  });

  it('⛔ a finding that is not currently true cannot be acknowledged in advance', async () => {
    const f = await fixture('advance');
    await expect(
      asOrg(f.orgId, (tx) =>
        acknowledgeFinding(tx, f.admin, { findingKey: 'trialBalanceDoesNotTie', period: PERIOD }),
      ),
    ).rejects.toThrow(/not currently a finding/);
  });

  it('⚠️ an expired acknowledgement stops suppressing, on its own', async () => {
    const f = await withFinding('expired');
    await asOrg(f.orgId, (tx) =>
      acknowledgeFinding(tx, f.admin, { findingKey: 'dueFromDueToNotReciprocal', period: PERIOD }),
    );
    // Age it past the window. An accepted risk should be RE-accepted, not forgotten.
    await sql`
      update finding_acknowledgements
      set acknowledged_at = now() - interval '40 days', expires_at = now() - interval '10 days'
      where org_id = ${f.orgId}`;
    const result = await feed(f);
    expect(result.findings.find((x) => x.kind === 'dueFromDueToNotReciprocal')!.status).toBe('open');
    expect(result.openCount).toBe(1);
  });
});

describe('close readiness is a FILTER over the same feed, not a second engine', () => {
  it('a hard finding blocks the close even when acknowledged', async () => {
    const f = await fixture('close');
    await post(
      f,
      [
        { code: '1250', debit: '500.00', party: { t: 'store', id: 'STORE-X' } },
        { code: '1110', credit: '500.00' },
      ],
      uid('k'),
    );
    await asOrg(f.orgId, (tx) =>
      acknowledgeFinding(tx, f.admin, { findingKey: 'dueFromDueToNotReciprocal', period: PERIOD }),
    );
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    // ⚠️ Accepting a risk is not the same as the books adding up.
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking.map((b) => b.kind)).toContain('dueFromDueToNotReciprocal');
  });

  it('a clean ledger is ready to close', async () => {
    const f = await fixture('ready');
    await post(f, [{ code: '6300', debit: '10.00' }, { code: '1110', credit: '10.00' }], uid('k'));
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    expect(readiness.ready).toBe(true);
  });
});

// =====================================================================================
// T-152 — the ceiling, the cadence, and DEF-082's float
// =====================================================================================

/**
 * Post a pair of legs ON A GIVEN DATE.
 *
 * ⛔ **The date must be set at post time, never afterwards.** Invariant 5's trigger refuses any
 * UPDATE to a posted entry — *"posted journal entry … is immutable except for the reversed status
 * transition"* — which a first draft of these tests discovered by trying exactly that. Ageing a
 * fixture by rewriting `entry_date` is not available, and should not be.
 */
async function postOn(
  f: Fixture,
  on: string,
  legs: { code: string; debit?: string; credit?: string }[],
  key: string,
) {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: on,
      sourceType: 'manual_journal',
      sourceId: key,
      idempotencyKey: key,
      memo: 'fixture',
      postedBy: f.personId,
      lines: legs.map((l) => ({
        accountCode: l.code,
        storeId: f.storeId,
        ...(l.debit ? { debit: l.debit } : {}),
        ...(l.credit ? { credit: l.credit } : {}),
      })),
    }),
  );
}

/** Cashier takings on a given date — the shape that creates an un-remitted position. */
const takings = (f: Fixture, on: string, amount: string, key: string) =>
  postOn(f, on, [{ code: '1110', debit: amount }, { code: '4100', credit: amount }], key);

/** A service-charge accrual on a given date: cash in, `2160` float up. */
const serviceCharge = (f: Fixture, on: string, amount: string, key: string) =>
  postOn(f, on, [{ code: '1110', debit: amount }, { code: '2160', credit: amount }], key);

/** T-187 §3 — a second store in the SAME org, for the per-store regroup case below. */
async function addStore(orgId: string, hint: string) {
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  return { id: store!.id };
}

/** Same shape as `serviceCharge`, but posted at an EXPLICIT store rather than the fixture's own —
 *  needed once a single org holds more than one store. */
async function serviceChargeAt(f: Fixture, storeId: string, on: string, amount: string, key: string) {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: on,
      sourceType: 'manual_journal',
      sourceId: key,
      idempotencyKey: key,
      memo: 'fixture',
      postedBy: f.personId,
      lines: [
        { accountCode: '1110', storeId, debit: amount },
        { accountCode: '2160', storeId, credit: amount },
      ],
    }),
  );
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * T-152's detectors measure age against `current_date`, so their fixtures must post at REAL
 * recent dates rather than the shared January period the other tests use.
 *
 * ⚠️ `postEntry` refuses a date no open fiscal period covers, so the window has to exist. It is
 * deliberately disjoint from the January period the fixture already creates.
 */
async function openRecentPeriod(f: Fixture) {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${f.orgId}, ${daysAgo(200)}, ${daysAhead(5)}, 'open')`;
}

async function setPolicy(f: Fixture, cadence: string, ceiling: string | null) {
  await sql`update stores set remittance_cadence = ${cadence},
              unremitted_ceiling = ${ceiling} where id = ${f.storeId}`;
}

describe('T-152 — the un-remitted ceiling (bible row 129)', () => {
  it('⭐ fires when the pooled position exceeds the ceiling', async () => {
    const f = await fixture('ceil-over');
    await openRecentPeriod(f);
    await setPolicy(f, 'weekly', '5000.00');
    await takings(f, today(), '9000.00', uid('k'));
    const finding = (await feed(f)).findings.find((x) => x.kind === 'unremittedCeilingBreached');
    expect(finding).toBeDefined();
    expect(finding!.storeId).toBe(f.storeId);
    // ⛔ Soft: row 129 — visible and unignorable, never a blocked till.
    expect(finding!.severity).toBe('soft');
    // ⭐ Grouped and symbol-first via @shareat/core's formatter — never a hand-rolled
    // `₱${n.toFixed(2)}`, which prints a negative as ₱-9,000.00 with the sign in the wrong place.
    expect(finding!.detail).toMatch(/₱9,000\.00 un-remitted against a ceiling of ₱5,000\.00/);
  });

  it('stays quiet while the position is under the ceiling', async () => {
    const f = await fixture('ceil-under');
    await openRecentPeriod(f);
    await setPolicy(f, 'weekly', '5000.00');
    await takings(f, today(), '1200.00', uid('k'));
    expect(await kinds(f)).not.toContain('unremittedCeilingBreached');
  });

  it('⚠️ a `daily` store with no ceiling can never breach one', async () => {
    const f = await fixture('ceil-daily');
    await openRecentPeriod(f);
    // The default: cadence 'daily', ceiling null. Lawful — daily remittance is its own bound.
    await takings(f, today(), '999999.00', uid('k'));
    expect(await kinds(f)).not.toContain('unremittedCeilingBreached');
  });

  it('⭐ separates what CAN be remitted from what is merely held', async () => {
    const f = await fixture('ceil-unverified');
    await openRecentPeriod(f);
    await setPolicy(f, 'weekly', '1000.00');
    await takings(f, today(), '4000.00', uid('k'));
    const finding = (await feed(f)).findings.find((x) => x.kind === 'unremittedCeilingBreached');
    // No sales day exists, so none of it is verified — and the message must say so rather than
    // implying somebody is sitting on remittable cash they have refused to hand over.
    expect(finding!.detail).toMatch(/not verified yet, so it cannot/);
  });
});

describe('T-152 — the cadence clock', () => {
  it('⭐ fires when the oldest unsettled day is older than the cadence allows', async () => {
    const f = await fixture('cad-late');
    await openRecentPeriod(f);
    await setPolicy(f, 'weekly', '50000.00');
    await takings(f, daysAgo(20), '800.00', uid('k'));
    const finding = (await feed(f)).findings.find((x) => x.kind === 'remittanceOverdue');
    expect(finding).toBeDefined();
    expect(finding!.detail).toMatch(/on a weekly cadence that allows 7/);
  });

  it('stays quiet inside the cadence window', async () => {
    const f = await fixture('cad-ok');
    await openRecentPeriod(f);
    await setPolicy(f, 'weekly', '50000.00');
    await takings(f, daysAgo(2), '800.00', uid('k'));
    expect(await kinds(f)).not.toContain('remittanceOverdue');
  });

  it('⚠️ a NET OUTFLOW day is not "outstanding" — the drawer is down, not behind', async () => {
    const f = await fixture('cad-outflow');
    await openRecentPeriod(f);
    await setPolicy(f, 'weekly', '5000.00');
    // An old expense paid from the till: 1110 is credited, so the position is negative.
    await postOn(
      f,
      daysAgo(30),
      [{ code: '6300', debit: '400.00' }, { code: '1110', credit: '400.00' }],
      uid('k'),
    );
    const ks = await kinds(f);
    expect(ks).not.toContain('remittanceOverdue');
    expect(ks).not.toContain('unremittedCeilingBreached');
  });

  it('⭐ a day fully settled by a remittance stops counting — settled means NOTHING OUTSTANDING', async () => {
    const f = await fixture('cad-settled');
    await openRecentPeriod(f);
    await setPolicy(f, 'weekly', '100.00');
    const on = daysAgo(30);
    await takings(f, on, '2000.00', uid('k'));
    expect(await kinds(f)).toContain('unremittedCeilingBreached');

    // Settle it the way T-143 does — a posted remittance with an allocation against that date.
    const [r] = await sql<{ id: string }[]>`
      insert into remittances (org_id, store_id, remitted_on, status, created_by)
      values (${f.orgId}, ${f.storeId}, ${on}, 'posted', ${f.personId}) returning id`;
    await sql`insert into remittance_allocations (remittance_id, business_date, amount)
              values (${r!.id}, ${on}, '2000.00')`;

    const ks = await kinds(f);
    expect(ks).not.toContain('unremittedCeilingBreached');
    expect(ks).not.toContain('remittanceOverdue');
  });
});

describe('T-152 — DEF-082, the service-charge float nothing can discharge', () => {
  it('⭐ is SILENT on a zero float — which is the live state today', async () => {
    const f = await fixture('sc-zero');
    await openRecentPeriod(f);
    await takings(f, today(), '500.00', uid('k'));
    expect(await kinds(f)).not.toContain('serviceChargeFloatAgeing');
  });

  it('stays quiet inside the sixteen-day window', async () => {
    const f = await fixture('sc-recent');
    await openRecentPeriod(f);
    await serviceCharge(f, daysAgo(3), '300.00', uid('k'));
    expect(await kinds(f)).not.toContain('serviceChargeFloatAgeing');
  });

  it('⛔ fires once an accrual passes sixteen days, and says nothing can pay it — PER STORE', async () => {
    const f = await fixture('sc-aged');
    await openRecentPeriod(f);
    await serviceCharge(f, daysAgo(40), '300.00', uid('k'));
    const finding = (await feed(f)).findings.find((x) => x.kind === 'serviceChargeFloatAgeing');
    expect(finding).toBeDefined();
    expect(finding!.detail).toMatch(/RA 11360/);
    expect(finding!.detail).toMatch(/DEF-082/);
    // ⚠️ Soft on purpose: `hard` would block EVERY close forever, since nothing can discharge it.
    expect(finding!.severity).toBe('soft');
    // ⭐ T-187 §2 Q4 / §3 — ruled PER STORE, so the finding must carry ITS store, mirroring
    // `grniNotAtRest`'s shape. ⛔ Today's code groups by `entry_date` only and emits `storeId:
    // null` org-wide — this is a real assertion failure on the shape the regroup must produce,
    // not an import error: `serviceChargeFloatAgeing` already exists and already runs.
    expect(finding!.storeId).toBe(f.storeId);
    expect(finding!.key).toBe(`serviceChargeFloatAgeing:${f.storeId}`);
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    expect(readiness.blocking.map((b) => b.kind)).not.toContain('serviceChargeFloatAgeing');
  });

  it('⭐ ages FIFO — clearing the OLDEST accrual silences it even though the float is not empty', async () => {
    const f = await fixture('sc-fifo');
    await openRecentPeriod(f);

    await serviceCharge(f, daysAgo(40), '300.00', uid('sc-old'));
    await serviceCharge(f, daysAgo(1), '100.00', uid('sc-new'));
    const midway = (await feed(f)).findings.find((x) => x.kind === 'serviceChargeFloatAgeing');
    expect(midway).toBeDefined();
    expect(midway!.storeId).toBe(f.storeId); // per-store, same as sc-aged above

    // Pay out exactly the OLD accrual. ₱100 of float remains, but it is one day old.
    await postOn(
      f,
      daysAgo(1),
      [{ code: '2160', debit: '300.00' }, { code: '1110', credit: '300.00' }],
      uid('sc-pay'),
    );

    // ⭐ The alarm is about the AGE of what is un-cleared, not the balance. A non-empty float that
    // is all recent is exactly the healthy state a working distribution produces.
    expect(await kinds(f)).not.toContain('serviceChargeFloatAgeing');
  });

  // ⚠️ §3's reported gap: the four cases above only ever used day-3 and day-40, so the actual
  // statutory cutoff — day-16 vs day-17 — has never been exercised. `SERVICE_CHARGE_MAX_DAYS`
  // gates on `ageDays <= 16`, so sixteen must stay silent and seventeen must fire.
  //
  // ⚠️ Deliberately NOT `daysAgo()` (defined above): that helper subtracts from `Date.now()` in
  // UTC, but the detector's age comes from `MANILA_TODAY` (Postgres, Asia/Manila). Manila is
  // UTC+8, so whenever this suite runs between 16:00–23:59 UTC, Manila has already rolled over to
  // the next calendar date and a UTC-computed "sixteen days ago" would actually land on Manila's
  // seventeen — turning this exact boundary test flaky at exactly the boundary it exists to
  // prove. Shifting to Manila's wall-clock before reading the date removes that skew — the same
  // technique `manilaOffset` uses further down this file for the T-199 block, reproduced locally
  // here since that one is scoped inside its own `describe` and declared after this point.
  const manilaDaysAgo = (n: number) => {
    const d = new Date(Date.now() + 8 * 3_600_000);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  it('⚠️ stays quiet AT exactly sixteen days — the statutory boundary itself', async () => {
    const f = await fixture('sc-day16');
    await openRecentPeriod(f);
    await serviceCharge(f, manilaDaysAgo(16), '300.00', uid('k'));
    expect(await kinds(f)).not.toContain('serviceChargeFloatAgeing');
  });

  it('⚠️ fires the day the window is exceeded — seventeen days', async () => {
    const f = await fixture('sc-day17');
    await openRecentPeriod(f);
    await serviceCharge(f, manilaDaysAgo(17), '300.00', uid('k'));
    const finding = (await feed(f)).findings.find((x) => x.kind === 'serviceChargeFloatAgeing');
    expect(finding).toBeDefined();
  });

  it('⭐ T-187 §3 — the regroup: two stores, one past sixteen days and one inside it, exactly ONE finding, carrying the right storeId', async () => {
    const f = await fixture('sc-regroup');
    await openRecentPeriod(f);
    const storeB = await addStore(f.orgId, 'sc-regroup-b');
    await sql`insert into person_store_scope (person_id, store_id, source) values (${f.personId}, ${storeB.id}, 'manual')`;

    // f.storeId is PAST sixteen days — must fire, carrying f.storeId.
    await serviceCharge(f, daysAgo(40), '300.00', uid('regroup-old'));
    // storeB is INSIDE the window — must stay quiet for its OWN store, and must not be swept
    // into f.storeId's finding either.
    await serviceChargeAt(f, storeB.id, daysAgo(3), '150.00', uid('regroup-new'));

    const findings = (await feed(f)).findings.filter((x) => x.kind === 'serviceChargeFloatAgeing');
    // ⛔ Today's code groups by `entry_date` across the WHOLE ORG (no store_id in its query at
    // all) and emits `storeId: null`. It happens to also produce exactly ONE finding here —
    // nothing has been debited anywhere, so the FIFO walk stops at the very first, oldest row —
    // so a count-only assertion would pass today for the wrong reason. The real failure is that
    // the one finding it does emit names no store, so a reader cannot tell it apart from a finding
    // about storeB, and storeB's own inside-window entry is silently merged into it instead of
    // being ignored. Per store, this must be exactly one finding, and it must be f.storeId's.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.storeId).toBe(f.storeId);
    expect(findings[0]!.key).toBe(`serviceChargeFloatAgeing:${f.storeId}`);
  });

  /**
   * ⛔⛔ DEF-406 — documenting a known blind spot as a deliberate, failing-when-fixed state, not
   * proving the detector correct. `serviceChargeFloatAgeing`'s own gate is `if (balance < 0.005)
   * continue` (findings.ts:611) — no direction. A float over-discharged PAST zero reads exactly
   * like one correctly settled AT zero, and goes just as silent. This is NOT reachable through
   * `distributeServiceCharge` in this suite: the cap re-derives from the ledger on every call, so a
   * second SEQUENTIAL payout sees the first and refuses — a genuinely negative float only arises
   * from the DEF-374 concurrency class, which needs a harness this suite does not have. So the
   * negative balance below is planted with a DIRECT ledger debit, never through the function under
   * test, on purpose: this test is not exercising a real caller, it is pinning the detector's
   * CURRENT behaviour against a state that should not exist so the gap has a name and a red test
   * the day someone closes it, instead of staying a blind spot nobody wrote down.
   */
  it('⛔ DEF-406 — a float over-discharged PAST zero is ALSO silent, indistinguishable from a correctly settled one', async () => {
    const f = await fixture('sc-def406');
    await openRecentPeriod(f);
    await serviceCharge(f, daysAgo(20), '300.00', uid('def406-credit'));
    // Planted directly, never via distributeServiceCharge — an over-discharge past what was ever
    // credited, the DEF-374 concurrency shape this suite cannot construct through the real caller.
    await postOn(
      f,
      daysAgo(1),
      [{ code: '2160', debit: '500.00' }, { code: '1110', credit: '500.00' }],
      uid('def406-overdraw'),
    );

    const [row] = await sql<{ balance: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::text as balance
      from journal_lines jl join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.status <> 'draft' and a.code = '2160' and jl.store_id = ${f.storeId}`;
    // The premise, confirmed directly from the ledger, not from the detector under test: this
    // store's float is genuinely negative — over-discharged, not settled.
    expect(Number(row!.balance)).toBe(-200);

    // ⛔ DEF-406 itself: silent, exactly as if the float had been correctly paid down to zero.
    expect(await kinds(f)).not.toContain('serviceChargeFloatAgeing');
  });
});

/**
 * ⭐ **T-199 — the alarm that notices the sweep stopped.**
 *
 * ⛔ A check that asks *"did the cron run?"* needs something else scheduled to ask it. This detects
 * the missing OUTCOME instead — open shifts sitting in the data — so it is true even when the sweep
 * is dead, which is the only kind of watchdog that survives the failure it watches for.
 *
 * ⚠️ It is the control that would have caught all three of this business's historical failures:
 * v1's depreciation cron that never existed, and POS's holiday-calendar and weather jobs.
 */
describe('⛔ T-199 — stale open shifts are a HARD finding', () => {
  /** An open day (an in, no out) on a given shift day, inserted directly — the detector reads
   *  `attendance_days`, so the day is the fixture and the punches are not needed. */
  async function openDayOn(f: Fixture, shiftDay: string) {
    const [worker] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Maria Santos') returning id`;
    await asOrg(f.orgId, (tx) => seedCanonicalPositions(tx, f.orgId));
    const emp = await asOrg(f.orgId, (tx) =>
      createEmployment(tx, f.admin, {
        storeId: f.storeId, personId: worker!.id, employmentStatus: 'regular', startedOn: '2026-01-01',
      }),
    );
    const cfg = await asOrg(f.orgId, (tx) =>
      seedAttendanceConfig(tx, { orgId: f.orgId, storeId: f.storeId, effectiveFrom: '2026-01-01' }),
    );
    await sql`
      insert into attendance_days
        (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode,
         status, computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes,
         holiday_minutes, is_holiday, holiday_type)
      values (${f.orgId}, ${f.storeId}, ${worker!.id}, ${emp.id}, ${shiftDay}, ${cfg.id},
              'exact', 'open', 0, false, 0, 0, 0, false, null)`;
  }

  const manilaOffset = (days: number) => {
    const d = new Date(Date.now() + 8 * 3_600_000);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  it('⭐ a shift open for four days is reported, and reported HARD', async () => {
    const f = await fixture('stale-open');
    await openDayOn(f, manilaOffset(-4));
    const found = (await feed(f)).findings.find((x) => x.kind === 'openShiftsStale');
    expect(found).toBeDefined();
    // ⛔ HARD, because an open day is unpayable and unpaid — closing a period over one books a
    // month that still owes somebody wages.
    expect(found!.severity).toBe('hard');
    expect(found!.detail).toMatch(/never paid|unpaid/i);
    // ⚠️ And it names the fix, because a finding nobody can act on is just an alarm.
    expect(found!.detail).toMatch(/attendance-sweep/);
  });

  it('⛔ today’s open shift is NOT reported — somebody is simply still on the floor', async () => {
    const f = await fixture('open-today');
    await openDayOn(f, manilaOffset(0));
    expect(await kinds(f)).not.toContain('openShiftsStale');
  });

  it('⚠️ yesterday’s is not reported either — a night shift and an offline replay both land there', async () => {
    const f = await fixture('open-yesterday');
    await openDayOn(f, manilaOffset(-1));
    expect(await kinds(f)).not.toContain('openShiftsStale');
  });
});
