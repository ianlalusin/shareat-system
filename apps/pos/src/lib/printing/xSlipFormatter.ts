/**
 * T-425 S5 - the X-slip text (Ruling 7; ADR A4.5): a cash-control reading the tablet prints every 4 hours of an offline period and on demand.
 * It is NOT a BIR document (the header says so). Pure: no firebase, no React. Every number comes from the sale LEDGER only, so the slip
 * and the ledger can never disagree.
 */
import type { LedgerEvent } from '@/lib/outbox/ledger';
import { formatCentavos } from '@/lib/money/format';

export const XSLIP_HEADER = 'X-READING — cash control, not a BIR document';

export interface XSlipSummary {
  receiptCount: number;
  firstReceiptNumber: string | null;
  lastReceiptNumber: string | null;
  grossCentavos: number;
  totalsByTender: Record<string, { centavos: number; toCheck: boolean }>;
  unpaidVoids: number;
  unsentTotalCentavos: number;
}

/** Statuses of a sale that really happened on this tablet (skipped = no money, rejected = refused, reserved = not yet known). */
const COUNTED: LedgerEvent['status'][] = ['unsent', 'acknowledged', 'stuck', 'quarantined'];

export function summarizeXSlip(events: LedgerEvent[], periodStartMs: number, periodEndMs: number): XSlipSummary {
  const inPeriod = (e: LedgerEvent) => e.createdAtClientMs >= periodStartMs && e.createdAtClientMs <= periodEndMs;
  const sales = events
    .filter((e) => e.kind === 'sale' && inPeriod(e) && COUNTED.includes(e.status))
    .sort((a, b) => a.terminalSeq - b.terminalSeq || (a.deviceId < b.deviceId ? -1 : 1));
  const totalsByTender: XSlipSummary['totalsByTender'] = {};
  for (const e of sales) {
    for (const t of e.tenders) {
      const cur = totalsByTender[t.method] ?? { centavos: 0, toCheck: false };
      totalsByTender[t.method] = { centavos: cur.centavos + t.centavos, toCheck: cur.toCheck || t.toCheck };
    }
  }
  return {
    receiptCount: sales.length,
    firstReceiptNumber: sales[0]?.receiptNumber ?? null,
    lastReceiptNumber: sales[sales.length - 1]?.receiptNumber ?? null,
    grossCentavos: sales.reduce((n, e) => n + e.totalCentavos, 0),
    totalsByTender,
    unpaidVoids: events.filter((e) => e.kind === 'void' && inPeriod(e) && e.status !== 'skipped').length,
    unsentTotalCentavos: events.filter((e) => e.kind === 'sale' && (e.status === 'unsent' || e.status === 'stuck')).reduce((n, e) => n + e.totalCentavos, 0),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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

export function formatXSlip(i: {
  storeName: string;
  terminalNo: number;
  periodStartMs: number;
  periodEndMs: number;
  events: LedgerEvent[];
  widthMm?: 58 | 80;
}): string {
  const width = (i.widthMm ?? 80) === 58 ? 32 : 48;
  const s = summarizeXSlip(i.events, i.periodStartMs, i.periodEndMs);
  const hr = '-'.repeat(width);
  const two = (left: string, right: string) => {
    const room = Math.max(1, width - right.length - 1);
    return `${left.length > room ? left.slice(0, room) : left.padEnd(room)} ${right}`;
  };
  const lines: string[] = [...wrap(XSLIP_HEADER, width), hr, ...wrap(i.storeName, width)];
  lines.push(`Terminal: ${i.terminalNo}`, `From: ${stamp(i.periodStartMs)}`, `To:   ${stamp(i.periodEndMs)}`, hr);
  lines.push(`Receipts: ${s.receiptCount}`, `First: ${s.firstReceiptNumber ?? '-'}`, `Last:  ${s.lastReceiptNumber ?? '-'}`, hr);
  let tendered = 0;
  for (const [method, t] of Object.entries(s.totalsByTender)) {
    tendered += t.centavos;
    lines.push(two(t.toCheck ? `${method} TO CHECK` : method, formatCentavos(t.centavos)));
  }
  lines.push(two('Sales total', formatCentavos(s.grossCentavos)));
  // Tenders are what customers handed over; anything above the sales total was given back as change.
  if (tendered > s.grossCentavos) lines.push(two('Change given', formatCentavos(tendered - s.grossCentavos)));
  lines.push(hr, `Unpaid voids: ${s.unpaidVoids}`, `Unsent total: ${formatCentavos(s.unsentTotalCentavos)}`, hr);
  lines.push(...wrap('Not a tax receipt. Hand to the manager with the cash drawer count.', width));
  return lines.join('\n');
}
