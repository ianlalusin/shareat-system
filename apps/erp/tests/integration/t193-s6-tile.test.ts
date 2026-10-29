import { afterAll, describe, expect, it, vi } from 'vitest';

import { expectAbsent, plain, render, sessionMock } from './t435-fixture';
import { closeDb, type Tx } from '@shareat/db';
import { recordStatutoryPayment, voidStatutoryPayment } from '@shareat/domain';
import { mkOrg, mkPerson, mkRun } from '../../../../packages/db/tests/integration/_fixtures/t193-s2-world';
import { asOrg, mkWorld, uid, type World } from '../../../../packages/domain/tests/integration/_fixtures/t193-s3-world';
import postgres from 'postgres';
import { config } from 'dotenv';

/**
 * T-193 S6 (TESTER) - the dashboard tile: what is owed to the agencies and what is overdue, beside the cash. Remit_statutory holders only.
 * Spec: old spec "Reports" 3 (s16.5 req. 2: total unremitted and the age of the oldest unpaid month; admin only), REFRESH S6 ("what is owed and overdue").
 *
 * NAMES FIXED BY THIS FILE:
 *   apps/erp/src/app/payroll/statutory-payments/lib.ts
 *     statutoryTileFor(actor, today?) -> null when the actor does NOT hold remit_statutory (it must NOT throw: the dashboard calls it for every
 *       viewer), else
 *       { totalOutstanding: string,                 Sum of outstanding over every agency, month and store (the same figures monthsFor returns), 'n.nn'
 *         totalOverdue: string,                     Sum of outstanding of months whose due date (due_day of month+1, clamped) is BEFORE today; a month with no due day on file is never overdue
 *         oldestUnpaidMonth: 'YYYY-MM-01' | null,   the earliest month with outstanding > 0
 *         agencies: { agency, outstanding, overdue }[] }   one entry per agency that has outstanding money or is overdue
 *       `today` is 'YYYY-MM-DD'; omitted = the business date now. Authorization is checked inside (a holder check, not a thrown refusal).
 *   apps/erp/src/app/page.tsx   the dashboard renders a tile for a holder, containing the words "Government" and "Overdue", the total outstanding
 *       (1,234.56 style) and the month words of the oldest unpaid month ("July 2026"); it renders NOTHING of it for anyone else.
 *
 * MUTANTS (named per leg): tile shown to managers / staff; the helper throws for a non-holder (the dashboard would crash); other organization's
 * money counted; voided payments still counted as paid; overdue = outstanding; overdue measured from the month, not from the due date; due day
 * ignored; today ignored; a month without a due day treated as overdue; oldest month ignores a fully paid month; figures differ from monthsFor.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
void sessionMock;

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const lib = () => import('../../src/app/payroll/statutory-payments/lib');
const dashboard = () => import('../../src/app/page');
type Tile = {
  totalOutstanding: string;
  totalOverdue: string;
  oldestUnpaidMonth: string | null;
  agencies: { agency: string; outstanding: string; overdue: string }[];
};
const tileFor = async (actor: unknown, today?: string): Promise<Tile | null> => {
  const f = (await lib())['statutoryTileFor' as keyof Awaited<ReturnType<typeof lib>>];
  if (typeof f !== 'function') throw new Error('statutoryTileFor is not exported from payroll/statutory-payments/lib.ts');
  return (await (f as unknown as (a: unknown, t?: string) => Promise<Tile | null>)(actor, today)) as Tile | null;
};
const by = (t: Tile | null, agency: string) => {
  const a = t?.agencies.find((x) => x.agency === agency);
  return [a?.outstanding ?? '0.00', a?.overdue ?? '0.00'];
};
const org = (w: World) => ({ orgId: w.orgId, lipa: w.lipa, malvar: w.malvar, adminId: w.adminId, bankId: w.lipaOffice });
const PAY = (w: World, over: Record<string, unknown> = {}) => ({
  paymentId: crypto.randomUUID(), agency: 'sss', month: '2026-10-01', paidOn: '2026-11-11', moneyAccountId: w.lipaOffice,
  referenceNo: uid('PRN'), lines: [{ storeId: w.lipa, amount: '1000.00' }], ...over,
});
const pay = (w: World, inp: Record<string, unknown>) =>
  asOrg(w.orgId, (tx: Tx) => (recordStatutoryPayment as unknown as (t: Tx, a: unknown, i: unknown) => Promise<{ id: string }>)(tx, w.admin, inp));
const voidIt = (w: World, paymentId: string) =>
  asOrg(w.orgId, (tx: Tx) => (voidStatutoryPayment as unknown as (t: Tx, a: unknown, i: unknown) => Promise<unknown>)(tx, w.admin, { paymentId, reason: 'Wrong receipt' }));
/** A BIR due day, so BIR months have a due date too (the base world has no BIR row). */
const birDueDay = (w: World, day = 10) =>
  sql`insert into statutory_employers (org_id, agency, employer_no, due_day, created_by) values (${w.orgId}, 'bir', null, ${day}, ${w.adminId})`;
