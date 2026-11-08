/**
 * T-511 S7a (TESTER) - the world the approve-day tests run in (NOT a test file). It builds on the S5 world (read-only: Lipa/Malvar/Banay-banay, a Grab and a Foodpanda
 * channel each with the REAL platform codes, an admin, a manager per store, loans through the real domain, a destination account) and adds:
 *  - Oct and Nov 2026 OPEN, plus two more managers of Lipa (so "a different manager of the same store" and "the manager who uploaded the other file" exist),
 *  - sales days that are created, submitted and verified through the REAL domain, so they carry the journal entry (1220 / 4150) approve corrects,
 *  - controllable Grab files (a Transactions + Transfers pair for ONE day) and Foodpanda invoices (any days, any fees, an unrecognised Appendix B charge): bytes only, then
 *    staged through the REAL `ingestSettlementFile`,
 *  - thin wrappers for the functions under test (loaded through the barrel as a namespace, so a missing export is "is not a function" in one test, not an import crash),
 *  - read-backs on the raw connection.
 */
import type postgres from 'postgres';
import type { Actor } from '@shareat/auth';
import type { Tx } from '@shareat/db';
import * as D from '@shareat/domain';
import { seedExpenseCategories } from '../../../../db/seed/expense-categories';
import { ingestSettlementFile } from '../../../src/settlement-intake/ingest';
import { GRAB_TRANSACTION_HEADERS } from '../../../src/settlement-intake/grab-transactions';
import { GRAB_TRANSFER_HEADERS } from '../../../src/settlement-intake/grab-transfers';
import { linesOf } from './t511-s6b-world';
import { LIPA_FP, LIPA_GRAB_ID, asOrg, lineOn, mkLoan, setDestination, world3, type World3 } from './t511-s5-world';
import { mkSubmitter, submitThenVerify } from './sales-day-flow';
import { day as isoDay, fp34Order, fpChargeRow, fpWorkbook, toCsv, zipBytes } from '../../unit/t511-s3-helpers';

export * from './t511-s5-world';
export { corrections, entriesOf, linesOf, lineText, netDebit, sentenceOf } from './t511-s6b-world';
export { links as chargeLinks } from './t511-s6c-world';

/** The Foodpanda week (Mon 12 to Wed 14 Oct) and the Grab day of worked example 1. */
export const D1 = '2026-10-12';
export const D2 = '2026-10-13';
export const D3 = '2026-10-14';
export const GRAB_DAY = '2026-10-15';
/** The first open date when October is closed and November is open. */
export const NEXT_OPEN = '2026-11-01';

export interface S7World extends World3 {
  /** two more managers of Lipa: neither uploads anything unless a test says so */
  managerA2: Actor;
  managerA3: Actor;
  submitter: Actor;
}

let seq = 0;
const tag = (p: string): string => `${p}-${Date.now()}-${++seq}`;

/**
 * Oct and Nov 2026 open. `loanPeriods` (default true) keeps the S5 world's May and September periods so a loan can be drawn; a test that closes October after the
 * day is posted passes false (an open period may not start before a closed one), and uses a Foodpanda day, which needs no loan.
 */
export async function s7World(sql: postgres.Sql, hint: string, o: { loanPeriods?: boolean } = {}): Promise<S7World> {
  const w = await world3(sql, `s7a-${hint}`, { periods: o.loanPeriods !== false });
  await seedExpenseCategories(sql, w.orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${w.orgId}, '2026-10-01', '2026-10-31', 'open'), (${w.orgId}, '2026-11-01', '2026-11-30', 'open')`;
  const manager = async (name: string): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'manager')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.storeA})`;
    return { personId: p!.id, orgId: w.orgId };
  };
  const submitter = await mkSubmitter(sql, w.orgId, [w.storeA], 'Submitter');
  return { ...w, managerA2: await manager('Manager A2'), managerA3: await manager('Manager A3'), submitter };
}

