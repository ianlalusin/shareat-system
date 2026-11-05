import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * T-519 S2 - the "Charges and repayment agreements" section (R7): the two server actions through the REAL domain and database,
 * and the section's render by role. docs/tasks/519-staff-deduction-agreements.md R7.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: the database name must contain "_test".');

const holder: { actor: { orgId: string; personId: string } | null } = { actor: null };
const flashes: { path: string; flash: { ok?: string; error?: string } }[] = [];
vi.mock('../../src/lib/session', () => ({ requireActor: vi.fn(async () => holder.actor!) }));
vi.mock('@/lib/flash', () => ({
  redirectWithFlash: async (path: string, _q: unknown, flash: { ok?: string; error?: string }) => {
    flashes.push({ path, flash });
  },
}));

import { closeDb } from '@shareat/db';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { chargeEntry, scanFor } from '../../../../packages/domain/tests/integration/_fixtures/t519-agreements';
import { cancelDeductionAgreementAction, recordDeductionAgreementAction } from '../../src/app/staff/actions';
import { deductionAgreementsFor } from '../../src/app/staff/lib';
import { DeductionAgreementsSection } from '../../src/app/staff/[employmentId]/DeductionAgreementsSection';
import { chargeRepaymentLabel, chargeSourceLabel } from '../../src/app/staff/deduction-labels';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await sql.end();
  await closeDb();
});
beforeEach(() => {
  flashes.length = 0;
});

async function fixture() {
  const code = uid('t519s2');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id`)[0]!.id;
  const storeId = await mkStore('a');
  const store2Id = await mkStore('b');
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin', [storeId, store2Id]);
  const managerId = await mk('Manager', 'manager', [storeId]);
  const staffId = await mk('Other Staff', 'staff', [storeId]);
  const workerId = await mk('Worker', 'staff', [storeId]);
  const emp = async (personId: string, store: string) =>
    (await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${orgId}, ${personId}, ${store}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, '2026-01-01', 'regular', ${adminId}) returning id`)[0]!.id;
  const f = { orgId, storeId, store2Id, adminId, managerId, staffId, workerId, employmentId: await emp(workerId, storeId) };
  return { ...f, adminEmploymentId: await emp(adminId, storeId) };
}
type F = Awaited<ReturnType<typeof fixture>>;

