import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-440 S7 (TESTER) - one refusal per rule the S7 sweep newly enforces on the server (Q5: a field marked required or bounded on
 * screen but never checked by the action / domain path). Each case runs the REAL server action with a bad value and proves two
 * things: the person is told the rule's exact sentence (the line the screen shows live, imported from the rule set so the
 * expectation is never a copy), and NOTHING was written.
 *
 * Session mocked (t412 idiom); redirects captured; the banner read through the flash jar. Every case names the mutant it kills;
 * the mutant is "the assertFieldRules call is removed from that action / domain path" unless stated otherwise.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../../../../tests/helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../../../apps/erp/src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import { captureRedirect, outcomeOf, resetJar } from '../../../../tests/helpers/flash-jar';
import { moneyFixture } from './_fixtures/t402-s3-money';
import { testItemCode } from './_fixtures/item-code';
import { SETTINGS_LEAVE_CAP_RULES, SETTINGS_LEAVE_KIND_RULES, SETTINGS_ORG_TOLERANCE_RULES, SETTINGS_ITEM_TOLERANCE_RULES, SETTINGS_ORGANIZATION_RULES, SETTINGS_EXPENSE_CATEGORY_RULES, SETTINGS_SALES_CHANNEL_RULES, SETTINGS_POS_LINK_RULES, SETTINGS_POS_UNLINK_RULES, SETTINGS_TENDER_RULES } from '../../src/field-rules/settings';
import { FINDINGS_MISSING_PERIOD_RULES, FINDINGS_MISSED_MONTH_RULES } from '../../src/field-rules/findings';
import { REPORTS_DUAL_RUN_DISPOSITION_RULES } from '../../src/field-rules/reports';
import { checkField } from '../../src/field-rules/check';

const sql = postgres(url, { max: 5 });
const APP = '../../../../apps/erp/src/app';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Fx = Awaited<ReturnType<typeof moneyFixture>>;
let fxPromise: Promise<Fx> | null = null;
const fixture = () => (fxPromise ??= moneyFixture(sql, 't440s7'));

/** The sentence the SCREEN shows for this value: the rule set's own, so client === server is the thing under test. */
function sentence(rule: Parameters<typeof checkField>[0], value: string): string {
  const c = checkField(rule, value);
  if (c.ok) throw new Error(`the fixture value ${JSON.stringify(value.slice(0, 12))} passes ${rule.name}; pick a failing one`);
  return c.requirement;
}

/** Runs the action as the org's administrator and returns the banner it redirected with. */
async function run(mod: string, name: string, fields: Record<string, string>, as?: { personId: string; orgId: string }) {
  const f = await fixture();
  const act = ((await import(/* @vite-ignore */ `${APP}/${mod}`)) as Record<string, (fd: FormData) => Promise<void>>)[name];
  if (!act) throw new Error(`${mod} exports no ${name}`);
  resetJar();
  h.actor = as ?? f.admin;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => act(fd)));
}

