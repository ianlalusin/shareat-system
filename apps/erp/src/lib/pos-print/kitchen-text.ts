import { center, columnsFor, justify, rule, wrap } from './layout';
import type { KitchenTicketView, PrintLayout, RefillSlipView } from './types';

/**
 * T-528a — the kitchen ticket and the refill slip, as plain text.
 *
 * These are PREP INSTRUCTIONS, not receipts: no prices, no totals, no store header. A cook reads
 * them across a hot room, so the station is the biggest thing on the paper and the quantities are
 * the second (v1's `kitchenTicketFormatter.ts` made the same choice).
 */

/** Append `text` wrapped at the print width, indented. */
function pushWrapped(out: string[], text: string, cols: number, indent = 0): void {
  const width = Math.max(1, cols - indent);
  for (const line of wrap(text, width)) out.push(' '.repeat(indent) + line);
}

/** Append `text` wrapped, each line centred. */
function pushCentered(out: string[], text: string, cols: number): void {
  const trimmed = text.trim();
  if (!trimmed) {
    out.push('');
    return;
  }
  for (const line of wrap(trimmed, cols)) out.push(center(line, cols));
}

export function formatKitchenTicket(view: KitchenTicketView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];

  pushCentered(out, view.stationName.toUpperCase(), cols);
  if (view.offline) pushCentered(out, 'OFFLINE', cols);

  // A take-out ticket has no stand, and printing an empty `TABLE:` would read as a table number the
  // cook cannot find, so the absence is stated instead.
  if (view.tableLabel === null) out.push(...wrap('TAKE-OUT', cols));
  else out.push(...justify('TABLE:', view.tableLabel, cols));
  out.push(...justify('TICKET:', view.ticketNo, cols));
  out.push(...justify('TIME:', view.sentAtLocal, cols));

  out.push(rule(cols));
  for (const item of view.items) {
    pushWrapped(out, `${item.qty} x ${item.name}`, cols);
    if (item.note !== null) pushWrapped(out, `* ${item.note}`, cols, 2);
  }

  return out;
}

export function formatRefillSlip(view: RefillSlipView, layout: PrintLayout): string[] {
  const cols = columnsFor(layout);
  const out: string[] = [];

  pushCentered(out, 'REFILL', cols);
  if (view.offline) pushCentered(out, 'OFFLINE', cols);

  out.push(...justify('TABLE:', view.tableLabel, cols));
  out.push(...justify('TIME:', view.sentAtLocal, cols));

  out.push(rule(cols));
  for (const item of view.items) pushWrapped(out, `${item.qty} x ${item.name}`, cols);

  return out;
}
