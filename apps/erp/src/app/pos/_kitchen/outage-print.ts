/**
 * T-529 R3 - the outage backstop. While the store tablet is OFFLINE, an order sent to the kitchen also goes out on paper: one kitchen ticket per station (only
 * stations whose `printOnOutage` is true in the snapshot) and one slip per refill. While ONLINE nothing prints: the kitchen screen is the source of truth.
 * The device store, the printer and the menu are injected, so this is plain logic with no browser in it. A print failure never loses the order (it is
 * already saved): the paper comes back as a job the screen offers to Reprint.
 */
import { formatKitchenTicket, formatRefillSlip } from '@/lib/pos-print';
import type { KitchenTicketView, PrintLayout } from '@/lib/pos-print';
import { asStoreMenu, type MenuLike } from '../_orders/menu-filter';

export const KITCHEN_TICKET_SEQ_KEY = 'app.kitchenTicketSeq';
/** The ticket label when the till number is unknown: an honest blank, never `K-0-…`. */
export const NO_TICKET_NO = 'K-—';
/** The ticket for a line with no station, or a station this tablet does not know: no station means no rule to skip it, so it always prints. */
export const CATCH_ALL_STATION = 'Kitchen';
export const UNKNOWN_ITEM = 'Unknown item';
export const PRINT_FAILED_NOTE = 'Kitchen ticket did not print. Tap Reprint.';

export interface PrintJob {
  lines: string[];
  copies: number;
}
export interface OutageResult {
  printed: number;
  failed: PrintJob[];
  message: string | null;
}
type Printer = (lines: string[], o: { copies: number }) => Promise<'printed' | 'fallback' | 'failed'>;
type MetaGet = <T>(key: string) => Promise<T | null>;
type MetaSet = <T>(key: string, value: T) => Promise<void>;
export interface OutageDeps {
  online: boolean;
  menu: MenuLike;
  stands: { id: string; number: number }[];
  /** Null when the cached snapshot does not carry the till number yet: the ticket then prints `K-—` and uses no counter. */
  terminalNo: number | null;
  layout: PrintLayout;
  copies: number;
  /** Already formatted by the caller. */
  sentAtLocal: string;
  /** The label of a table that is ALREADY open, by session id: a `lines.added` payload only carries the session id. */
  tableLabels: Record<string, string | null>;
  printLines: Printer;
  getMeta: MetaGet;
  setMeta: MetaSet;
}

// Calls that overlap (two events in one tick) must not read the same counter: they queue here, and each writes its number back before the next reads.
let counterQueue: Promise<unknown> = Promise.resolve();

/** `K-<terminal>-<n>`: a print reference kept on the device, never sent to the server. The number is written BEFORE it is returned, so a crash cannot reuse it. */
export function nextKitchenTicketNo(d: { terminalNo: number; getMeta: MetaGet; setMeta: MetaSet }): Promise<string> {
  const run = counterQueue.then(async () => {
    const next = ((await d.getMeta<number>(KITCHEN_TICKET_SEQ_KEY)) ?? 0) + 1;
    await d.setMeta(KITCHEN_TICKET_SEQ_KEY, next);
    return `K-${d.terminalNo}-${next}`;
  });
  counterQueue = run.catch(() => undefined);
  return run;
}

interface EventLine {
  menuItemId?: unknown;
  variantId?: unknown;
  qty?: unknown;
  note?: unknown;
  optionValueIds?: unknown;
}

/** The name the server stores on the line (domain `addLines`): the item, then its size, then the chosen options. The note travels apart. */
function lineName(menu: ReturnType<typeof asStoreMenu>, l: EventLine): { name: string; stationId: string | null } {
  const item = menu.items.find((i) => i.id === l.menuItemId);
  if (!item) return { name: UNKNOWN_ITEM, stationId: null }; // an order is never dropped because this tablet's menu is older than the order
  const variant = item.variants.find((v) => v.id === l.variantId) ?? item.variants.find((v) => v.isDefault) ?? item.variants[0];
  const chosen = new Set(Array.isArray(l.optionValueIds) ? (l.optionValueIds as string[]) : []);
  const options = (variant?.optionGroups ?? []).flatMap((g) => g.values.filter((v) => chosen.has(v.id)).map((v) => v.name));
  return { name: `${item.name}${variant?.label ? ` - ${variant.label}` : ''}${options.length ? ` + ${options.join(', ')}` : ''}`, stationId: item.stationId };
}

