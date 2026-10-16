import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-418 (TESTER) - deleting an unposted draft needs NO administrator's PIN; a posted record is never deleted.
 * docs/tasks/418-draft-delete-without-pin.md, cases 1-8 (case 9 is the census, case 10 the render guard).
 *
 * The three real server actions run with the session mocked (the t412-destructive-actions idiom). No case posts an
 * `adminPin` unless it says so.
 *
 * RED TODAY: the three actions still call verifyAdminApproval, so a draft delete with no PIN is refused with the
 * admin-PIN sentence and the row is still there (cases 1-3, 8b); the "with a valid PIN" legs of cases 4-6 find either
 * a destructive.approved row or a PIN-shaped refusal where a status refusal belongs.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import { hashPin, pinLookupHash } from '@shareat/auth';
import * as D from '@shareat/domain';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';
import { asOrgOn } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { auditRows, draftExpense, moneyFixture, pendingInvoice, uid, type MoneyFx } from '../../../../packages/domain/tests/integration/_fixtures/t402-s3-money';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
const ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.';
const ATTEST = { supplier: true, invoice: true, items: true, price: true };

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function runAction(modulePath: string, name: string, fields: Record<string, string>, who: { personId: string; orgId: string }) {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  const act = mod[name];
  if (typeof act !== 'function') throw new Error(`MISSING EXPORT: ${modulePath} does not export ${name}.`);
  resetJar();
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => (act as (f: FormData) => Promise<void>)(fd)));
}
const EXP = '../../src/app/expenses/actions';
const USE = '../../src/app/inventory/usage/actions';
const REC = '../../src/app/expenses/recurring/actions';

async function adminPinOf(f: MoneyFx): Promise<string> {
  const pin = String(300000 + Math.floor(Math.random() * 600000));
  await sql`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${f.adminId}, 'pin', ${f.storeId}, ${await hashPin(pin)}, ${pinLookupHash(f.orgId, pin)})`;
  return pin;
}

/** A draft cash expense by STAFF (against a verified invoice), or the same one approved (posted). */
async function expense(f: MoneyFx, posted: boolean) {
  const inv = await pendingInvoice(sql, f, '5000.00');
  await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
  const e = await draftExpense(f, inv, '150.00');
  if (posted) await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, e.id));
  return e.id;
}
const expenseStatus = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]?.status ?? 'gone';
const journalCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId}`)[0]!.n;

/** A usage draft (staff) in a store with an operating room and one item; optionally flipped to posted by SQL. */
async function usage(f: MoneyFx, posted: boolean) {
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, ${uid('T')}, 'Room') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, ${uid('K')}, 'Kitchen', ${t!.id}, 'operating', true, ${f.staffId}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${testItemCode()}, 'Pork Belly', 'raw_material', 'kg', ${f.staffId}) returning id`;
  const r = await asOrgOn(f.orgId, (tx) =>
    D.saveUsageDraft(tx, f.staff, { orgId: f.orgId, storeId: f.storeId, locationId: loc!.id, kind: 'usage', usedOn: '2026-01-10', lines: [{ itemId: item!.id, quantity: '2' }] }),
  );
  if (!r.ok) throw new Error(r.reason);
  if (posted) await sql`update stock_usage_records set status = 'posted', posted_at = now(), posted_by = ${f.managerId} where id = ${r.recordId}`;
  return r.recordId;
}
const usageState = async (id: string) =>
  JSON.stringify({
    rec: (await sql<{ status: string }[]>`select status from stock_usage_records where id = ${id}`)[0]?.status ?? 'gone',
    lines: (await sql<{ n: number }[]>`select count(*)::int as n from stock_usage_lines where record_id = ${id}`)[0]!.n,
  });
