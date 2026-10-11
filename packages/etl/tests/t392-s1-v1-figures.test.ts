/**
 * T-392 S1 (TESTER) - v1 snapshot, week maths and v1 figures (pure; docs/tasks/392-dual-run-comparator.md).
 *
 * The spec names the files and the invariants but no signatures, so THIS FILE PINS THEM. Builder: match these exactly
 * or report the one you cannot (do not reshape the tests). Everything lives under packages/etl/src/dual-run/.
 * Money is INTEGER CENTAVOS (number) in every output; snapshot documents keep v1's pesos-as-floats.
 *
 *  week.ts
 *    addDays(date, n) -> 'YYYY-MM-DD'            weekStartOf(date) -> the Monday ('YYYY-MM-DD'); throws on a non-date
 *    datesInWeek(weekStart) -> 7 strings         normaliseBusinessDate(s) -> 'YYYY-MM-DD' | null  (accepts legacy YYYYMMDD)
 *    manilaDateOf(ms) -> Manila calendar date of an instant. NEVER used to place a figure in a week (R1); it exists for
 *    provenance and a --through default, and pins that the Manila day rolls at 16:00 UTC.
 *  snapshot.ts   buildSnapshot(raw, { from, through }) -> V1Snapshot
 *    raw = { stores[], journal[], expenses[], salesDays[], suppliers[], paymentAccounts[] }, every doc carrying its storeId.
 *    Whitelist (NOT blacklist), window = [from - 7, through + 7] on the date STRINGS, Padre Garcia / test stores moved to
 *    `excludedStores` ({ id, name, reason }) and their docs dropped, an id in neither roster throws /unknown store/i.
 *    V1Snapshot = { version: 1, from, through, window, extractedAt, stores, excludedStores, suppliers, paymentAccounts,
 *                   journal, expenses, salesDays } (fixtures/t392-v1-snapshot.json is one, already whitelisted).
 *  v1-figures.ts   computeV1Figures(snapshot, { weekStart, through? }) -> V1Figures   (through defaults to weekStart + 6)
 *    V1Figures = { weekStart, through, excluded: [{ id, name, reason }], stores: Record<v1StoreId, V1StoreFigures> }
 *      stores has EVERY operating store in the snapshot, with or without data.
 *    V1StoreFigures = { storeId, name, hasData, tradingDays: string[], lines: V1Line[], scope: ScopeEntry[],
 *        posted: { legs, in, out }, cashResidual: Record<date, number>, warnings: [{ code: 'SUB_CENTAVO', docId, value }],
 *        flags: [{ code: 'V1_REMITTED_FIELD_ZERO', date }] }
 *      V1_REMITTED_FIELD_ZERO: a counted salesDay with dineInSales 0 whose posted sale legs are non-zero (v1 draft paths
 *      write 0, sales-report-draft.actions.ts:68,413): NO cashResidual entry for that day, one flag, still a trading day.
 *      hasData === (lines.length > 0 || tradingDays.length > 0 || a cashResidual entry); a store-week with none of them has
 *      lines === [] (never zeros). Audit round: unparseable amounts and unknown statuses THROW (message names the doc id);
 *      `voided: { legs, expenses, salesDays }` counts what was excluded; flags also carry V1_EXPENSE_ENTRY_GROUP_CONFLICT.
 *      posted = every status 'posted' leg in [weekStart, through], whatever its sourceType or account.
 *      cashResidual = UNFLOORED remitted - online - credit - other per trading day, remitted = salesDay.dineInSales
 *      (GLOSSARY: the ERP stores the remitted-daily channels there), online = sum(onlineBreakdown).
 *    V1Line = { kind, key, amount, days: Record<date, number>, group?, supplierId?, in?, out?, debit?, credit?, legs? }
 *      cash_bank     key = v1 account id (cash__cashier|office|staff, online__{id}); in/out/legs; amount = in - out;
 *                    debit/credit from adaptLegacyLegs polarity (cash and online: in = debit). In-scope sourceTypes only
 *                    (sale, expense_payment, ap_payment) AND cash__/online__ accounts.
 *      sales_tender  key = cash__cashier | online__{id} | credit | other; amount = tender total over R4-status salesDays
 *                    (cash from the sale LEGS = the floored cashPayments; online per wallet; credit / other from the doc).
 *      expense_category  key = expenseEntryId; group = expenseEntryGroup; amount = sum totalAmount of posted expenses on
 *                    dayKey in groups OPEX, CAPEX, PERSONAL, OTHERS. COGS never appears here.
 *      inventory_basis   one line, key 'COGS': posted COGS-group spend (the INVENTORY_BASIS policy line, S2 classes it).
 *      ap_supplier   key = 'ap__{sid}' (supplierId = sid): in = incurred (credit), out = paid (debit), amount = in - out;
 *                    key = 'supplier_advance__{sid}' on its OWN line: amount = debit - credit.
 *    ScopeEntry = { class: 'NOT_IN_DUAL_RUN_SCOPE' | 'PAYROLL_ON_V1', sourceType, legs, in, out }: every posted leg that is
 *      not in cash_bank or ap_supplier lands here, so nothing is dropped (invariant 9).
 *  keys.ts   KeyRow = { section: 'store'|'money'|'category', v1Store: string, v1Key, v1Label, v2Key, ticked }
 *    parseKeysCsv(text) / serialiseKeysCsv(rows) (header section,v1_store,v1_key,v1_label,v2_key,ticked; ticked 'Y' or '';
 *    RFC-4180 quoting; CRLF accepted)   prefillKeys({ snapshot, existing, v2 }) -> KeyRow[]   (never ticks; suggests ONLY
 *    on an exact normalised-name match; keeps every existing row as Ian left it)   assertStoresTicked(rows, v1StoreIds) throws.
 *  index.ts re-exports all of the above; packages/etl/src/index.ts gets `export * from './dual-run';`.
 *
 * Judged by: every test imports ../src/dual-run/*, so on HEAD the whole file is red with "Cannot find module" (the
 * module is missing, which is the right reason). Once it exists, each `it` names the assertion that judges it.
 * Invariants 1-10 of the spec are tagged [inv N]; the mutant each one catches is in the comment above its test.
 * Out of this slice (S2): the V1_CASH_RESIDUAL class rule, UNMAPPED_KEY, candidate matching.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays, datesInWeek, manilaDateOf, normaliseBusinessDate, weekStartOf } from '../src/dual-run/week';
import { buildSnapshot } from '../src/dual-run/snapshot';
import { computeV1Figures } from '../src/dual-run/v1-figures';
import { assertStoresTicked, parseKeysCsv, prefillKeys, serialiseKeysCsv } from '../src/dual-run/keys';
import * as barrel from '../src/dual-run';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const D = 'eVYKj6wABdakk8RgEotW';
const PADRE = 'y1DMgfisuTHBF57cNL6i';
const WEEK = '2026-10-19';
const c = (pesos: number): number => Math.round(pesos * 100);

const snap = (): Any => JSON.parse(readFileSync(join(__dirname, 'fixtures', 't392-v1-snapshot.json'), 'utf8'));
const fig = (s: Any = snap(), weekStart = WEEK, through?: string): Any =>
  computeV1Figures(s, through ? { weekStart, through } : { weekStart });
const line = (f: Any, store: string, kind: string, key: string): Any =>
  f.stores[store].lines.find((l: Any) => l.kind === kind && l.key === key);
const day = (l: Any, date: string): number => l?.days?.[date] ?? 0;
const scopeSum = (f: Any, store: string, cls: string, sourceType: string): Any => {
  const rows = f.stores[store].scope.filter((s: Any) => s.class === cls && s.sourceType === sourceType);
  return rows.reduce((a: Any, s: Any) => ({ legs: a.legs + s.legs, in: a.in + s.in, out: a.out + s.out }), { legs: 0, in: 0, out: 0 });
};

// ----------------------------------------------------------------------------------------------------------------
describe('week maths on strings (R1)', () => {
  it('weekStartOf is the Monday, whatever the weekday, across a year end and a leap day', () => {
    expect(weekStartOf('2026-10-19')).toBe('2026-10-19');
    expect(weekStartOf('2026-10-25')).toBe('2026-10-19'); // Sunday belongs to the week that began 19 Oct
    expect(weekStartOf('2026-10-26')).toBe('2026-10-26');
    expect(weekStartOf('2027-01-01')).toBe('2026-12-28');
    expect(weekStartOf('2028-02-29')).toBe('2028-02-28');
  });
  it('addDays and datesInWeek are calendar arithmetic, seven dates Monday to Sunday', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(datesInWeek(WEEK)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  });
  it('normaliseBusinessDate accepts v1 legacy YYYYMMDD and refuses junk', () => {
    expect(normaliseBusinessDate('20261025')).toBe('2026-10-25');
    expect(normaliseBusinessDate('2026-10-25')).toBe('2026-10-25');
    expect(normaliseBusinessDate('2026-13-40')).toBeNull();
    expect(normaliseBusinessDate('Oct 25')).toBeNull();
    expect(() => weekStartOf('not a date')).toThrow();
  });
  it('manilaDateOf rolls the day at 16:00 UTC, never at midnight UTC', () => {
    expect(manilaDateOf(Date.parse('2026-10-25T15:59:59.999Z'))).toBe('2026-10-25');
    expect(manilaDateOf(Date.parse('2026-10-25T16:00:00.000Z'))).toBe('2026-10-26');
    expect(manilaDateOf(Date.parse('2026-10-26T00:30:00.000Z'))).toBe('2026-10-26'); // UTC says Monday too, but 08:30 Manila
    expect(manilaDateOf(Date.parse('2026-10-24T23:59:00.000Z'))).toBe('2026-10-25'); // UTC Saturday, Manila Sunday morning
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe('snapshot: whitelist, window, exclusions', () => {
  const raw = (): Any => ({
    stores: [
      { id: L, name: 'SharEat Lipa', ownerEmail: 'ZZ-owner@example.test' },
      { id: PADRE, name: 'SharEat Padre Garcia' },
      { id: 'TEST', name: 'Test Commissary' },
    ],
    journal: [
      { id: 'j1', storeId: L, businessDate: '2026-10-20', sourceType: 'expense_payment', sourceId: 'ex1', legKey: 'cash:cashier', accountId: 'cash__cashier', direction: 'out', amount: 2500, status: 'posted', supplierId: 'S1', employeeId: 'ZZ-emp-1', memo: 'ZZ-memo', notes: 'ZZ-leg-notes', createdByUid: 'ZZ-uid', createdAtMs: 1760000000000, zzUnlistedField: 'ZZ-new-field' },
      { id: 'j-old', storeId: L, businessDate: '2026-10-11', sourceType: 'sale', sourceId: 'x', legKey: 'cash:cashier', accountId: 'cash__cashier', direction: 'in', amount: 1, status: 'posted' },
      { id: 'j-edge-lo', storeId: L, businessDate: '20261012', sourceType: 'sale', sourceId: 'y', legKey: 'cash:cashier', accountId: 'cash__cashier', direction: 'in', amount: 2, status: 'posted' },
      { id: 'j-edge-hi', storeId: L, businessDate: '2026-11-01', sourceType: 'sale', sourceId: 'z', legKey: 'cash:cashier', accountId: 'cash__cashier', direction: 'in', amount: 3, status: 'posted' },
      { id: 'j-late', storeId: L, businessDate: '2026-11-02', sourceType: 'sale', sourceId: 'w', legKey: 'cash:cashier', accountId: 'cash__cashier', direction: 'in', amount: 4, status: 'posted' },
      { id: 'j-padre', storeId: PADRE, businessDate: '2026-10-20', sourceType: 'sale', sourceId: 'p', legKey: 'cash:cashier', accountId: 'cash__cashier', direction: 'in', amount: 9, status: 'posted' },
    ],
    expenses: [
      { id: 'ex1', storeId: L, dayKey: '2026-10-20', totalAmount: 2500, status: 'posted', supplierId: 'S1', expenseEntryId: 'ent-util', expenseEntryGroup: 'OPEX', category: 'Electricity', particulars: 'ZZ-particulars', staffName: 'ZZ-staff-name', payeeName: 'ZZ-payee', localActorName: 'ZZ-actor', createdAt: 1760000000000, notes: 'ZZ-exp-notes',
        payments: [{ method: 'cash', amount: 2500, accountId: 'cashier', staffId: 'ZZ-pay-staff', staffName: 'ZZ-pay-staff-name', notes: 'ZZ-pay-notes', referenceNo: 'ZZ-ref' }] },
    ],
    salesDays: [
      { id: '2026-10-20', storeId: L, status: 'verified', dineInSales: 5000, onlineBreakdown: { gcash: 100 }, creditSales: 0, otherPaymentSales: 0, submittedByName: 'ZZ-submitter', verifiedByUid: 'ZZ-verifier', otherPaymentBreakdown: [{ id: 'o1', note: 'ZZ-other-note', amount: 1 }], flagReason: 'ZZ-flag' },
    ],
    suppliers: [{ id: 'S1', name: 'Alpha Foods Trading', phone: 'ZZ-555-0100', email: 'ZZ@example.test', address: 'ZZ-street', contactPerson: 'ZZ-contact', tin: 'ZZ-tin' }],
    paymentAccounts: [{ id: 'gcash', storeId: L, name: 'GCash Lipa', accountNumber: 'ZZ-0917000000' }],
  });
  const build = (r: Any = raw()): Any => buildSnapshot(r, { from: '2026-10-19', through: '2026-10-25' });

  // [inv 8] Mutant: whole payload kept. The sentinel ZZ- is planted in every forbidden field AND in one field the
  // whitelist has never heard of (a whitelist drops it; a blacklist keeps it).
  it('[inv 8] no staff name, uid, employeeId, staffId, free text, contact or account number survives, nor any unlisted field', () => {
    const text = JSON.stringify(build());
    expect(text).not.toContain('ZZ-');
  });

  it('keeps what the figures need: ids, dates, amounts, polarity, status, groups, payment method and account', () => {
    const s = build();
    const leg = s.journal.find((j: Any) => j.id === 'j1');
    expect(leg).toMatchObject({ storeId: L, businessDate: '2026-10-20', sourceType: 'expense_payment', sourceId: 'ex1', accountId: 'cash__cashier', direction: 'out', amount: 2500, status: 'posted', supplierId: 'S1' });
    expect(s.expenses[0]).toMatchObject({ id: 'ex1', dayKey: '2026-10-20', totalAmount: 2500, status: 'posted', expenseEntryId: 'ent-util', expenseEntryGroup: 'OPEX', category: 'Electricity' });
    expect(s.expenses[0].payments).toEqual([expect.objectContaining({ method: 'cash', amount: 2500, accountId: 'cashier' })]);
    expect(s.salesDays[0]).toMatchObject({ id: '2026-10-20', status: 'verified', dineInSales: 5000, onlineBreakdown: { gcash: 100 } });
    expect(s.suppliers).toEqual([expect.objectContaining({ id: 'S1', name: 'Alpha Foods Trading' })]);
    expect(s.paymentAccounts).toEqual([expect.objectContaining({ id: 'gcash', storeId: L, name: 'GCash Lipa' })]);
  });

  it('the window is [from - 7, through + 7] on date strings, legacy YYYYMMDD included', () => {
    const ids = build().journal.map((j: Any) => j.id).sort();
    expect(ids).toEqual(['j-edge-hi', 'j-edge-lo', 'j1']); // 11 Oct and 2 Nov are out; 12 Oct (legacy form) and 1 Nov are in
  });

  // [inv 7] Mutant: silent exclusion.
  it('[inv 7] Padre Garcia and the test stores are named in excludedStores and their documents are gone', () => {
    const s = build();
    expect(s.stores.map((x: Any) => x.id)).toEqual([L]);
    expect(s.excludedStores.map((x: Any) => x.id).sort()).toEqual(['TEST', PADRE].sort());
    expect(s.excludedStores.find((x: Any) => x.id === PADRE)).toMatchObject({ name: 'SharEat Padre Garcia' });
    expect(s.excludedStores.every((x: Any) => typeof x.reason === 'string' && x.reason.length > 0)).toBe(true);
    expect(s.journal.some((j: Any) => j.storeId === PADRE)).toBe(false);
  });

  it('a store in neither roster is refused, not skipped', () => {
    const r = raw();
    r.stores.push({ id: 'MYSTERY', name: 'Somewhere New' });
    expect(() => build(r)).toThrow(/unknown store/i);
    const r2 = raw();
    r2.journal.push({ ...r2.journal[0], id: 'j-ghost', storeId: 'GHOST' });
    expect(() => build(r2)).toThrow(/unknown store/i);
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe('v1 figures: the fixture week (Lipa, 19-25 Oct 2026)', () => {
  // [inv 1] Mutant: no status filter. Voided: leg ex4 (999 cash out), leg of voided salesDay 24 Oct (6,000 cash in),
  // voided expense ex4 (999 OPEX), voided Davao leg and expense.
  it('[inv 1] a voided leg and a voided expense contribute nothing, in any line', () => {
    const f = fig();
    expect(line(f, L, 'cash_bank', 'cash__cashier')).toMatchObject({ in: c(30000), out: c(2500), amount: c(27500), legs: 5 });
    expect(line(f, L, 'expense_category', 'ent-util')).toMatchObject({ amount: c(2500), group: 'OPEX' }); // not 3,499
    expect(line(f, L, 'sales_tender', 'cash__cashier').amount).toBe(c(30000)); // not 36,000
    expect(f.stores[L].posted.legs).toBe(32); // 34 leg documents are dated in the week; the two voided ones are not posted
  });

  // [inv 2] Mutant: raw direction sign. cash/online IN is a debit; ap__ IN is a CREDIT (the owed side grew).
  it('[inv 2] polarity comes from the account: cash in = debit, ap in = credit, advance in = debit', () => {
    const f = fig();
    expect(line(f, L, 'cash_bank', 'cash__cashier')).toMatchObject({ debit: c(30000), credit: c(2500) });
    expect(line(f, L, 'cash_bank', 'online__gcash')).toMatchObject({ debit: c(21000), credit: c(12000), in: c(21000), out: c(12000), amount: c(9000), legs: 6 });
    expect(line(f, L, 'ap_supplier', 'ap__S1')).toMatchObject({ supplierId: 'S1', in: c(4000), out: c(1500), credit: c(4000), debit: c(1500), amount: c(2500) });
    expect(line(f, L, 'ap_supplier', 'ap__S2')).toMatchObject({ credit: 0, debit: c(500), amount: -c(500) });
    expect(line(f, L, 'ap_supplier', 'ap__S3')).toMatchObject({ credit: c(6000), debit: 0, amount: c(6000) });
    expect(line(f, L, 'ap_supplier', 'supplier_advance__S2')).toMatchObject({ supplierId: 'S2', debit: c(200), credit: 0, amount: c(200) });
  });

  it('the other cash_bank lines: office and staff cash, maya, and per-day movement', () => {
    const f = fig();
    expect(line(f, L, 'cash_bank', 'cash__office')).toMatchObject({ in: 0, out: c(2350), amount: -c(2350), legs: 3 }); // 150 + 1,500 + 700; the 9,000 payroll and 1,100 loan are scope
    expect(line(f, L, 'cash_bank', 'cash__staff')).toMatchObject({ out: c(300), amount: -c(300), legs: 1 }); // the 800 cash-request IN is scope
    expect(line(f, L, 'cash_bank', 'online__maya')).toMatchObject({ in: c(2000), amount: c(2000) });
    const cashier = line(f, L, 'cash_bank', 'cash__cashier');
    expect(cashier.days).toMatchObject({ '2026-10-19': c(5500), '2026-10-20': c(13000), '2026-10-21': c(1500 - 2500), '2026-10-25': c(10000) });
    expect(Object.values(cashier.days).reduce((a: number, b: any) => a + b, 0)).toBe(cashier.amount);
  });

  // [inv 3] Mutants: createdAt-derived date; createdAtMs-derived date.
  it('[inv 3] an expense lands on its dayKey (the receipt date), not on createdAt; a leg on its businessDate', () => {
    const f = fig();
    const util = line(f, L, 'expense_category', 'ent-util');
    expect(util.amount).toBe(c(2500)); // ex1 createdAt is 12 Oct (earlier week) and counts; ex8 createdAt is 20 Oct (inside) and dayKey 26 Oct, so it does NOT
    expect(util.days).toEqual({ '2026-10-21': c(2500) });
    const next = fig(snap(), '2026-10-26');
    expect(line(next, L, 'expense_category', 'ent-util')).toMatchObject({ amount: c(700), days: { '2026-10-26': c(700) } });
  });

  it('[inv 3] a legacy YYYYMMDD businessDate is normalised and lands on its day', () => {
    const cashier = line(fig(), L, 'cash_bank', 'cash__cashier');
    expect(day(cashier, '2026-10-25')).toBe(c(10000)); // leg stored as 20261025
  });

  // [inv 6] Mutant: week computed from a timestamp in UTC. The 25 Oct legs were created 00:30 Manila MONDAY; the 26 Oct
  // leg was created 23:00 Manila SUNDAY; the 18 Oct leg was created 01:00 Manila MONDAY 19 Oct.
  it('[inv 6] businessDate 25 Oct is in the week of 19 Oct and 26 Oct is not, whatever the leg timestamp says', () => {
    const f = fig();
    const cashier = line(f, L, 'cash_bank', 'cash__cashier');
    expect(day(cashier, '2026-10-25')).toBe(c(10000)); // createdAtMs says Monday in Manila
    expect(day(cashier, '2026-10-26')).toBe(0); // createdAtMs says Sunday
    expect(day(cashier, '2026-10-18')).toBe(0); // createdAtMs says Monday 19 Oct in Manila
    expect(cashier.in).toBe(c(30000)); // not 33,000 (18 Oct) and not 35,000 (26 Oct)
    const prev = fig(snap(), '2026-10-12');
    expect(line(prev, L, 'cash_bank', 'cash__cashier')).toMatchObject({ in: c(3000), days: { '2026-10-18': c(3000) } });
  });

  it('[inv 3, 6] no timestamp is read: moving every createdAt / createdAtMs by weeks changes no figure', () => {
    const moved = snap();
    for (const l of moved.journal) if ('createdAtMs' in l) l.createdAtMs += 21 * 86400000;
    for (const e of moved.expenses) e.createdAt -= 40 * 86400000;
    expect(fig(moved)).toEqual(fig());
    const bare = snap();
    for (const l of bare.journal) delete l.createdAtMs;
    for (const e of bare.expenses) delete e.createdAt;
    expect(fig(bare)).toEqual(fig());
  });

  it('a partial week (--through) counts nothing dated after it and reports the through date', () => {
    const f = fig(snap(), WEEK, '2026-10-21');
    expect(f.through).toBe('2026-10-21');
    expect(f.stores[L].tradingDays).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
    expect(line(f, L, 'cash_bank', 'cash__cashier')).toMatchObject({ in: c(20000), out: c(2500) });
    expect(line(f, L, 'expense_category', 'ent-rent')).toMatchObject({ amount: c(6000) });
    expect(line(f, L, 'expense_category', 'ent-equip')).toBeUndefined(); // 24 Oct
  });

  // [inv 4] Mutants: cash read from the unfloored residual; (class rule is S2). 22 Oct: remitted 10,000, online 7,000,
  // credit 3,500, other 0 -> cash leg 0, residual -500.
  it('[inv 4] the cash tender is the floored sale leg; the unfloored residual is computed separately', () => {
    const f = fig();
    const cash = line(f, L, 'sales_tender', 'cash__cashier');
    expect(day(cash, '2026-10-22')).toBe(0); // NOT -50,000
    expect(f.stores[L].cashResidual['2026-10-22']).toBe(-c(500));
    expect(f.stores[L].cashResidual).toEqual({
      '2026-10-19': c(5500), // 10,000 - 3,000 - 1,000 - 500
      '2026-10-20': c(13000), // 20,000 - 7,000
      '2026-10-21': c(1500), // 8,000 - 4,000 - 2,500
      '2026-10-22': -c(500),
      '2026-10-25': c(10000), // 12,000 - 2,000
    });
    expect(day(cash, '2026-10-19')).toBe(c(5500));
    expect(cash.amount).toBe(c(30000));
  });

  it('sales_tender: online per wallet, credit and other from the salesDay, only for counted days', () => {
    const f = fig();
    expect(line(f, L, 'sales_tender', 'online__gcash')).toMatchObject({ amount: c(21000), days: { '2026-10-19': c(3000), '2026-10-20': c(5000), '2026-10-21': c(4000), '2026-10-22': c(7000), '2026-10-25': c(2000) } });
    expect(line(f, L, 'sales_tender', 'online__maya').amount).toBe(c(2000));
    expect(line(f, L, 'sales_tender', 'credit')).toMatchObject({ amount: c(7000), days: { '2026-10-19': c(1000), '2026-10-21': c(2500), '2026-10-22': c(3500) } }); // the submitted day's 700 is not here
    expect(line(f, L, 'sales_tender', 'other')).toMatchObject({ amount: c(500), days: { '2026-10-19': c(500) } });
  });

  // [inv 5] Mutants: submitted counted; partially_remitted dropped. 20 Oct is partially_remitted, 21 Oct remitted,
  // 23 Oct submitted (credit 700, no legs), 24 Oct voided.
  it('[inv 5] submitted is not a sale, partially_remitted and remitted are, voided is not', () => {
    const f = fig();
    expect(f.stores[L].tradingDays).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-25']);
    expect(day(line(f, L, 'sales_tender', 'credit'), '2026-10-23')).toBe(0);
    expect(f.stores[L].cashResidual['2026-10-23']).toBeUndefined();
    expect(f.stores[L].cashResidual['2026-10-24']).toBeUndefined();
    expect(day(line(f, L, 'sales_tender', 'cash__cashier'), '2026-10-20')).toBe(c(13000)); // partially_remitted kept
  });

  it('expense_category: posted OPEX / CAPEX / PERSONAL / OTHERS by entry on dayKey; COGS is the inventory_basis line only', () => {
    const f = fig();
    const cats = f.stores[L].lines.filter((l: Any) => l.kind === 'expense_category');
    expect(cats.map((l: Any) => [l.key, l.group, l.amount]).sort()).toEqual(
      [['ent-equip', 'CAPEX', c(12000)], ['ent-misc', 'OTHERS', c(150)], ['ent-pers', 'PERSONAL', c(300)], ['ent-rent', 'OPEX', c(6000)], ['ent-util', 'OPEX', c(2500)]].sort(),
    );
    expect(cats.some((l: Any) => l.group === 'COGS' || l.key === 'ent-pork')).toBe(false);
    expect(line(f, L, 'inventory_basis', 'COGS')).toMatchObject({ amount: c(4000), days: { '2026-10-20': c(4000) } });
    expect(f.stores[L].lines.filter((l: Any) => l.kind === 'inventory_basis')).toHaveLength(1);
  });

  // [inv 9] Mutant: an unknown sourceType dropped.
  it('[inv 9] every posted leg lands in exactly one line or one named scope class; nothing is dropped', () => {
    const f = fig();
    const s = f.stores[L];
    expect(s.posted).toEqual({ legs: 32, in: c(79400), out: c(33900) });
    const legLines = s.lines.filter((l: Any) => l.kind === 'cash_bank' || l.kind === 'ap_supplier');
    const sum = (k: 'legs' | 'in' | 'out'): number =>
      legLines.reduce((a: number, l: Any) => a + (l[k] ?? 0), 0) + s.scope.reduce((a: number, e: Any) => a + e[k], 0);
    expect(sum('legs')).toBe(s.posted.legs);
    expect(sum('in')).toBe(s.posted.in);
    expect(sum('out')).toBe(s.posted.out);
  });

  it('[inv 9] scope classes are named by sourceType: payroll is PAYROLL_ON_V1, the rest NOT_IN_DUAL_RUN_SCOPE, unknown included', () => {
    const f = fig();
    expect(scopeSum(f, L, 'PAYROLL_ON_V1', 'payroll_payout')).toEqual({ legs: 1, in: 0, out: c(9000) });
    expect(scopeSum(f, L, 'NOT_IN_DUAL_RUN_SCOPE', 'remittance')).toEqual({ legs: 2, in: c(3000), out: c(3000) });
    expect(scopeSum(f, L, 'NOT_IN_DUAL_RUN_SCOPE', 'transfer')).toEqual({ legs: 2, in: c(400), out: c(400) });
    expect(scopeSum(f, L, 'NOT_IN_DUAL_RUN_SCOPE', 'cash_request_release')).toEqual({ legs: 2, in: c(800), out: c(800) });
    expect(scopeSum(f, L, 'NOT_IN_DUAL_RUN_SCOPE', 'salary_advance')).toEqual({ legs: 1, in: 0, out: c(400) });
    expect(scopeSum(f, L, 'NOT_IN_DUAL_RUN_SCOPE', 'loan_payment')).toEqual({ legs: 1, in: 0, out: c(1100) });
    expect(scopeSum(f, L, 'NOT_IN_DUAL_RUN_SCOPE', 'future_thing')).toEqual({ legs: 1, in: 0, out: c(50) }); // a sourceType nobody has heard of
    expect(scopeSum(f, L, 'NOT_IN_DUAL_RUN_SCOPE', 'expense_payment')).toEqual({ legs: 1, in: c(12000), out: 0 }); // the CAPEX asset__A1 leg: in-scope sourceType, off-tie account
  });

  // [inv 7] in the figures: the stray Padre Garcia rows in the fixture must not become a store.
  it('[inv 7] excluded stores are listed by name and never appear as a store with figures', () => {
    const f = fig();
    expect(Object.keys(f.stores).sort()).toEqual([L, M, B, D].sort());
    expect(f.excluded.map((e: Any) => e.id).sort()).toEqual([PADRE, 'TEST', 'XbkyEgZqunmj2wzhicNf'].sort());
    expect(f.excluded.find((e: Any) => e.id === PADRE).name).toBe('SharEat Padre Garcia');
    expect(JSON.stringify(f.stores)).not.toContain('77700');
  });

  it('Malvar, the second store with data, is figured on its own legs only', () => {
    const f = fig();
    expect(f.stores[M].hasData).toBe(true);
    expect(line(f, M, 'cash_bank', 'cash__cashier')).toMatchObject({ in: c(8000), amount: c(8000), legs: 2 });
    expect(line(f, M, 'sales_tender', 'cash__cashier').amount).toBe(c(8000));
    expect(f.stores[M].tradingDays).toEqual(['2026-10-20', '2026-10-22']);
    expect(f.stores[M].lines.some((l: Any) => l.key === 'ent-util')).toBe(false);
  });

  // Day-doc trap: sales-report-draft.actions.ts:68,413 write dineInSales: 0 on some paths. Malvar 22 Oct is verified with
  // dineInSales 0 but a posted sale leg of 3,000. The residual 0 - online - credit - other would be 0 and look like a tie.
  it('[residual] a verified day with dineInSales 0 and non-zero sale legs gets NO residual and the named flag V1_REMITTED_FIELD_ZERO', () => {
    const f = fig();
    expect(f.stores[M].cashResidual['2026-10-22']).toBeUndefined();
    expect(f.stores[M].cashResidual['2026-10-20']).toBe(c(5000));
    expect(f.stores[M].flags).toEqual([expect.objectContaining({ code: 'V1_REMITTED_FIELD_ZERO', date: '2026-10-22' })]);
    expect(f.stores[L].flags).toEqual([]);
    expect(day(line(f, M, 'sales_tender', 'cash__cashier'), '2026-10-22')).toBe(c(3000)); // still a trading day, cash from the legs
    const s = snap();
    s.salesDays.find((d: Any) => d.storeId === M && d.id === '2026-10-22').dineInSales = 3000;
    expect(fig(s).stores[M].cashResidual['2026-10-22']).toBe(c(3000)); // field repaired: residual back, no flag
    expect(fig(s).stores[M].flags).toEqual([]);
  });

  // Unknown group: v1's group is a free string on the expense doc. Dropping it would hide spend; counting it under a tie
  // line would invent a category. Pinned: an expense_category line carrying class 'V1_UNKNOWN_EXPENSE_GROUP' (and the raw
  // group, or null), amount kept. Fixture lines carry no class at all.
  it('an expense in a group outside OPEX/CAPEX/PERSONAL/OTHERS/COGS is kept under the named class V1_UNKNOWN_EXPENSE_GROUP', () => {
    const base = fig();
    expect(base.stores[L].lines.filter((l: Any) => l.class !== undefined)).toEqual([]);
    const s = snap();
    const mk = (id: string, entry: string, group: Any, total: number): Any => ({ id, storeId: L, dayKey: '2026-10-23', totalAmount: total, status: 'posted', supplierId: '', expenseEntryId: entry, expenseEntryGroup: group, category: 'New thing', payments: [] });
    s.expenses.push(mk('exu1', 'ent-new', 'CAPITAL_PROJECTS', 123.45), mk('exu2', 'ent-nogroup', null, 10));
    const f = fig(s);
    expect(line(f, L, 'expense_category', 'ent-new')).toMatchObject({ class: 'V1_UNKNOWN_EXPENSE_GROUP', group: 'CAPITAL_PROJECTS', amount: c(123.45), days: { '2026-10-23': c(123.45) } });
    expect(line(f, L, 'expense_category', 'ent-nogroup')).toMatchObject({ class: 'V1_UNKNOWN_EXPENSE_GROUP', amount: c(10) });
    expect(line(f, L, 'inventory_basis', 'COGS').amount).toBe(c(4000)); // not absorbed into COGS
    expect(line(f, L, 'expense_category', 'ent-util').class).toBeUndefined();
    const voided = s.expenses.find((e: Any) => e.id === 'exu1');
    expect(voided).toBeDefined();
    voided.status = 'voided';
    expect(line(fig(s), L, 'expense_category', 'ent-new')).toBeUndefined(); // a voided one still contributes nothing
  });

  it('order of the input documents changes nothing', () => {
    const shuffled = snap();
    shuffled.journal.reverse();
    shuffled.expenses.reverse();
    shuffled.salesDays.reverse();
    expect(fig(shuffled)).toEqual(fig());
  });

  it('a sub-centavo v1 value is reported by document id, never rounded silently', () => {
    const s = snap();
    s.journal.push({ id: 'sale:odd:cash:cashier', storeId: M, businessDate: '2026-10-21', sourceType: 'sale', sourceId: 'odd', legKey: 'cash:cashier', accountId: 'cash__cashier', direction: 'in', amount: 263.888, status: 'posted' });
    const f = fig(s);
    expect(f.stores[M].warnings).toEqual([expect.objectContaining({ code: 'SUB_CENTAVO', docId: 'sale:odd:cash:cashier', value: 263.888 })]);
    expect(line(f, M, 'cash_bank', 'cash__cashier').in).toBe(800000 + 26389);
    expect(fig().stores[L].warnings).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe('vacuous data: a store-week with no v1 rows has no figures, never zeros that tie', () => {
  it('Banay-Banay (no document at all) is present, hasData false, no lines', () => {
    const s = fig().stores[B];
    expect(s).toMatchObject({ storeId: B, name: 'SharEat Banay-Banay', hasData: false, tradingDays: [], lines: [], scope: [] });
    expect(s.posted).toEqual({ legs: 0, in: 0, out: 0 });
    expect(s.cashResidual).toEqual({});
  });

  // Davao has: a submitted salesDay (credit 100), a voided expense, a voided leg, and one posted payroll leg.
  it('Davao (only a submitted day, voided rows and a payroll leg) has no tie-set figure; the payroll leg is still named', () => {
    const f = fig();
    expect(f.stores[D].hasData).toBe(false);
    expect(f.stores[D].lines).toEqual([]);
    expect(f.stores[D].tradingDays).toEqual([]);
    expect(scopeSum(f, D, 'PAYROLL_ON_V1', 'payroll_payout')).toEqual({ legs: 1, in: 0, out: c(2000) });
    expect(f.stores[D].posted.legs).toBe(1);
  });

  it('a week with rows only in other weeks has no figures either', () => {
    const f = fig(snap(), '2026-11-02');
    for (const id of [L, M, B, D]) expect(f.stores[id]).toMatchObject({ hasData: false, lines: [], tradingDays: [] });
  });

  it('hasData flips true the moment one tie-set figure exists (a lone credit expense)', () => {
    const s = snap();
    s.expenses.push({ id: 'exb', storeId: B, dayKey: '2026-10-21', totalAmount: 90, status: 'posted', supplierId: '', expenseEntryId: 'ent-util', expenseEntryGroup: 'OPEX', category: 'Electricity', payments: [] });
    const f = fig(s);
    expect(f.stores[B].hasData).toBe(true);
    expect(line(f, B, 'expense_category', 'ent-util').amount).toBe(c(90));
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe('v1 restates in place (R8, risk 3)', () => {
  // The leg is EDITED IN PLACE: same id, new amount, original businessDate. Its own week is restated; the week of the
  // later extract is untouched. Mutant (S4 side): delta placed on the extract date.
  it('an edited leg restates the week it is dated in, and only that week', () => {
    const before = snap();
    const after = snap();
    const target = after.journal.find((l: Any) => l.id === 'expense_payment:ex1:cash:cashier');
    expect(target.amount).toBe(2500);
    target.amount = 2750;
    after.extractedAt = '2026-11-09T01:00:00.000Z';
    const w0 = fig(before);
    const w1 = fig(after);
    expect(line(w1, L, 'cash_bank', 'cash__cashier')).toMatchObject({ out: c(2750), amount: c(27250) });
    expect(line(w1, L, 'cash_bank', 'cash__cashier').amount - line(w0, L, 'cash_bank', 'cash__cashier').amount).toBe(-c(250));
    expect(day(line(w1, L, 'cash_bank', 'cash__cashier'), '2026-10-21')).toBe(c(1500 - 2750));
    for (const week of ['2026-10-12', '2026-10-26']) expect(fig(after, week)).toEqual(fig(before, week));
  });

  it('a leg deleted from v1 is simply absent from the next extract', () => {
    const after = snap();
    after.journal = after.journal.filter((l: Any) => l.id !== 'expense_payment:ex1:cash:cashier');
    expect(line(fig(after), L, 'cash_bank', 'cash__cashier')).toMatchObject({ out: 0, legs: 4, amount: c(30000) });
  });

  it('a voided-in-place leg (v1 mutates, no offset) drops out of its own week', () => {
    const after = snap();
    after.journal.find((l: Any) => l.id === 'ap_payment:pay1:ap:S1').status = 'voided';
    expect(line(fig(after), L, 'ap_supplier', 'ap__S1')).toMatchObject({ out: 0, amount: c(4000) });
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe('keys sheet: store / money / category (R7)', () => {
  const v2 = {
    stores: [{ key: 'LIPA', name: 'SharEat Lipa' }, { key: 'MLVR', name: 'SharEat Malvar' }],
    money: [{ key: 'GCASH-LIPA', name: 'GCash Lipa' }, { key: 'MAYA-LIPA-CASHIER', name: 'Maya - Lipa cashier' }],
    categories: [{ key: 'cat-elec', name: 'electricity' }, { key: 'cat-rent', name: 'Rent ' }],
  };
  const rowsOf = (rows: Any[], section: string): Any[] => rows.filter((r) => r.section === section);

  it('pre-fills every v1 key seen, once, without ever ticking', () => {
    const rows = prefillKeys({ snapshot: snap(), existing: [], v2 });
    expect(rows.every((r: Any) => r.ticked === false)).toBe(true);
    expect(rowsOf(rows, 'store').map((r) => r.v1Key).sort()).toEqual([L, M, B, D].sort()); // operating stores only: no Padre Garcia
    const lipaMoney = rowsOf(rows, 'money').filter((r) => r.v1Store === L).map((r) => r.v1Key).sort();
    expect(lipaMoney).toEqual(['cash__cashier', 'cash__office', 'cash__staff', 'online__gcash', 'online__maya']);
    const lipaCat = rowsOf(rows, 'category').filter((r) => r.v1Store === L).map((r) => r.v1Key).sort();
    expect(lipaCat).toEqual(['ent-equip', 'ent-misc', 'ent-pers', 'ent-pork', 'ent-rent', 'ent-util']);
    expect(new Set(rows.map((r: Any) => `${r.section}|${r.v1Store}|${r.v1Key}`)).size).toBe(rows.length);
  });

  it('suggests a v2 key only on an exact normalised-name match, never a near one', () => {
    const rows = prefillKeys({ snapshot: snap(), existing: [], v2 });
    const get = (section: string, store: string, key: string): Any => rows.find((r: Any) => r.section === section && r.v1Store === store && r.v1Key === key);
    expect(get('store', '', L)).toMatchObject({ v2Key: 'LIPA', v1Label: 'SharEat Lipa' });
    expect(get('store', '', B).v2Key).toBe(''); // no v2 store of that name
    expect(get('money', L, 'online__gcash')).toMatchObject({ v2Key: 'GCASH-LIPA', v1Label: 'GCash Lipa' });
    expect(get('money', L, 'online__maya').v2Key).toBe(''); // 'Maya Lipa' is close to 'Maya - Lipa cashier' but not equal
    expect(get('category', L, 'ent-util').v2Key).toBe('cat-elec'); // case-insensitive
    expect(get('category', L, 'ent-rent').v2Key).toBe('cat-rent'); // surrounding space ignored
  });

  it('a re-run keeps every row Ian ticked or corrected, adds new keys, and keeps rows no longer seen', () => {
    const ian = [
      { section: 'store', v1Store: '', v1Key: L, v1Label: 'SharEat Lipa', v2Key: 'LIPA-CORRECTED', ticked: true },
      { section: 'money', v1Store: L, v1Key: 'online__retired', v1Label: 'Old wallet', v2Key: 'GCASH-LIPA', ticked: true },
    ];
    const rows = prefillKeys({ snapshot: snap(), existing: ian as Any, v2 });
    expect(rows.find((r: Any) => r.section === 'store' && r.v1Key === L)).toMatchObject({ v2Key: 'LIPA-CORRECTED', ticked: true });
    expect(rows.find((r: Any) => r.v1Key === 'online__retired')).toMatchObject({ ticked: true, v2Key: 'GCASH-LIPA' });
    expect(rowsOf(rows, 'store').filter((r) => r.v1Key === L)).toHaveLength(1);
    expect(rowsOf(rows, 'store').some((r) => r.v1Key === M)).toBe(true);
  });

  it('csv round-trips, quotes commas and quotes, and accepts the CRLF Excel writes', () => {
    const rows = [
      { section: 'store', v1Store: '', v1Key: L, v1Label: 'Lipa, "Main"', v2Key: 'LIPA', ticked: true },
      { section: 'category', v1Store: L, v1Key: 'ent-x', v1Label: 'Rent', v2Key: '', ticked: false },
    ];
    const text = serialiseKeysCsv(rows as Any);
    expect((text.split('\n')[0] ?? '').replace('\r', '')).toBe('section,v1_store,v1_key,v1_label,v2_key,ticked');
    expect(parseKeysCsv(text)).toEqual(rows);
    expect(parseKeysCsv(text.replace(/\r?\n/g, '\r\n'))).toEqual(rows);
    expect(parseKeysCsv(text).find((r: Any) => r.v1Key === 'ent-x')?.ticked).toBe(false);
  });

  // [inv 10] Mutant: skip. A suggestion that was never ticked, a ticked row with no v2 key, and a ticked money row do not count.
  it('[inv 10] a v1 operating store with no ticked store row is a refusal naming the store, not a skipped store', () => {
    const tick = (id: string, name: string, v2Key = id.slice(0, 4)): Any => ({ section: 'store', v1Store: '', v1Key: id, v1Label: name, v2Key, ticked: true });
    const all = [tick(L, 'SharEat Lipa'), tick(M, 'SharEat Malvar'), tick(B, 'SharEat Banay-Banay'), tick(D, 'SharEat Davao')];
    expect(() => assertStoresTicked(all, [L, M, B, D])).not.toThrow();
    const unticked = all.map((r) => (r.v1Key === B ? { ...r, ticked: false } : r));
    expect(() => assertStoresTicked(unticked, [L, M, B, D])).toThrow(new RegExp(`${B}|Banay-Banay`));
    const noKey = all.map((r) => (r.v1Key === D ? { ...r, v2Key: '' } : r));
    expect(() => assertStoresTicked(noKey, [L, M, B, D])).toThrow(new RegExp(`${D}|Davao`));
    const missing = all.filter((r) => r.v1Key !== M);
    expect(() => assertStoresTicked(missing, [L, M, B, D])).toThrow(new RegExp(`${M}|Malvar`));
    const moneyOnly = [...missing, { section: 'money', v1Store: M, v1Key: 'cash__cashier', v1Label: 'x', v2Key: '1110', ticked: true }];
    expect(() => assertStoresTicked(moneyOnly as Any, [L, M, B, D])).toThrow(new RegExp(`${M}|Malvar`));
  });
});

// ----------------------------------------------------------------------------------------------------------------
describe('store roster comes from the keys sheet, not a built-in list', () => {
  // computeV1Figures(snapshot, { weekStart, through?, keys? }): with `keys` (KeyRow[]) the roster is exactly the ticked
  // `store` rows; each store figure carries `v2Key`. Omitting `keys` keeps the snapshot's own roster (tests above).
  const sheet = (): Any[] => parseKeysCsv(readFileSync(join(__dirname, 'fixtures', 't392-keys.csv'), 'utf8'));
  const withKeys = (rows: Any[], s: Any = snap()): Any => computeV1Figures(s, { weekStart: WEEK, keys: rows } as Any);

  it('the ticked store rows are the roster, and each store carries the v2 code the sheet gave it', () => {
    const f = withKeys(sheet());
    expect(Object.keys(f.stores).sort()).toEqual([L, M, B, D].sort());
    expect(f.stores[L].v2Key).toBe('LIPA');
    expect(f.stores[D].v2Key).toBe('DAVO');
    expect(line(f, L, 'cash_bank', 'cash__cashier')).toMatchObject({ in: c(30000), amount: c(27500) });
    const renamed = sheet().map((r) => (r.section === 'store' && r.v1Key === L ? { ...r, v2Key: 'LIPA-2' } : r));
    expect(withKeys(renamed).stores[L].v2Key).toBe('LIPA-2');
  });

  it('a store in the snapshot with no ticked row (unticked, no v2 key, or absent) is refused by name, never included', () => {
    const unticked = sheet().map((r) => (r.section === 'store' && r.v1Key === B ? { ...r, ticked: false } : r));
    expect(() => withKeys(unticked)).toThrow(new RegExp(`${B}|Banay-Banay`));
    const noKey = sheet().map((r) => (r.section === 'store' && r.v1Key === D ? { ...r, v2Key: '' } : r));
    expect(() => withKeys(noKey)).toThrow(new RegExp(`${D}|Davao`));
    const omitted = sheet().filter((r) => !(r.section === 'store' && r.v1Key === M));
    expect(() => withKeys(omitted)).toThrow(new RegExp(`${M}|Malvar`));
  });

  it('a ticked row for a store the snapshot does not hold, or for an excluded store, is refused, not silently added', () => {
    const extra = [...sheet(), { section: 'store', v1Store: '', v1Key: 'NEWSTORE', v1Label: 'Somewhere New', v2Key: 'NEW', ticked: true }];
    expect(() => withKeys(extra)).toThrow(/unknown store|NEWSTORE/i);
    const padre = [...sheet(), { section: 'store', v1Store: '', v1Key: PADRE, v1Label: 'SharEat Padre Garcia', v2Key: 'PGAR', ticked: true }];
    expect(() => withKeys(padre)).toThrow(/excluded|Padre/i);
  });
});

describe('audit round: bad data is loud, never silently zero', () => {
  const legId = 'expense_payment:ex1:cash:cashier';
  const mutate = (fn: (s: Any) => void): Any => {
    const s = snap();
    fn(s);
    return s;
  };
  const leg = (s: Any, id = legId): Any => s.journal.find((l: Any) => l.id === id);
  const exp = (s: Any, id = 'ex1'): Any => s.expenses.find((e: Any) => e.id === id);
  const sday = (s: Any, store = L, id = '2026-10-19'): Any => s.salesDays.find((d: Any) => d.storeId === store && d.id === id);

  // [audit 1]
  it('[audit 1] a leg amount that is "1,234.50", "₱500", NaN, missing or null throws naming the leg', () => {
    for (const bad of ['1,234.50', '₱500', 'abc', Number.NaN, undefined, null]) {
      const s = mutate((x) => { leg(x).amount = bad; });
      expect(() => fig(s), String(bad)).toThrow(new RegExp(legId));
    }
    const plain = mutate((x) => { leg(x).amount = '2500'; });
    expect(line(fig(plain), L, 'cash_bank', 'cash__cashier').out).toBe(c(2500)); // a plain numeric string is fine
  });

  it('[audit 1] an expense totalAmount that is a currency string, NaN or missing throws naming the expense', () => {
    for (const bad of ['₱2,500', Number.NaN, undefined]) {
      const s = mutate((x) => { exp(x).totalAmount = bad; });
      expect(() => fig(s), String(bad)).toThrow(/ex1/);
    }
  });

  it('[audit 1] a salesDay tender (dineInSales, credit, other, an online wallet) that is unparseable throws naming the day', () => {
    for (const [field, bad] of [['dineInSales', '10,000'], ['dineInSales', Number.NaN], ['dineInSales', undefined], ['creditSales', '₱1000'], ['otherPaymentSales', Number.NaN]] as Array<[string, Any]>) {
      const s = mutate((x) => { sday(x)[field] = bad; });
      expect(() => fig(s), `${field}=${String(bad)}`).toThrow(/2026-10-19/);
    }
    const wallet = mutate((x) => { sday(x).onlineBreakdown.gcash = '3,000'; });
    expect(() => fig(wallet)).toThrow(/2026-10-19/);
    const nulls = mutate((x) => { sday(x).creditSales = null; delete sday(x).otherPaymentSales; });
    expect(() => fig(nulls)).not.toThrow(); // credit / other are optional in v1 and mean 0 when null or absent
  });

  // [audit 2]
  it('[audit 2] an unknown direction or an unknown leg / expense / salesDay status throws; it is not dropped as if voided', () => {
    expect(() => fig(mutate((x) => { leg(x).direction = 'sideways'; }))).toThrow(new RegExp(legId));
    expect(() => fig(mutate((x) => { leg(x).status = 'pending'; }))).toThrow(new RegExp(legId));
    expect(() => fig(mutate((x) => { exp(x).status = 'archived'; }))).toThrow(/ex1/);
    expect(() => fig(mutate((x) => { sday(x).status = 'weird'; }))).toThrow(/2026-10-19/);
    for (const known of ['open', 'submitted', 'verified', 'partially_remitted', 'remitted', 'voided']) {
      expect(() => fig(mutate((x) => { sday(x).status = known; })), known).not.toThrow();
    }
  });

  it('[audit 2] voided documents are excluded from every figure but counted separately, per store', () => {
    const f = fig();
    expect(f.stores[L].voided).toEqual({ legs: 2, expenses: 1, salesDays: 1 }); // sale leg 24 Oct, ex4 leg; ex4; salesDay 24 Oct
    expect(f.stores[D].voided).toEqual({ legs: 1, expenses: 1, salesDays: 0 });
    expect(f.stores[B].voided).toEqual({ legs: 0, expenses: 0, salesDays: 0 });
    expect(f.stores[M].voided).toEqual({ legs: 0, expenses: 0, salesDays: 0 });
  });

  // [audit 5]
  it('[audit 5] dineInSales 0 with any non-zero online / credit / other tender is flagged even with no sale legs', () => {
    for (const patch of [{ creditSales: 500 }, { otherPaymentSales: 50 }, { onlineBreakdown: { gcash: 100 } }]) {
      const s = mutate((x) => {
        x.salesDays.push({ id: '2026-10-21', storeId: B, status: 'verified', dineInSales: 0, onlineBreakdown: {}, creditSales: 0, otherPaymentSales: 0, ...patch });
      });
      const f = fig(s);
      expect(f.stores[B].flags, JSON.stringify(patch)).toEqual([expect.objectContaining({ code: 'V1_REMITTED_FIELD_ZERO', date: '2026-10-21' })]);
      expect(f.stores[B].cashResidual['2026-10-21']).toBeUndefined();
    }
    const zeroDay = mutate((x) => {
      x.salesDays.push({ id: '2026-10-21', storeId: B, status: 'verified', dineInSales: 0, onlineBreakdown: {}, creditSales: 0, otherPaymentSales: 0 });
    });
    expect(fig(zeroDay).stores[B].flags).toEqual([]); // a genuinely empty day is not suspicious
    expect(fig(zeroDay).stores[B].cashResidual['2026-10-21']).toBe(0);
  });

  // [audit 7]
  it('[audit 7] a store-week with trading days or residuals but no lines still has hasData true', () => {
    const s = mutate((x) => {
      x.salesDays.push({ id: '2026-10-21', storeId: B, status: 'verified', dineInSales: 1000, onlineBreakdown: {}, creditSales: 0, otherPaymentSales: 0 });
    });
    const st = fig(s).stores[B];
    expect(st.tradingDays).toEqual(['2026-10-21']);
    expect(st.cashResidual['2026-10-21']).toBe(c(1000));
    expect(st.hasData).toBe(true);
    const flagged = mutate((x) => {
      x.salesDays.push({ id: '2026-10-21', storeId: B, status: 'verified', dineInSales: 0, onlineBreakdown: {}, creditSales: 500, otherPaymentSales: 0 });
    });
    expect(fig(flagged).stores[B].hasData).toBe(true); // flagged day: trading day, no residual
  });

  // [audit 6]
  it('[audit 6] one expenseEntryId under two groups is not merged: keyed group:entryId and flagged', () => {
    const s = mutate((x) => {
      x.expenses.push({ id: 'exc1', storeId: L, dayKey: '2026-10-23', totalAmount: 40, status: 'posted', supplierId: '', expenseEntryId: 'ent-util', expenseEntryGroup: 'CAPEX', category: 'Electricity', payments: [] });
      x.expenses.push({ id: 'exc2', storeId: L, dayKey: '2026-10-23', totalAmount: 15, status: 'posted', supplierId: '', expenseEntryId: 'ent-pork', expenseEntryGroup: 'OPEX', category: 'Pork', payments: [] });
    });
    const f = fig(s);
    expect(line(f, L, 'expense_category', 'ent-util')).toBeUndefined();
    expect(line(f, L, 'expense_category', 'OPEX:ent-util')).toMatchObject({ amount: c(2500), group: 'OPEX' });
    expect(line(f, L, 'expense_category', 'CAPEX:ent-util')).toMatchObject({ amount: c(40), group: 'CAPEX' });
    expect(line(f, L, 'expense_category', 'OPEX:ent-pork')).toMatchObject({ amount: c(15) });
    expect(line(f, L, 'inventory_basis', 'COGS').amount).toBe(c(4000)); // the COGS half stays the policy line
    expect(f.stores[L].flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'V1_EXPENSE_ENTRY_GROUP_CONFLICT', entryId: 'ent-util' }),
      expect.objectContaining({ code: 'V1_EXPENSE_ENTRY_GROUP_CONFLICT', entryId: 'ent-pork' }),
    ]));
    expect(line(f, L, 'expense_category', 'ent-rent')).toMatchObject({ amount: c(6000) }); // non-conflicting entries keep their plain key
  });

  it('[audit 6] an empty expenseEntryId under several groups is not merged either', () => {
    const s = mutate((x) => {
      for (const [id, group, total] of [['exe1', 'OPEX', 11], ['exe2', 'CAPEX', 22]] as Array<[string, string, number]>) {
        x.expenses.push({ id, storeId: L, dayKey: '2026-10-23', totalAmount: total, status: 'posted', supplierId: '', expenseEntryId: '', expenseEntryGroup: group, category: '', payments: [] });
      }
    });
    const f = fig(s);
    expect(line(f, L, 'expense_category', 'OPEX:')).toMatchObject({ amount: c(11) });
    expect(line(f, L, 'expense_category', 'CAPEX:')).toMatchObject({ amount: c(22) });
    expect(f.stores[L].flags).toContainEqual(expect.objectContaining({ code: 'V1_EXPENSE_ENTRY_GROUP_CONFLICT', entryId: '' }));
  });
});

describe('audit round: snapshot privacy and pruning', () => {
  const staff = 'ZZ-STAFF-9';
  const staff2 = 'ZZ-STAFF-8';
  const rawLeg = (id: string, accountId: string, legKey: string, extra: Any = {}): Any => ({ id, storeId: L, businessDate: '2026-10-21', sourceType: 'expense_payment', sourceId: 'ex1', legKey, accountId, direction: 'in', amount: 50, status: 'posted', ...extra });
  const rawBase = (): Any => ({
    stores: [{ id: L, name: 'SharEat Lipa' }],
    journal: [
      rawLeg(`expense_payment:ex1:reimbursable:${staff}:0`, `staff_reimbursable__${staff}`, `reimbursable:${staff}:0`),
      rawLeg(`expense_payment:ex2:reimbursable:${staff}:1`, `staff_reimbursable__${staff}`, `reimbursable:${staff}:1`, { sourceId: 'ex2' }),
      rawLeg(`expense_payment:ex3:reimbursable:${staff2}:0`, `staff_reimbursable__${staff2}`, `reimbursable:${staff2}:0`, { sourceId: 'ex3' }),
      rawLeg('sa:advance', `staff_advance__${staff}`, 'advance', { sourceType: 'salary_advance', sourceId: `sa-${staff}` }),
      rawLeg('ap-leg', 'ap__S2', 'ap:S2', { sourceType: 'expense_payment', sourceId: 'ex4' }),
      rawLeg('wallet-leg', 'online__gcash', 'online:gcash', { sourceType: 'sale', sourceId: '2026-10-21', direction: 'in' }),
      rawLeg('far-leg', 'ap__S7', 'ap:S7', { businessDate: '2026-11-02', supplierId: 'S7' }),
    ],
    expenses: [{ id: 'ex5', storeId: L, dayKey: '2026-10-22', totalAmount: 10, status: 'posted', supplierId: 'S3', expenseEntryId: 'ent-util', expenseEntryGroup: 'OPEX', category: 'Electricity', subCategory: 'ZZ-sub-text', payments: [{ method: 'online', amount: 10, accountId: 'bank1' }] }],
    salesDays: [{ id: '2026-10-21', storeId: L, status: 'verified', dineInSales: 100, onlineBreakdown: { maya: 20 }, creditSales: 0, otherPaymentSales: 0 }],
    suppliers: ['S1', 'S2', 'S3', 'S7', 'S9'].map((id) => ({ id, name: `Supplier ${id}` })),
    paymentAccounts: ['gcash', 'maya', 'bank1', 'wallet-old'].map((id) => ({ id, storeId: L, name: `Account ${id}` })),
  });
  const build = (r: Any = rawBase()): Any => buildSnapshot(r, { from: '2026-10-19', through: '2026-10-25' });

  // [audit 3]
  it('[audit 3] no raw staff id survives in any field, id, legKey, sourceId or account id; the redaction is stable per person', () => {
    const s = build();
    const text = JSON.stringify(s);
    expect(text).not.toContain(staff);
    expect(text).not.toContain(staff2);
    const accounts = s.journal.filter((l: Any) => /^staff_/.test(l.accountId)).map((l: Any) => l.accountId);
    expect(accounts).toHaveLength(4);
    expect(accounts.every((a: string) => /^staff_(reimbursable|advance)__[0-9a-f]{8,}$/.test(a))).toBe(true);
    const byLeg = (id: string): Any => s.journal.find((l: Any) => l.sourceId === id && l.accountId.startsWith('staff_reimbursable'));
    expect(byLeg('ex1').accountId).toBe(byLeg('ex2').accountId); // same staff, same token
    expect(byLeg('ex1').accountId).not.toBe(byLeg('ex3').accountId); // another staff, another token
    expect(s.journal.find((l: Any) => l.accountId.startsWith('staff_advance')).accountId.split('__')[1]).toBe(byLeg('ex1').accountId.split('__')[1]);
    expect(s.journal).toHaveLength(6); // redacted, not dropped (far-leg is outside the window)
  });

  it('[audit 3] the redacted legs still count: they land in scope and the conservation holds, with no staff id in any key', () => {
    const f = computeV1Figures(build(), { weekStart: WEEK });
    const st = f.stores[L] as Any;
    expect(JSON.stringify(f)).not.toContain(staff);
    expect(st.posted.legs).toBe(6);
    const legLines = st.lines.filter((l: Any) => l.kind === 'cash_bank' || l.kind === 'ap_supplier');
    const total = legLines.reduce((a: number, l: Any) => a + (l.legs ?? 0), 0) + st.scope.reduce((a: number, e: Any) => a + e.legs, 0);
    expect(total).toBe(6);
  });

  // [audit 4]
  it('[audit 4] only suppliers and payment accounts referenced by in-window documents are kept, with their names', () => {
    const s = build();
    expect(s.suppliers.map((x: Any) => x.id).sort()).toEqual(['S2', 'S3']); // S2 via an ap__ account, S3 via an expense; S7 only via an out-of-window leg
    expect(s.suppliers.find((x: Any) => x.id === 'S2')).toMatchObject({ name: 'Supplier S2' });
    expect(s.paymentAccounts.map((x: Any) => x.id).sort()).toEqual(['bank1', 'gcash', 'maya']); // wallet-leg, expense payment, salesDay breakdown; not wallet-old
    expect(s.paymentAccounts.find((x: Any) => x.id === 'bank1')).toMatchObject({ name: 'Account bank1', storeId: L });
    expect(JSON.stringify(s)).not.toContain('ZZ-sub-text');
    expect(s.expenses[0]).not.toHaveProperty('subCategory');
  });
});

describe('wiring', () => {
  it('the dual-run barrel exports the public surface and packages/etl/src/index.ts re-exports it', () => {
    for (const name of ['addDays', 'weekStartOf', 'datesInWeek', 'normaliseBusinessDate', 'manilaDateOf', 'buildSnapshot', 'computeV1Figures', 'parseKeysCsv', 'serialiseKeysCsv', 'prefillKeys', 'assertStoresTicked']) {
      expect(typeof (barrel as Any)[name]).toBe('function');
    }
    const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(index).toMatch(/export \* from '\.\/dual-run';/);
  });
});
