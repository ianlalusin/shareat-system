import { afterAll, describe, expect, it, vi } from 'vitest';

import { expectAbsent, expectAuthRefusal, expectPresent, expectRefusalCard, plain, render, sessionMock } from './t435-fixture';
import { closeDb, type Tx } from '@shareat/db';
import { recordStatutoryPayment, voidStatutoryPayment } from '@shareat/domain';
import { mkPerson, mkRun } from '../../../../packages/db/tests/integration/_fixtures/t193-s2-world';
import { asOrg, mkWorld, uid, type World } from '../../../../packages/domain/tests/integration/_fixtures/t193-s3-world';
import postgres from 'postgres';
import { config } from 'dotenv';

/**
 * T-193 S6 (TESTER) - the month detail screen: one agency + one month, the payslip rows behind it and that month's payments.
 * Spec: REFRESH.md S6 + the old spec "Reports" 2, "Per person" (:49), "Due dates and lateness" (:106-112), cases 12 and 16, K5.
 *
 * NAMES FIXED BY THIS FILE (the builder implements them; apps/erp/src/app/payroll/statutory-payments/):
 *   month/page.tsx   default export, searchParams { agency, month } -> the screen (route '/payroll/statutory-payments/month').
 *                    `month` must be 'YYYY-MM-01'; an unknown agency or a month that is not a first-of-month date -> notFound().
 *                    One <tr> per payslip: person name, the person's government number for THAT agency (sss_no / philhealth_no /
 *                    pagibig_no / tin, read at report time), then ee, er, ec, total as 1,234.56 (in that order, for SSS); a payslip
 *                    whose agency is in skipped_agencies shows "not deducted" and four 0.00 figures. One <tr> per payment of the
 *                    month and agency (posted AND voided): reference no., amount, status "Posted"/"Voided", and an <a href> to
 *                    /payroll/statutory-payments/<paymentId>. A CSV link to /payroll/statutory-payments/month/export?agency=..&month=..
 *   lib.ts           monthDetailFor(actor, { agency, month, today? }) (remit_statutory FIRST) ->
 *                      { rows: MonthDetailRow[] (the repo's monthDetail rows PLUS govNo: string | null),
 *                        payments: StatutoryPaymentRow[] (this agency + month, posted and voided, this org),
 *                        dueDate: 'YYYY-MM-DD' | null   (due_day of month+1 from statutory_employers, clamped to month end; null = no due day on file),
 *                        daysLate: number               (unpaid month: today - due; fully paid month: last posted paid_on - due; never negative),
 *                        dueSoon: boolean               (not late and due within 5 days, today inclusive of the due day),
 *                        estimatedPenalty: string | null  ('0.00' when not late or nothing outstanding; NULL when late with money outstanding - the spec gives no agency rate, so nothing is invented; NEVER posted) }
 *                    `today` is 'YYYY-MM-DD'; omitted = the business date now.
 *
 * MUTANTS (named per leg): voided / draft run payslips listed; skipped payslip dropped; government number of the wrong agency;
 * payments of another month or agency listed; voided payments hidden; payment without a link; other organization's rows; gate = menu only;
 * month string not validated; due date month+1 by string math (December), not clamped (31st), or days late measured to today for a paid month;
 * the 5-day warning off by one; the estimate posted to the ledger.
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

const monthPage = () => import('../../src/app/payroll/statutory-payments/month/page');
const lib = () => import('../../src/app/payroll/statutory-payments/lib');
type Detail = {
  rows: { personName: string; govNo: string | null; ee: string; er: string; ec: string; total: string; notDeducted: boolean; storeId: string }[];
  payments: { id: string; referenceNo: string; status: string; agency: string; month: string }[];
  dueDate: string | null;
  daysLate: number;
  dueSoon: boolean;
  estimatedPenalty: string | null;
};
const detailFor = async (actor: unknown, agency: string, month: string, today?: string): Promise<Detail> => {
  const f = (await lib())['monthDetailFor' as keyof Awaited<ReturnType<typeof lib>>];
  if (typeof f !== 'function') throw new Error('monthDetailFor is not exported from payroll/statutory-payments/lib.ts');
  return (await (f as unknown as (a: unknown, i: unknown) => Promise<Detail>)(actor, { agency, month, ...(today ? { today } : {}) })) as Detail;
};

const AMOUNT = /\d[\d,]*\.\d{2}/g;
const figures = (t: string): string[] => t.match(AMOUNT) ?? [];
const rowsOf = (html: string): { text: string; raw: string }[] =>
  html.split(/<tr[\s>]/).slice(1).map((r) => r.split('</tr>')[0]!).map((raw) => ({ raw, text: plain(raw) }));
const rowWith = (html: string, needle: string) => {
  const hits = rowsOf(html).filter((r) => r.text.includes(needle));
  expect(hits.length, `exactly one row with "${needle}" (found ${hits.length})`).toBe(1);
  return hits[0]!;
};
const org = (w: World) => ({ orgId: w.orgId, lipa: w.lipa, malvar: w.malvar, adminId: w.adminId, bankId: w.lipaOffice });

const PAY = (w: World, over: Record<string, unknown> = {}) => ({
  paymentId: crypto.randomUUID(),
  agency: 'sss' as const,
  month: '2026-10-01',
  paidOn: '2026-11-10',
  moneyAccountId: w.lipaOffice,
  referenceNo: uid('PRN'),
  lines: [{ storeId: w.lipa, amount: '1000.00' }],
  ...over,
});
const pay = (w: World, inp: ReturnType<typeof PAY>) =>
  asOrg(w.orgId, (tx: Tx) => (recordStatutoryPayment as unknown as (t: Tx, a: unknown, i: unknown) => Promise<{ id: string; entryId: string }>)(tx, w.admin, inp));
const voidIt = (w: World, paymentId: string) =>
  asOrg(w.orgId, (tx: Tx) => (voidStatutoryPayment as unknown as (t: Tx, a: unknown, i: unknown) => Promise<unknown>)(tx, w.admin, { paymentId, reason: 'Wrong receipt' }));
const entries = async (w: World): Promise<number> =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${w.orgId}`)[0]!.n);

// -----------------------------------------------------------------------------------------------------------------
describe('the payslip rows', () => {
  it('SSS October: every payslip of a posted run, exact to the centavo; voided and draft runs and other months are not listed (kills: voided/draft listed; owed from ee only; other month leaks)', async () => {
    const w = await mkWorld(sql, 's6rows');
    const f = org(w);
    const vera = await mkPerson(sql, f, 'Vera Voided', w.malvar);
    const dina = await mkPerson(sql, f, 'Dina Draft', w.lipa);
    const nora = await mkPerson(sql, f, 'Nora November', w.lipa);
    await mkRun(sql, f, { storeId: w.malvar, start: '2026-10-26', end: '2026-10-31', status: 'voided', slips: [{ who: vera, sss: ['999.00', '999.00', '99.00'] }] });
    await mkRun(sql, f, { storeId: w.lipa, start: '2026-10-01', end: '2026-10-15', status: 'draft', slips: [{ who: dina, sss: ['888.00', '888.00', '88.00'] }] });
    await mkRun(sql, f, { storeId: w.lipa, start: '2026-11-01', end: '2026-11-15', status: 'posted', slips: [{ who: nora, sss: ['777.00', '777.00', '77.00'] }] });

    const html = await render(monthPage, w.admin, { search: { agency: 'sss', month: '2026-10-01' } });
    const ana = rowsOf(html).filter((r) => r.text.includes('Ana Lipa')).map((r) => figures(r.text));
    expect(ana.sort(), 'Ana has two October payslips').toEqual([
      ['525.00', '1,035.00', '25.00', '1,585.00'],
      ['525.00', '1,045.00', '25.00', '1,595.00'],
    ]);
    expect(rowsOf(html).filter((r) => r.text.includes('Ben Malvar')).map((r) => figures(r.text)).sort()).toEqual([
      ['525.00', '1,035.00', '25.00', '1,585.00'],
      ['525.00', '1,045.00', '25.00', '1,595.00'],
    ]);
    expect(figures(rowWith(html, 'Rita Rosario').text)).toEqual(['300.00', '650.00', '50.00', '1,000.00']);
    expectAbsent(html, 'rows', 'Vera Voided', 'Dina Draft', 'Nora November');

    const d = await detailFor(w.admin, 'sss', '2026-10-01', '2026-10-29');
    expect(d.rows.map((r) => r.personName).sort()).toEqual(['Ana Lipa', 'Ana Lipa', 'Ben Malvar', 'Ben Malvar', 'Rita Rosario']);
    expect(d.rows.reduce((n, r) => n + Math.round(Number(r.total) * 100), 0)).toBe(736000);
  });

  it('a payslip whose SSS was skipped stays on the list as "not deducted" at 0.00 (case 12; kills: person C dropped from the list)', async () => {
    const w = await mkWorld(sql, 's6skip');
    const f = org(w);
    const cora = await mkPerson(sql, f, 'Cora Nosssno', w.malvar);
    await mkRun(sql, f, { storeId: w.malvar, start: '2026-10-26', end: '2026-10-31', status: 'posted', slips: [{ who: cora, skipped: ['sss'] }] });
    const html = await render(monthPage, w.admin, { search: { agency: 'sss', month: '2026-10-01' } });
    const row = rowWith(html, 'Cora Nosssno');
    expect(row.text).toMatch(/not deducted/i);
    expect(figures(row.text)).toEqual(['0.00', '0.00', '0.00', '0.00']);
    const d = await detailFor(w.admin, 'sss', '2026-10-01', '2026-10-29');
    expect(d.rows.find((r) => r.personName === 'Cora Nosssno')?.notDeducted).toBe(true);
    // the skip is per agency: the same payslip is not "not deducted" on the PhilHealth screen
    const ph = await detailFor(w.admin, 'philhealth', '2026-10-01', '2026-10-29');
    expect(ph.rows.find((r) => r.personName === 'Cora Nosssno')?.notDeducted ?? false).toBe(false);
  });

  it("each agency shows that agency's government number for the person, read at report time (kills: the SSS number on every screen)", async () => {
    const w = await mkWorld(sql, 's6govno');
    await sql`update persons set sss_no = '3412345678', philhealth_no = '120987654321', pagibig_no = '121122334455', tin = '987654321012'
              where org_id = ${w.orgId} and display_name = 'Ana Lipa'`;
    const nums = { sss: '3412345678', philhealth: '120987654321', pagibig: '121122334455', bir: '987654321012' } as const;
    for (const [agency, own] of Object.entries(nums)) {
      const html = await render(monthPage, w.admin, { search: { agency, month: '2026-10-01' } });
      const ana = rowsOf(html).filter((r) => r.text.includes('Ana Lipa')).map((r) => r.text).join(' || ');
      expect(ana, `${agency}: Ana's own number is on her row`).toContain(own);
      for (const [other, n] of Object.entries(nums)) if (other !== agency) expect(ana, `${agency} screen must not show the ${other} number`).not.toContain(n);
    }
    // read at report time: change the number, the next read shows the new one
    await sql`update persons set sss_no = '3499999999' where org_id = ${w.orgId} and display_name = 'Ana Lipa'`;
    const html = await render(monthPage, w.admin, { search: { agency: 'sss', month: '2026-10-01' } });
    expect(plain(html)).toContain('3499999999');
    expect(plain(html)).not.toContain('3412345678');
    const d = await detailFor(w.admin, 'sss', '2026-10-01', '2026-10-29');
    expect(d.rows.find((r) => r.personName === 'Ana Lipa')?.govNo).toBe('3499999999');
  });

  it("BIR October: the withholding is the amount (125.50 on Ana's second payslip) (kills: BIR read from the contribution columns)", async () => {
    const w = await mkWorld(sql, 's6bir');
    const html = await render(monthPage, w.admin, { search: { agency: 'bir', month: '2026-10-01' } });
    expect(figures(rowsOf(html).filter((r) => r.text.includes('Ana Lipa')).map((r) => r.text).join(' '))).toContain('125.50');
    expect(plain(html)).not.toContain('1,585.00');
  });
});

describe("the month's payments", () => {
  it('lists this agency + month, posted and voided, each linking to its detail page; other months, agencies and organizations are absent (kills: voided hidden; no link; month/agency filter dropped)', async () => {
    const w = await mkWorld(sql, 's6pays');
    const f = org(w);
    const zed = await mkPerson(sql, f, 'Zed September', w.lipa);
    await mkRun(sql, f, { storeId: w.lipa, start: '2026-09-01', end: '2026-09-15', status: 'posted', slips: [{ who: zed, sss: ['525.00', '1035.00', '25.00'] }] });
    const posted = await pay(w, PAY(w, { referenceNo: 'PRN-S6-POSTED', lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    const voided = await pay(w, PAY(w, { referenceNo: 'PRN-S6-VOIDED', lines: [{ storeId: w.malvar, amount: '3180.00' }] }));
    await voidIt(w, voided.id);
    await pay(w, PAY(w, { month: '2026-09-01', paidOn: '2026-09-20', referenceNo: 'PRN-S6-SEP', lines: [{ storeId: w.lipa, amount: '500.00' }] }));
    await pay(w, PAY(w, { agency: 'philhealth', referenceNo: 'PRN-S6-PH', lines: [{ storeId: w.lipa, amount: '1040.00' }] }));
    const other = await mkWorld(sql, 's6paysB');
    await pay(other, PAY(other, { referenceNo: 'PRN-S6-OTHERORG' }));

    const html = await render(monthPage, w.admin, { search: { agency: 'sss', month: '2026-10-01' } });
    const a = rowWith(html, 'PRN-S6-POSTED');
    expect(a.text).toContain('1,000.00');
    expect(a.text).toMatch(/Posted/i);
    expect(a.raw, 'links to the payment page').toContain(`href="/payroll/statutory-payments/${posted.id}"`);
    const v = rowWith(html, 'PRN-S6-VOIDED');
    expect(v.text).toMatch(/Voided/i);
    expect(v.raw, 'a voided payment links too').toContain(`href="/payroll/statutory-payments/${voided.id}"`);
    expectAbsent(html, 'payments', 'PRN-S6-SEP', 'PRN-S6-PH', 'PRN-S6-OTHERORG');

    const d = await detailFor(w.admin, 'sss', '2026-10-01', '2026-11-12');
    expect(d.payments.map((p) => p.referenceNo).sort()).toEqual(['PRN-S6-POSTED', 'PRN-S6-VOIDED']);
    expect(d.payments.every((p) => p.agency === 'sss' && p.month === '2026-10-01')).toBe(true);
  });
});

describe('this organization only', () => {
  it("another organization's people and payments never appear (kills: org filter dropped)", async () => {
    const a = await mkWorld(sql, 's6orgA');
    const b = await mkWorld(sql, 's6orgB');
    await sql`update persons set display_name = 'Zzyx ' || display_name where org_id = ${b.orgId}`;
    await pay(b, PAY(b, { referenceNo: 'PRN-S6-ZZ' }));
    const html = await render(monthPage, a.admin, { search: { agency: 'sss', month: '2026-10-01' } });
    expectAbsent(html, 'org A', 'Zzyx', 'PRN-S6-ZZ');
    const d = await detailFor(a.admin, 'sss', '2026-10-01', '2026-10-29');
    expect(d.rows.some((r) => r.personName.includes('Zzyx'))).toBe(false);
    expect(d.payments).toEqual([]);
  });
});

describe('who may open it (kills: the gate is the menu only)', () => {
  it('a manager and staff get the access-refused card and no figure or name; the loader refuses on its own; admin and super admin open it', async () => {
    const w = await mkWorld(sql, 's6gate');
    await sql`update persons set sss_no = '3412345678' where org_id = ${w.orgId} and display_name = 'Ana Lipa'`;
    const p = await pay(w, PAY(w, { referenceNo: 'PRN-S6-GATE' }));
    for (const who of ['manager', 'staff'] as const) {
      const html = await render(monthPage, w[who], { search: { agency: 'sss', month: '2026-10-01' } });
      expectRefusalCard(html, `${who} month detail`);
      expectAbsent(html, `${who} month detail`, '3,180.00', '1,585.00', '3412345678', 'Ana Lipa', 'PRN-S6-GATE', p.id);
      await expectAuthRefusal(() => detailFor(w[who], 'sss', '2026-10-01'), 'remit_statutory', `monthDetailFor(${who})`);
    }
    for (const who of ['admin', 'superAdmin'] as const) {
      const html = await render(monthPage, w[who], { search: { agency: 'sss', month: '2026-10-01' } });
      expect(plain(html)).not.toContain('You do not have access to this screen');
      expectPresent(html, `${who} month detail`, 'Ana Lipa', '3412345678', 'PRN-S6-GATE');
    }
  });
});

describe('what the address may say', () => {
  it('an unknown agency, a month that is not a first-of-month date, or a missing parameter is notFound (kills: params trusted)', async () => {
    const w = await mkWorld(sql, 's6params');
    for (const search of <Record<string, string>[]>[
      { agency: 'gsis', month: '2026-10-01' },
      { agency: 'sss', month: '2026-10-15' },
      { agency: 'sss', month: 'October' },
      { agency: 'sss', month: "2026-10-01'; drop table payslips;--" },
      { agency: 'sss' },
      {},
    ]) {
      await expect(render(monthPage, w.admin, { search }), JSON.stringify(search)).rejects.toThrow('NEXT_NOT_FOUND');
    }
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from payslips where org_id = ${w.orgId}`;
    expect(Number(row!.n), 'payslips untouched').toBeGreaterThan(0);
  });
});

describe('K5 - due date, days late, the 5-day warning, the estimated penalty (never posted)', () => {
  it('SSS October, due day 10: due 2026-11-10; the warning starts 5 days before and includes the due day; late counts from the day after (kills: off by one; today not passed)', async () => {
    const w = await mkWorld(sql, 's6due');
    const at = (today: string) => detailFor(w.admin, 'sss', '2026-10-01', today);
    const t4 = await at('2026-11-04');
    expect([t4.dueDate, t4.daysLate, t4.dueSoon, t4.estimatedPenalty]).toEqual(['2026-11-10', 0, false, '0.00']);
    expect((await at('2026-11-05')).dueSoon, '5 days before: warn').toBe(true);
    const t10 = await at('2026-11-10');
    expect([t10.daysLate, t10.dueSoon, t10.estimatedPenalty], 'on the due day: not late yet').toEqual([0, true, '0.00']);
    const t14 = await at('2026-11-14');
    expect([t14.daysLate, t14.dueSoon]).toEqual([4, false]);
    expect(t14.estimatedPenalty, 'late with money outstanding and no rate on file: null, never a made-up number').toBeNull();
  });

  it('the due date rolls the year (December -> January) and clamps the due day to the month end (31 -> 30 Nov, 28 Feb) (kills: month+1 by string math; no clamp)', async () => {
    const w = await mkWorld(sql, 's6clamp');
    const f = org(w);
    const dec = await mkPerson(sql, f, 'Dec Person', w.lipa);
    await mkRun(sql, f, { storeId: w.lipa, start: '2026-12-01', end: '2026-12-15', status: 'posted', slips: [{ who: dec, sss: ['525.00', '1035.00', '25.00'] }] });
    const jan = await mkPerson(sql, f, 'Jan Person', w.lipa);
    await mkRun(sql, f, { storeId: w.lipa, start: '2027-01-01', end: '2027-01-15', status: 'posted', slips: [{ who: jan, pi: ['100.00', '100.00'] }] });
    expect((await detailFor(w.admin, 'sss', '2026-12-01', '2026-12-20')).dueDate).toBe('2027-01-10');
    await sql`update statutory_employers set due_day = 31 where org_id = ${w.orgId} and agency = 'pagibig'`;
    expect((await detailFor(w.admin, 'pagibig', '2026-10-01', '2026-10-29')).dueDate).toBe('2026-11-30');
    expect((await detailFor(w.admin, 'pagibig', '2027-01-01', '2027-01-20')).dueDate).toBe('2027-02-28');
  });

  it('a fully paid month: days late is measured to the last payment, not to today (late 10 days, and on time 0) (kills: days late = today - due for a paid month)', async () => {
    const late = await mkWorld(sql, 's6paidlate');
    await pay(late, PAY(late, { paidOn: '2026-11-20', lines: [{ storeId: late.lipa, amount: '3180.00' }, { storeId: late.malvar, amount: '3180.00' }, { storeId: late.rosario, amount: '1000.00' }], moneyAccountId: late.lipaOffice }));
    const l = await detailFor(late.admin, 'sss', '2026-10-01', '2026-12-30');
    expect([l.daysLate, l.dueSoon]).toEqual([10, false]);
    const ontime = await mkWorld(sql, 's6paidontime');
    await pay(ontime, PAY(ontime, { paidOn: '2026-11-09', lines: [{ storeId: ontime.lipa, amount: '3180.00' }, { storeId: ontime.malvar, amount: '3180.00' }, { storeId: ontime.rosario, amount: '1000.00' }] }));
    const o = await detailFor(ontime.admin, 'sss', '2026-10-01', '2026-12-30');
    expect([o.daysLate, o.estimatedPenalty]).toEqual([0, '0.00']);
  });

  it('no due day on file for the agency: no due date is guessed (BIR has no employer row in this world)', async () => {
    const w = await mkWorld(sql, 's6nodue');
    const d = await detailFor(w.admin, 'bir', '2026-10-01', '2026-12-30');
    expect([d.dueDate, d.daysLate, d.dueSoon]).toEqual([null, 0, false]);
  });

  it('the screen of a month that is late says so and labels the penalty an estimate; reading it posts nothing to the ledger (kills: the estimate posted)', async () => {
    const w = await mkWorld(sql, 's6late');
    const f = org(w);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${w.orgId}, '2026-08-01', '2026-08-31', 'open')`;
    const amy = await mkPerson(sql, f, 'Amy August', w.lipa);
    await mkRun(sql, f, { storeId: w.lipa, start: '2026-08-16', end: '2026-08-31', status: 'posted', slips: [{ who: amy, sss: ['525.00', '1035.00', '25.00'] }] });
    const before = await entries(w);
    const html = await render(monthPage, w.admin, { search: { agency: 'sss', month: '2026-08-01' } });
    const t = plain(html);
    expect(t, 'due 10 September').toMatch(/2026-09-10|10 Sep(tember)? 2026|Sep(tember)? 10, 2026/);
    expect(t).toMatch(/\b\d+ days? late\b|late by \d+/i);
    expect(t).toMatch(/Estimated penalty: not calculated.*rate is not on file/i);
    const d = await detailFor(w.admin, 'sss', '2026-08-01', '2026-10-29');
    expect(d.daysLate).toBe(49);
    expect(d.estimatedPenalty).toBeNull();
    expect(await entries(w), 'no journal entry was written by reading the screen').toBe(before);
    const [pen] = await sql<{ b: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as b from journal_lines jl join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id where je.org_id = ${w.orgId} and a.code = '6810'`;
    expect(Number(pen!.b), 'nothing booked to 6810 Penalties and surcharges').toBe(0);
  });
});

describe('T-193 S6 - a late month that is fully paid (kills: the unpaid-month wording shown for a paid month; a made-up penalty)', () => {
  it('paid 10 days late: the screen says "Paid 10 days late", no "when you record", estimatedPenalty null; paid on time: not late and 0.00', async () => {
    const late = await mkWorld(sql, 's6paidlatescr');
    await pay(late, PAY(late, { paidOn: '2026-11-20', lines: [{ storeId: late.lipa, amount: '3180.00' }, { storeId: late.malvar, amount: '3180.00' }, { storeId: late.rosario, amount: '1000.00' }] }));
    const t = plain(await render(monthPage, late.admin, { search: { agency: 'sss', month: '2026-10-01' } }));
    expect(t).toMatch(/Paid 10 days late/);
    expect(t, 'nothing left to record').not.toMatch(/when you record/i);
    expect((await detailFor(late.admin, 'sss', '2026-10-01', '2026-12-30')).estimatedPenalty).toBeNull();

    const ontime = await mkWorld(sql, 's6paidontimescr');
    await pay(ontime, PAY(ontime, { paidOn: '2026-11-09', lines: [{ storeId: ontime.lipa, amount: '3180.00' }, { storeId: ontime.malvar, amount: '3180.00' }, { storeId: ontime.rosario, amount: '1000.00' }] }));
    const t2 = plain(await render(monthPage, ontime.admin, { search: { agency: 'sss', month: '2026-10-01' } }));
    expect(t2).not.toMatch(/days? late/i);
    expect((await detailFor(ontime.admin, 'sss', '2026-10-01', '2026-12-30')).estimatedPenalty).toBe('0.00');
  });
});
