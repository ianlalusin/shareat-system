import { center, columnsFor, justify, printAmount, rule, wrap } from './layout';
import { TEST_LINE } from './receipt-text';
import type { OfflineXSlipView, PrintLayout, ReadingSlipView, ZSlipView } from './types';

/**
 * T-531 R6 - the X-reading and the Z-reading as plain text, one string per paper line. Cash control, not a BIR document (bible row 390).
 *
 * NOTHING HERE IS COMPUTED. Every figure arrives already worked out (`readingFor`) and prints exactly as given, even one that does not add up: a slip that
 * silently corrected a figure would be worse than a wrong one. A discount row of zero is not printed; the to-check and late counts print only when above zero.
 */

/** Append `text` wrapped at the print width, each wrapped line centred. */
function pushCentered(out: string[], text: string, cols: number): void {
  const trimmed = text.trim();
  if (!trimmed) {
    out.push('');
    return;
  }
  for (const line of wrap(trimmed, cols)) out.push(center(line, cols));
}

const isZeroAmount = (value: string): boolean => /^-?0(\.0+)?$/.test(value.trim());
const FOOTER = 'Cash control, not a BIR document';

/** The store header and the blank line under it. */
function pushHeader(out: string[], view: Pick<ReadingSlipView, 'header'>, cols: number): void {
  pushCentered(out, view.header.businessName.toUpperCase(), cols);
  for (const address of view.header.addressLines) pushCentered(out, address, cols);
  if (view.header.tin !== null) pushCentered(out, `TIN: ${view.header.tin} ${view.header.vatRegistered ? 'VAT' : 'Non-VAT'}`, cols);
  out.push('');
  if (view.header.test) pushCentered(out, TEST_LINE, cols);
}

/** From / to, "Spans two dates", who printed it; the Z adds who approved it. */
function pushWindow(out: string[], view: ReadingSlipView, cols: number, approvedBy: string | null): void {
  out.push(...justify('FROM:', view.windowFromLocal, cols));
  out.push(...justify('TO:', view.windowToLocal, cols));
  if (view.spansTwoDates) pushCentered(out, 'Spans two dates', cols);
  out.push(...justify('PRINTED BY:', view.printedBy, cols));
  if (approvedBy !== null) out.push(...justify('APPROVED BY:', approvedBy, cols));
}

/** The same figures on an X and a Z: the totals, the unli / a la carte split, the people, the tenders and the counts to look at. */
function pushFigures(out: string[], view: ReadingSlipView, cols: number): void {
  out.push(rule(cols));
  out.push(...justify('RECEIPTS', String(view.receiptCount), cols));
  out.push(...justify('SUBTOTAL', printAmount(view.subtotal), cols));
  if (!isZeroAmount(view.discounts.senior)) out.push(...justify('SENIOR DISCOUNT', `-${printAmount(view.discounts.senior)}`, cols));
  if (!isZeroAmount(view.discounts.pwd)) out.push(...justify('PWD DISCOUNT', `-${printAmount(view.discounts.pwd)}`, cols));
  if (!isZeroAmount(view.discounts.other)) out.push(...justify('OTHER DISCOUNT', `-${printAmount(view.discounts.other)}`, cols));
  if (!isZeroAmount(view.discountTotal)) out.push(...justify('TOTAL DISCOUNTS', `-${printAmount(view.discountTotal)}`, cols));
  if (view.chargeTotal !== undefined && !isZeroAmount(view.chargeTotal)) out.push(...justify('CHARGES', `+${printAmount(view.chargeTotal)}`, cols));
  out.push(...justify('GROSS TOTAL', printAmount(view.grossTotal), cols));
  out.push(rule(cols));
  out.push(...justify('UNLI SALES', printAmount(view.unliSales), cols));
  out.push(...justify('A LA CARTE SALES', printAmount(view.alaCarteSales), cols));
  out.push(...justify('HEADS', String(view.heads), cols));
  out.push(...justify('PACKAGE SESSIONS', String(view.packageSessions), cols));
  out.push(...justify('SENIOR/PWD DINERS', String(view.seniorPwdDiners), cols));
  out.push(rule(cols));
  for (const tender of view.tenders) out.push(...justify(tender.name, printAmount(tender.amount), cols));
  if (view.convert && view.convert.count > 0) {
    out.push(...justify('CONVERT: CASH IN', printAmount(view.convert.cashIn), cols));
    out.push(...justify('CONVERT: CASH OUT', printAmount(view.convert.cashOut), cols));
  }
  if (view.refunds && view.refunds.count > 0) out.push(...justify('REFUNDS', `-${printAmount(view.refunds.total)}`, cols));
  // T-628: reservation deposits. Taken and refunded moved cash or wallet money the day they happened; applied is a tender of the bills above (it is not in the method rows); kept moved nothing.
  if (view.deposits) {
    if (!isZeroAmount(view.deposits.taken)) out.push(...justify('DEPOSITS TAKEN', printAmount(view.deposits.taken), cols));
    if (!isZeroAmount(view.deposits.refunded)) out.push(...justify('DEPOSITS REFUNDED', `-${printAmount(view.deposits.refunded)}`, cols));
    if (!isZeroAmount(view.deposits.kept)) out.push(...justify('DEPOSITS KEPT', printAmount(view.deposits.kept), cols));
    if (!isZeroAmount(view.deposits.applied)) out.push(...justify('DEPOSITS APPLIED', printAmount(view.deposits.applied), cols));
    // the drawer's own part: a deposit that came in (or went back) by GCash is in the lines above but not in the drawer
    if (view.deposits.cashTaken !== undefined && !isZeroAmount(view.deposits.cashTaken)) out.push(...justify('DEPOSITS CASH IN', printAmount(view.deposits.cashTaken), cols));
    if (view.deposits.cashReturned !== undefined && !isZeroAmount(view.deposits.cashReturned)) out.push(...justify('DEPOSITS CASH OUT', `-${printAmount(view.deposits.cashReturned)}`, cols));
  }
  if (view.varianceTotal !== undefined && !isZeroAmount(view.varianceTotal)) out.push(...justify('SHORT PAYMENTS', printAmount(view.varianceTotal), cols));
  if ((view.shortfallCount ?? 0) > 0) out.push(...justify('SHORT PAY FINDINGS', String(view.shortfallCount), cols));
  if (view.toCheckCount > 0) out.push(...justify('TO CHECK (wallet)', String(view.toCheckCount), cols));
  if (view.lateCount > 0) out.push(...justify('LATE RECEIPTS', String(view.lateCount), cols));
  out.push(rule(cols));
  pushCentered(out, FOOTER, cols);
}

