/**
 * getSalesRollup — T-210. Combines `reportsRepo.getSalesByPeriod` (the ledger total, grouped by
 * day/month/store) with `reportsRepo.getSalesByChannelAndMode` (channel and mode breakdown, from
 * `sales_days`/`sales_day_channels` — see that function's own comment for why the ledger cannot
 * carry the channel dimension) and asserts all three groupings of the same recognised revenue
 * agree to the centavo. docs/tasks/210-sales-reporting-over-the-ledger.md.
 */
import { reportsRepo, type Executor } from '@shareat/db';
import { add, equals, money, type Money } from '@shareat/core/money';

export interface SalesRollupInput {
  orgId: string;
  storeId?: string | null;
  fromDate: string;
  toDate: string;
  groupBy: reportsRepo.SalesRollupGrouping;
  /** T-421. With `groupBy: 'day'` only: also return the per-day channel split and the days that do not reconcile. */
  channelDays?: boolean;
}

export interface SalesPeriodLine {
  period: string | null;
  storeId: string | null;
  total: Money;
}

export interface SalesChannelLine {
  /** Null only on the synthetic "POS corrections" line (T-375 R14). */
  channelId: string | null;
  channelName: string;
  isRemittedDaily: boolean;
  total: Money;
}

export interface SalesModeLine {
  mode: 'unli' | 'ala_carte';
  total: Money;
}

export interface SalesRollupBasis {
  orgId: string;
  storeId: string | null;
  fromDate: string;
  toDate: string;
  groupBy: reportsRepo.SalesRollupGrouping;
}

export interface SalesChannelDayBlock {
  /** Null only on the synthetic "POS corrections" block. */
  channelId: string | null;
  channelName: string;
  total: Money;
}

export interface SalesChannelDay {
  day: string;
  /** The sum of this day's blocks. */
  total: Money;
  channels: SalesChannelDayBlock[];
}

export interface SalesRollupResult {
  periods: SalesPeriodLine[];
  ledgerTotal: Money;
  channels: SalesChannelLine[];
  channelTotal: Money;
  modes: SalesModeLine[];
  modeTotal: Money;
  /** channelTotal === ledgerTotal === modeTotal, to the centavo. */
  reconciles: boolean;
  /** T-421. Empty unless `channelDays` was asked for with `groupBy: 'day'`. */
  channelDays: SalesChannelDay[];
  /** T-421. Days whose blocks do not add up to that day's ledger total, to the centavo. */
  unreconciledDays: string[];
  basis: SalesRollupBasis;
}

export async function getSalesRollup(ex: Executor, input: SalesRollupInput): Promise<SalesRollupResult> {
  const storeId = input.storeId ?? null;

  const wantDays = input.channelDays === true && input.groupBy === 'day';
  const [periodRows, breakdown, dayRows] = await Promise.all([
    reportsRepo.getSalesByPeriod(ex, { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate, groupBy: input.groupBy }),
    reportsRepo.getSalesByChannelAndMode(ex, { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate }),
    wantDays
      ? reportsRepo.getSalesByDayAndChannel(ex, { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate })
      : Promise.resolve([] as reportsRepo.SalesByDayAndChannelRow[]),
  ]);

  const periods: SalesPeriodLine[] = periodRows.map((r) => ({ period: r.period, storeId: r.storeId, total: money(r.total) }));
  const channels: SalesChannelLine[] = breakdown.channels.map((c) => ({
    channelId: c.channelId,
    channelName: c.channelName,
    isRemittedDaily: c.isRemittedDaily,
    total: money(c.total),
  }));
  const modes: SalesModeLine[] = breakdown.modes.map((m) => ({ mode: m.mode, total: money(m.total) }));

  const ledgerTotal = add(...periods.map((p) => p.total));
  const channelTotal = add(...channels.map((c) => c.total));
  const modeTotal = add(...modes.map((m) => m.total));

  const byDay = new Map<string, SalesChannelDayBlock[]>();
  for (const r of dayRows) {
    const list = byDay.get(r.day) ?? [];
    list.push({ channelId: r.channelId, channelName: r.channelName, total: money(r.total) });
    byDay.set(r.day, list);
  }
  const channelDays: SalesChannelDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, blocks]) => ({ day, total: add(...blocks.map((b) => b.total)), channels: blocks }));
  const unreconciledDays: string[] = [];
  if (wantDays) {
    const ledgerOf = new Map<string, (typeof periods)[number]['total']>();
    for (const p of periods) ledgerOf.set(p.period ?? '', p.total);
    const days = new Set<string>([...ledgerOf.keys(), ...byDay.keys()]);
    for (const day of [...days].sort()) {
      const blocks = byDay.get(day) ?? [];
      if (!equals(add(...blocks.map((b) => b.total)), ledgerOf.get(day) ?? money('0'))) unreconciledDays.push(day);
    }
  }

  return {
    periods,
    ledgerTotal,
    channels,
    channelTotal,
    modes,
    modeTotal,
    reconciles: equals(ledgerTotal, channelTotal) && equals(ledgerTotal, modeTotal),
    channelDays,
    unreconciledDays,
    basis: { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate, groupBy: input.groupBy },
  };
}
