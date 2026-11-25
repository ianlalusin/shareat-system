import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-635 - slicer pay, against real Postgres. docs/tasks/635-slicer-pay.md, MIGRATION 0279.
 * Tests 2-6 of the spec (test 1, the maths, is `tests/unit/t635-slicer-pay-math.test.ts`; the rate in force and the unpaid-line
 * exclusion are also exercised end to end by the pay-run cases here).
 *
 * Slice records the pay run reads are inserted as POSTED rows directly (a pay run only reads them); the real draft -> post -> edit
 * path, with stock, is used where the test is about that path (self-post, edit clears the confirmation, performed_by rules).
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
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  confirmSlicing,
  createProductionDraft,
  derivePeriods,
  editPostedProduction,
  hasLiveSlicerPaymentCovering,
  postPayRun,
  postProduction,
  previewPayRun,
  seedAttendanceConfig,
  seedCanonicalPositions,
  setSlicerPayRate,
  slicerPayOverview,
  unconfirmSlicing,
  voidPayRun,
  voidProduction,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';

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

async function fixture(hint: string, opts: { rates?: boolean } = {}) {
  const code = uid(`p635-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('A')}, 'Store A', 'multi_room') returning id`;
  const storeId = s!.id;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2025-01-01' }));
  const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await fundAccount(sql, { orgId, storeId, code: '1130', amount: '10000000.00' });

  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  await seedStatutoryRates(orgId, actor(orgId, adminId), [storeId]);
  const managerId = await mk('Manager', 'manager');
  let n = 0;
  const emp = async (personId: string, startedOn = '2025-01-01', rate = '600.00') => {
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${storeId}, ${`SE-${String(++n).padStart(3, '0')}`}, ${startedOn}, 'regular', ${adminId}) returning id`;
    await sql`insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by) values (${orgId}, ${e!.id}, 'daily', ${rate}, '2025-01-01', ${adminId})`;
    await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: e!.id, personId, setBy: managerId });
    return e!.id;
  };
  const samId = await mk('Sam Slicer', 'staff');
  const samEmp = await emp(samId);
  await grantSlicerPosition(sql, { orgId, employmentId: samEmp });
  const cyId = await mk('Cy Checker', 'staff');
  await emp(cyId);
  // a staff member with NO position grants: holds no stock capability at all
  const plainId = await mk('Plain Pat', 'staff');
  const [plainEmp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${plainId}, ${storeId}, 'SE-090', '2025-01-01', 'regular', ${adminId}) returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: plainEmp!.id, personId: plainId, setBy: managerId, capabilities: [] });

  // stock side (for the real draft -> post -> edit path)
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Kitchen type') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${t!.id}, 'operating', true, ${adminId}) returning id`;
  const mkItem = async (name: string, kind: string, parent: string | null = null) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by) values (${orgId}, ${testItemCode()}, ${name}, ${kind}, 'kg', ${parent}, ${adminId}) returning id`)[0]!.id;
  const slab = await mkItem('Beef Forequarter', 'meat_slab');
  const sliceA = await mkItem('Slice A', 'meat_sliced', slab);
  const sliceB = await mkItem('Slice B', 'meat_sliced', slab);
  const sliceC = await mkItem('Slice C', 'meat_sliced', slab);
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${`orgs/${orgId}/p.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${adminId}) returning id`;

  const f = {
    orgId, storeId, officeId: office!.id, locationId: loc!.id, slab, sliceA, sliceB, sliceC, fileId: file!.id,
    adminId, managerId, samId, cyId, plainId, samEmp,
    admin: actor(orgId, adminId), mgr: actor(orgId, managerId), sam: actor(orgId, samId), cy: actor(orgId, cyId), plain: actor(orgId, plainId),
  };
  if (opts.rates !== false) {
    // default 5.00 from 1 Jan; Slice B pays 8.00 from 10 Jan. Set through the domain, as the screen does.
    const set = (itemId: string | null, ratePerKg: string, effectiveFrom: string) =>
      asOrg(orgId, (tx) => setSlicerPayRate(tx, f.admin, { storeId, itemId, ratePerKg, effectiveFrom }));
    expect((await set(null, '5.00', '2026-01-01')).ok).toBe(true);
    expect((await set(sliceB, '8.00', '2026-01-10')).ok).toBe(true);
  }
  return f;
}
type F = Awaited<ReturnType<typeof fixture>>;

/** A POSTED slice record by `by` (default Sam), with its output lines, inserted directly. */
async function posted(
  f: F,
  producedOn: string,
  lines: { item: string; qty: string; unit?: string; paid?: boolean }[],
  over: { by?: string; confirmedBy?: string | null } = {},
): Promise<string> {
  const by = over.by ?? f.samId;
  const confirmedBy = over.confirmedBy === undefined ? f.cyId : over.confirmedBy;
  const [r] = await sql<{ id: string }[]>`
    insert into production_records (org_id, store_id, location_id, kind, status, produced_on, performed_by_person_id,
                                    confirmed_by_person_id, confirmed_at, posted_at, posted_by, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.locationId}, 'slice', 'posted', ${producedOn}, ${by},
            ${confirmedBy}, ${confirmedBy ? new Date() : null}, now(), ${f.managerId}, ${f.managerId}) returning id`;
  for (const l of lines) {
    await sql`insert into production_record_lines (record_id, direction, item_id, quantity, unit, is_paid)
              values (${r!.id}, 'in', ${l.item}, ${l.qty}, ${l.unit ?? 'kg'}, ${l.paid ?? true})`;
  }
  return r!.id;
}

const PERIOD = derivePeriods({ payrollPeriodType: 'semi_monthly', semiMonthlyCutoffDay: 15 }, 2026, 1);
const preview = (f: F, start: string, end: string) => asOrg(f.orgId, (tx) => previewPayRun(tx, f.admin, { storeId: f.storeId, periodStart: start, periodEnd: end }));
const post = (f: F, start: string, end: string) =>
  asOrg(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, periodStart: start, periodEnd: end, moneyAccountId: f.officeId }));
const rowOf = async (id: string) =>
  (await sql<{ status: string; confirmed_by_person_id: string | null; paid_by_pay_run_id: string | null; revision: number }[]>`
    select status, confirmed_by_person_id, paid_by_pay_run_id, revision from production_records where id = ${id}`)[0]!;

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================

describe('T-635 pay run - what slicer pay adds to a payslip', () => {
  it('the semi-monthly period the date rule comes from ends on the 15th', () => {
    expect(PERIOD[0]).toMatchObject({ start: '2026-01-01', end: '2026-01-15' });
  });

  it('3. pays confirmed, posted, unpaid slicing in the period to the right person: kg x rate in force, override, g->kg, unpaid lines out; gross, net and one journal entry', async () => {
    const f = await fixture('p3');
    // R1: A 10 kg + B 5 kg paid (Slice B override 8.00 is in force on the 12th), C 3 kg NOT paid -> 10x5 + 5x8 = 90.00, 15 kg
    await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }, { item: f.sliceB, qty: '5' }, { item: f.sliceC, qty: '3', paid: false }]);
    // R2: 2000 g of B on the 5th, BEFORE the override: default 5.00 x 2 kg = 10.00
    await posted(f, '2026-01-05', [{ item: f.sliceB, qty: '2000', unit: 'g' }]);
    // R3: not confirmed -> waits
    await posted(f, '2026-01-13', [{ item: f.sliceA, qty: '40' }], { confirmedBy: null });

    const pv = await preview(f, '2026-01-01', '2026-01-15');
    expect(pv.slicerProblems).toEqual([]);
    expect(pv.slips).toHaveLength(1);
    expect(pv.slips[0]).toMatchObject({ personId: f.samId, slicerPay: '100.00', slicerKg: '17.000', slicerRecords: 2, basicPay: '0.00', grossPay: '100.00' });

    const before = Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where org_id = ${f.orgId}`)[0]!.n);
    const out = await post(f, '2026-01-01', '2026-01-15');
    const [slip] = await sql<{ slicer_pay: string; slicer_kg: string; slicer_records: number; gross_pay: string; net_pay: string; journal_entry_id: string }[]>`
      select slicer_pay, slicer_kg, slicer_records, gross_pay, net_pay, journal_entry_id from payslips where run_id = ${out.runId}`;
    expect(slip).toMatchObject({ slicer_pay: '100.00', slicer_kg: '17.000', slicer_records: 2, gross_pay: '100.00', net_pay: '100.00' });

    // labour is booked ONCE: the pay run wrote exactly one entry (the payslip's), 6100 is debited the gross once, and it balances.
    const after = Number((await sql<{ n: string }[]>`select count(*)::text n from journal_entries where org_id = ${f.orgId}`)[0]!.n);
    expect(after - before).toBe(1);
    const [six] = await sql<{ debit: string; credit: string }[]>`
      select coalesce(sum(l.debit),0)::text debit, coalesce(sum(l.credit),0)::text credit from journal_lines l
      join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and e.source_type = 'payrollpayslip' and a.code = '6100'`;
    expect(six).toEqual({ debit: '100.00', credit: '0.00' });
    const [tb] = await sql<{ net: string }[]>`select (sum(l.debit) - sum(l.credit))::text net from journal_lines l join journal_entries e on e.id = l.entry_id where e.id = ${slip!.journal_entry_id}`;
    expect(tb!.net).toBe('0.00');

    // the two paid records are frozen to the run; the unconfirmed one is not
    const frozen = await sql<{ n: string }[]>`select count(*)::text n from production_records where paid_by_pay_run_id = ${out.runId}`;
    expect(frozen[0]!.n).toBe('2');
  });

  it('3b. the same inclusive period as attendance: a record on the period\'s LAST day is paid, the day after is not', async () => {
    const f = await fixture('p3b');
    const last = PERIOD[0]!.end; // 2026-01-15
    const next = PERIOD[1]!.start; // 2026-01-16
    await posted(f, last, [{ item: f.sliceA, qty: '10' }]);
    await posted(f, next, [{ item: f.sliceA, qty: '20' }]);
    const first = await preview(f, PERIOD[0]!.start, last);
    expect(first.slips[0]).toMatchObject({ slicerPay: '50.00', slicerRecords: 1 });
    const second = await preview(f, next, PERIOD[1]!.end);
    expect(second.slips[0]).toMatchObject({ slicerPay: '100.00', slicerRecords: 1 });
    // and the first day of a period is in it too
    const f2 = await fixture('p3c');
    await posted(f2, '2026-01-01', [{ item: f2.sliceA, qty: '10' }]);
    expect((await preview(f2, '2026-01-01', '2026-01-15')).slips[0]).toMatchObject({ slicerRecords: 1 });
  });

  it('3c. a record already paid is never paid again by a second run for the same dates', async () => {
    const f = await fixture('p3d');
    await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }]);
    await post(f, '2026-01-01', '2026-01-15');
    const pv = await preview(f, '2026-01-01', '2026-01-15');
    expect(pv.slips).toHaveLength(0);
  });

  it('3d. slicing that cannot be priced (no rate in force) is reported and the run refuses to post; nothing is written', async () => {
    const f = await fixture('p3e', { rates: false });
    await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }]);
    const pv = await preview(f, '2026-01-01', '2026-01-15');
    expect(pv.slicerProblems[0]).toMatch(/no slicer rate in force for Slice A/);
    await expect(post(f, '2026-01-01', '2026-01-15')).rejects.toThrow(/slicer pay cannot be priced/);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text n from pay_runs where org_id = ${f.orgId}`)[0]!.n)).toBe(0);
  });

  it('3e. a slicer paid ONLY per kg needs no daily rate: the slip is made, gross = the slicer pay, no pay rate on it, not a minimum-wage earner; someone with neither a rate nor slicer pay still gets no slip', async () => {
    const f = await fixture('p3f');
    const mkNoRate = async (name: string, code: string, slicer: boolean) => {
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, ${name}) returning id`;
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
      const [e] = await sql<{ id: string }[]>`
        insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
        values (${f.orgId}, ${p!.id}, ${f.storeId}, ${code}, '2025-01-01', 'regular', ${f.adminId}) returning id`;
      if (slicer) await grantSlicerPosition(sql, { orgId: f.orgId, employmentId: e!.id, primary: true });
      return p!.id;
    };
    const noraId = await mkNoRate('Nora Norate', 'SE-095', true);
    await mkNoRate('Olga Nothing', 'SE-096', false); // no rate, no slicer pay, no attendance
    await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }], { by: noraId });

    const pv = await preview(f, '2026-01-01', '2026-01-15');
    expect(pv.slicerProblems).toEqual([]);
    expect(pv.slips).toHaveLength(1); // Nora only; Olga (no rate, nothing to pay) makes no slip
    expect(pv.slips[0]).toMatchObject({ personId: noraId, payRateId: null, slicerPay: '50.00', basicPay: '0.00', grossPay: '50.00', isMwe: false });

    const out = await post(f, '2026-01-01', '2026-01-15');
    const [slip] = await sql<{ pay_rate_id: string | null; slicer_pay: string; gross_pay: string; net_pay: string; is_mwe: boolean }[]>`
      select pay_rate_id, slicer_pay, gross_pay, net_pay, is_mwe from payslips where run_id = ${out.runId}`;
    expect(slip).toMatchObject({ pay_rate_id: null, slicer_pay: '50.00', gross_pay: '50.00', net_pay: '50.00', is_mwe: false });
  });
});

