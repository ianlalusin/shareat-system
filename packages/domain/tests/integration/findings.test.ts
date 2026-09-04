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
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  return { orgId, storeId: store!.id, admin: actor(orgId, p!.id), personId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

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
    await post(f, [{ code: '6300', debit: '100.00' }, { code: '1110', credit: '100.00' }], uid('k'));
    const result = await feed(f);
    expect(result.findings).toEqual([]);
    expect(result.openCount).toBe(0);
    expect(result.hardCount).toBe(0);
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

describe('acknowledgement accepts a risk without pretending it is fixed', () => {
  async function withFinding(hint: string) {
    const f = await fixture(hint);
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

  it('⛔ fires once an accrual passes sixteen days, and says nothing can pay it', async () => {
    const f = await fixture('sc-aged');
    await openRecentPeriod(f);
    await serviceCharge(f, daysAgo(40), '300.00', uid('k'));
    const finding = (await feed(f)).findings.find((x) => x.kind === 'serviceChargeFloatAgeing');
    expect(finding).toBeDefined();
    expect(finding!.detail).toMatch(/RA 11360/);
    expect(finding!.detail).toMatch(/DEF-082/);
    // ⚠️ Soft on purpose: `hard` would block EVERY close forever, since nothing can discharge it.
    expect(finding!.severity).toBe('soft');
    const readiness = await asOrg(f.orgId, (tx) => closeReadiness(tx, f.orgId, PERIOD));
    expect(readiness.blocking.map((b) => b.kind)).not.toContain('serviceChargeFloatAgeing');
  });

  it('⭐ ages FIFO — clearing the OLDEST accrual silences it even though the float is not empty', async () => {
    const f = await fixture('sc-fifo');
    await openRecentPeriod(f);

    await serviceCharge(f, daysAgo(40), '300.00', uid('sc-old'));
    await serviceCharge(f, daysAgo(1), '100.00', uid('sc-new'));
    expect(await kinds(f)).toContain('serviceChargeFloatAgeing');

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
