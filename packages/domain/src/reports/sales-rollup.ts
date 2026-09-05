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
}

export interface SalesPeriodLine {
  period: string | null;
  storeId: string | null;
  total: Money;
}

export interface SalesChannelLine {
  channelId: string;
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

export interface SalesRollupResult {
  periods: SalesPeriodLine[];
  ledgerTotal: Money;
  channels: SalesChannelLine[];
  channelTotal: Money;
  modes: SalesModeLine[];
  modeTotal: Money;
  /** channelTotal === ledgerTotal === modeTotal, to the centavo. */
  reconciles: boolean;
  basis: SalesRollupBasis;
}

export async function getSalesRollup(ex: Executor, input: SalesRollupInput): Promise<SalesRollupResult> {
  const storeId = input.storeId ?? null;

  const [periodRows, breakdown] = await Promise.all([
    reportsRepo.getSalesByPeriod(ex, { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate, groupBy: input.groupBy }),
    reportsRepo.getSalesByChannelAndMode(ex, { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate }),
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

  return {
    periods,
    ledgerTotal,
    channels,
    channelTotal,
    modes,
    modeTotal,
    reconciles: equals(ledgerTotal, channelTotal) && equals(ledgerTotal, modeTotal),
    basis: { orgId: input.orgId, storeId, fromDate: input.fromDate, toDate: input.toDate, groupBy: input.groupBy },
  };
}