async function submit(f: F, as: string, employmentId: string, entryId: string, over: Record<string, string> = {}) {
  holder.actor = { orgId: f.orgId, personId: as };
  const scan = await scanFor(sql, f, as);
  const fd = new FormData();
  const fields: Record<string, string> = {
    employmentId, sourceEntryId: entryId, amount: '500.00', perPayrollLimit: '250.00', noticeGivenAt: '2026-01-03',
    signedOn: '2026-01-04', employeeExplanation: 'none given', scanFileId: scan, ...over,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  await recordDeductionAgreementAction(fd);
  return flashes.at(-1)!.flash;
}
const agreementsOf = (f: F) => sql<{ id: string; status: string }[]>`select id, status from staff_deduction_agreements where org_id = ${f.orgId}`;

describe('T-519 S2 - record and cancel through the real domain', () => {
  it('an administrator records an agreement; the charge leaves "waiting"; then cancels it with a reason', async () => {
    const f = await fixture();
    const entry = await chargeEntry(sql, f, f.workerId, '800.00');
    holder.actor = { orgId: f.orgId, personId: f.adminId };
    expect((await deductionAgreementsFor(holder.actor, f.workerId, f.storeId))!.waiting).toHaveLength(1);

    expect((await submit(f, f.adminId, f.employmentId, entry)).ok).toMatch(/Agreement recorded/);
    const rows = await agreementsOf(f);
    expect(rows).toHaveLength(1);
    const view = (await deductionAgreementsFor(holder.actor, f.workerId, f.storeId))!;
    expect(view.waiting).toHaveLength(0);
    expect(view.agreements[0]).toMatchObject({ status: 'active', amount: '500.00', left: '500.00' });
    expect(view.capPercent).toBe(20);

    const fd = new FormData();
    fd.set('employmentId', f.employmentId);
    fd.set('agreementId', rows[0]!.id);
    fd.set('reason', 'signed in error');
    await cancelDeductionAgreementAction(fd);
    expect(flashes.at(-1)!.flash.ok).toMatch(/cancelled/);
    expect((await agreementsOf(f))[0]!.status).toBe('cancelled');
    expect((await deductionAgreementsFor(holder.actor, f.workerId, f.storeId))!.waiting).toHaveLength(1);
  });

  it('a cancel with no reason is refused and the agreement stays active', async () => {
    const f = await fixture();
    const entry = await chargeEntry(sql, f, f.workerId, '800.00');
    await submit(f, f.adminId, f.employmentId, entry);
    const fd = new FormData();
    fd.set('employmentId', f.employmentId);
    fd.set('agreementId', (await agreementsOf(f))[0]!.id);
    await cancelDeductionAgreementAction(fd);
    expect(flashes.at(-1)!.flash.error).toBeTruthy();
    expect((await agreementsOf(f))[0]!.status).toBe('active');
  });

  it('staff are refused: nothing is written', async () => {
    const f = await fixture();
    const entry = await chargeEntry(sql, f, f.workerId, '800.00');
    expect((await submit(f, f.staffId, f.employmentId, entry)).error).toBeTruthy();
    expect(await agreementsOf(f)).toHaveLength(0);
  });

  it('the charged person is refused even when they hold payroll rights', async () => {
    const f = await fixture();
    const entry = await chargeEntry(sql, f, f.adminId, '800.00');
    const flash = await submit(f, f.adminId, f.adminEmploymentId, entry);
    expect(flash.error).toMatch(/against yourself/);
    expect(await agreementsOf(f)).toHaveLength(0);
  });

  it('a charge posted at another store is refused', async () => {
    const f = await fixture();
    const entry = await chargeEntry(sql, { orgId: f.orgId, storeId: f.store2Id }, f.workerId, '800.00');
    expect((await submit(f, f.adminId, f.employmentId, entry)).error).toMatch(/different store/);
    expect(await agreementsOf(f)).toHaveLength(0);
  });

  it('a missing scan is refused before anything is written, and a blank explanation is refused by the field rule', async () => {
    const f = await fixture();
    const entry = await chargeEntry(sql, f, f.workerId, '800.00');
    expect((await submit(f, f.adminId, f.employmentId, entry, { scanFileId: '' })).error).toMatch(/scan/i);
    expect((await submit(f, f.adminId, f.employmentId, entry, { employeeExplanation: '' })).error).toMatch(/explain/i);
    expect(await agreementsOf(f)).toHaveLength(0);
  });
});

describe('T-519 S2 - the section by role', () => {
  it('an administrator sees the section with the form and the cap; staff and a manager get no section', async () => {
    const f = await fixture();
    await chargeEntry(sql, f, f.workerId, '800.00');
    const draw = async (as: string) => {
      const view = await deductionAgreementsFor({ orgId: f.orgId, personId: as }, f.workerId, f.storeId);
      return { view, html: renderToStaticMarkup(createElement(DeductionAgreementsSection, { view, employmentId: f.employmentId, storeId: f.storeId })) };
    };
    const admin = await draw(f.adminId);
    expect(admin.html).toContain('Charges and repayment agreements');
    expect(admin.html).toContain('Till shortage');
    expect(admin.html).toContain('Record signed agreement');
    expect(admin.html).toContain('20%');
    for (const who of [f.staffId, f.managerId]) {
      const r = await draw(who);
      expect(r.view).toBeNull();
      expect(r.html).toBe('');
    }
  });

  it('the charged person sees their own list but no form and no cancel', async () => {
    const f = await fixture();
    await chargeEntry(sql, f, f.adminId, '800.00');
    const view = await deductionAgreementsFor({ orgId: f.orgId, personId: f.adminId }, f.adminId, f.storeId);
    const html = renderToStaticMarkup(createElement(DeductionAgreementsSection, { view, employmentId: f.adminEmploymentId, storeId: f.storeId }));
    expect(html).toContain('Till shortage');
    expect(html).not.toContain('Record signed agreement');
  });
});

describe('T-519 S2 - plain words', () => {
  it('the payslip line and the source names', () => {
    expect(chargeRepaymentLabel('2026-01-04')).toBe('Charge repayment, agreement of 2026-01-04');
    expect(chargeSourceLabel('tillcountshortage')).toBe('Till shortage');
    expect(chargeSourceLabel('remittance_variance')).toBe('Remittance shortage');
    expect(chargeSourceLabel('trade_discrepancy')).toBe('Commissary charge');
    expect(chargeSourceLabel('order_wastage')).toBe('Wastage charge');
    expect(chargeSourceLabel('owner_pay_recovery')).toBe('Owner drawing');
  });
});
