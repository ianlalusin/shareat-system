import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-635 S2 - clock in as slicer or regular staff, against real Postgres. docs/tasks/635-slicer-pay.md "S2".
 *   - the choice rides on the punch event and reaches attendance_days (an event without it is regular)
 *   - the roster mirror tells the kiosk who is a slicer
 *   - the day's worked_as is DERIVED (punches + adjustments) so a recompute cannot lose it; a manager's correction is an audited adjustment
 *   - payroll: a slicer day pays 0 from the daily rate, a regular day pays it; slicer-only days need no rate
 *   - the confirmer is never a slicer; a late confirmation is paid in the next run, exactly once
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { fundAccount } from './_fixtures/fund-account';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { grantSlicerPosition } from './_fixtures/t635-slicer';
import { testItemCode } from './_fixtures/item-code';
import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  activateTerminal,
  adjudicateDay,
  confirmSlicing,
  createEmployment,
  drainOutbox,
  enrolCard,
  ingestEvents,
  postPayRun,
  previewPayRun,
  provisionTerminal,
  recordAdjustment,
  seedAttendanceConfig,
  seedCanonicalPositions,
  setSlicerPayRate,
  shiftDayRange,
  toShiftDay,
  voidPayRun,
  type MirrorDocument,
  type MirrorDriver,
  type TerminalIdentityDriver,
} from '@shareat/domain';

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });
const idDriver: TerminalIdentityDriver = {
  async mintCustomToken() {
    return 'token';
  },
  async disable() {},
};

afterAll(async () => {
  await sql.end();
  await closeDb();
});

const DAY = toShiftDay(new Date(Date.now() - 24 * 3_600_000));
const DAY_START = shiftDayRange(DAY).start.getTime();
const at = (hour: number) => DAY_START + ((((hour - 5) % 24) + 24) % 24) * 60 * 60_000;

/** An org with a store, an admin, a manager, a slicer (Sam, daily rate 600) and a plain staff member (Pat, daily rate 600), each with a card, and one terminal. */
async function fixture(hint: string) {
  const code = uid(`s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('S')}, 'Store', 'multi_room') returning id`;
  const storeId = st!.id;
  const mkPerson = async (name: string, role: string | null) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const admin = actor(orgId, adminId);
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2025-01-01' }));
  await seedStatutoryRates(orgId, admin, [storeId]);
  const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await fundAccount(sql, { orgId, storeId, code: '1130', amount: '10000000.00' });
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${storeId} and superseded_at is null`;

  const { terminal } = await asOrg(orgId, (tx) => provisionTerminal(tx, admin, idDriver, { storeId, label: 'Counter' }));
  await asOrg(orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));

  let n = 0;
  const staff = async (name: string, slicer: boolean, rate: boolean = true) => {
    const personId = await mkPerson(name, 'staff');
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${storeId}, ${`SE-${String(++n).padStart(3, '0')}`}, '2025-01-05', 'regular', ${adminId}) returning id`;
    if (rate) await sql`insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by) values (${orgId}, ${emp!.id}, 'daily', '600.00', '2025-01-01', ${adminId})`;
    await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId, setBy: managerId });
    if (slicer) await grantSlicerPosition(sql, { orgId, employmentId: emp!.id, primary: false });
    const cardId = uid('card');
    const cred = await asOrg(orgId, (tx) => enrolCard(tx, admin, { employmentId: emp!.id, cardId }));
    await sql`update attendance_credentials set enrolled_at = now() - interval '30 days' where id = ${cred.id}`;
    return { personId, employmentId: emp!.id, cardId, actor: actor(orgId, personId) };
  };
  const sam = await staff('Sam Slicer', true);
  const pat = await staff('Pat Plain', false);
  return { orgId, storeId, admin, adminId, managerId, mgr: actor(orgId, managerId), officeId: office!.id, configId: cfg!.id, terminal, sam, pat, staff };
}
type F = Awaited<ReturnType<typeof fixture>>;

const event = (f: F, who: { cardId: string }, over: Record<string, unknown> = {}) => ({
  clientPunchId: uid('cp'),
  occurredAt: at(9),
  deviceId: f.terminal.id,
  storeId: f.storeId,
  credentialKind: 'card',
  credentialRef: who.cardId,
  method: 'qr',
  assertedIntent: 'in',
  ...over,
});
const ingest = (f: F, events: unknown[]) => asOrg(f.orgId, (tx) => ingestEvents(tx, events));
const dayOf = async (employmentId: string, shiftDay = DAY) =>
  (await sql<{ worked_as: string; status: string }[]>`select worked_as, status from attendance_days where employment_id = ${employmentId} and shift_day = ${shiftDay}`)[0];