/** The X-reading: the open window so far. It writes and closes nothing, and the paper says so. */
export function formatXSlip(view: ReadingSlipView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];
  pushHeader(out, view, cols);
  pushCentered(out, 'X-READING', cols);
  pushCentered(out, 'Reading so far - the day is NOT closed', cols);
  pushWindow(out, view, cols, null);
  pushFigures(out, view, cols);
  return out;
}

/** The Z-reading: the window just closed, with its number (`Z-0001`), its business date and who approved it. A reprint says REPRINT under the header. */
export function formatZSlip(view: ZSlipView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];
  pushHeader(out, view, cols);
  if (view.reprint) pushCentered(out, 'REPRINT', cols);
  pushCentered(out, 'Z-READING', cols);
  out.push(...justify('Z NO:', `Z-${String(view.zNo).padStart(4, '0')}`, cols));
  out.push(...justify('BUSINESS DATE:', view.businessDateLocal, cols));
  pushWindow(out, view, cols, view.approvedBy);
  pushFigures(out, view, cols);
  return out;
}

/**
 * T-621 S4: the offline X-slip, printed every N hours while the till has no internet. Same widths and layout as `formatXSlip`. Built from the tablet's own
 * outbox, so the paper says plainly it is not a BIR reading. Nothing is computed: the tenders and the short-paid line add up to the total because the
 * caller made them so (`offlineXSlipFigures`).
 */
export function formatOfflineXSlip(view: OfflineXSlipView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];
  pushHeader(out, view, cols);
  pushCentered(out, 'OFFLINE X-SLIP - not a BIR reading', cols);
  pushCentered(out, "From this tablet's own unsent sales", cols);
  out.push(...justify('TERMINAL:', String(view.terminalNo), cols));
  out.push(...justify('OFFLINE SINCE:', view.offlineSinceLocal, cols));
  out.push(...justify('PRINTED AT:', view.printedAtLocal, cols));
  out.push(rule(cols));
  out.push(...justify('SALES', String(view.saleCount), cols));
  out.push(...justify('TOTAL', printAmount(view.total), cols));
  out.push(rule(cols));
  for (const tender of view.tenders) out.push(...justify(tender.name, printAmount(tender.amount), cols));
  if (!isZeroAmount(view.shortPaid)) out.push(...justify('SHORT PAID', printAmount(view.shortPaid), cols));
  out.push(rule(cols));
  out.push(...justify('WAITING TO SEND', String(view.waitingCount), cols));
  out.push(rule(cols));
  pushCentered(out, FOOTER, cols);
  return out;
}