const movementCount = async (orgId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from stock_movements where org_id = ${orgId}`)[0]!.n;

async function template(f: MoneyFx, produced: boolean) {
  const t = await asOrgOn(f.orgId, (tx) =>
    D.createRecurringTemplate(tx, f.manager, { storeId: f.storeId, name: 'Lipa rent', categoryId: f.categoryId, supplierId: f.supplierId, defaultAmount: '25000.00', interval: 'monthly', anchorDay: 5 }),
  );
  if (produced) {
    const inv = await pendingInvoice(sql, f, '5000.00');
    const e = await draftExpense(f, inv, '100.00');
    await sql`update recurring_expenses set last_drafted_expense_id = ${e.id}, last_drafted_at = now() where id = ${t.id}`;
  }
  return t.id;
}
const templateExists = async (id: string) => (await sql<{ n: number }[]>`select count(*)::int as n from recurring_expenses where id = ${id}`)[0]!.n === 1;

describe('T-418 case 1: a manager deletes another person draft expense with no adminPin', () => {
  it('row gone, redirect to /expenses, no approval row', async () => {
    const f = await moneyFixture(sql, 't418-c1');
    const id = await expense(f, false);
    expect(await expenseStatus(id)).toBe('draft');
    const o = await runAction(EXP, 'deleteDraftAction', { expenseId: id }, f.manager);
    expect(o.flash.error, 'no PIN was asked for').toBeUndefined();
    expect(await expenseStatus(id), 'the draft is gone').toBe('gone');
    expect(o.path).toBe('/expenses');
    expect(await auditRows(sql, f.orgId, 'destructive.approved', id)).toHaveLength(0);
  });
});

describe('T-418 case 2: a manager deletes a USAGE draft with no adminPin', () => {
  it('record and its lines gone, no approval row', async () => {
    const f = await moneyFixture(sql, 't418-c2');
    const id = await usage(f, false);
    expect(JSON.parse(await usageState(id)).lines).toBe(1);
    const o = await runAction(USE, 'deleteUsageDraftAction', { recordId: id, storeId: f.storeId }, f.manager);
    expect(o.flash.error, 'no PIN was asked for').toBeUndefined();
    expect(JSON.parse(await usageState(id)), 'record and lines gone').toEqual({ rec: 'gone', lines: 0 });
    expect(await auditRows(sql, f.orgId, 'destructive.approved', id)).toHaveLength(0);
  });
});

describe('T-418 case 3: a manager deletes a recurring template that never produced, no adminPin', () => {
  it('template gone, no approval row', async () => {
    const f = await moneyFixture(sql, 't418-c3');
    const id = await template(f, false);
    const o = await runAction(REC, 'deleteTemplateAction', { templateId: id, storeId: f.storeId }, f.manager);
    expect(o.flash.error, 'no PIN was asked for').toBeUndefined();
    expect(await templateExists(id)).toBe(false);
    expect(await auditRows(sql, f.orgId, 'destructive.approved', id)).toHaveLength(0);
  });
});

describe('T-418 case 4: deleteDraftAction on a POSTED expense is refused, PIN or not', () => {
  it('without a PIN and with a valid admin PIN: "Only a draft can be deleted", still posted, journal unchanged', async () => {
    const f = await moneyFixture(sql, 't418-c4');
    const adminPin = await adminPinOf(f);
    const id = await expense(f, true);
    expect(await expenseStatus(id)).toBe('posted');
    const journal = await journalCount(f.orgId);
    for (const fields of [{ expenseId: id }, { expenseId: id, adminPin }]) {
      const o = await runAction(EXP, 'deleteDraftAction', fields, f.manager);
      expect(o.flash.error ?? '', 'refused for the right reason, not as a PIN problem').toContain('Only a draft can be deleted');
      expect(await expenseStatus(id)).toBe('posted');
      expect(await journalCount(f.orgId)).toBe(journal);
    }
  });
});

describe('T-418 case 5: deleteUsageDraftAction on a POSTED usage record is refused', () => {
  it('record, lines and stock movements unchanged; not a PIN refusal', async () => {
    const f = await moneyFixture(sql, 't418-c5');
    const adminPin = await adminPinOf(f);
    const id = await usage(f, true);
    const before = await usageState(id);
    const moves = await movementCount(f.orgId);
    expect(JSON.parse(before).rec).toBe('posted');
    for (const fields of [{ recordId: id, storeId: f.storeId }, { recordId: id, storeId: f.storeId, adminPin }]) {
      const o = await runAction(USE, 'deleteUsageDraftAction', fields, f.manager);
      expect(o.flash.error, 'refused').toBeDefined();
      expect(o.flash.error, 'refused because it is not a draft, not for want of a PIN').not.toBe(ADMIN_PIN_REFUSED);
      expect(await usageState(id)).toBe(before);
      expect(await movementCount(f.orgId)).toBe(moves);
    }
  });
});

describe('T-418 case 6: deleteTemplateAction on a template that HAS produced an expense is refused', () => {
  it('"pause it instead"; the template stays', async () => {
    const f = await moneyFixture(sql, 't418-c6');
    const adminPin = await adminPinOf(f);
    const id = await template(f, true);
    for (const fields of [{ templateId: id, storeId: f.storeId }, { templateId: id, storeId: f.storeId, adminPin }]) {
      const o = await runAction(REC, 'deleteTemplateAction', fields, f.manager);
      expect(o.flash.error ?? '').toContain('pause it instead');
      expect(await templateExists(id)).toBe(true);
    }
  });
});

describe('T-418 case 7: removing the PIN does not remove the domain authorization', () => {
  it('a cashier with only edit_own_expense who is NOT the creator cannot delete someone else draft', async () => {
    const f = await moneyFixture(sql, 't418-c7');
    const id = await expense(f, false); // created by f.staff
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Cashier Two') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${f.orgId}, ${f.storeId}, ${p!.id}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId: f.orgId, storeId: f.storeId, employmentId: emp!.id, personId: p!.id, setBy: f.managerId, capabilities: ['edit_own_expense'] });
    const o = await runAction(EXP, 'deleteDraftAction', { expenseId: id }, { personId: p!.id, orgId: f.orgId });
    expect(o.flash.error, 'refused').toBeDefined();
    expect(o.flash.error, 'refused by the domain gate, not asked for a PIN').not.toBe(ADMIN_PIN_REFUSED);
    expect(await expenseStatus(id), 'the draft is still there').toBe('draft');
  });
});

describe('T-418 case 8: posted-record voids keep the admin PIN; draft deletes write no approval row', () => {
  it('voidExpenseAction and voidUsageAction with no adminPin -> ADMIN_PIN_REFUSED, nothing changed', async () => {
    const f = await moneyFixture(sql, 't418-c8');
    const eid = await expense(f, true);
    const rid = await usage(f, true);
    const journal = await journalCount(f.orgId);
    const e = await runAction(EXP, 'voidExpenseAction', { expenseId: eid, reason: 'Wrong supplier' }, f.manager);
    expect(e.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await expenseStatus(eid)).toBe('posted');
    const u = await runAction(USE, 'voidUsageAction', { recordId: rid, reason: 'Wrong qty' }, f.manager);
    expect(u.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(JSON.parse(await usageState(rid)).rec).toBe('posted');
    expect(await journalCount(f.orgId)).toBe(journal);
  });

  it('no destructive.approved row exists after the three draft deletes (no approver, no row)', async () => {
    const f = await moneyFixture(sql, 't418-c8b');
    const eid = await expense(f, false);
    const rid = await usage(f, false);
    const tid = await template(f, false);
    await runAction(EXP, 'deleteDraftAction', { expenseId: eid }, f.manager);
    await runAction(USE, 'deleteUsageDraftAction', { recordId: rid, storeId: f.storeId }, f.manager);
    await runAction(REC, 'deleteTemplateAction', { templateId: tid, storeId: f.storeId }, f.manager);
    expect(await expenseStatus(eid), 'the deletes happened').toBe('gone');
    expect(await auditRows(sql, f.orgId, 'destructive.approved')).toHaveLength(0);
  });
});
