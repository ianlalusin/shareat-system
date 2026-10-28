/**
 * T-398 S6d - what the franchisor is shown after pressing a look button. Plain server-rendered elements (no hooks), so the server action can return them as they are
 * and a test can render them. Money is shown as pesos (two decimals) and is added with the money type, never as a float. Only CHECKED (verified) days count in the
 * totals (QI-1 default); every day is labelled. Payments are shown by kind (cash / online / credit), never by account name (QI-2 default).
 */
import { add, ZERO, type Money } from '@shareat/core/money';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import type { FranchiseSalesLine, FranchiseStockLine } from '@shareat/domain';
import { peso } from '../../lib/format';
import { Banner, NumTd, Table, Td, Th } from '@/components/ui';

const m = (v: Money | null): Money => v ?? ZERO;
const show = (v: Money | null): string => (v === null ? '-' : peso(v));

export function LookRefused({ words }: { words: string }) {
  return <Banner tone="error">{words}</Banner>;
}

export function SalesResult({ lines }: { lines: FranchiseSalesLine[] }) {
  const days = lines.filter((l) => l.rowKind === 'day');
  const channelsOf = (d: FranchiseSalesLine) => lines.filter((l) => l.rowKind === 'channel' && l.storeId === d.storeId && l.businessDate === d.businessDate);
  const checked = days.filter((d) => d.dayStatus === 'verified');
  const total = (pick: (d: FranchiseSalesLine) => Money | null): Money => add(ZERO, ...checked.map((d) => m(pick(d))));
  if (days.length === 0) return <p className="text-sm text-muted">No sales days in that range.</p>;
  return (
    <section className="space-y-4" aria-label="Sales looked at">
      <h2 className="text-lg font-semibold">Sales looked at</h2>
      <Table card={{ title: 'Day', keys: ['Status', 'Gross', 'Net'] }}>
        <thead>
          <tr>
            <Th>Day</Th>
            <Th>Store</Th>
            <Th>Status</Th>
            <Th numeric>Gross</Th>
            <Th numeric>Discounts</Th>
            <Th numeric>Comps</Th>
            <Th numeric>Refunds</Th>
            <Th numeric>Net</Th>
            <Th numeric>Cash</Th>
            <Th numeric>Online</Th>
            <Th numeric>Credit</Th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={`${d.storeId}-${d.businessDate}`}>
              <Td>
                {d.businessDate}
                {channelsOf(d).length > 0 ? (
                  <ul className="mt-1 text-xs text-muted">
                    {channelsOf(d).map((c) => (
                      <li key={c.channelName}>
                        {c.channelName}: {show(c.channelAmount)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Td>
              <Td>{d.storeName}</Td>
              <Td>{d.dayStatus === 'verified' ? 'Checked' : `Not checked (${d.dayStatus})`}</Td>
              <NumTd>{show(d.grossSales)}</NumTd>
              <NumTd>{show(d.discounts)}</NumTd>
              <NumTd>{show(d.comps)}</NumTd>
              <NumTd>{show(d.refunds)}</NumTd>
              <NumTd>{show(d.netSales)}</NumTd>
              <NumTd>{show(d.cashCollected)}</NumTd>
              <NumTd>{show(d.onlineCollected)}</NumTd>
              <NumTd>{show(d.creditSales)}</NumTd>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="rounded-[20px] border border-surface-border p-4 text-sm">
        <p className="font-medium">
          Totals of the {checked.length} checked {checked.length === 1 ? 'day' : 'days'} only
          {days.length > checked.length ? ` (${days.length - checked.length} not checked, left out)` : ''}
        </p>
        <p className="mt-1 tabular-nums">
          Gross {peso(total((d) => d.grossSales))} - Net {peso(total((d) => d.netSales))} - Cash {peso(total((d) => d.cashCollected))} - Online{' '}
          {peso(total((d) => d.onlineCollected))} - Credit {peso(total((d) => d.creditSales))}
        </p>
      </div>
    </section>
  );
}

export function StockResult({ lines }: { lines: FranchiseStockLine[] }) {
  if (lines.length === 0) return <p className="text-sm text-muted">No stock to show.</p>;
  return (
    <section className="space-y-4" aria-label="Stock looked at">
      <h2 className="text-lg font-semibold">Stock looked at</h2>
      <Table card={{ title: 'Item', keys: ['Store', 'On hand'] }}>
        <thead>
          <tr>
            <Th>Store</Th>
            <Th>Item</Th>
            <Th>Unit</Th>
            <Th numeric>On hand</Th>
            <Th numeric>Low-stock line</Th>
            <Th>Flag</Th>
            <Th>As of</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.storeId}-${l.itemName}`}>
              <Td>{l.storeName}</Td>
              <Td>{l.itemName}</Td>
              <Td>{l.baseUnit}</Td>
              <NumTd>{l.onHand}</NumTd>
              <NumTd>{l.threshold ?? '-'}</NumTd>
              <Td>{l.belowThreshold ? 'Low - at or below the line' : ''}</Td>
              <Td>{formatBusinessDateTime(l.asOf)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