/** A sales day of Lipa for one channel, created, submitted and VERIFIED through the real domain (so it carries its journal entry: Dr 1220 / Cr 4150). Returns its id. */
export async function postedDay(w: S7World, channelId: string, date: string, amount: string): Promise<string> {
  const d = await asOrg(w.orgId, (tx) =>
    D.createSalesDay(tx, w.submitter, {
      storeId: w.storeA, businessDate: date, totalSales: amount, unliSales: '0.00', alaCarteSales: amount, cashCollected: '0.00', channels: [{ channelId, amount }],
    }),
  );
  await asOrg(w.orgId, (tx) => submitThenVerify(tx, w.admin, d.id, w.submitter));
  return d.id;
}

/* ------------------------------------------------------------------ file bytes */

export type File = { bytes: Buffer; contentType: string };

export const ingest = (w: S7World, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));

export interface FpDay {
  date: string;
  /** column K and R: the order value (net of the platform discount) */
  gross: number;
  /** column Y: the commission, the only fee of the day (so staged commission = fees and the net is gross - fees) */
  fees: number;
}
export interface FpOptions {
  invoice?: string;
  /** a charge of Appendix B under a category the system does not know: it stays a period charge (booked by its own action) */
  periodChargeNet?: number;
  /** makes the bytes (and so the fingerprint) unique */
  tag?: string;
}

/** A Foodpanda zip for Lipa's real vendor code: one order per day, commission = `fees`, nothing else deducted, balance = gross - fees. */
export function fpInvoice(days: FpDay[], o: FpOptions = {}): Buffer {
  const invoice = o.invoice ?? '200777000001';
  const t = o.tag ?? tag('fp');
  const orders = days.map((d, i) =>
    fp34Order(`${LIPA_FP.toLowerCase()}-${String(i).padStart(4, '0')}-${t}`, { 7: isoDay(d.date), 10: d.gross, 17: d.gross, 19: 0, 22: d.gross, 24: d.fees, 29: 0, 33: Number((d.gross - d.fees).toFixed(2)) }, invoice, LIPA_FP),
  );
  const charge = o.periodChargeNet === undefined ? [] : [fpChargeRow('Admin Adjustment Fee', 'Admin Adjustment Fee', o.periodChargeNet, '12%', LIPA_FP.toLowerCase())];
  for (const c of charge) c[1] = invoice;
  const book = fpWorkbook({ orderRows: orders, chargeRows: charge });
  return zipBytes([
    { name: '20261015_200999999999.xls', data: book },
    { name: '20261015_200999999999.pdf', data: Buffer.from(`%PDF-1.4 stub ${t}`) },
  ]);
}
export const zip = (b: Buffer): File => ({ bytes: b, contentType: 'application/zip' });

export interface GrabFigures {
  settlementId?: string;
  salesDate?: string;
  orderValue: string;
  /** a magnitude: written as the negative Channel Commission of the payment row */
  commission: string;
  /** a magnitude: a Withholding Tax Remittance adjustment row (staged as the platform fee) */
  platformFee?: string;
  /** a magnitude: one Loan Deduction row */
  loan?: string;
  /** the Transfers file's Net Total (must equal the rows' total or the day is flagged unexplained) */
  net: string;
  tag?: string;
}

const money2 = (cents: bigint): string => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
const cents = (t: string): bigint => BigInt(t.replace('.', ''));