async function count(table: string, orgId: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table} where org_id = '${orgId}'`);
  return rows[0]?.n ?? 0;
}

describe('T-440 S7: a bad value is refused with the rule sentence and nothing is written', () => {
  it('settings/attendance saveLeaveCapAction: a negative monthly cap is refused; no cap row (mutant: assert removed from saveLeaveCapAction)', async () => {
    const f = await fixture();
    const before = await count('leave_caps', f.orgId);
    const o = await run('settings/attendance/actions', 'saveLeaveCapAction', { storeId: f.storeId, scope: 'store', leaveType: 'vacation', monthlyCap: '-1', yearlyCap: '' });
    expect(o.flash.error).toBe(sentence(SETTINGS_LEAVE_CAP_RULES.monthlyCap, '-1'));
    expect(await count('leave_caps', f.orgId)).toBe(before);
  });

  it('settings/attendance saveLeaveCapAction: 367 days a year is refused; no cap row (mutant: max 366 dropped from the rule)', async () => {
    const f = await fixture();
    const before = await count('leave_caps', f.orgId);
    const o = await run('settings/attendance/actions', 'saveLeaveCapAction', { storeId: f.storeId, scope: 'store', leaveType: 'vacation', monthlyCap: '', yearlyCap: '367' });
    expect(o.flash.error).toBe(sentence(SETTINGS_LEAVE_CAP_RULES.yearlyCap, '367'));
    expect(await count('leave_caps', f.orgId)).toBe(before);
  });

  it('settings/attendance addLeaveTypeAction: a code that starts with a digit is refused; no leave kind (mutant: assert removed from addLeaveTypeAction)', async () => {
    const f = await fixture();
    const before = await count('leave_types', f.orgId);
    const o = await run('settings/attendance/actions', 'addLeaveTypeAction', { storeId: f.storeId, label: 'Study leave', code: '1study', paid: 'paid' });
    expect(o.flash.error).toBe(sentence(SETTINGS_LEAVE_KIND_RULES.code, '1study'));
    expect(await count('leave_types', f.orgId)).toBe(before);
  });

  it('settings/attendance addLeaveTypeAction: a blank name is refused with the one leave-kind sentence; no leave kind (mutant: label rule dropped)', async () => {
    const f = await fixture();
    const before = await count('leave_types', f.orgId);
    const o = await run('settings/attendance/actions', 'addLeaveTypeAction', { storeId: f.storeId, label: '   ', code: 'study_ok', paid: 'paid' });
    expect(o.flash.error).toBe(sentence(SETTINGS_LEAVE_KIND_RULES.label, ''));
    expect(await count('leave_types', f.orgId)).toBe(before);
  });

  it('settings/usage-tolerance setOrgUsageToleranceAction: 1.5 is refused; the stored band is unchanged (mutant: pattern loosened or assert removed)', async () => {
    const f = await fixture();
    const [b] = await sql<{ t: string }[]>`select usage_tolerance::text as t from organizations where id = ${f.orgId}`;
    const o = await run('settings/usage-tolerance/actions', 'setOrgUsageToleranceAction', { tolerance: '1.5' });
    expect(o.flash.error).toBe(sentence(SETTINGS_ORG_TOLERANCE_RULES.tolerance, '1.5'));
    const [a] = await sql<{ t: string }[]>`select usage_tolerance::text as t from organizations where id = ${f.orgId}`;
    expect(a!.t).toBe(b!.t);
  });

  it('settings/usage-tolerance setItemUsageToleranceAction: five decimals are refused; the item keeps no override (mutant: item rule not applied)', async () => {
    const f = await fixture();
    const code = testItemCode();
    const [item] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${code}, 'Pork', 'raw_material', 'kg', ${f.admin.personId}) returning id`;
    if (!item) throw new Error('fixture: the item insert returned no row');
    const o = await run('settings/usage-tolerance/actions', 'setItemUsageToleranceAction', { itemId: item.id, tolerance: '0.12345' });
    expect(o.flash.error).toBe(sentence(SETTINGS_ITEM_TOLERANCE_RULES.tolerance, '0.12345'));
    const [row] = await sql<{ t: string | null }[]>`select usage_tolerance::text as t from items where id = ${item.id}`;
    expect(row!.t).toBeNull();
  });

  it('settings/organization setOrganizationIdentityAction: a 4-digit TIN is refused; the stored TIN is unchanged (mutant: TIN rule not applied)', async () => {
    const f = await fixture();
    const [b] = await sql<{ tin: string | null }[]>`select tin from organizations where id = ${f.orgId}`;
    const o = await run('settings/organization/actions', 'setOrganizationIdentityAction', { legalName: 'Shareat Test Corp', tin: '1234', taxType: 'vat' });
    expect(o.flash.error).toBe(sentence(SETTINGS_ORGANIZATION_RULES.tin, '1234'));
    const [a] = await sql<{ tin: string | null }[]>`select tin from organizations where id = ${f.orgId}`;
    expect(a!.tin).toBe(b!.tin);
  });

  it('settings/expense-categories createCategoryAction: a blank name is refused; no category row (mutant: category rule not applied)', async () => {
    const f = await fixture();
    const before = await count('expense_categories', f.orgId);
    const o = await run('settings/expense-categories/actions', 'createCategoryAction', { category: '   ', group: 'OPEX', accountCode: '' });
    expect(o.flash.error).toBe(sentence(SETTINGS_EXPENSE_CATEGORY_RULES.category, ''));
    expect(await count('expense_categories', f.orgId)).toBe(before);
  });

  it('settings/sales-channels createSalesChannelAction: a blank name is refused; no channel row (mutant: channel name rule not applied)', async () => {
    const f = await fixture();
    const before = await count('sales_channels', f.orgId);
    const o = await run('settings/sales-channels/actions', 'createSalesChannelAction', { storeId: f.storeId, name: '   ', isRemittedDaily: 'true' });
    expect(o.flash.error).toBe(sentence(SETTINGS_SALES_CHANNEL_RULES.name, ''));
    expect(await count('sales_channels', f.orgId)).toBe(before);
  });

  it('settings/pos-link createTenderAction: a blank kind is refused; no tender row (mutant: tender kind rule not applied)', async () => {
    const f = await fixture();
    const before = await count('tenders', f.orgId);
    const o = await run('settings/pos-link/actions', 'createTenderAction', { storeId: f.storeId, name: 'GCash', kind: '' });
    expect(o.flash.error).toBe(sentence(SETTINGS_TENDER_RULES.kind, ''));
    expect(await count('tenders', f.orgId)).toBe(before);
  });

  it('settings/pos-link createTenderAction: a blank name is refused; no tender row (mutant: tender name rule not applied)', async () => {
    const f = await fixture();
    const before = await count('tenders', f.orgId);
    const o = await run('settings/pos-link/actions', 'createTenderAction', { storeId: f.storeId, name: '   ', kind: 'wallet' });
    expect(o.flash.error).toBe(sentence(SETTINGS_TENDER_RULES.name, ''));
    expect(await count('tenders', f.orgId)).toBe(before);
  });

  it('settings/pos-link unlinkStoreFromPosAction: a 501-character reason is refused after the retype passes; the store stays as it was (mutant: unlink reason max dropped)', async () => {
    const f = await fixture();
    const [store] = await sql<{ name: string }[]>`select name from stores where id = ${f.storeId}`;
    const before = await count('pos_v1_store_links', f.orgId);
    // Unlinking is a super-administrator's capability (CAPABILITY-MATRIX), so the actor is one.
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Super') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'super_admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
    const o = await run('settings/pos-link/actions', 'unlinkStoreFromPosAction', { storeId: f.storeId, confirmName: store!.name, reason: 'q'.repeat(501) }, { personId: p!.id, orgId: f.orgId });
    expect(o.flash.error).toBe(sentence(SETTINGS_POS_UNLINK_RULES.reason, 'q'.repeat(501)));
    expect(await count('pos_v1_store_links', f.orgId)).toBe(before);
  });

  it('findings createMissingClosedPeriodAction: a blank reason is refused with the screen sentence; no period created (mutant: assert removed from createMissingClosedPeriodAction)', async () => {
    const f = await fixture();
    const before = await count('fiscal_periods', f.orgId);
    const o = await run('findings/actions', 'createMissingClosedPeriodAction', { period: '2026-01', startsOn: '2025-12-01', endsOn: '2025-12-31', reason: '   ' });
    expect(o.flash.error).toBe(sentence(FINDINGS_MISSING_PERIOD_RULES.reason, ''));
    expect(await count('fiscal_periods', f.orgId)).toBe(before);
  });

  it('findings bookMissedMonthAction: a blank reason is refused with the screen sentence; no journal entry (mutant: assert removed from bookMissedMonthAction)', async () => {
    const f = await fixture();
    const before = await count('journal_entries', f.orgId);
    const o = await run('findings/actions', 'bookMissedMonthAction', {
      period: '2026-01',
      schedule: 'depreciation',
      subjectId: '00000000-0000-0000-0000-000000000000',
      belongsToPeriod: '2026-01',
      reason: '   ',
    });
    expect(o.flash.error).toBe(sentence(FINDINGS_MISSED_MONTH_RULES.reason, ''));
    expect(await count('journal_entries', f.orgId)).toBe(before);
  });

  it('reports/dual-run recordDualRunDispositionAction: a reference not shaped like DEF-123 is refused; no disposition row (mutant: ref rule not applied in the domain)', async () => {
    const f = await fixture();
    const before = await count('dual_run_dispositions', f.orgId);
    const o = await run('reports/dual-run/actions', 'recordDualRunDispositionAction', {
      storeId: f.storeId,
      weekStart: '2026-01-05',
      kind: 'sales_tender',
      lineKey: 'cash',
      class: 'V1_DEFECT',
      ref: 'bug-9',
      note: 'The old system rounds up',
    });
    expect(o.flash.error).toBe(sentence(REPORTS_DUAL_RUN_DISPOSITION_RULES.ref, 'bug-9'));
    expect(await count('dual_run_dispositions', f.orgId)).toBe(before);
  });

  it('reports/dual-run recordDualRunDispositionAction: a 501-character note is refused; no disposition row (mutant: note max dropped)', async () => {
    const f = await fixture();
    const before = await count('dual_run_dispositions', f.orgId);
    const note = 'z'.repeat(501);
    const o = await run('reports/dual-run/actions', 'recordDualRunDispositionAction', {
      storeId: f.storeId,
      weekStart: '2026-01-05',
      kind: 'sales_tender',
      lineKey: 'cash',
      class: 'V2_DEFECT',
      ref: 'DEF-123',
      note,
    });
    expect(o.flash.error).toBe(sentence(REPORTS_DUAL_RUN_DISPOSITION_RULES.note, note));
    expect(await count('dual_run_dispositions', f.orgId)).toBe(before);
  });
});
