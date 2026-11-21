/**
 * T-621 S4 - the offline X-slip: what it counts and when it prints. Pure, except `checkOfflineXSlip`, which takes its storage and printer as arguments.
 *
 * WHAT. Only the tablet's own outbox (the server's reading is out of reach offline): every queued `sale.completed`, its bill total (`device.total`) and its
 * payments, in exact centavos. Change given is taken off the largest cash payment of that sale (the server's own rule for change), so the tenders show the
 * money kept; a bill paid short shows as SHORT PAID. Tenders + short paid = total, always.
 *
 * WHEN. After N hours offline (`pos.offline_xslip_hours`), and again every N hours while still offline: once per period. Everything it must remember lives
 * in the device meta store (`app.offlineXSlip`): when this offline stretch began and the last period printed. So a reload neither reprints nor restarts
 * the clock. Going online clears it.
 */
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import type { PosEvent } from '@/lib/pos-device';
import type { OfflineXSlipView, ReceiptHeader } from '@/lib/pos-print/types';

export const OFFLINE_XSLIP_META_KEY = 'app.offlineXSlip';
const HOUR_MS = 3_600_000;

export interface OfflineXSlipFigures {
  saleCount: number;
  totalCentavos: bigint;
  tenders: { name: string; centavos: bigint }[];
  shortPaidCentavos: bigint;
}

const cents = (v: unknown): bigint | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  try {
    return toCentavos(money(String(v)));
  } catch {
    return null;
  }
};

/** The slip's figures from the outbox. `tenders` is the snapshot's tender list (order and names); a tender it does not know prints as `OTHER TENDER`. */
export function offlineXSlipFigures(events: readonly PosEvent[], tenders: readonly { id: string; name: string; kind: string }[]): OfflineXSlipFigures {
  const byId = new Map<string, bigint>();
  let saleCount = 0;
  let totalCentavos = 0n;
  let shortPaidCentavos = 0n;
  for (const e of events) {
    if (e.kind !== 'sale.completed') continue;
    const total = cents((e.payload.device as { total?: unknown } | undefined)?.total);
    if (total === null) continue;
    saleCount += 1;
    totalCentavos += total;
    const rows = (Array.isArray(e.payload.payments) ? (e.payload.payments as { tenderId?: unknown; amount?: unknown }[]) : [])
      .map((p) => ({ tenderId: typeof p.tenderId === 'string' ? p.tenderId : '', amount: cents(p.amount) ?? 0n }))
      .filter((r) => r.amount > 0n);
    const paid = rows.reduce((s, r) => s + r.amount, 0n);
    if (paid > total) {
      // Change comes out of the largest cash row (completeSale's rule); with no cash row, out of the largest row.
      const isCash = (id: string) => tenders.find((t) => t.id === id)?.kind === 'cash';
      const pool = rows.some((r) => isCash(r.tenderId)) ? rows.filter((r) => isCash(r.tenderId)) : rows;
      const biggest = pool.reduce((a, b) => (b.amount > a.amount ? b : a));
      biggest.amount -= paid - total;
    } else {
      shortPaidCentavos += total - paid;
    }
    for (const r of rows) byId.set(r.tenderId, (byId.get(r.tenderId) ?? 0n) + r.amount);
  }
  const known = tenders.flatMap((t) => {
    const c = byId.get(t.id);
    return c === undefined ? [] : [{ name: t.name, centavos: c }];
  });
  const unknown = [...byId.entries()].filter(([id]) => !tenders.some((t) => t.id === id)).reduce((s, [, c]) => s + c, 0n);
  return { saleCount, totalCentavos, tenders: unknown !== 0n ? [...known, { name: 'OTHER TENDER', centavos: unknown }] : known, shortPaidCentavos };
}

/** The paper view: figures as Money, header and times as given. */
export function offlineXSlipView(f: OfflineXSlipFigures, ctx: { header: ReceiptHeader; terminalNo: number; offlineSinceLocal: string; printedAtLocal: string; waitingCount: number }): OfflineXSlipView {
  return {
    header: ctx.header,
    terminalNo: ctx.terminalNo,
    offlineSinceLocal: ctx.offlineSinceLocal,
    printedAtLocal: ctx.printedAtLocal,
    saleCount: f.saleCount,
    total: fromCentavos(f.totalCentavos),
    tenders: f.tenders.map((t) => ({ name: t.name, amount: fromCentavos(t.centavos) })),
    shortPaid: fromCentavos(f.shortPaidCentavos),
    waitingCount: ctx.waitingCount,
  };
}

/** What the meta store keeps for one offline stretch. */
export interface OfflineXSlipMeta {
  sinceMs: number;
  printedPeriod: number;
}

/**
 * One check. `meta` is what was stored (null: a new offline stretch, which starts at `offlineSinceMs`). Period k is [since + kN h, since + (k+1)N h);
 * period 1 and up print once each. A tablet asleep through several periods prints once, for the current one.
 */
export function offlineXSlipStep(i: { meta: OfflineXSlipMeta | null; offlineSinceMs: number; nowMs: number; hours: number }): { meta: OfflineXSlipMeta; print: boolean } {
  const meta = i.meta ?? { sinceMs: i.offlineSinceMs, printedPeriod: 0 };
  const period = Math.floor((i.nowMs - meta.sinceMs) / (i.hours * HOUR_MS));
  const print = period >= 1 && period > meta.printedPeriod;
  return { meta: print ? { sinceMs: meta.sinceMs, printedPeriod: period } : meta, print };
}

const isMeta = (v: unknown): v is OfflineXSlipMeta =>
  typeof v === 'object' && v !== null && Number.isFinite((v as OfflineXSlipMeta).sinceMs) && Number.isInteger((v as OfflineXSlipMeta).printedPeriod);

/**
 * Run one check against the meta store. Online: forget the stretch. Offline: read, decide, hand the slip's start time to `print`, and remember the period only AFTER it printed or
 * was shown (`print` returns false when it could not do either: the next check tries again, no slip is skipped silently). Returns whether it printed.
 */
export async function checkOfflineXSlip(deps: {
  online: boolean;
  offlineSinceMs: number | null;
  nowMs: number;
  hours: number | null;
  getMeta: () => Promise<unknown>;
  setMeta: (v: OfflineXSlipMeta | null) => Promise<void>;
  print: (sinceMs: number) => Promise<boolean | void>;
}): Promise<boolean> {
  if (deps.online) {
    await deps.setMeta(null);
    return false;
  }
  if (deps.hours === null || deps.offlineSinceMs === null) return false;
  const stored = await deps.getMeta();
  const step = offlineXSlipStep({ meta: isMeta(stored) ? stored : null, offlineSinceMs: deps.offlineSinceMs, nowMs: deps.nowMs, hours: deps.hours });
  // A new stretch's start is saved at once (a retry must not shift it); the printed period only once the slip is out.
  if (!isMeta(stored)) await deps.setMeta({ sinceMs: step.meta.sinceMs, printedPeriod: 0 });
  if (!step.print) return false;
  if ((await deps.print(step.meta.sinceMs)) === false) return false;
  await deps.setMeta(step.meta);
  return true;
}