/** A Grab Transactions + Transfers pair for ONE day of Lipa (the real Store ID), built from the real headers. The payout is dated the day after the sales day. */
export function grabPair(f: GrabFigures): { settlementId: string; transactions: File; transfers: File } {
  const t = f.tag ?? tag('g');
  const settlementId = f.settlementId ?? `SPH${t.replace(/[^0-9]/g, '').slice(-9).padStart(9, '0')}`;
  const day = f.salesDate ?? GRAB_DAY;
  const [yy, mm, dd] = day.split('-').map(Number) as [number, number, number];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const printed = (d: number, time: string): string => `${d} ${MONTHS[mm - 1]} ${yy} ${time}`;
  const txHeaders = [...GRAB_TRANSACTION_HEADERS] as string[];
  const row = (over: Record<string, string>): string[] => {
    const r = txHeaders.map(() => '');
    const put = (h: string, v: string): void => void (r[txHeaders.indexOf(h)] = v);
    put('Store Name', 'SharEat Lipa - San Carlos');
    put('Store ID', LIPA_GRAB_ID);
    put('Updated On', printed(dd, '11:00 PM'));
    put('Created On', printed(dd, '12:30 PM'));
    put('Status', 'Completed');
    put('Settlement ID', settlementId);
    for (const [h, v] of Object.entries(over)) put(h, v);
    return r;
  };
  const rows: string[][] = [
    row({ Type: 'GrabFood', Category: 'Payment ', Amount: f.orderValue, 'Discount (Merchant-Funded)': '0', 'Net Sales': f.orderValue, 'Channel Commission': `-${f.commission}`, Total: money2(cents(f.orderValue) - cents(f.commission)) }),
  ];
  if (f.platformFee) {
    rows.push(row({ Type: 'GrabFood', Category: 'Adjustment ', Subcategory: 'Withholding Tax Remittance (non-taxable)', Total: `-${f.platformFee}`, Description: 'Withholding Tax on Gross Remittance' }));
  }
  if (f.loan) rows.push(row({ Type: 'GrabFinance', Category: 'Loans', Subcategory: 'Loan Deduction', Total: `-${f.loan}` }));
  const transactions = toCsv({ headers: txHeaders, rows }, { bom: true });
  const trHeaders = [...GRAB_TRANSFER_HEADERS] as string[];
  const tr = trHeaders.map(() => '');
  const putT = (h: string, v: string): void => void (tr[trHeaders.indexOf(h)] = v);
  putT('Date', printed(dd + 1, '1:48 AM'));
  putT('Store Name', 'SharEat Lipa - San Carlos');
  putT('Store ID', LIPA_GRAB_ID);
  putT('Settlement ID', settlementId);
  putT('Net Total', f.net);
  putT('Status', 'Completed');
  putT('Transfer Date', printed(dd + 1, '2:47 PM'));
  putT('Bank Statement Code', '0000000000');
  putT('Bank Name', 'BANK REDACTED');
  putT('Bank Account', '0000');
  const transfers = toCsv({ headers: trHeaders, rows: [tr] }, { bom: true });
  return { settlementId, transactions: { bytes: transactions, contentType: 'text/csv' }, transfers: { bytes: transfers, contentType: 'text/csv' } };
}

/** Stages a Grab pair through the real ingest: the Transactions file by `txBy`, the Transfers file by `trBy` (the payout upload). */
export async function stageGrab(w: S7World, f: GrabFigures, txBy: Actor, trBy: Actor = txBy): Promise<string> {
  const p = grabPair(f);
  await ingest(w, txBy, p.transactions);
  await ingest(w, trBy, p.transfers);
  return p.settlementId;
}

/* ------------------------------------------------------------------ worlds of the two worked examples */

/**
 * Worked example 1: Lipa Grab, staff recorded 10,000.00 on 15 Oct, the file says 11,000.00, commission 2,200.00, platform fee 100.00, one loan leg of 500.00,
 * payout 8,200.00 (= 11,000 - 2,300 - 500). One loan of Lipa expecting 500.00 a day, a destination account, the day staged through the real ingest.
 * `staff` and `loan` can be changed for the variants (no loan recorded gives a loan_leg_problem day).
 */
export async function grabWorld(
  sql: postgres.Sql,
  hint: string,
  o: { staff?: string | null; txBy?: 'managerA' | 'managerA2' | 'admin'; trBy?: 'managerA' | 'managerA2' | 'admin'; loan?: boolean; destination?: boolean; loanPeriods?: boolean } = {},
) {
  const w = await s7World(sql, hint, { loanPeriods: o.loanPeriods });
  const loanId = o.loan === false ? null : await D_mkLoan(sql, w);
  if (o.destination !== false) await setDestination(sql, w, w.grabA);
  const dayId = o.staff === null ? null : await postedDay(w, w.grabA, GRAB_DAY, o.staff ?? '10000.00');
  const settlementId = await stageGrab(w, { orderValue: '11000.00', commission: '2200.00', platformFee: '100.00', loan: '500.00', net: '8200.00' }, w[o.txBy ?? 'managerA'], w[o.trBy ?? o.txBy ?? 'managerA']);
  const line = await lineOn(sql, w.orgId, w.grabA, GRAB_DAY);
  return { w, loanId, dayId, payoutId: settlementId, lineId: line.id, line };
}
const D_mkLoan = (sql: postgres.Sql, w: S7World): Promise<string> =>
  mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan', startDate: '2026-05-11', principal: '200000.00', repayment: '500.00' });