/** A real session row for the manager (an adjustment names the session it was decided under). */
const sessionFor = async (f: F) => {
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash) values (${f.managerId}, 'pin', ${f.storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  return (
    await sql<{ id: string }[]>`
      insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at) values (${uid('t')}, ${f.managerId}, ${cred!.id}, 'pin', ${f.storeId}, now() + interval '12 hours') returning id`
  )[0]!.id;
};

// =====================================================================================

describe('T-635 S2 the choice reaches the day', () => {
  it('a slicer clock-in carrying workedAs=slicer makes a slicer day; the punch keeps it', async () => {
    const f = await fixture('a1');
    const e = event(f, f.sam, { workedAs: 'slicer' });
    const r = await ingest(f, [e]);
    expect(r.ingested).toBe(1);
    const [p] = await sql<{ worked_as: string | null }[]>`select worked_as from attendance_punches where client_punch_id = ${e.clientPunchId}`;
    expect(p!.worked_as).toBe('slicer');
    expect((await dayOf(f.sam.employmentId))!.worked_as).toBe('slicer');
  });

  it('a slicer tap from someone WITHOUT the Slicer position is stored as REGULAR (a wrong tap never zeroes regular pay)', async () => {
    const f = await fixture('a5');
    const e = event(f, f.pat, { workedAs: 'slicer' }); // Pat holds no Slicer position
    expect((await ingest(f, [e])).ingested).toBe(1);
    const [p] = await sql<{ worked_as: string | null }[]>`select worked_as from attendance_punches where client_punch_id = ${e.clientPunchId}`;
    expect(p!.worked_as).toBe('regular');
    expect((await dayOf(f.pat.employmentId))!.worked_as).toBe('regular');
  });

  it('an event WITHOUT the field means regular (an old queued punch still ingests); an explicit regular is regular', async () => {
    const f = await fixture('a2');
    expect((await ingest(f, [event(f, f.sam)])).ingested).toBe(1); // no workedAs key at all
    expect((await dayOf(f.sam.employmentId))!.worked_as).toBe('regular');
    expect((await ingest(f, [event(f, f.pat, { workedAs: 'regular' })])).ingested).toBe(1);
    expect((await dayOf(f.pat.employmentId))!.worked_as).toBe('regular');
  });

  it('a value that is neither word is quarantined as malformed, not guessed', async () => {
    const f = await fixture('a3');
    const r = await ingest(f, [event(f, f.sam, { workedAs: 'boss' })]);
    expect(r.quarantined).toBe(1);
    expect(r.byReason.malformed).toBe(1);
  });

  it("only the day's first clock-in decides: a later clock-in with another value does not flip the day", async () => {
    const f = await fixture('a4');
    await ingest(f, [event(f, f.sam, { workedAs: 'slicer', occurredAt: at(9) })]);
    await ingest(f, [event(f, f.sam, { assertedIntent: 'out', occurredAt: at(12) })]);
    await ingest(f, [event(f, f.sam, { workedAs: 'regular', occurredAt: at(13) })]);
    expect((await dayOf(f.sam.employmentId))!.worked_as).toBe('slicer');
  });
});

describe('T-635 S2 the roster mirror tells the kiosk who is a slicer', () => {
  it('the roster document says isSlicer true for the Slicer position holder (primary or not) and false for everyone else', async () => {
    const f = await fixture('b1');
    await sql`delete from mirror_outbox where org_id = ${f.orgId}`;
    // touch both employments so each has a pending roster row
    for (const e of [f.sam, f.pat]) await sql`update employments set staff_code = staff_code where id = ${e.employmentId}`;
    const written: MirrorDocument[] = [];
    const driver: MirrorDriver = {
      async publish(docs) {
        written.push(...docs);
      },
    };
    await asOrg(f.orgId, (tx) => drainOutbox(tx, driver, {}));
    const roster = (id: string) => written.filter((d) => d.path === `mirror/${f.storeId}/roster/${id}` && !d.deleted).at(-1)?.data as { isSlicer?: boolean } | undefined;
    expect(roster(f.sam.employmentId)?.isSlicer).toBe(true);
    expect(roster(f.pat.employmentId)?.isSlicer).toBe(false);
  });
});

describe('T-635 S2 a manager can correct it, and a recompute never loses it', () => {
  it('the correction is an audited adjustment (who decided, superseding the last); the day follows it and a RECOMPUTE keeps it', async () => {
    const f = await fixture('c1');
    await ingest(f, [event(f, f.sam, { workedAs: 'slicer' })]);
    await ingest(f, [event(f, f.sam, { assertedIntent: 'out', occurredAt: at(18) })]);
    const sessionId = await sessionFor(f);
    const { adjustment } = await asOrg(f.orgId, (tx) =>
      recordAdjustment(tx, f.mgr, { employmentId: f.sam.employmentId, shiftDay: DAY, kind: 'worked_as', workedAs: 'regular', reason: 'forgot to pick', sessionId }),
    );
    expect(adjustment).toMatchObject({ kind: 'worked_as', workedAs: 'regular', decidedByPersonId: f.managerId });
    expect((await dayOf(f.sam.employmentId))!.worked_as).toBe('regular');
    // a recompute (what a late punch or the sweep does) keeps the decision: it is derived from punches + adjustments, never a hand-set column
    await asOrg(f.orgId, (tx) => adjudicateDay(tx, { employmentId: f.sam.employmentId, shiftDay: DAY as never }));
    expect((await dayOf(f.sam.employmentId))!.worked_as).toBe('regular');
    // a second decision supersedes the first: still one live row
    await asOrg(f.orgId, (tx) => recordAdjustment(tx, f.mgr, { employmentId: f.sam.employmentId, shiftDay: DAY, kind: 'worked_as', workedAs: 'slicer', sessionId }));
    const live = await sql`select id from attendance_adjustments where employment_id = ${f.sam.employmentId} and shift_day = ${DAY} and kind = 'worked_as' and superseded_by_adjustment_id is null`;
    expect(live).toHaveLength(1);
    expect((await dayOf(f.sam.employmentId))!.worked_as).toBe('slicer');
  });

  it('a day cannot be marked slicer for someone who does not hold the Slicer position; a junk value is refused', async () => {
    const f = await fixture('c2');
    await ingest(f, [event(f, f.pat)]);
    const sessionId = await sessionFor(f);
    await expect(
      asOrg(f.orgId, (tx) => recordAdjustment(tx, f.mgr, { employmentId: f.pat.employmentId, shiftDay: DAY, kind: 'worked_as', workedAs: 'slicer', sessionId })),
    ).rejects.toThrow(/does not hold the Slicer position/);
    await expect(
      asOrg(f.orgId, (tx) => recordAdjustment(tx, f.mgr, { employmentId: f.pat.employmentId, shiftDay: DAY, kind: 'worked_as', workedAs: 'boss', sessionId })),
    ).rejects.toThrow(/slicer or as regular/);
  });
});

// ---- payroll ---------------------------------------------------------------------------
const period = { periodStart: '2026-01-01', periodEnd: '2026-01-15' };
const addDay = (f: F, e: { employmentId: string; personId: string }, shiftDay: string, workedAs: 'regular' | 'slicer', minutes = 540) =>
  sql`insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes, worked_as)
      values (${f.orgId}, ${f.storeId}, ${e.personId}, ${e.employmentId}, ${shiftDay}, ${f.configId}, 'exact', 'verified', ${minutes}, ${workedAs})`;
const preview = (f: F) => asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...period }));
const post = (f: F) => asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeId }));