// =====================================================================================

describe('T-635 confirm', () => {
  it('2. the slicer cannot confirm their own record; another staff member can; a second confirm and an unpaid un-confirm behave; each is audited', async () => {
    const f = await fixture('c2');
    const id = await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }], { confirmedBy: null });

    const own = await asOrg(f.orgId, (tx) => confirmSlicing(tx, f.sam, { recordId: id }));
    expect(own).toMatchObject({ ok: false });
    if (!own.ok) expect(own.reason).toMatch(/cannot confirm your own slicing/);
    expect((await rowOf(id)).confirmed_by_person_id).toBeNull();

    expect(await asOrg(f.orgId, (tx) => confirmSlicing(tx, f.cy, { recordId: id }))).toEqual({ ok: true });
    expect((await rowOf(id)).confirmed_by_person_id).toBe(f.cyId);
    const again = await asOrg(f.orgId, (tx) => confirmSlicing(tx, f.cy, { recordId: id }));
    expect(again.ok).toBe(false);

    expect(await asOrg(f.orgId, (tx) => unconfirmSlicing(tx, f.cy, { recordId: id }))).toEqual({ ok: true });
    expect((await rowOf(id)).confirmed_by_person_id).toBeNull();
    const audit = await sql<{ action: string }[]>`select action from audit_log where org_id = ${f.orgId} and entity_id = ${id} order by recorded_at, id`;
    expect(audit.map((a) => a.action)).toEqual(['production.slicing_confirmed', 'production.slicing_unconfirmed']);
  });

  it('2b. the database also refuses a confirmer who is the slicer (the CHECK is the backstop)', async () => {
    const f = await fixture('c2b');
    await expect(posted(f, '2026-01-12', [{ item: f.sliceA, qty: '1' }], { confirmedBy: f.samId })).rejects.toThrow(/production_records_confirmer_not_slicer_check/);
  });

  it('2c. an unconfirmed record is not paid; once confirmed the next run pays it', async () => {
    const f = await fixture('c2c');
    const id = await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }], { confirmedBy: null });
    expect((await preview(f, '2026-01-01', '2026-01-15')).slips).toHaveLength(0);
    await asOrg(f.orgId, (tx) => confirmSlicing(tx, f.cy, { recordId: id }));
    expect((await preview(f, '2026-01-01', '2026-01-15')).slips[0]).toMatchObject({ slicerPay: '50.00' });
  });

  it('2d. editing a posted record clears its confirmation (real draft -> post by the slicer -> confirm -> manager edit)', async () => {
    const f = await fixture('c2d');
    const [d0] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by) values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-02', ${f.fileId}, ${f.adminId}) returning id`;
    const r0 = await asOrg(f.orgId, (tx) =>
      receiveDelivery(tx, {
        orgId: f.orgId, storeId: f.storeId, deliveryId: d0!.id, deliveredOn: '2026-01-02', receivedBy: f.adminId,
        locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
        lines: [{ lineId: '1', itemId: f.slab, itemKind: 'meat_slab', receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '300.0000', locationId: f.locationId }],
      }),
    );
    if (!r0.ok) throw new Error(r0.reason);

    const draft = await asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.sam, {
        orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'slice', performedByPersonId: f.samId, producedOn: '2026-01-12',
        inputs: [{ itemId: f.slab, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: f.sliceA, quantity: '9', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    // the slicer posts their own record with the capability that let them record it (no post_production needed) ...
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.sam, { recordId: draft.recordId }));
    expect(p.ok, p.ok ? '' : p.reason).toBe(true);
    // ... but another person's record is NOT theirs to post
    const other = await asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.cy, {
        orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'slice', performedByPersonId: f.samId, producedOn: '2026-01-13',
        inputs: [{ itemId: f.slab, quantity: '5', unit: 'kg' }], outputs: [{ itemId: f.sliceA, quantity: '4', unit: 'kg' }],
      }),
    );
    if (!other.ok) throw new Error(other.reason);
    await expect(asOrg(f.orgId, (tx) => postProduction(tx, f.cy, { recordId: other.recordId }))).rejects.toThrow();

    expect(await asOrg(f.orgId, (tx) => confirmSlicing(tx, f.cy, { recordId: draft.recordId }))).toEqual({ ok: true });
    expect((await rowOf(draft.recordId)).confirmed_by_person_id).toBe(f.cyId);

    const edited = await asOrg(f.orgId, (tx) =>
      editPostedProduction(tx, f.mgr, {
        recordId: draft.recordId,
        inputs: [{ itemId: f.slab, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: f.sliceA, quantity: '8', unit: 'kg' }],
      }),
    );
    expect(edited.ok, edited.ok ? '' : edited.reason).toBe(true);
    const row = await rowOf(draft.recordId);
    expect(row.confirmed_by_person_id).toBeNull(); // the check no longer matches the record
    expect(row.revision).toBe(2);
    // and the unconfirmed record is not paid
    expect((await preview(f, '2026-01-01', '2026-01-15')).slips).toHaveLength(0);
  });
});