export interface FpWeek {
  w: S7World;
  /** the three staged lines of 12, 13 and 14 Oct, by date */
  lines: Record<string, string>;
  /** the unrecognised charge's staged line id, when the invoice carries one */
  chargeLineId: string | null;
}

/**
 * Worked example 2: Lipa Foodpanda, invoice 200777000001, D1 12 Oct gross 9,000 (fees 1,800, net 7,200), D2 13 Oct 8,000 (1,600, 6,400), D3 14 Oct 10,000 (2,000, 8,000);
 * staff recorded exactly the file figure each day (so no correction). `charge` adds Appendix B's unrecognised charge of net 100.00 (+12% VAT = 112.00), staged as a period
 * charge. The spec's D3 fee of 2,000 "including the weekly platform fee" is staged here as plain commission: the settlement arithmetic cannot tell them apart.
 */
export async function fpWeek(
  sql: postgres.Sql,
  hint: string,
  o: { charge?: boolean; destination?: boolean; staff?: [string, string, string]; loanPeriods?: boolean } = {},
): Promise<FpWeek> {
  const w = await s7World(sql, hint, { loanPeriods: o.loanPeriods });
  if (o.destination !== false) await setDestination(sql, w, w.fpA);
  const staff = o.staff ?? ['9000.00', '8000.00', '10000.00'];
  for (const [i, d] of [D1, D2, D3].entries()) if (staff[i] !== '') await postedDay(w, w.fpA, d, staff[i]!);
  await ingest(
    w,
    w.managerA,
    zip(fpInvoice([{ date: D1, gross: 9000, fees: 1800 }, { date: D2, gross: 8000, fees: 1600 }, { date: D3, gross: 10000, fees: 2000 }], o.charge ? { periodChargeNet: 100 } : {})),
  );
  const lines: Record<string, string> = {};
  for (const d of [D1, D2, D3]) lines[d] = (await lineOn(sql, w.orgId, w.fpA, d)).id;
  const [c] = await sql<{ id: string }[]>`
    select ol.id::text as id from settlement_other_lines ol join settlement_uploads u on u.id = ol.upload_id
     where u.org_id = ${w.orgId} and ol.kind = 'period_charge' and ol.day_line_id is null order by ol.id limit 1`;
  return { w, lines, chargeLineId: c?.id ?? null };
}

/**
 * An entry as money per account: the lines of one account and side are added up (the settlement posts commission and platform fee as two 6400 lines; the worked examples
 * speak of one 6400 amount), a net-zero account is left out, sorted. 'Dr 6400 2300.00' / 'Cr 1220 11000.00'.
 */
export async function aggText(sql: postgres.Sql, entryId: string): Promise<string[]> {
  const sum = new Map<string, bigint>();
  for (const l of await linesOf(sql, entryId)) {
    const c = (t: string): bigint => BigInt(t.replace('.', ''));
    sum.set(l.code, (sum.get(l.code) ?? 0n) + c(l.debit) - c(l.credit));
  }
  const text = (n: bigint): string => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
  return [...sum.entries()].filter(([, n]) => n !== 0n).map(([code, n]) => (n > 0n ? `Dr ${code} ${text(n)}` : `Cr ${code} ${text(-n)}`)).sort();
}

/** The id of Lipa's current Foodpanda line on one date (after an ingest). */
export const stageFpOne = async (sql: postgres.Sql, w: S7World, date: string): Promise<string | undefined> => (await lineOn(sql, w.orgId, w.fpA, date))?.id;

/* ------------------------------------------------------------------ the functions under test */

export interface ApproveResult {
  settlementId: string;
  correctionId: string | null;
  chargeIds: string[];
  postedOn: string;
}
type ApproveFn = (tx: Tx, actor: Actor, input: { lineId: string; differenceReason?: string; confirmedDifference?: string }) => Promise<ApproveResult>;
const approveFn = (): ApproveFn => (D as unknown as { approveDay: ApproveFn }).approveDay;

