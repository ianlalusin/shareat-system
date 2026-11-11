import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-519 S1 - payroll recovers a staff charge ONLY under a signed deduction agreement (DEF-813).
 * docs/tasks/519-staff-deduction-agreements.md, rulings R1-R6.
 *
 * Fixture: a worker on a 540.00 daily rate with two verified days = a 1,080.00 gross, so the 20% wage cap (R3) is 216.00.
 * The 13th-month and separation gates, and the owner self-agreement (R5), are tested beside their own fixtures
 * (thirteenth-month.test.ts, separation.test.ts, t370-owner-cap-payroll-recovery.test.ts).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { agree, asOrgT519, chargeEntry, creditEntry, scanFor } from './_fixtures/t519-agreements';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, deductionAgreementsRepo } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  agreedRecoverable,
  applyDeductionRecovery,
  deductionCapPercent,
  wageCap,
  cancelDeductionAgreement,
  postPayRun,
  reverseEntry,
  recordDeductionAgreement,
  setPayRate,
  voidPayRun,
} from '@shareat/domain';
import { RefusalError } from '../../src/shared/refusal';
import { recordOwnerSelfAgreement } from '../../src/payroll/deduction-agreements';
import { money } from '@shareat/core/money';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string, rate = '540.00') {
  const code = uid(`t519-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const mkStore = async (h: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore(hint);
  const store2Id = await mkStore(`${hint}2`);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [config] = await sql<{ id: string }[]>`
    insert into store_attendance_config (org_id, store_id, effective_from, required_hours_per_shift, overtime_multiplier, night_diff_multiplier, overtime_mode)
    values (${orgId}, ${storeId}, '2026-01-01', '9', '1.25', '1.10', 'multiplier') returning id`;
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin', [storeId, store2Id]);
  const admin2Id = await mk('Admin Two', 'admin', [storeId]);
  const managerId = await mk('Manager', 'manager', [storeId]);
  const workerId = await mk('Worker', 'staff', [storeId]);
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${adminId}) returning id`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  await seedStatutoryRates(orgId, actor(orgId, adminId), [storeId]);
  const f = {
    orgId, storeId, store2Id, configId: config!.id, adminId, admin2Id, managerId, workerId,
    admin: actor(orgId, adminId), admin2: actor(orgId, admin2Id), manager: actor(orgId, managerId),
    employmentId: emp!.id, officeAccountId: office!.id,
  };
  await asOrgT519(orgId, (tx) =>
    setPayRate(tx, f.admin, { employmentId: f.employmentId, storeId, basis: 'daily', amount: rate, effectiveFrom: '2026-01-01' }));
  for (const d of ['2026-01-05', '2026-01-06']) {
    await sql`
      insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes, is_half_day,
                                   pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday, holiday_type)
      values (${orgId}, ${storeId}, ${workerId}, ${f.employmentId}, ${d}, ${f.configId}, 'exact', 'verified', 540, false, 0, 0, 0, false, null)`;
  }
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const period = { periodStart: '2026-01-01', periodEnd: '2026-01-15' };
const post = (f: Fixture) => asOrgT519(f.orgId, (tx) => postPayRun(tx, f.admin, { storeId: f.storeId, ...period, moneyAccountId: f.officeAccountId }));
const slipRecovered = async (f: Fixture) =>
  (await sql<{ advance_recovered: string; net_pay: string }[]>`select advance_recovered, net_pay from payslips where org_id = ${f.orgId}`)[0]!;
const balance1230 = async (f: Fixture) =>
  (await sql<{ bal: string }[]>`
    select coalesce(sum(l.debit - l.credit), 0)::text as bal from journal_lines l join journal_entries e on e.id = l.entry_id
    join accounts a on a.id = l.account_id where e.org_id = ${f.orgId} and a.code = '1230' and l.party_id = ${f.workerId} and e.status <> 'draft'`)[0]!.bal;
const statusOf = async (id: string) =>
  (await sql<{ status: string; completed_at: Date | null }[]>`select status, completed_at from staff_deduction_agreements where id = ${id}`)[0]!;

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-519 R1 - a charge with no agreement is not recovered', () => {
  it('recovers 0, stays on 1230, and is listed as waiting for the employee\'s signed agreement', async () => {
    const f = await fixture('noagree');
    const charge = await chargeEntry(sql, f, f.workerId, '5000.00');
    await post(f);
    const slip = await slipRecovered(f);
    expect(slip.advance_recovered).toBe('0.00');
    expect(slip.net_pay).toBe('1080.00');
    expect(await balance1230(f)).toBe('5000.00');
    const waiting = await asOrgT519(f.orgId, (tx) => deductionAgreementsRepo.chargesWaitingForAgreement(tx, f.orgId, f.workerId));
    expect(waiting.map((w) => [w.entryId, w.amount])).toEqual([[charge, '5000.00']]);
  });

  it('a requested cash advance (not one of the six charge sources) is never recoverable, even with a record against it', async () => {
    const f = await fixture('cashreq');
    const entry = await chargeEntry(sql, f, f.workerId, '400.00', 'cash_request_release');
    await expect(agree(sql, f, f.admin, f.workerId, entry, { amount: '400.00' })).rejects.toBeInstanceOf(RefusalError);
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('0.00');
  });
});