describe('T-635 edit keeps the paid / unpaid choice', () => {
  it('2e. editing a posted slice record WITHOUT sending isPaid keeps an unpaid line unpaid (and a paid one paid); sending a value changes it', async () => {
    const f = await fixture('e2e');
    const [d0] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by) values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-02', ${f.fileId}, ${f.adminId}) returning id`;
    const r0 = await asOrg(f.orgId, (tx) =>
      receiveDelivery(tx, {
        orgId: f.orgId, storeId: f.storeId, deliveryId: d0!.id, deliveredOn: '2026-01-02', receivedBy: f.adminId,
        locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
        lines: [{ lineId: '1', itemId: f.slab, itemKind: 'meat_slab', receivedQuantity: quantity('100'), conversionFactor: '1', unitCost: '300.0000', locationId: f.locationId }],
      }),
    );
    if (!r0.ok) throw new Error(r0.reason);
    const draft = await asOrg(f.orgId, (tx) =>
      createProductionDraft(tx, f.sam, {
        orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'slice', performedByPersonId: f.samId, producedOn: '2026-01-12',
        inputs: [{ itemId: f.slab, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: f.sliceA, quantity: '6', unit: 'kg' }, { itemId: f.sliceC, quantity: '3', unit: 'kg', isPaid: false }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const p = await asOrg(f.orgId, (tx) => postProduction(tx, f.sam, { recordId: draft.recordId }));
    expect(p.ok, p.ok ? '' : p.reason).toBe(true);
    const live = () =>
      sql<{ item_id: string; is_paid: boolean }[]>`
        select item_id, is_paid from production_record_lines
        where record_id = ${draft.recordId} and direction = 'in' and reversed_at is null order by quantity desc`;
    expect((await live()).map((l) => [l.item_id, l.is_paid])).toEqual([[f.sliceA, true], [f.sliceC, false]]);

    // edit the quantities only: no isPaid is sent, so Slice C stays unpaid
    const e1 = await asOrg(f.orgId, (tx) =>
      editPostedProduction(tx, f.mgr, {
        recordId: draft.recordId, inputs: [{ itemId: f.slab, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: f.sliceA, quantity: '7', unit: 'kg' }, { itemId: f.sliceC, quantity: '2', unit: 'kg' }],
      }),
    );
    expect(e1.ok, e1.ok ? '' : e1.reason).toBe(true);
    expect((await live()).map((l) => [l.item_id, l.is_paid])).toEqual([[f.sliceA, true], [f.sliceC, false]]);

    // an explicit value wins: Slice C is now paid
    const e2 = await asOrg(f.orgId, (tx) =>
      editPostedProduction(tx, f.mgr, {
        recordId: draft.recordId, inputs: [{ itemId: f.slab, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: f.sliceA, quantity: '7', unit: 'kg' }, { itemId: f.sliceC, quantity: '2', unit: 'kg', isPaid: true }],
      }),
    );
    expect(e2.ok, e2.ok ? '' : e2.reason).toBe(true);
    expect((await live()).map((l) => [l.item_id, l.is_paid])).toEqual([[f.sliceA, true], [f.sliceC, true]]);
  });
});

// =====================================================================================

describe('T-635 lock - a paid record is frozen by the pay run, and voiding the run unfreezes it', () => {
  it('4. edit and void of a paid record are refused in words; the table refuses a void too; voiding the run unfreezes; then void works', async () => {
    const f = await fixture('l4');
    const id = await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }]);
    const out = await post(f, '2026-01-01', '2026-01-15');
    expect((await rowOf(id)).paid_by_pay_run_id).toBe(out.runId);
    expect(await asOrg(f.orgId, (tx) => hasLiveSlicerPaymentCovering(tx, { orgId: f.orgId, recordId: id }))).toBe(true);

    const voided = await asOrg(f.orgId, (tx) => voidProduction(tx, f.mgr, { recordId: id, reason: 'oops' }));
    expect(voided.ok).toBe(false);
    if (!voided.ok) expect(voided.reason).toMatch(/already paid to the slicer in a pay run/);
    const edited = await asOrg(f.orgId, (tx) =>
      editPostedProduction(tx, f.mgr, { recordId: id, inputs: [{ itemId: f.slab, quantity: '1', unit: 'kg' }], outputs: [{ itemId: f.sliceA, quantity: '1', unit: 'kg' }] }),
    );
    expect(edited.ok).toBe(false);
    if (!edited.ok) expect(edited.reason).toMatch(/already paid to the slicer in a pay run/);
    const unconf = await asOrg(f.orgId, (tx) => unconfirmSlicing(tx, f.cy, { recordId: id }));
    expect(unconf.ok).toBe(false);
    expect((await rowOf(id)).status).toBe('posted');
    await expect(sql`update production_records set status = 'void', voided_at = now(), voided_by = ${f.managerId}, void_reason = 'x' where id = ${id}`).rejects.toThrow(/production_records_paid_shape_check/);

    const v = await asOrg(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId: out.runId, reason: 'wrong period' }));
    expect(v.unfrozenSlicerRecords).toBe(1);
    expect((await rowOf(id)).paid_by_pay_run_id).toBeNull();
    expect(await asOrg(f.orgId, (tx) => hasLiveSlicerPaymentCovering(tx, { orgId: f.orgId, recordId: id }))).toBe(false);
    // payable again, and now editable / voidable
    expect((await preview(f, '2026-01-01', '2026-01-15')).slips[0]).toMatchObject({ slicerPay: '50.00' });
    const voidedNow = await asOrg(f.orgId, (tx) => voidProduction(tx, f.mgr, { recordId: id, reason: 'now allowed' }));
    expect(voidedNow.ok, voidedNow.ok ? '' : voidedNow.reason).toBe(true);
  });
});