const cents = (s: string) => Math.round(Number(s) * 100);

// October 2026 outstanding in the base world: SSS 7,360.00 (Lipa 3,180 + Malvar 3,180 + Rosario 1,000), PhilHealth 1,040.00,
// Pag-IBIG 400.00, BIR 125.50 => 8,925.50. Due: SSS 10 Nov, PhilHealth 15 Nov, Pag-IBIG 10 Nov (due days 10 / 15 / 10).
describe('the figures behind the tile', () => {
  it('owed and overdue per agency, by the due date: 5 Nov nothing is overdue, 12 Nov SSS + Pag-IBIG + BIR are, 16 Dec all four (kills: overdue = outstanding; due day ignored; today ignored)', async () => {
    const w = await mkWorld(sql, 's6tile');
    await birDueDay(w);
    const t5 = await tileFor(w.admin, '2026-11-05');
    expect(t5!.totalOutstanding).toBe('8925.50');
    expect(t5!.totalOverdue, 'nothing is past its due date on 5 Nov').toBe('0.00');
    expect(t5!.oldestUnpaidMonth).toBe('2026-10-01');
    const t12 = await tileFor(w.admin, '2026-11-12');
    expect([t12!.totalOutstanding, t12!.totalOverdue]).toEqual(['8925.50', '7885.50']);
    expect(by(t12, 'sss')).toEqual(['7360.00', '7360.00']);
    expect(by(t12, 'philhealth'), 'PhilHealth is due the 15th: not overdue on the 12th').toEqual(['1040.00', '0.00']);
    expect(by(t12, 'pagibig')).toEqual(['400.00', '400.00']);
    expect(by(t12, 'bir')).toEqual(['125.50', '125.50']);
    const t10 = await tileFor(w.admin, '2026-11-10');
    expect(t10!.totalOverdue, 'on the due day itself it is not overdue yet').toBe('0.00');
    const t16 = await tileFor(w.admin, '2026-12-16');
    expect(t16!.totalOverdue).toBe('8925.50');
  });

  it('a payment lowers both numbers; a voided payment puts them back (kills: voided still counted as paid)', async () => {
    const w = await mkWorld(sql, 's6tilepay');
    await birDueDay(w);
    const p = await pay(w, PAY(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    const after = await tileFor(w.admin, '2026-11-12');
    expect([after!.totalOutstanding, after!.totalOverdue]).toEqual(['7925.50', '6885.50']);
    expect(by(after, 'sss')).toEqual(['6360.00', '6360.00']);
    await voidIt(w, p.id);
    const back = await tileFor(w.admin, '2026-11-12');
    expect([back!.totalOutstanding, back!.totalOverdue]).toEqual(['8925.50', '7885.50']);
  });

  it('the total equals the sum of the list the screen shows (monthsFor) to the centavo (kills: a second, different query)', async () => {
    const w = await mkWorld(sql, 's6tilesame');
    await pay(w, PAY(w, { lines: [{ storeId: w.malvar, amount: '1234.56' }] }));
    const monthsFor = (await lib()).monthsFor as unknown as (a: unknown, f: unknown) => Promise<{ outstanding: string }[]>;
    const sum = (await monthsFor(w.admin, {})).reduce((n, r) => n + cents(r.outstanding), 0);
    const t = await tileFor(w.admin, '2026-11-12');
    expect(cents(t!.totalOutstanding)).toBe(sum);
    expect(t!.totalOutstanding).toBe('7690.94');
  });

  it('the oldest unpaid month moves on when that month is paid up (kills: oldest month ignores payments)', async () => {
    const w = await mkWorld(sql, 's6tileold');
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${w.orgId}, '2026-08-01', '2026-08-31', 'open')`;
    const amy = await mkPerson(sql, org(w), 'Amy August', w.lipa);
    await mkRun(sql, org(w), { storeId: w.lipa, start: '2026-08-16', end: '2026-08-31', status: 'posted', slips: [{ who: amy, sss: ['311.11', '622.22', '33.33'] }] });
    expect((await tileFor(w.admin, '2026-10-29'))!.oldestUnpaidMonth).toBe('2026-08-01');
    expect(by(await tileFor(w.admin, '2026-10-29'), 'sss')[1], 'August SSS (due 10 Sep) is overdue on 29 Oct; October SSS (due 10 Nov) is not').toBe('966.66');
    await pay(w, PAY(w, { month: '2026-08-01', paidOn: '2026-09-09', lines: [{ storeId: w.lipa, amount: '966.66' }] }));
    const t = await tileFor(w.admin, '2026-10-29');
    expect(t!.oldestUnpaidMonth).toBe('2026-10-01');
    expect(by(t, 'sss')[1]).toBe('0.00');
  });

  it('a month with no due day on file is counted as owed but never as overdue (no date is guessed): BIR in the base world has no row', async () => {
    const w = await mkWorld(sql, 's6tilenodue');
    const t = await tileFor(w.admin, '2026-12-31');
    expect(by(t, 'bir')).toEqual(['125.50', '0.00']);
    expect(t!.totalOutstanding).toBe('8925.50');
    expect(t!.totalOverdue).toBe('8800.00');
  });

  it("nothing owed: zeros and no oldest month; and another organization's money is never counted (kills: org filter dropped)", async () => {
    const a = await mkWorld(sql, 's6tileA');
    const b = await mkOrg(sql, 's6tileB');
    await sql`insert into person_roles (person_id, org_id, role) values (${b.adminId}, ${b.orgId}, 'admin')`;
    const ta = await tileFor(a.admin, '2026-11-12');
    expect(ta!.totalOutstanding, 'org A is not affected by org B').toBe('8925.50');
    const empty = await tileFor({ personId: b.adminId, orgId: b.orgId }, '2026-11-12');
    expect([empty!.totalOutstanding, empty!.totalOverdue, empty!.oldestUnpaidMonth]).toEqual(['0.00', '0.00', null]);
  });
});

describe('who sees it (kills: tile shown to managers; helper throws for a non-holder)', () => {
  it('the helper returns null for a manager and for staff (it must not throw) and a tile for an admin and a super admin', async () => {
    const w = await mkWorld(sql, 's6tilegate');
    expect(await tileFor(w.manager, '2026-11-12')).toBeNull();
    expect(await tileFor(w.staff, '2026-11-12')).toBeNull();
    expect((await tileFor(w.admin, '2026-11-12'))!.totalOutstanding).toBe('8925.50');
    expect((await tileFor(w.superAdmin, '2026-11-12'))!.totalOutstanding).toBe('8925.50');
  });

  it('the dashboard page: an admin sees the tile (words, total, oldest month); a manager sees the dashboard but no trace of it', async () => {
    const w = await mkWorld(sql, 's6tilepage');
    // A far-future month, so the total is stable whatever day this runs: January 2099 SSS 1,234.56 (due 10 Feb 2099, never overdue in practice).
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${w.orgId}, '2099-01-01', '2099-01-31', 'open')`;
    const fay = await mkPerson(sql, org(w), 'Fay Future', w.rosario);
    await mkRun(sql, org(w), { storeId: w.rosario, start: '2099-01-01', end: '2099-01-31', status: 'posted', slips: [{ who: fay, sss: ['400.00', '800.00', '34.56'] }] });
    const total = '10,160.06'; // 8,925.50 + 1,234.56
    const admin = await render(dashboard, w.admin);
    const t = plain(admin);
    expect(t, 'the tile names the money').toMatch(/Government/);
    expect(t).toMatch(/Overdue/i);
    expect(t, 'total owed to the agencies').toContain(total);
    expect(t, 'the oldest unpaid month, in words').toMatch(/October 2026|Oct 2026/);
    const manager = await render(dashboard, w.manager);
    expect(plain(manager), 'a manager still gets the dashboard').toMatch(/Dashboard|Sales/i);
    expectAbsent(manager, 'manager dashboard', total, 'Overdue', 'October 2026');
    expect(plain(manager)).not.toMatch(/Government payments|owed to (the )?government/i);
  });
});

describe('T-193 S6 - an agency with money outstanding and no due day on file (kills: shown as "0.00 overdue"; no way to fix it)', () => {
  it('noDueDay is true for BIR in the base world and false for the agencies with a due day; the dashboard says "No due day set" and links to /payroll/rates; once a due day is set the notice is gone', async () => {
    const w = await mkWorld(sql, 's6tilenodueflag');
    const t = await tileFor(w.admin, '2026-11-12');
    const flag = (tile: Tile | null) =>
      Object.fromEntries((tile!.agencies as unknown as { agency: string; noDueDay: boolean }[]).map((a) => [a.agency, a.noDueDay]));
    expect(flag(t)).toEqual({ sss: false, philhealth: false, pagibig: false, bir: true });
    const html = await render(dashboard, w.admin);
    expect(plain(html)).toMatch(/No due day set/);
    expect(html).toContain('href="/payroll/rates"');
    await birDueDay(w);
    expect(Object.values(flag(await tileFor(w.admin, '2026-11-12'))).some(Boolean)).toBe(false);
    expect(plain(await render(dashboard, w.admin))).not.toMatch(/No due day set/);
  });
});

describe('T-193 S6 - one peso sign on the dashboard tile (kills: value pre-formatted AND the card adds its own currency sign)', () => {
  it('the rendered dashboard has no doubled peso sign and shows the total with exactly one', async () => {
    const w = await mkWorld(sql, 's6tilepeso');
    const peso = String.fromCharCode(0x20b1);
    const t = plain(await render(dashboard, w.admin)).replace(/\s+/g, '');
    expect(t.includes(peso + peso), 'no doubled peso sign anywhere on the dashboard').toBe(false);
    expect(t.includes(peso + '8,925.50'), 'the total is shown with exactly one peso sign').toBe(true);
  });
});
