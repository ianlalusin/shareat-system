/**
 * T-471 S3 - the Z / X reading slip text (Ruling 7). Pure: no firebase, no React. Same widths (58 mm = 32, 80 mm = 48 characters) and the same two-column
 * rule as the X-slip. Every number is printed from the ZReading the server computed, so the slip and the stored Z can never disagree.
 * Times are Manila time, written explicitly (the tablet's own zone is never consulted).
 */
import type { ZReading, ZWindow } from '@/lib/cash/z-reading';
import { formatCentavos } from '@/lib/money/format';
import { XSLIP_HEADER } from '@/lib/printing/xSlipFormatter';

export const ZSLIP_HEADER = 'Z-READING — cash control, not a BIR document';
export const ZSLIP_FOOTER = "The ERP's sales day still follows midnight until the shared database (P2).";

const pad2 = (n: number) => String(n).padStart(2, '0');
function manilaStamp(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > width) {
      if (line) { out.push(line); line = ''; }
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

export function formatZSlip(i: {
  kind: 'X' | 'Z';
  storeName: string;
  zNo: string | null;
  window: ZWindow;
  reading: ZReading;
  printedBy: string;
  approvedBy: string | null;
  widthMm?: 58 | 80;
}): string {
  const width = (i.widthMm ?? 80) === 58 ? 32 : 48;
  const r = i.reading;
  const hr = '-'.repeat(width);
  const two = (left: string, right: string) => {
    const room = Math.max(1, width - right.length - 1);
    return `${left.length > room ? left.slice(0, room) : left.padEnd(room)} ${right}`;
  };
  const m = (c: number) => formatCentavos(c);
  const lines: string[] = [...wrap(i.kind === 'Z' ? ZSLIP_HEADER : XSLIP_HEADER, width), hr, ...wrap(i.storeName, width)];
  lines.push(...wrap(i.kind === 'Z' ? `Z number: ${i.zNo ?? '-'}` : 'Reading so far - the day is NOT closed', width));
  lines.push(`From: ${manilaStamp(i.window.fromMs)}`, `To:   ${manilaStamp(i.window.toMs)}`);
  if (i.window.spansTwoDates) lines.push(...wrap(`Spans two dates: ${i.window.fromDate} to ${i.window.toDate}`, width));
  lines.push(hr, `Receipts: ${r.receiptCount}`);
  lines.push(two('Gross sales', m(r.grossCentavos)), two('Charges', m(r.chargesCentavos)), two('Discounts', m(r.discounts.ordinaryCentavos)));
  lines.push(two(`Senior/PWD (${r.discounts.seniorPwd.dinerCount} diners)`, m(r.discounts.seniorPwd.centavos)));
  lines.push(two(`Refunds (${r.refunds.count})`, m(r.refunds.centavos)), two(`Voided sales (${r.voids.count})`, m(r.voids.centavos)));
  lines.push(hr, 'BY PAYMENT METHOD');
  for (const l of r.byMethod) {
    lines.push(...wrap(l.method || '(no method)', width), two('  Sale', m(l.saleCentavos)), two('  Refund', m(l.refundCentavos)), two('  Convert', m(l.convertCentavos)), two('  Net', m(l.netCentavos)));
  }
  lines.push(two('Total sales', m(r.totals.saleCentavos)), two('Total refunds', m(r.totals.refundCentavos)), two('Net', m(r.totals.netCentavos)));
  lines.push(hr, 'CASH IN THE DRAWER');
  lines.push(two('Starting cash', m(r.cash.startingCentavos)), two('Cash sales', m(r.cash.salesCentavos - r.cash.voidCashKeptCentavos)), two('Cash kept on voided sales', m(r.cash.voidCashKeptCentavos)), two('Convert net', m(r.cash.convertNetCentavos)),
    ...(r.cash.manualAdjustmentCentavos === undefined ? [] : [two('Manual adjustments', m(r.cash.manualAdjustmentCentavos))]),
    two('Less deductions', m(r.cash.deductionsCentavos)), two('Less cash refunds', m(r.cash.refundsPaidCentavos)), two('Expected cash', m(r.cash.expectedCentavos)));
  if (r.lastHandover) lines.push(two('Counted at handover', m(r.lastHandover.countedCentavos)), two('Variance', m(r.lastHandover.varianceCentavos)));
  if (r.lateReceiptNumbers.length) {
    lines.push(hr, 'LATE FROM AN EARLIER DAY');
    for (const n of r.lateReceiptNumbers) lines.push(...wrap(n, width));
  }
  if (r.negativeMethods.length) lines.push(hr, ...wrap(`BELOW ZERO: ${r.negativeMethods.join(', ')}`, width));
  lines.push(hr, ...wrap(`Printed by: ${i.printedBy}`, width));
  if (i.kind === 'Z' && i.approvedBy) lines.push(...wrap(`Approved by: ${i.approvedBy}`, width));
  lines.push(hr, ...wrap(ZSLIP_FOOTER, width));
  return lines.join('\n');
}
