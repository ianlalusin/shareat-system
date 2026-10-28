import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-193 S2 (TESTER) - `statutoryPaymentsRepo`: what is OWED to each agency per month and store (summed live from POSTED pay runs),
 * what is PAID (posted payment lines only), the per-payslip month detail, and the all-time reconciliation against the ledger.
 * docs/tasks/193-statutory-remittance/REFRESH.md s5 S2 (cases 1, 11, 12) + docs/tasks/193-statutory-remittance.md "The model".
 *
 * RED TODAY: `statutoryPaymentsRepo` is not exported from @shareat/db (packages/db/src/repo/statutory-payments.ts does not exist),
 * so every leg fails with "is not a function" / undefined - the right reason.
 *
 * NAMES THE TESTER FIXED (the builder implements these exact spellings; the figures are the spec's):
 *  - `import { statutoryPaymentsRepo } from '@shareat/db'` (index.ts: `export * as statutoryPaymentsRepo from './repo/statutory-payments'`).
 *  - monthTotals(tx, orgId, filter?: { agency?, storeId?, year?: number })
 *      -> { agency, month: 'YYYY-MM-01', storeId, owed, paid, outstanding }[]   (numeric(14,2) TEXT, e.g. '3180.00', '-10.00')
 *      One row per (agency, month, store) that has owed > 0 OR paid > 0 (a month with no payroll but a payment still shows, owed '0.00');
 *      ordered oldest month first. Month = calendar month of pay_runs.period_end. Owed: POSTED runs only. Paid: lines of POSTED payments only.
 *  - monthDetail(tx, orgId, agency, month)
 *      -> { payslipId, runId, storeId, personId, personName, ee, er, ec, total, notDeducted }[]   one row per payslip of a POSTED run whose
 *      period_end is in `month`. sss: ee=sss_ee er=sss_er ec=sss_ec; philhealth / pagibig: ec '0.00'; bir: ee = withholding, er = ec = '0.00'.
 *      notDeducted = the agency is in payslips.skipped_agencies (the row stays, at 0.00).
 *  - reconciliation(tx, orgId) -> { agency, storeId, outstanding, glBalance }[]   ALL-TIME (no year filter). outstanding = owed - paid summed over
 *      every month; glBalance = credit - debit on the 2210 / 2220 / 2230 / 2240 lines of non-draft entries at that store. Rows for (agency, store)
 *      pairs with any owed, paid or GL activity.
 *  - insertPayment(tx, { id, orgId, agency, month, paidOn, moneyAccountId, referenceNo, penalty: Money, notes: string | null, createdBy }) -> void
 *    insertLines(tx, orgId, paymentId, [{ storeId, amount: Money }]) -> void
 *    getById(tx, orgId, id) -> null | { id, agency, month, paidOn, moneyAccountId, referenceNo, penalty, notes, journalEntryId, status, voidReason,
 *      voidedBy, createdBy, lines: { storeId, amount }[] }
 *    setEntry(tx, orgId, id, journalEntryId) -> boolean        markVoided(tx, orgId, id, { voidedBy, reason }) -> boolean   (false = nothing changed)
 *
 * MUTANTS (each leg names its own): owed from ee only; month by period_start / entry_date; voided or draft run counted; org filter missing;
 *   voided payment counted as paid; payments-only month dropped; year filter ignored; lines not per store; GL narrowed to the year;
 *   glBalance copied from outstanding; skipped person dropped from the detail; float sums; markVoided not guarded by status.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { transaction, systemTransaction, APP_ROLE, statutoryPaymentsRepo as repo, type Tx } from '@shareat/db';
import { money } from '@shareat/core/money';
import { glEntry, mkOrg, mkPerson, mkRun, mkWorld, sumMoney, type Agency, type World } from './_fixtures/t193-s2-world';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
/** The system (RLS-bypassing) connection: only the repo's OWN org filter stands between this call and another org's rows. */
const asOwner = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => systemTransaction(fn);

type Row = { agency: Agency; month: string; storeId: string; owed: string; paid: string; outstanding: string };
const cell = (rows: Row[], agency: Agency, month: string, storeId: string): Row | undefined =>
  rows.find((r) => r.agency === agency && r.month === month && r.storeId === storeId);

describe('T-193 S2 - owed / paid per agency, month and store', () => {
  let w: World;
  let rows: Row[];
  beforeAll(async () => {
    w = await mkWorld(sql, 'owed');
    rows = (await asOrg(w.orgId, (tx) => repo.monthTotals(tx, w.orgId))) as Row[];
  });

  it('case 1 - owed is the whole contribution (ee + er + ec), per store: SSS October Lipa 3,180.00, Malvar 3,180.00 (kills: owed from ee only = 1,050.00)', () => {
    expect(cell(rows, 'sss', '2026-10-01', w.lipa)?.owed).toBe('3180.00');
    expect(cell(rows, 'sss', '2026-10-01', w.malvar)?.owed).toBe('3180.00');
    const both = rows.filter((r) => r.agency === 'sss' && r.month === '2026-10-01').map((r) => r.owed);
    expect(sumMoney(both)).toBe('6360.00');
  });

  it('case 1 - PhilHealth, Pag-IBIG and BIR owed follow their own columns (er counted; BIR = withholding; no BIR row where nothing was withheld)', () => {
    expect(cell(rows, 'philhealth', '2026-10-01', w.lipa)?.owed).toBe('1340.00'); // Ana 1,040 + Cora 300
    expect(cell(rows, 'philhealth', '2026-10-01', w.malvar)?.owed).toBe('1040.00');
    expect(cell(rows, 'pagibig', '2026-10-01', w.lipa)?.owed).toBe('500.00');
    expect(cell(rows, 'pagibig', '2026-10-01', w.malvar)?.owed).toBe('400.00');
    expect(cell(rows, 'bir', '2026-10-01', w.lipa)?.owed).toBe('125.50');
    expect(cell(rows, 'bir', '2026-10-01', w.malvar)).toBeUndefined();
  });

  it('case 1 - the month is the calendar month of period_end: Malvar run 26 Sep - 10 Oct is OCTOBER, and September has no row at all (kills: month by period_start / entry_date)', () => {
    expect(rows.filter((r) => r.month === '2026-09-01')).toEqual([]);
    // November / January are separate months, not folded into October
    expect(cell(rows, 'sss', '2026-11-01', w.lipa)?.owed).toBe('310.30');
    expect(cell(rows, 'sss', '2027-01-01', w.lipa)?.owed).toBe('160.00');
    expect(cell(rows, 'sss', '2026-11-01', w.malvar)).toBeUndefined();
  });

  it('rounding - owed is exact to the centavo: November Lipa SSS 310.00 + (0.10 + 0.20 + 0.00) = 310.30, not a float (kills: Number() sums)', () => {
    expect(cell(rows, 'sss', '2026-11-01', w.lipa)?.owed).toBe('310.30');
    for (const r of rows) {
      for (const v of [r.owed, r.paid, r.outstanding]) expect(v).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('a VOIDED run (SSS 9,999.00 in October) and a DRAFT run (777.00 in December) are never owed (kills: voided / draft run counted)', () => {
    expect(cell(rows, 'sss', '2026-10-01', w.lipa)?.owed).toBe('3180.00');
    expect(rows.find((r) => r.owed === '9999.00' || r.owed === '777.00' || r.owed === '13179.00' || r.owed === '3957.00')).toBeUndefined();
    expect(rows.filter((r) => r.agency === 'sss' && r.month === '2026-12-01')).toEqual([]);
  });

  it('paid is the POSTED lines only, per store: SSS Oct Lipa paid 2,500.00 (2,000 + 500 of a two-store payment), Malvar 1,000.10; outstanding = owed - paid (kills: voided payment counted)', () => {
    const lipa = cell(rows, 'sss', '2026-10-01', w.lipa)!;
    const malvar = cell(rows, 'sss', '2026-10-01', w.malvar)!;
    expect([lipa.paid, lipa.outstanding]).toEqual(['2500.00', '680.00']);
    // the voided PRN-0003 (3,180.00) must not count: 3,180.00 owed - 1,000.10 = 2,179.90, never -1,000.10
    expect([malvar.paid, malvar.outstanding]).toEqual(['1000.10', '2179.90']);
  });

  it('a fully paid month reads outstanding 0.00; an unpaid one reads paid 0.00 (the row still exists)', () => {
    expect(cell(rows, 'philhealth', '2026-10-01', w.lipa)).toMatchObject({ owed: '1340.00', paid: '1340.00', outstanding: '0.00' });
    expect(cell(rows, 'philhealth', '2026-10-01', w.malvar)).toMatchObject({ owed: '1040.00', paid: '0.00', outstanding: '1040.00' });
    expect(cell(rows, 'bir', '2026-10-01', w.lipa)).toMatchObject({ paid: '0.00', outstanding: '125.50' });
  });

  it('a month with NO payroll but a payment still shows, owed 0.00 and outstanding negative (kills: payments-only month dropped)', () => {
    expect(cell(rows, 'philhealth', '2026-12-01', w.malvar)).toMatchObject({ owed: '0.00', paid: '10.00', outstanding: '-10.00' });
  });

  it('rows come back oldest month first', () => {
    const months = rows.map((r) => r.month);
    expect(months).toEqual([...months].sort());
    expect(months[0]).toBe('2026-10-01');
  });

  it('filters: agency, store and year each narrow the rows (kills: filter ignored)', async () => {
    const bir = (await asOrg(w.orgId, (tx) => repo.monthTotals(tx, w.orgId, { agency: 'bir' }))) as Row[];
    expect(bir.length).toBeGreaterThan(0);
    expect(bir.every((r) => r.agency === 'bir')).toBe(true);
    const malvar = (await asOrg(w.orgId, (tx) => repo.monthTotals(tx, w.orgId, { storeId: w.malvar }))) as Row[];
    expect(malvar.length).toBeGreaterThan(0);
    expect(malvar.every((r) => r.storeId === w.malvar)).toBe(true);
    const y2026 = (await asOrg(w.orgId, (tx) => repo.monthTotals(tx, w.orgId, { year: 2026 }))) as Row[];
    expect(y2026.some((r) => r.month.startsWith('2027'))).toBe(false);
    expect(y2026.some((r) => r.month === '2026-10-01')).toBe(true);
    const y2027 = (await asOrg(w.orgId, (tx) => repo.monthTotals(tx, w.orgId, { year: 2027 }))) as Row[];
    expect(y2027.map((r) => r.month)).toEqual(['2027-01-01']);
  });

  it('another org is never in the numbers: its Oct SSS 9,999.00 run, store and payment stay out (kills: org filter missing; run without the role switch so only the repo filter protects)', async () => {
    const other = await mkOrg(sql, 'other');
    const ozzy = await mkPerson(sql, other, 'Ozzy Other', other.lipa);
    await mkRun(sql, other, { storeId: other.lipa, start: '2026-10-01', end: '2026-10-15', status: 'posted', slips: [{ who: ozzy, sss: ['9999.00', '0.00', '0.00'] }] });
    const mine = (await asOwner((tx) => repo.monthTotals(tx, w.orgId))) as Row[];
    expect(mine.every((r) => r.storeId === w.lipa || r.storeId === w.malvar)).toBe(true);
    expect(mine.find((r) => r.owed === '9999.00')).toBeUndefined();
    expect(cell(mine, 'sss', '2026-10-01', w.lipa)?.owed).toBe('3180.00');
    const theirs = (await asOwner((tx) => repo.monthTotals(tx, other.orgId))) as Row[];
    expect(theirs.map((r) => [r.storeId, r.owed])).toEqual([[other.lipa, '9999.00']]);
    const detail = await asOwner((tx) => repo.monthDetail(tx, w.orgId, 'sss', '2026-10-01'));
    expect(detail.find((d: { personName: string }) => d.personName === 'Ozzy Other')).toBeUndefined();
  });
});

describe('T-193 S2 - month detail, one row per payslip (case 12)', () => {
  let w: World;
  type Detail = { payslipId: string; runId: string; storeId: string; personId: string; personName: string; ee: string; er: string; ec: string; total: string; notDeducted: boolean };
  let sss: Detail[];
  beforeAll(async () => {
    w = await mkWorld(sql, 'detail');
    sss = (await asOrg(w.orgId, (tx) => repo.monthDetail(tx, w.orgId, 'sss', '2026-10-01'))) as Detail[];
  });

  it('case 12 - person C has no SSS number: no SSS owed from her, and she is LISTED "not deducted" with 0.00 (kills: C dropped from the list)', () => {
    const cora = sss.filter((d) => d.personId === w.cora.personId);
    expect(cora).toHaveLength(1);
    expect(cora[0]).toMatchObject({ personName: 'Cora NoSss', storeId: w.lipa, ee: '0.00', er: '0.00', ec: '0.00', total: '0.00', notDeducted: true });
    expect(sss).toHaveLength(5); // Ana x2, Cora, Ben x2: every payslip of a posted October run, nothing else
  });

  it('SSS detail carries ee / er / ec per payslip and they add up to the month total (Lipa 3,180.00 = Ana 1,585 + 1,595; Cora adds nothing)', () => {
    const ana = sss.filter((d) => d.personId === w.ana.personId).sort((a, b) => a.total.localeCompare(b.total));
    expect(ana.map((d) => [d.ee, d.er, d.ec, d.total, d.notDeducted])).toEqual([
      ['525.00', '1035.00', '25.00', '1585.00', false],
      ['525.00', '1045.00', '25.00', '1595.00', false],
    ]);
    const lipaTotal = sumMoney(sss.filter((d) => d.storeId === w.lipa).map((d) => d.total));
    expect(lipaTotal).toBe('3180.00');
    // Ben's run M1 ended 10 Oct (started 26 Sep) - he is in October's detail
    expect(sss.filter((d) => d.personId === w.ben.personId)).toHaveLength(2);
  });

  it('Cora is a normal row for PhilHealth (the skip is per agency): ee 150.00 er 150.00 ec 0.00, notDeducted false', async () => {
    const ph = (await asOrg(w.orgId, (tx) => repo.monthDetail(tx, w.orgId, 'philhealth', '2026-10-01'))) as Detail[];
    const cora = ph.find((d) => d.personId === w.cora.personId)!;
    expect(cora).toMatchObject({ ee: '150.00', er: '150.00', ec: '0.00', total: '300.00', notDeducted: false });
  });

  it('BIR detail shows the withholding as ee with er and ec 0.00', async () => {
    const bir = (await asOrg(w.orgId, (tx) => repo.monthDetail(tx, w.orgId, 'bir', '2026-10-01'))) as Detail[];
    const ana = bir.find((d) => d.personId === w.ana.personId && d.total === '125.50')!;
    expect(ana).toMatchObject({ ee: '125.50', er: '0.00', ec: '0.00', notDeducted: false });
  });

  it('a month with no payroll has an empty detail, and the voided / draft runs never appear', async () => {
    const dec = await asOrg(w.orgId, (tx) => repo.monthDetail(tx, w.orgId, 'sss', '2026-12-01'));
    expect(dec).toEqual([]);
    expect(sss.find((d) => d.ee === '9999.00' || d.ee === '777.00')).toBeUndefined();
    expect(sss.map((d) => d.runId)).not.toContain(w.runs.L5v);
    expect(sss.map((d) => d.runId)).not.toContain(w.runs.L6d);
  });
});

describe('T-193 S2 - reconciliation against the ledger, all-time (case 11 query leg)', () => {
  type Rec = { agency: Agency; storeId: string; outstanding: string; glBalance: string };
  const recOf = (rows: Rec[], agency: Agency, storeId: string): Rec => rows.find((r) => r.agency === agency && r.storeId === storeId) ?? { agency, storeId, outstanding: '0.00', glBalance: '0.00' };

  /** The ledger's own answer, computed here straight from journal lines (never through the repo). */
  async function gl(orgId: string, agency: Agency, storeId: string): Promise<string> {
    const code = { sss: '2210', philhealth: '2220', pagibig: '2230', bir: '2240' }[agency];
    const [r] = await sql<{ b: string }[]>`
      select coalesce(sum(jl.credit - jl.debit), 0)::numeric(14,2)::text as b
      from journal_lines jl join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and a.code = ${code} and jl.store_id = ${storeId} and je.status <> 'draft'`;
    return r!.b;
  }

  it('sum of outstanding per store and agency equals the GL 22x0 balance at that store, every pair (kills: lines not per store -> Malvar mismatch)', async () => {
    const w = await mkWorld(sql, 'recon');
    const rows = (await asOrg(w.orgId, (tx) => repo.reconciliation(tx, w.orgId))) as Rec[];
    for (const agency of ['sss', 'philhealth', 'pagibig', 'bir'] as Agency[]) {
      for (const storeId of [w.lipa, w.malvar]) {
        const r = recOf(rows, agency, storeId);
        expect(r.glBalance, `${agency} ${storeId === w.lipa ? 'Lipa' : 'Malvar'} GL`).toBe(await gl(w.orgId, agency, storeId));
        expect(r.outstanding, `${agency} ${storeId === w.lipa ? 'Lipa' : 'Malvar'} outstanding = GL`).toBe(r.glBalance);
      }
    }
    // the figures themselves, so a wrong-but-equal pair (both zero) cannot pass
    expect(recOf(rows, 'sss', w.lipa).outstanding).toBe('1150.30'); // 3,180.00 + 310.30 + 160.00 - 2,500.00
    expect(recOf(rows, 'sss', w.malvar).outstanding).toBe('2179.90'); // 3,180.00 - 1,000.10 (the voided 3,180.00 never counted)
    expect(recOf(rows, 'philhealth', w.lipa).outstanding).toBe('200.00'); // 1,340.00 + 200.00 - 1,340.00
    expect(recOf(rows, 'philhealth', w.malvar).outstanding).toBe('1030.00'); // 1,040.00 - the 10.00 paid for a month with no payroll
    expect(recOf(rows, 'bir', w.lipa).outstanding).toBe('125.50');
  });

  it('is ALL-TIME: the Jan 2027 SSS 160.00 is inside Lipa 1,150.30 even though a year-2026 month view excludes it (kills: year-narrowed GL / outstanding)', async () => {
    const w = await mkWorld(sql, 'recon-year');
    const rows = (await asOrg(w.orgId, (tx) => repo.reconciliation(tx, w.orgId))) as Rec[];
    expect(recOf(rows, 'sss', w.lipa).outstanding).toBe('1150.30');
    const y2026 = (await asOrg(w.orgId, (tx) => repo.monthTotals(tx, w.orgId, { year: 2026 }))) as Row[];
    const lipa2026 = sumMoney(y2026.filter((r) => r.agency === 'sss' && r.storeId === w.lipa).map((r) => r.outstanding));
    expect(lipa2026).toBe('990.30'); // the year view is narrower on purpose; the reconciliation must not be
    expect(recOf(rows, 'sss', w.lipa).glBalance).toBe('1150.30');
  });

  it('a manual entry to 2210 shows as a MISMATCH (Malvar GL 2,229.90 vs outstanding 2,179.90), so the banner can fire (kills: glBalance copied from outstanding)', async () => {
    const w = await mkWorld(sql, 'recon-mismatch');
    await glEntry(sql, w.orgId, '2026-11-20', 'manual', [
      { code: '6100', storeId: w.malvar, debit: '50.00' },
      { code: '2210', storeId: w.malvar, credit: '50.00' },
    ]);
    const rows = (await asOrg(w.orgId, (tx) => repo.reconciliation(tx, w.orgId))) as Rec[];
    const r = recOf(rows, 'sss', w.malvar);
    expect([r.outstanding, r.glBalance]).toEqual(['2179.90', '2229.90']);
    expect(recOf(rows, 'sss', w.lipa).outstanding).toBe(recOf(rows, 'sss', w.lipa).glBalance);
  });

  it('another org\'s ledger and payslips are not in this org\'s reconciliation (run without the role switch)', async () => {
    const w = await mkWorld(sql, 'recon-iso');
    const other = await mkWorld(sql, 'recon-iso-b');
    const mine = (await asOwner((tx) => repo.reconciliation(tx, w.orgId))) as Rec[];
    expect(mine.every((r) => r.storeId === w.lipa || r.storeId === w.malvar)).toBe(true);
    expect(mine.some((r) => r.storeId === other.lipa || r.storeId === other.malvar)).toBe(false);
  });
});

describe('T-193 S2 - payment rows: insert, read back, link the entry, void (guarded)', () => {
  it('insertPayment + insertLines round-trip through getById; setEntry links once; markVoided is guarded by status and removes the lines from "paid"', async () => {
    const f = await mkOrg(sql, 'crud');
    const other = await mkOrg(sql, 'crud-other');
    const id = crypto.randomUUID();
    const entry = await glEntry(sql, f.orgId, '2027-02-05', 'statutory_payment', [
      { code: '2210', storeId: f.lipa, debit: '150.10' },
      { code: '1130', storeId: f.lipa, credit: '150.10' },
    ]);

    await asOrg(f.orgId, async (tx) => {
      await repo.insertPayment(tx, {
        id, orgId: f.orgId, agency: 'sss', month: '2027-01-01', paidOn: '2027-02-05', moneyAccountId: f.bankId,
        referenceNo: 'PRN-CRUD-1', penalty: money('0.00'), notes: null, createdBy: f.adminId,
      });
      await repo.insertLines(tx, f.orgId, id, [
        { storeId: f.lipa, amount: money('100.10') },
        { storeId: f.malvar, amount: money('50.00') },
      ]);
    });

    const got = await asOrg(f.orgId, (tx) => repo.getById(tx, f.orgId, id));
    expect(got).toMatchObject({ id, agency: 'sss', month: '2027-01-01', paidOn: '2027-02-05', referenceNo: 'PRN-CRUD-1', penalty: '0.00', status: 'posted', journalEntryId: null, notes: null });
    expect([...got!.lines].sort((a, b) => (a.storeId < b.storeId ? -1 : 1)).map((l) => [l.storeId, l.amount])).toEqual(
      [
        [f.malvar, '50.00'],
        [f.lipa, '100.10'],
      ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    );
    // not visible as another org's payment, by id
    expect(await asOwner((tx) => repo.getById(tx, other.orgId, id))).toBeNull();
    expect(await asOrg(f.orgId, (tx) => repo.getById(tx, f.orgId, crypto.randomUUID()))).toBeNull();

    // a payment for a month with no payroll is paid-only: both stores show, owed 0.00
    const live = (await asOrg(f.orgId, (tx) => repo.monthTotals(tx, f.orgId))) as Row[];
    expect(live.map((r) => [r.storeId, r.owed, r.paid, r.outstanding]).sort()).toEqual(
      [
        [f.lipa, '0.00', '100.10', '-100.10'],
        [f.malvar, '0.00', '50.00', '-50.00'],
      ].sort(),
    );

    // the link: set once, on this org's row only
    expect(await asOwner((tx) => repo.setEntry(tx, other.orgId, id, entry))).toBe(false);
    expect(await asOrg(f.orgId, (tx) => repo.setEntry(tx, f.orgId, id, entry))).toBe(true);
    expect((await asOrg(f.orgId, (tx) => repo.getById(tx, f.orgId, id)))!.journalEntryId).toBe(entry);

    // void: another org cannot, we can once, the second time changes nothing (kills: UPDATE not guarded by status = 'posted')
    expect(await asOwner((tx) => repo.markVoided(tx, other.orgId, id, { voidedBy: other.adminId, reason: 'not yours' }))).toBe(false);
    expect(await asOrg(f.orgId, (tx) => repo.markVoided(tx, f.orgId, id, { voidedBy: f.adminId, reason: 'wrong month' }))).toBe(true);
    expect(await asOrg(f.orgId, (tx) => repo.markVoided(tx, f.orgId, id, { voidedBy: f.adminId, reason: 'again' }))).toBe(false);
    const after = await asOrg(f.orgId, (tx) => repo.getById(tx, f.orgId, id));
    expect(after).toMatchObject({ status: 'voided', voidReason: 'wrong month', voidedBy: f.adminId });
    expect(after!.lines).toHaveLength(2); // the lines stay as history
    // voided = no longer paid (kills: voided lines counted): the month has neither owed nor paid, so no row remains
    expect(await asOrg(f.orgId, (tx) => repo.monthTotals(tx, f.orgId))).toEqual([]);
  });
});