async function send(printLines: Printer, job: PrintJob, tally: OutageResult): Promise<void> {
  let outcome: 'printed' | 'fallback' | 'failed';
  try {
    outcome = await printLines(job.lines, { copies: job.copies });
  } catch {
    outcome = 'failed';
  }
  if (outcome === 'failed') tally.failed.push(job);
  else tally.printed += 1;
}

const settle = (t: OutageResult): OutageResult => ({ ...t, message: t.failed.length > 0 ? PRINT_FAILED_NOTE : null });

export async function printOutageForEvent(deps: OutageDeps, event: { kind: string; payload: Record<string, unknown> }): Promise<OutageResult> {
  const tally: OutageResult = { printed: 0, failed: [], message: null };
  if (deps.online) return tally;
  const p = event.payload as { sessionId?: unknown; standId?: unknown; mode?: unknown; lines?: unknown };
  const lines = (Array.isArray(p.lines) ? p.lines : []) as EventLine[];
  const menu = asStoreMenu(deps.menu);

  if (event.kind === 'refill.requested') {
    const items = lines.flatMap((l) => {
      const n = lineName(menu, l);
      return typeof l.qty === 'number' ? [{ name: n.name, qty: l.qty }] : [];
    });
    if (items.length === 0) return tally;
    const label = (typeof p.sessionId === 'string' ? deps.tableLabels[p.sessionId] : null) ?? '-';
    await send(deps.printLines, { lines: formatRefillSlip({ tableLabel: label, sentAtLocal: deps.sentAtLocal, items, offline: true }, deps.layout), copies: deps.copies }, tally);
    return settle(tally);
  }

  if (event.kind !== 'stand.opened' && event.kind !== 'lines.added') return tally;
  const tableLabel =
    event.kind === 'stand.opened'
      ? p.mode === 'take_out' || typeof p.standId !== 'string'
        ? null
        : String(deps.stands.find((s) => s.id === p.standId)?.number ?? '-')
      : ((typeof p.sessionId === 'string' ? deps.tableLabels[p.sessionId] : null) ?? null);
  const known = new Set(menu.stations.map((s) => s.id));
  const byStation = new Map<string | null, KitchenTicketView['items']>();
  for (const l of lines) {
    const n = lineName(menu, l);
    if (typeof l.qty !== 'number') continue;
    const key = n.stationId !== null && known.has(n.stationId) ? n.stationId : null;
    byStation.set(key, [...(byStation.get(key) ?? []), { name: n.name, qty: l.qty, note: typeof l.note === 'string' && l.note !== '' ? l.note : null }]);
  }
  // The stations in menu order (only those that print on an outage), then the catch-all for lines with no known station, which always prints.
  const tickets = [...menu.stations.filter((s) => s.printOnOutage).map((s) => ({ key: s.id as string | null, name: s.name })), { key: null, name: CATCH_ALL_STATION }];
  for (const t of tickets) {
    const items = byStation.get(t.key);
    if (!items) continue;
    const ticketNo = deps.terminalNo === null ? NO_TICKET_NO : await nextKitchenTicketNo({ ...deps, terminalNo: deps.terminalNo });
    await send(deps.printLines, { lines: formatKitchenTicket({ stationName: t.name, tableLabel, ticketNo, sentAtLocal: deps.sentAtLocal, items, offline: true }, deps.layout), copies: deps.copies }, tally);
  }
  return settle(tally);
}

/** Prints the same paper again. It uses no ticket number: the number is in the lines already. */
export async function reprintOutage(deps: { printLines: Printer }, jobs: PrintJob[]): Promise<OutageResult> {
  const tally: OutageResult = { printed: 0, failed: [], message: null };
  for (const job of jobs) await send(deps.printLines, job, tally);
  return settle(tally);
}