describe('T-635 S2 payroll per day', () => {
  it('a regular day pays the daily rate; a slicer day pays 0 from it; the slip says regular days N and slicer days N', async () => {
    const f = await fixture('d1');
    await addDay(f, f.sam, '2026-01-05', 'regular');
    await addDay(f, f.sam, '2026-01-06', 'slicer');
    await addDay(f, f.sam, '2026-01-07', 'slicer');
    const pv = await preview(f);
    const slip = pv.slips.find((s) => s.personId === f.sam.personId)!;
    expect(slip).toMatchObject({ daysWorked: 1, slicerDays: 2, basicPay: '600.00', grossPay: '600.00' });
    expect(slip.dayIds).toHaveLength(3); // every day, slicer or regular, is frozen to the run that paid the person
    const out = await post(f);
    const [row] = await sql<{ days_worked: string; slicer_days: number }[]>`select days_worked, slicer_days from payslips where run_id = ${out.runId} and person_id = ${f.sam.personId}`;
    expect(row!.slicer_days).toBe(2);
    expect(Number(row!.days_worked)).toBe(1);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text n from attendance_days where frozen_by_pay_run_id = ${out.runId}`)[0]!.n)).toBe(3);
  });

  it('a person whose only days are slicer days needs NO daily rate (no unrated refusal); a regular day with no rate is still refused', async () => {
    const f = await fixture('d2');
    const nora = await f.staff('Nora Norate', true, false); // a slicer with NO daily rate, slicer days only
    const olga = await f.staff('Olga Norate', false, false); // regular staff with no daily rate and a regular day
    await addDay(f, nora, '2026-01-05', 'slicer');
    await addDay(f, olga, '2026-01-05', 'regular');
    const pv = await preview(f);
    expect(pv.unratedEmployments.map((u) => u.personName)).toEqual(['Olga Norate']); // Nora (slicer days only) is not flagged
    expect(pv.unratedEmployments[0]!.days).toBe(1);
  });
});

describe('T-635 S2 who may confirm, and late confirmations', () => {
  async function slice(f: F, producedOn: string, confirmedBy: string | null) {
    let locationId = (await sql<{ id: string }[]>`select id from stock_locations where org_id = ${f.orgId} limit 1`)[0]?.id;
    if (!locationId) {
      const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Kitchen type') returning id`;
      locationId = (
        await sql<{ id: string }[]>`
          insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${f.orgId}, ${f.storeId}, 'KIT', 'Kitchen', ${t!.id}, 'operating', true, ${f.adminId}) returning id`
      )[0]!.id;
    }
    let item = (await sql<{ id: string }[]>`select id from items where org_id = ${f.orgId} and name = 'Slice A'`)[0]?.id;
    if (!item) {
      const slab = (await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${testItemCode()}, 'Slab', 'meat_slab', 'kg', ${f.adminId}) returning id`)[0]!.id;
      item = (
        await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by) values (${f.orgId}, ${testItemCode()}, 'Slice A', 'meat_sliced', 'kg', ${slab}, ${f.adminId}) returning id`
      )[0]!.id;
    }
    const [r] = await sql<{ id: string }[]>`
      insert into production_records (org_id, store_id, location_id, kind, status, produced_on, performed_by_person_id, confirmed_by_person_id, confirmed_at, posted_at, posted_by, created_by)
      values (${f.orgId}, ${f.storeId}, ${locationId}, 'slice', 'posted', ${producedOn}, ${f.sam.personId}, ${confirmedBy}, ${confirmedBy ? new Date() : null}, now(), ${f.managerId}, ${f.managerId}) returning id`;
    await sql`insert into production_record_lines (record_id, direction, item_id, quantity, unit, is_paid) values (${r!.id}, 'in', ${item}, '10', 'kg', true)`;
    return r!.id;
  }
  const withRate = (f: F) => asOrg(f.orgId, (tx) => setSlicerPayRate(tx, f.admin, { storeId: f.storeId, itemId: null, ratePerKg: '5.00', effectiveFrom: '2026-01-01' }));

  it('a person who holds the Slicer position cannot confirm slicing; another staff member can', async () => {
    const f = await fixture('e1');
    const id = await slice(f, '2026-01-12', null);
    // a SECOND slicer, who is not the one who sliced
    const other = await f.staff('Other Slicer', true);

    const bySlicer = await asOrg(f.orgId, (tx) => confirmSlicing(tx, other.actor, { recordId: id }));
    expect(bySlicer.ok).toBe(false);
    if (!bySlicer.ok) expect(bySlicer.reason).toMatch(/slicer cannot confirm slicing/i);
    expect(await asOrg(f.orgId, (tx) => confirmSlicing(tx, f.pat.actor, { recordId: id }))).toEqual({ ok: true });
  });

  it('a late-confirmed record from BEFORE the period is paid in the next run, flagged "from an earlier period", and paid exactly once', async () => {
    const f = await fixture('e2');
    await withRate(f);
    await slice(f, '2026-01-12', f.pat.personId);
    await slice(f, '2026-01-20', f.pat.personId);
    // the run for 16-31 Jan picks up both: the 20th is in the period, the 12th was confirmed late
    const p2 = { periodStart: '2026-01-16', periodEnd: '2026-01-31' };
    const pv = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, ...p2 }));
    expect(pv.slips[0]).toMatchObject({ slicerRecords: 2, slicerEarlierRecords: 1, slicerPay: '100.00' });
    const out = await asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, ...p2, moneyAccountId: f.officeId }));
    expect(Number((await sql<{ n: string }[]>`select count(*)::text n from production_records where paid_by_pay_run_id = ${out.runId}`)[0]!.n)).toBe(2);
    const [slip] = await sql<{ slicer_records: number; slicer_earlier_records: number }[]>`select slicer_records, slicer_earlier_records from payslips where run_id = ${out.runId}`;
    expect(slip).toEqual({ slicer_records: 2, slicer_earlier_records: 1 });
    // exactly once: a later run finds nothing to pay
    const again = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-02-01', periodEnd: '2026-02-15' }));
    expect(again.slips).toHaveLength(0);
    // and voiding the run releases both
    await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: 'test' }));
    expect(Number((await sql<{ n: string }[]>`select count(*)::text n from production_records where paid_by_pay_run_id is not null and org_id = ${f.orgId}`)[0]!.n)).toBe(0);
  });

  it("a record paid by the run for its own period is not paid again by the next period (carry-forward never double pays)", async () => {
    const f = await fixture('e3');
    await withRate(f);
    await slice(f, '2026-01-12', f.pat.personId);
    await post(f);
    const next = await asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-01-16', periodEnd: '2026-01-31' }));
    expect(next.slips).toHaveLength(0);
  });
});
