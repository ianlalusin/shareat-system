import { afterAll, describe, expect, it, vi } from 'vitest';

import { expectAbsent, expectAuthRefusal, expectPresent, expectRefusalCard, plain, render, sessionMock } from './t435-fixture';
import { closeDb, type Tx } from '@shareat/db';
import { recordStatutoryPayment, voidStatutoryPayment } from '@shareat/domain';
import { mkPerson, mkRun } from '../../../../packages/db/tests/integration/_fixtures/t193-s2-world';
import { asOrg, mkWorld, uid, type World } from '../../../../packages/domain/tests/integration/_fixtures/t193-s3-world';
import postgres from 'postgres';
import { config } from 'dotenv';

/**
 * T-193 S5 (TESTER) - the three screens, rendered as the app renders them (session mocked to a real actor, real database):
 *   /payroll/statutory-payments           the list: owed / paid / outstanding per agency + month + store
 *   /payroll/statutory-payments/new       the record form (paymentId minted per render, lines default to outstanding, no 1120)
 *   /payroll/statutory-payments/[id]      the payment: lines, entry link, status, the void form
 * Spec: docs/tasks/193-statutory-remittance/REFRESH.md s5 S5 + the old spec "Reports" 1 and "Authorization".
 *
 * NAMES FIXED BY THIS FILE (the builder implements them; apps/erp/src/app/payroll/statutory-payments/):
 *   page.tsx           default export, searchParams { agency?, year?, store? } -> the list (route '/payroll/statutory-payments')
 *   new/page.tsx       default export, searchParams { agency?, month? } -> the record form
 *   [id]/page.tsx      default export, params { id } -> the payment; a non-uuid or unknown or other-org id -> notFound()
 *   lib.ts             monthsFor(actor, { agency?, year?, storeId? }) -> { agency, month, storeId, owed, paid, outstanding }[]  (remit_statutory FIRST)
 *                      reconciliationFor(actor) -> { agency, storeId, outstanding, glBalance }[]                               (remit_statutory FIRST)
 *                      paymentFor(actor, id) -> StatutoryPaymentRow | null  (null for a non-uuid / unknown / other-org id)     (remit_statutory FIRST)
 *                      payFromAccountsFor(actor) -> money accounts a payment may be drawn from (never GL 1120)                 (remit_statutory FIRST)
 *   The list: one table row per agency + month + store showing, IN THIS ORDER, owed, paid, outstanding as 1,234.56 (peso sign allowed);
 *   the row also carries the agency label (SSS / PhilHealth / Pag-IBIG / BIR), the month ("October 2026", "Oct 2026" or "2026-10"),
 *   the store name. Oldest unpaid month first. Filters are GET params: agency=sss|philhealth|pagibig|bir, year=2026, store=<store uuid>.
 *   A red mismatch banner (text contains "mismatch" or "does not match") when the all-time outstanding differs from GL 22x0.
 *   The form: <input name="paymentId"> uuid minted per render; name="agency", "month", "paidOn", "moneyAccountId", "referenceNo",
 *   "penalty", "notes"; per store one name="lineStoreId" and one name="lineAmount" (default = the outstanding, plain 3180.00).
 *   The detail: reference no., agency label, store names and amounts, the penalty, status "Posted"/"Voided", a link to
 *   /reports/journal-lines?entry=<entryId>, and (posted only) the void form with <input name="paymentId"> and <textarea|input name="reason">.
 *
 * MUTANTS (named per leg): owed from the employee share only; stores summed into one row; paid ignores the lines; a voided payment still
 * counted as paid; gate = the menu only (the page renders for anyone); org filter dropped; filters ignored; oldest-first reversed;
 * mismatch banner always on / never on; fixed paymentId; lines default to 0; picker lists GL 1120; detail trusts a non-uuid id;
 * detail loads another org's payment; void form shown on a voided payment.
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

const listPage = () => import('../../src/app/payroll/statutory-payments/page');
const newPage = () => import('../../src/app/payroll/statutory-payments/new/page');
const detailPage = () => import('../../src/app/payroll/statutory-payments/[id]/page');
const lib = () => import('../../src/app/payroll/statutory-payments/lib');
type Loader = (...a: unknown[]) => Promise<unknown>;
const loader = async (name: string): Promise<Loader> => {
  const f = (await lib())[name as keyof Awaited<ReturnType<typeof lib>>];
  if (typeof f !== 'function') throw new Error(`${name} is not exported from payroll/statutory-payments/lib.ts`);
  return f as unknown as Loader;
};

const MONTH = /October 2026|Oct 2026|2026-10/;
const AMOUNT = /\d[\d,]*\.\d{2}/g;

/** The `<tr>` of the list that carries this agency label, this store and October 2026, as plain text. */
function rowOf(html: string, agency: string, store: string): string {
  const rows = html.split(/<tr[\s>]/).slice(1).map((r) => plain(r.split('</tr>')[0]!));
  const hits = rows.filter((t) => t.includes(agency) && t.includes(store) && MONTH.test(t));
  expect(hits.length, `exactly one ${agency} / ${store} / October 2026 row (found ${hits.length}: ${hits.join(' || ')})`).toBe(1);
  return hits[0]!;
}
/** Every table row of the list as plain text (the filter controls above the table list every store and agency, so rows are what to judge). */
const dataRows = (html: string): string[] => html.split(/<tr[\s>]/).slice(1).map((r) => plain(r.split('</tr>')[0]!)).filter((t) => /\d[\d,]*\.\d{2}/.test(t));
const figures = (row: string): string[] => row.match(AMOUNT) ?? [];

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
async function nameOf(accountId: string): Promise<string> {
  const [r] = await sql<{ name: string }[]>`select name from money_accounts where id = ${accountId}`;
  return r!.name;
}
const renameStores = async (w: World, names: Record<string, string>) => {
  for (const [id, name] of Object.entries(names)) await sql`update stores set name = ${name} where id = ${id}`;
};