export const approve = (w: { orgId: string }, who: Actor, lineId: string, differenceReason?: string, confirmedDifference?: string): Promise<ApproveResult> =>
  asOrg(w.orgId, (tx) =>
    approveFn()(tx, who, { lineId, ...(differenceReason === undefined ? {} : { differenceReason }), ...(confirmedDifference === undefined ? {} : { confirmedDifference }) }),
  );

/** The blockers of a line as the screen reads them (the same function approve calls). */
export const blockersOf = (w: { orgId: string }, who: Actor, lineId: string, today?: string) =>
  asOrg(w.orgId, async (tx) => {
    const { settlementIntakeRepo } = await import('@shareat/db');
    const line = await settlementIntakeRepo.dayLineById(tx, w.orgId, lineId);
    const r = await D.dayBlockers(tx, who, line!, today === undefined ? {} : { today });
    // `code` is widened to string: the new codes do not exist in the union until the builder adds them
    return { ...r, blockers: r.blockers.map((b) => ({ code: b.code as string, sentence: b.sentence })) };
  });

export const postCharge = (w: { orgId: string }, who: Actor, otherLineId: string): Promise<{ posted: boolean; chargeId?: string; journalEntryId?: string }> =>
  asOrg(w.orgId, (tx) => D.postPlatformCharge(tx, who, { otherLineId }));

/* ------------------------------------------------------------------ read-backs (raw connection) */

export interface SettlementFull {
  id: string; status: string; gross_amount: string; outstanding_cleared: string; net_deposited: string; variance: string; settlement_gain: string; difference_reason: string | null;
  reference: string | null; settled_on: string; journal_entry_id: string | null; loan_deduction: string; commission: string; platform_fee: string; channel_id: string;
}
export const settlementFull = async (sql: postgres.Sql, id: string): Promise<SettlementFull> =>
  (
    await sql<SettlementFull[]>`
      select id::text, status, gross_amount::text, outstanding_cleared::text, net_deposited::text, variance::text, settlement_gain::text, difference_reason, reference,
             to_char(settled_on, 'YYYY-MM-DD') as settled_on, journal_entry_id::text, loan_deduction::text, commission::text, platform_fee::text, channel_id::text
        from channel_settlements where id = ${id}`
  )[0]!;
export const settlementsOf = (sql: postgres.Sql, orgId: string) =>
  sql<{ id: string }[]>`select id::text from channel_settlements where org_id = ${orgId} order by created_at, id`;
export const entryCount = async (sql: postgres.Sql, orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId}`)[0]!.n;
export const correctionCount = async (sql: postgres.Sql, orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sales_day_platform_corrections where org_id = ${orgId}`)[0]!.n;
export const entryOf = async (sql: postgres.Sql, entryId: string): Promise<{ entry_date: string; source_type: string; status: string }> =>
  (await sql<{ entry_date: string; source_type: string; status: string }[]>`select to_char(entry_date, 'YYYY-MM-DD') as entry_date, source_type, status from journal_entries where id = ${entryId}`)[0]!;
export const correctionEntryId = async (sql: postgres.Sql, correctionId: string): Promise<string> =>
  (await sql<{ id: string }[]>`select journal_entry_id::text as id from sales_day_platform_corrections where id = ${correctionId}`)[0]!.id;

export interface LineFull {
  id: string; review_state: string; decided_by: string | null; decided_at: Date | null; settlement_id: string | null; is_current: boolean; source_upload_id: string; payout_upload_id: string | null;
}
export const lineFull = async (sql: postgres.Sql, id: string): Promise<LineFull> =>
  (
    await sql<LineFull[]>`
      select id::text, review_state, decided_by::text, decided_at, settlement_id::text, is_current, source_upload_id::text, payout_upload_id::text from settlement_day_lines where id = ${id}`
  )[0]!;

/** Every string leaf of a JSON value (an audit payload), to look for ids without knowing the key names. */
export function leaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out);
  return out;
}