// =====================================================================================

describe('T-635 who sliced', () => {
  it('5. performed_by must hold Slicer at that store on that date; a slice record cannot be posted without one', async () => {
    const f = await fixture('w5');
    const draft = (by: string | null, producedOn = '2026-01-12') =>
      asOrg(f.orgId, (tx) =>
        createProductionDraft(tx, f.cy, {
          orgId: f.orgId, storeId: f.storeId, locationId: f.locationId, kind: 'slice', performedByPersonId: by, producedOn,
          inputs: [{ itemId: f.slab, quantity: '10', unit: 'kg' }], outputs: [{ itemId: f.sliceA, quantity: '9', unit: 'kg' }],
        }),
      );
    // not a slicer at all
    const notSlicer = await draft(f.cyId);
    expect(notSlicer.ok).toBe(false);
    if (!notSlicer.ok) expect(notSlicer.reason).toMatch(/does not hold the Slicer position at this store on/);
    // a slicer whose job at the store starts AFTER the day
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Late Larry') returning id`;
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${f.orgId}, ${p!.id}, ${f.storeId}, 'SE-096', '2026-02-01', 'regular', ${f.adminId}) returning id`;
    await grantSlicerPosition(sql, { orgId: f.orgId, employmentId: e!.id, primary: true });
    const late = await draft(p!.id);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toMatch(/does not hold the Slicer position/);
    // a real slicer is accepted at draft, and a draft with nobody named refuses to POST
    expect((await draft(f.samId)).ok).toBe(true);
    const unnamed = await draft(null);
    if (!unnamed.ok) throw new Error(unnamed.reason);
    const posted0 = await asOrg(f.orgId, (tx) => postProduction(tx, f.mgr, { recordId: unnamed.recordId }));
    expect(posted0.ok).toBe(false);
    if (!posted0.ok) expect(posted0.reason).toMatch(/Say who sliced this before posting it/);
  });
});

// =====================================================================================

describe('T-635 authorization - every new action authorizes first; each capability has its refusal', () => {
  it('6. confirm / un-confirm need the stock capability; setting a rate is admin only (a manager is refused); the overview needs run_payroll', async () => {
    const f = await fixture('a6');
    const id = await posted(f, '2026-01-12', [{ item: f.sliceA, qty: '10' }], { confirmedBy: null });

    // no stock capability at all -> refused before any read of the record's state
    await expect(asOrg(f.orgId, (tx) => confirmSlicing(tx, f.plain, { recordId: id }))).rejects.toThrow();
    expect((await rowOf(id)).confirmed_by_person_id).toBeNull();
    await expect(asOrg(f.orgId, (tx) => unconfirmSlicing(tx, f.plain, { recordId: id }))).rejects.toThrow();

    // set_pay_rate: a manager is refused (and nothing is written); the admin is allowed
    const before = Number((await sql<{ n: string }[]>`select count(*)::text n from slicer_pay_rates where org_id = ${f.orgId}`)[0]!.n);
    await expect(
      asOrg(f.orgId, (tx) => setSlicerPayRate(tx, f.mgr, { storeId: f.storeId, itemId: null, ratePerKg: '7.00', effectiveFrom: '2026-03-01' })),
    ).rejects.toThrow();
    expect(Number((await sql<{ n: string }[]>`select count(*)::text n from slicer_pay_rates where org_id = ${f.orgId}`)[0]!.n)).toBe(before);
    expect((await asOrg(f.orgId, (tx) => setSlicerPayRate(tx, f.admin, { storeId: f.storeId, itemId: null, ratePerKg: '7.00', effectiveFrom: '2026-03-01' }))).ok).toBe(true);

    // run_payroll: the overview is refused to someone without it, and shows the rows to an admin
    await expect(asOrg(f.orgId, (tx) => slicerPayOverview(tx, f.cy, { storeId: f.storeId, from: '2026-01-01', to: '2026-01-15' }))).rejects.toThrow();
    const ov = await asOrg(f.orgId, (tx) => slicerPayOverview(tx, f.admin, { storeId: f.storeId, from: '2026-01-01', to: '2026-01-15' }));
    expect(ov.rows).toEqual([expect.objectContaining({ personName: 'Sam Slicer', unconfirmed: 1, confirmedRecords: 0, amountDue: '0.00' })]);
  });

  it('6b. the rate rules: more than zero, a sliced product, and a rate is never replaced on the same day', async () => {
    const f = await fixture('a6b');
    const set = (over: Record<string, unknown>) =>
      asOrg(f.orgId, (tx) => setSlicerPayRate(tx, f.admin, { storeId: f.storeId, itemId: null, ratePerKg: '6.00', effectiveFrom: '2026-02-01', ...over } as never));
    const zero = await set({ ratePerKg: '0' });
    expect(zero).toMatchObject({ ok: false });
    const slab = await set({ itemId: f.slab });
    expect(slab.ok).toBe(false);
    if (!slab.ok) expect(slab.reason).toMatch(/not a sliced product/);
    expect((await set({})).ok).toBe(true);
    const dup = await set({ ratePerKg: '9.00' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toMatch(/already has a rate starting that day/);
    // append-only: the app role can neither update nor delete a rate
    await expect(asOrg(f.orgId, (tx) => tx.execute(dsql`update slicer_pay_rates set rate_per_kg = 1`))).rejects.toThrow();
    await expect(asOrg(f.orgId, (tx) => tx.execute(dsql`delete from slicer_pay_rates`))).rejects.toThrow();
  });
});