describe('T-519 R3 - the cap: min(20% of gross, per-payroll limits, unpaid agreed amount)', () => {
  it('a big agreement is held to 20% of the 1,080.00 gross = 216.00', async () => {
    const f = await fixture('cap20');
    const charge = await chargeEntry(sql, f, f.workerId, '5000.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '5000.00', perPayrollLimit: '5000.00' });
    await post(f);
    const slip = await slipRecovered(f);
    expect(slip.advance_recovered).toBe('216.00');
    expect(slip.net_pay).toBe('864.00');
    expect(await balance1230(f)).toBe('4784.00');
  });

  it('the per-payroll limit binds when it is under 20%', async () => {
    const f = await fixture('caplimit');
    const charge = await chargeEntry(sql, f, f.workerId, '5000.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '5000.00', perPayrollLimit: '100.00' });
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('100.00');
  });

  it('the agreed unpaid amount binds when it is under both', async () => {
    const f = await fixture('capunpaid');
    const charge = await chargeEntry(sql, f, f.workerId, '5000.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '50.00', perPayrollLimit: '100.00' });
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('50.00');
  });

  it('two agreements: the limits ADD (100 + 80 = 180, under 216), the amounts ADD, and recovery is spent oldest first', async () => {
    const f = await fixture('two');
    const c1 = await chargeEntry(sql, f, f.workerId, '1000.00');
    const c2 = await chargeEntry(sql, f, f.workerId, '1000.00', 'trade_discrepancy');
    const a1 = await agree(sql, f, f.admin, f.workerId, c1, { amount: '120.00', perPayrollLimit: '100.00' });
    const a2 = await agree(sql, f, f.admin, f.workerId, c2, { amount: '1000.00', perPayrollLimit: '80.00' });
    expect(await asOrgT519(f.orgId, (tx) => agreedRecoverable(tx, f.orgId, f.workerId, money('1080.00'), '2026-01-15'))).toBe('180.00');
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('180.00');
    const rows = await sql<{ agreement_id: string; amount: string }[]>`select agreement_id, amount from staff_deduction_recoveries where org_id = ${f.orgId} order by amount desc`;
    // each agreement gives at most its own per-payroll limit (BOSS audit): a1 100 (of 120), a2 80.
    expect(Object.fromEntries(rows.map((r) => [r.agreement_id, r.amount]))).toEqual({ [a1.id]: '100.00', [a2.id]: '80.00' });
    expect((await statusOf(a1.id)).status).toBe('active');
    expect((await statusOf(a2.id)).status).toBe('active');
  });

  it('BOSS audit: A owes 1000 limit 100, B owes 1000 limit 900, gross 5000 -> A recovers 100 and B recovers 900 (not 1000 from A)', async () => {
    const f = await fixture('limits', '2500.00'); // two days = 5,000.00 gross, 20% = 1,000.00
    const c1 = await chargeEntry(sql, f, f.workerId, '1000.00');
    const c2 = await chargeEntry(sql, f, f.workerId, '1000.00', 'trade_discrepancy');
    const a = await agree(sql, f, f.admin, f.workerId, c1, { amount: '1000.00', perPayrollLimit: '100.00' });
    const b = await agree(sql, f, f.admin, f.workerId, c2, { amount: '1000.00', perPayrollLimit: '900.00' });
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('1000.00');
    const rows = await sql<{ agreement_id: string; amount: string }[]>`select agreement_id, amount from staff_deduction_recoveries where org_id = ${f.orgId}`;
    expect(Object.fromEntries(rows.map((r) => [r.agreement_id, r.amount]))).toEqual({ [a.id]: '100.00', [b.id]: '900.00' });
  });

  it('the cap comes from ONE function (deductionCapPercent = 20 until T-519 S2 reads business_rule_values), and floors to the centavo', async () => {
    const f = await fixture('capfn');
    expect(await asOrgT519(f.orgId, (tx) => deductionCapPercent(tx, f.orgId, '2026-01-15'))).toBe(20);
    expect(wageCap(money('0.07'), 20)).toBe('0.01'); // 0.014 floors to 0.01, never rounds up
    expect(wageCap(money('1080.00'), 20)).toBe('216.00');
  });

  it('two agreements whose limits exceed 20%: still 216.00', async () => {
    const f = await fixture('two20');
    const c1 = await chargeEntry(sql, f, f.workerId, '1000.00');
    const c2 = await chargeEntry(sql, f, f.workerId, '1000.00', 'order_wastage');
    await agree(sql, f, f.admin, f.workerId, c1, { amount: '1000.00', perPayrollLimit: '150.00' });
    await agree(sql, f, f.admin, f.workerId, c2, { amount: '1000.00', perPayrollLimit: '150.00' });
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('216.00');
  });
});

describe('T-519 R6 - completion, and a void reopens it', () => {
  it('an agreement paid in full becomes completed in the same transaction as the post, and then recovers nothing more', async () => {
    const f = await fixture('complete');
    const charge = await chargeEntry(sql, f, f.workerId, '1000.00');
    const a = await agree(sql, f, f.admin, f.workerId, charge, { amount: '150.00', perPayrollLimit: '150.00' });
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('150.00');
    const s = await statusOf(a.id);
    expect(s.status).toBe('completed');
    expect(s.completed_at).not.toBeNull();
    expect(await asOrgT519(f.orgId, (tx) => agreedRecoverable(tx, f.orgId, f.workerId, money('1080.00'), '2026-01-15'))).toBe('0.00');
  });

  it('voiding the run puts the status back to active and the remaining amount returns', async () => {
    const f = await fixture('reopen');
    const charge = await chargeEntry(sql, f, f.workerId, '1000.00');
    const a = await agree(sql, f, f.admin, f.workerId, charge, { amount: '150.00', perPayrollLimit: '150.00' });
    const { runId } = await post(f);
    expect((await statusOf(a.id)).status).toBe('completed');
    await asOrgT519(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId, reason: 'test void' }));
    const s = await statusOf(a.id);
    expect(s.status).toBe('active');
    expect(s.completed_at).toBeNull();
    expect(await asOrgT519(f.orgId, (tx) => agreedRecoverable(tx, f.orgId, f.workerId, money('1080.00'), '2026-01-15'))).toBe('150.00');
    // and a second run recovers it again
    await post(f);
    expect((await statusOf(a.id)).status).toBe('completed');
  });
});

describe('T-519 R4 - who may record, and what must hold', () => {
  const rec = (f: Fixture, who: Actor, charge: string, over: Partial<Parameters<typeof recordDeductionAgreement>[2]> = {}) =>
    asOrgT519(f.orgId, async (tx) =>
      recordDeductionAgreement(tx, who, {
        personId: f.workerId, storeId: f.storeId, sourceEntryId: charge, amount: '100.00', perPayrollLimit: '100.00',
        noticeGivenAt: '2026-01-03', employeeExplanation: 'none given', signedOn: '2026-01-04',
        evidenceFileId: await scanFor(sql, f, who.personId), ...over,
      }));

  it('a manager (no run_payroll) is refused', async () => {
    const f = await fixture('mgr');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    await expect(rec(f, f.manager, charge)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('the charged person may not record their own agreement, even an admin', async () => {
    const f = await fixture('self');
    const charge = await chargeEntry(sql, f, f.admin2Id, '500.00');
    const err = await asOrgT519(f.orgId, async (tx) =>
      recordDeductionAgreement(tx, f.admin2, {
        personId: f.admin2Id, storeId: f.storeId, sourceEntryId: charge, amount: '100.00', perPayrollLimit: '100.00',
        noticeGivenAt: '2026-01-03', employeeExplanation: 'x', signedOn: '2026-01-04', evidenceFileId: await scanFor(sql, f, f.admin2Id),
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('the notice must be on or before the signing day; an explanation is required; the amount cannot exceed the charge', async () => {
    const f = await fixture('rules');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    await expect(rec(f, f.admin, charge, { noticeGivenAt: '2026-01-05', signedOn: '2026-01-04' })).rejects.toBeInstanceOf(RefusalError);
    await expect(rec(f, f.admin, charge, { employeeExplanation: '   ' })).rejects.toBeInstanceOf(RefusalError);
    await expect(rec(f, f.admin, charge, { amount: '500.01' })).rejects.toBeInstanceOf(RefusalError);
    await expect(rec(f, f.admin, charge, { amount: '500.00', perPayrollLimit: '500.00' })).resolves.toHaveProperty('id');
  });

  it('the remaining amount of a charge counts what earlier agreements already recovered', async () => {
    const f = await fixture('remain');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    const a = await agree(sql, f, f.admin, f.workerId, charge, { amount: '150.00', perPayrollLimit: '150.00' });
    await post(f); // recovers 150, completes it
    expect((await statusOf(a.id)).status).toBe('completed');
    await expect(rec(f, f.admin, charge, { amount: '351.00' })).rejects.toBeInstanceOf(RefusalError); // only 350 left
    await expect(rec(f, f.admin, charge, { amount: '350.00' })).resolves.toHaveProperty('id');
  });

  it('one active agreement per charge; cancelling frees the charge and stops recovery', async () => {
    const f = await fixture('onepercharge');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    const a = await agree(sql, f, f.admin, f.workerId, charge, { amount: '100.00' });
    await expect(rec(f, f.admin, charge)).rejects.toBeInstanceOf(RefusalError);
    await asOrgT519(f.orgId, (tx) => cancelDeductionAgreement(tx, f.admin, { agreementId: a.id, reason: 'signed by mistake' }));
    expect((await statusOf(a.id)).status).toBe('cancelled');
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('0.00');
    await expect(rec(f, f.admin, charge)).resolves.toHaveProperty('id');
    await expect(
      asOrgT519(f.orgId, (tx) => cancelDeductionAgreement(tx, f.admin, { agreementId: a.id, reason: 'again' })),
    ).rejects.toBeInstanceOf(RefusalError);
  });

  it('a manager cannot cancel', async () => {
    const f = await fixture('mgrcancel');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    const a = await agree(sql, f, f.admin, f.workerId, charge, { amount: '100.00' });
    await expect(asOrgT519(f.orgId, (tx) => cancelDeductionAgreement(tx, f.manager, { agreementId: a.id, reason: 'x' }))).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('a cross-store agreement is refused: the charge was posted at another store', async () => {
    const f = await fixture('xstore');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00'); // posted at storeId
    await expect(rec(f, f.admin, charge, { storeId: f.store2Id, evidenceFileId: await scanFor(sql, { orgId: f.orgId, storeId: f.store2Id }, f.adminId) })).rejects.toBeInstanceOf(RefusalError);
  });

  it('a cross-org charge is refused, and the other org cannot read the agreement', async () => {
    const f = await fixture('xorgA');
    const g = await fixture('xorgB');
    const foreignCharge = await chargeEntry(sql, g, g.workerId, '500.00');
    await expect(rec(f, f.admin, foreignCharge)).rejects.toBeInstanceOf(RefusalError);
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    const a = await agree(sql, f, f.admin, f.workerId, charge, { amount: '100.00' });
    expect(await asOrgT519(g.orgId, (tx) => deductionAgreementsRepo.getById(tx, g.orgId, a.id))).toBeNull();
    expect(await asOrgT519(g.orgId, (tx) => deductionAgreementsRepo.getById(tx, f.orgId, a.id))).toBeNull(); // RLS, even asking by the other org id
  });

  it('records an audit row and links the scan to the agreement', async () => {
    const f = await fixture('audit');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    const a = await agree(sql, f, f.admin, f.workerId, charge, { amount: '100.00' });
    const rows = await sql<{ action: string }[]>`select action from audit_log where org_id = ${f.orgId} and entity_id = ${a.id}`;
    expect(rows.map((r) => r.action)).toEqual(['staff_deduction_agreement.recorded']);
    const [file] = await sql<{ linked_to: string | null }[]>`select s.linked_to from stored_files s join staff_deduction_agreements d on d.evidence_file_id = s.id where d.id = ${a.id}`;
    expect(file!.linked_to).toBe(a.id);
  });
});

describe('T-519 audit fixes - live balance, live charge, reversal chains', () => {
  const reverse = (f: Fixture, entryId: string) =>
    asOrgT519(f.orgId, (tx) => reverseEntry(tx, { entryId, reason: 'test', reversedBy: f.adminId }));
  const recoveryTotal = async (f: Fixture) =>
    (await sql<{ t: string }[]>`select coalesce(sum(r.amount), 0)::text as t from staff_deduction_recoveries r where r.org_id = ${f.orgId}`)[0]!.t;

  it('probe: charge 500, agreed 500, charge reversed -> the next payroll recovers 0 and 1230 stays at 0', async () => {
    const f = await fixture('revcharge');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '500.00', perPayrollLimit: '500.00' });
    await reverse(f, charge);
    expect(await balance1230(f)).toBe('0.00');
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('0.00');
    expect(await balance1230(f)).toBe('0.00');
  });

  it('the live 1230 balance caps the recovery: agreed 500, but 450 was paid back outside payroll -> recovers 50, balance 0', async () => {
    const f = await fixture('balcap');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '500.00', perPayrollLimit: '500.00' });
    await creditEntry(sql, f, f.workerId, '450.00');
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('50.00');
    expect(await balance1230(f)).toBe('0.00');
  });

  it('a charge reversed and then re-stated (reversal of the reversal) is live again', async () => {
    const f = await fixture('revrev-charge');
    const charge = await chargeEntry(sql, f, f.workerId, '500.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '100.00', perPayrollLimit: '100.00' });
    const r1 = (await reverse(f, charge)).reversalEntryId;
    await reverse(f, r1);
    await post(f);
    expect((await slipRecovered(f)).advance_recovered).toBe('100.00');
  });

  it("probe: charge 1000, agreement 150, payroll void, then the void's own reversal reversed -> a second payroll takes nothing more (150 in all, not 300)", async () => {
    const f = await fixture('revvoid');
    const charge = await chargeEntry(sql, f, f.workerId, '1000.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '150.00', perPayrollLimit: '150.00' });
    const { runId } = await post(f);
    const [rec] = await sql<{ journal_entry_id: string }[]>`select journal_entry_id from staff_deduction_recoveries where org_id = ${f.orgId}`;
    await asOrgT519(f.orgId, (tx) => voidPayRun(tx, f.admin, { runId, reason: 'test void' }));
    const [rv] = await sql<{ id: string }[]>`select id from journal_entries where reversal_of_entry_id = ${rec!.journal_entry_id}`;
    await reverse(f, rv!.id); // the void is undone at the ledger: the payslip entry is live again, 1230 is credited again
    expect(await balance1230(f)).toBe('850.00');
    await post(f);
    expect(await recoveryTotal(f)).toBe('150.00'); // the second run recovered nothing more
    expect(await balance1230(f)).toBe('850.00');
  });

  it("recordOwnerSelfAgreement refuses a charge that is not the person's 1230 charge, and an amount above what the charge has left", async () => {
    const f = await fixture('ownerself');
    const mine = await chargeEntry(sql, f, f.workerId, '300.00', 'owner_pay_recovery');
    const someoneElses = await chargeEntry(sql, f, f.managerId, '300.00', 'owner_pay_recovery');
    const w = actor(f.orgId, f.workerId);
    const call = (entry: string, amount: string) =>
      asOrgT519(f.orgId, (tx) =>
        recordOwnerSelfAgreement(tx, w, { personId: f.workerId, storeId: f.storeId, sourceEntryId: entry, amount: money(amount), on: '2026-01-04' }));
    await expect(call(someoneElses, '100.00')).rejects.toBeInstanceOf(RefusalError);
    await expect(call(mine, '300.01')).rejects.toBeInstanceOf(RefusalError);
    await expect(call(mine, '300.00')).resolves.toBeUndefined();
  });

  it('two posts (payroll and separation both end in applyDeductionRecovery) cannot both spend one agreement: the second waits on the lock, then finds nothing left', async () => {
    const f = await fixture('lock');
    const charge = await chargeEntry(sql, f, f.workerId, '1000.00');
    const payoutA = await chargeEntry(sql, f, f.managerId, '1.00'); // stand-ins for the two posted payout entries
    const payoutB = await chargeEntry(sql, f, f.managerId, '1.00');
    await agree(sql, f, f.admin, f.workerId, charge, { amount: '60.00', perPayrollLimit: '60.00' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let firstApplied!: () => void;
    const applied = new Promise<void>((r) => { firstApplied = r; });
    const first = asOrgT519(f.orgId, async (tx) => {
      await applyDeductionRecovery(tx, f.orgId, f.workerId, payoutA, money('60.00'));
      firstApplied();
      await gate; // hold the first post open (uncommitted)
    });
    await applied;
    const second = Promise.allSettled([asOrgT519(f.orgId, (tx) => applyDeductionRecovery(tx, f.orgId, f.workerId, payoutB, money('60.00')))]);
    await new Promise((r) => setTimeout(r, 800)); // the second is parked on the lock; with no lock it would finish inside this wait
    release();
    await first;
    const [r2] = await second;
    expect(r2!.status).toBe('rejected');
    expect(await recoveryTotal(f)).toBe('60.00');
  });
});