// -----------------------------------------------------------------------------------------------------------------
describe('the list: owed / paid / outstanding per agency + month + store, to the centavo', () => {
  it('October 2026, nothing paid yet: six exact rows (kills: owed from the employee share only; stores summed into one row; Number() sums)', async () => {
    const w = await mkWorld(sql, 's5list');
    const html = await render(listPage, w.admin);
    expect(figures(rowOf(html, 'SSS', 'Lipa'))).toEqual(['3,180.00', '0.00', '3,180.00']);
    expect(figures(rowOf(html, 'SSS', 'Malvar'))).toEqual(['3,180.00', '0.00', '3,180.00']);
    expect(figures(rowOf(html, 'SSS', 'Rosario'))).toEqual(['1,000.00', '0.00', '1,000.00']);
    expect(figures(rowOf(html, 'PhilHealth', 'Lipa'))).toEqual(['1,040.00', '0.00', '1,040.00']);
    expect(figures(rowOf(html, 'Pag-IBIG', 'Lipa'))).toEqual(['400.00', '0.00', '400.00']);
    expect(figures(rowOf(html, 'BIR', 'Lipa'))).toEqual(['125.50', '0.00', '125.50']);
  });

  it('a part payment moves paid and outstanding for that store only; a voided payment moves them back (kills: paid ignores the lines; a voided payment still counted as paid; outstanding = owed)', async () => {
    const w = await mkWorld(sql, 's5paid');
    const p = await pay(w, PAY(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    let html = await render(listPage, w.admin);
    expect(figures(rowOf(html, 'SSS', 'Lipa'))).toEqual(['3,180.00', '1,000.00', '2,180.00']);
    expect(figures(rowOf(html, 'SSS', 'Malvar')), 'another store of the same agency and month is untouched').toEqual(['3,180.00', '0.00', '3,180.00']);
    expect(figures(rowOf(html, 'PhilHealth', 'Lipa')), 'another agency of the same store is untouched').toEqual(['1,040.00', '0.00', '1,040.00']);
    await voidIt(w, p.id);
    html = await render(listPage, w.admin);
    expect(figures(rowOf(html, 'SSS', 'Lipa')), 'a voided payment pays nothing: the month is owed again').toEqual(['3,180.00', '0.00', '3,180.00']);
  });

  it('oldest unpaid month first: October is listed above November (kills: newest first)', async () => {
    const w = await mkWorld(sql, 's5order');
    const org = { orgId: w.orgId, lipa: w.lipa, malvar: w.malvar, adminId: w.adminId, bankId: w.lipaOffice };
    const zed = await mkPerson(sql, org, 'Zed Lipa', w.lipa);
    await mkRun(sql, org, { storeId: w.lipa, start: '2026-11-01', end: '2026-11-15', status: 'posted', slips: [{ who: zed, sss: ['525.00', '1035.00', '25.00'] }] });
    const text = plain(await render(listPage, w.admin));
    const oct = text.search(/October 2026|Oct 2026|2026-10/);
    const nov = text.search(/November 2026|Nov 2026|2026-11/);
    expect(oct, 'October is on the page').toBeGreaterThanOrEqual(0);
    expect(nov, 'November is on the page').toBeGreaterThanOrEqual(0);
    expect(oct, 'October before November').toBeLessThan(nov);
  });

  it('filters: agency, store and year narrow the rows (kills: filters ignored)', async () => {
    const w = await mkWorld(sql, 's5filter');
    const ph = dataRows(await render(listPage, w.admin, { search: { agency: 'philhealth' } }));
    expect(ph.length).toBe(1);
    expect(ph[0]).toContain('PhilHealth');
    const malvar = dataRows(await render(listPage, w.admin, { search: { store: w.malvar } }));
    expect(malvar.length, 'store=Malvar: one SSS row').toBe(1);
    expect(malvar[0]).toContain('Malvar');
    expect(malvar[0]).toContain('SSS');
    const y25 = dataRows(await render(listPage, w.admin, { search: { year: '2025' } }));
    expect(y25, 'year=2025 has no rows').toEqual([]);
    const y26 = dataRows(await render(listPage, w.admin, { search: { year: '2026' } }));
    expect(y26.length, 'year=2026: all six October rows (SSS x3, PhilHealth, Pag-IBIG, BIR)').toBe(6);
  });

  it('this organization only: another organization\'s stores, ids and months never appear (kills: org filter dropped)', async () => {
    const a = await mkWorld(sql, 's5orgA');
    const b = await mkWorld(sql, 's5orgB');
    await renameStores(b, { [b.lipa]: 'Zzyx Otherorg Lipa', [b.malvar]: 'Zzyx Otherorg Malvar', [b.rosario]: 'Zzyx Otherorg Rosario' });
    const html = await render(listPage, a.admin);
    expectAbsent(html, 'org A list', 'Zzyx', b.lipa, b.malvar, b.rosario);
    expectPresent(html, 'org A list', 'Lipa');
    const months = (await (await loader('monthsFor'))(a.admin, {})) as { storeId: string }[];
    expect(months.length).toBeGreaterThan(0);
    expect(months.every((m) => [a.lipa, a.malvar, a.rosario].includes(m.storeId)), 'monthsFor returns this org\'s stores only').toBe(true);
  });
});

describe('the mismatch banner: all-time outstanding vs GL 22x0', () => {
  it('a clean organization shows no banner (kills: banner always on)', async () => {
    const w = await mkWorld(sql, 's5clean');
    const t = plain(await render(listPage, w.admin));
    expect(t).not.toMatch(/mismatch|does not match/i);
  });

  it('a manual credit to 2210 at Lipa that payroll never made raises the banner (kills: banner never on / reconciliation not read)', async () => {
    const w = await mkWorld(sql, 's5mismatch');
    await sql.begin(async (tx) => {
      const [period] = await tx<{ id: string }[]>`select id from fiscal_periods where org_id = ${w.orgId} and starts_on = '2026-10-01'`;
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${w.orgId}, '2026-10-20', ${period!.id}, 'manual', ${uid('man')}, 'draft') returning id`;
      const acc = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${w.orgId} and code in ('2210','6100')`;
      const by = new Map(acc.map((x) => [x.code, x.id]));
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${by.get('6100')!}, ${w.lipa}, '10.00', '0')`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${by.get('2210')!}, ${w.lipa}, '0', '10.00')`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    const t = plain(await render(listPage, w.admin));
    expect(t).toMatch(/mismatch|does not match/i);
    const rec = (await (await loader('reconciliationFor'))(w.admin)) as { agency: string; storeId: string; outstanding: string; glBalance: string }[];
    const row = rec.find((r) => r.agency === 'sss' && r.storeId === w.lipa);
    expect([row?.outstanding, row?.glBalance]).toEqual(['3180.00', '3190.00']);
  });
});

describe('who may open the screens (kills: the gate is the menu only)', () => {
  it('a manager and staff get the access-refused card on all three screens and none of the figures; the loaders refuse on their own', async () => {
    const w = await mkWorld(sql, 's5gate');
    const p = await pay(w, PAY(w));
    for (const who of ['manager', 'staff'] as const) {
      for (const [name, page, props] of [
        ['list', listPage, {}],
        ['new', newPage, { search: { agency: 'sss', month: '2026-10-01' } }],
        ['detail', detailPage, { params: { id: p.id } }],
      ] as const) {
        const html = await render(page, w[who], props as never);
        expectRefusalCard(html, `${who} ${name}`);
        expectAbsent(html, `${who} ${name}`, '3,180.00', '1,000.00', '3180.00', 'Lipa');
      }
      for (const [fn, args] of [['monthsFor', [{}]], ['reconciliationFor', []], ['paymentFor', [p.id]], ['payFromAccountsFor', []]] as const) {
        const f = await loader(fn);
        await expectAuthRefusal(() => f(w[who], ...args), 'remit_statutory', `${fn}(${who})`);
      }
    }
  });

  it('an admin and a super admin open the list (positive control)', async () => {
    const w = await mkWorld(sql, 's5gateok');
    for (const who of ['admin', 'superAdmin'] as const) {
      const html = await render(listPage, w[who]);
      expect(plain(html)).not.toContain('You do not have access to this screen');
      expectPresent(html, `${who} list`, '3,180.00');
    }
  });
});

describe('the record form', () => {
  it('mints a fresh uuid paymentId per render, defaults every line to its outstanding, and never offers the staff float (kills: fixed id; lines default 0; picker lists GL 1120)', async () => {
    const w = await mkWorld(sql, 's5form');
    const search = { agency: 'sss', month: '2026-10-01' };
    const one = await render(newPage, w.admin, { search });
    const two = await render(newPage, w.admin, { search });
    const idOf = (html: string): string => {
      const tag = html.match(/<input[^>]*name="paymentId"[^>]*>/)?.[0] ?? '';
      const v = tag.match(/value="([^"]+)"/)?.[1] ?? '';
      expect(v, `the paymentId hidden input: ${tag}`).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      return v;
    };
    expect(idOf(one), 'every render of the form mints its own id').not.toBe(idOf(two));
    for (const field of ['agency', 'month', 'paidOn', 'moneyAccountId', 'referenceNo', 'penalty', 'lineStoreId', 'lineAmount']) {
      expect(one, `the form has a "${field}" control`).toContain(`name="${field}"`);
    }
    // each store with something outstanding is a line, defaulted to the outstanding, exact
    const amounts = [...one.matchAll(/<input[^>]*name="lineAmount"[^>]*>/g)].map((m) => m[0].match(/value="([^"]*)"/)?.[1]);
    expect(amounts.sort()).toEqual(['1000.00', '3180.00', '3180.00']);
    for (const s of [w.lipa, w.malvar, w.rosario]) expect(one).toContain(s);
    // the picker: office safe + e-wallet yes, the staff float no
    const floatName = await nameOf(w.lipaFloat);
    const officeName = await nameOf(w.lipaOffice);
    expectPresent(one, 'money account picker', w.lipaOffice, officeName);
    expectAbsent(one, 'money account picker', w.lipaFloat);
    if (floatName !== officeName) expect(plain(one), 'the float is not named in the picker').not.toContain(floatName);
    const f = await loader('payFromAccountsFor');
    const accounts = (await f(w.admin)) as { id: string; glAccountCode: string }[];
    expect(accounts.map((a) => a.glAccountCode)).not.toContain('1120');
    expect(accounts.map((a) => a.id)).toContain(w.lipaOffice);
  });

  it('an agency + month with nothing outstanding offers no lines (a store with nothing owed is refused by the domain, so the form does not invite it)', async () => {
    const w = await mkWorld(sql, 's5formdone');
    await pay(w, PAY(w, { lines: [{ storeId: w.lipa, amount: '3180.00' }] }));
    const html = await render(newPage, w.admin, { search: { agency: 'sss', month: '2026-10-01' } });
    const amounts = [...html.matchAll(/<input[^>]*name="lineAmount"[^>]*>/g)].map((m) => m[0].match(/value="([^"]*)"/)?.[1]);
    expect(amounts.sort(), 'Lipa is paid up: only Malvar and Rosario remain').toEqual(['1000.00', '3180.00']);
  });
});

describe('the payment detail', () => {
  it('shows reference, agency, each line, the penalty, Posted, the entry link and the void form; a voided one shows Voided, the reason and no void form (kills: void form on a voided payment)', async () => {
    const w = await mkWorld(sql, 's5detail');
    const inp = PAY(w, { lines: [{ storeId: w.malvar, amount: '3180.00' }], penalty: '63.60', referenceNo: 'PRN-DETAIL-77' });
    const p = await pay(w, inp);
    let html = await render(detailPage, w.admin, { params: { id: p.id } });
    expectPresent(html, 'posted detail', 'PRN-DETAIL-77', 'Malvar', '3,180.00', '63.60', `/reports/journal-lines?entry=${p.entryId}`);
    expect(plain(html)).toMatch(/\bSSS\b/);
    expect(plain(html)).toMatch(/Posted/i);
    expect(html, 'the void form carries this payment id').toMatch(new RegExp(`<input[^>]*name="paymentId"[^>]*value="${p.id}"|<input[^>]*value="${p.id}"[^>]*name="paymentId"`));
    expect(html, 'the void form asks for a reason').toMatch(/name="reason"/);

    await voidIt(w, p.id);
    html = await render(detailPage, w.admin, { params: { id: p.id } });
    expect(plain(html)).toMatch(/Voided/i);
    expectPresent(html, 'voided detail', 'Wrong receipt', 'PRN-DETAIL-77');
    expect(html, 'no void form on a voided payment').not.toMatch(/name="reason"/);
  });

  it('a non-uuid id, an unknown uuid and another organization\'s payment are all notFound (kills: detail trusts the id; detail loads another org\'s payment)', async () => {
    const a = await mkWorld(sql, 's5nfA');
    const b = await mkWorld(sql, 's5nfB');
    const theirs = await pay(b, PAY(b, { referenceNo: 'PRN-OTHERORG-99' }));
    for (const id of ['not-a-uuid', '12345', `${a.lipa}x`, crypto.randomUUID(), theirs.id]) {
      await expect(render(detailPage, a.admin, { params: { id } }), `id ${id}`).rejects.toThrow('NEXT_NOT_FOUND');
    }
    const f = await loader('paymentFor');
    expect(await f(a.admin, 'not-a-uuid')).toBeNull();
    expect(await f(a.admin, theirs.id), 'another org\'s payment is not loaded').toBeNull();
    // and its own admin does see it
    expectPresent(await render(detailPage, b.admin, { params: { id: theirs.id } }), 'own org detail', 'PRN-OTHERORG-99');
  });
});
