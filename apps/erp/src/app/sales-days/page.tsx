import { salesDaysRepo } from '@shareat/db';
import { formatMoney, money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores } from './lib';
import { requireSession } from '../../lib/session';
import { withOrgPrincipal } from '../expenses/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Banner, Button, Select } from '@/components/ui';

export const metadata = { title: 'Sales days — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  status?: string;
}

export default async function SalesDaysPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  // ⭐ The org comes from the SESSION, not the URL. A person cannot browse another org's sales
  // days by editing a query string, and RLS refuses them underneath even if they try.
  const { actor } = await requireSession('/sales-days');
  const stores = await listStores(actor.orgId);
  const orgId = actor.orgId;

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : undefined;
  const status =
    sp.status === 'open' || sp.status === 'submitted' || sp.status === 'verified' || sp.status === 'voided'
      ? sp.status
      : undefined;

  const days = await withOrgPrincipal(orgId, (tx) =>
    salesDaysRepo.listSalesDays(tx, { orgId, storeId, status, limit: 100 }),
  );
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const carry = new URLSearchParams();
  if (storeId) carry.set('store', storeId);

  // ⭐ The create-block, surfaced BEFORE the user tries. Unrecognised revenue is the thing the
  // rule exists to prevent, so the screen should say which day is holding everything up rather
  // than waiting for a refusal on the next form.
  const oldestUnverified = days
    .filter((d) => d.status === 'open' || d.status === 'submitted')
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate))[0];

  return (
    <Page density="table">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Sales days</h1>
          <PageDescription>
            A day&apos;s selling, per store. <strong>Verifying is what recognises the revenue</strong> —
            an unverified day posts nothing (docs/tasks/123-sales-day.md).
          </PageDescription>
        </div>
        <a
          href={`/sales-days/new?${carry.toString()}`}
          className="inline-flex min-h-11 shrink-0 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
        >
          New sales day
        </a>
      </div>

      {oldestUnverified && (
        <Banner tone="warning">
          <strong className="font-medium">{oldestUnverified.businessDate}</strong> is still{' '}
          {oldestUnverified.status} and recognises no revenue.{' '}
          <a href={`/sales-days/${oldestUnverified.id}?${carry.toString()}`} className="underline hover:no-underline">
            Verify it
          </a>{' '}
          — a newer day cannot be created for that store until it is done (admins excepted).
        </Banner>
      )}

      <form
        method="GET"
        action="/sales-days"
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <Picker
          name="store"
          label="Store"
          value={storeId ?? ''}
          options={[{ v: '', t: 'All stores' }, ...stores.map((s) => ({ v: s.id, t: `${s.name} (${s.code})` }))]}
        />
        <Picker
          name="status"
          label="Status"
          value={status ?? ''}
          options={[
            { v: '', t: 'All' },
            { v: 'open', t: 'Open' },
            { v: 'submitted', t: 'Submitted' },
            { v: 'verified', t: 'Verified' },
            { v: 'voided', t: 'Voided' },
          ]}
        />
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </form>

      {days.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          No sales days match this filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">Cash</th>
                <th className="px-3 py-2 text-right font-medium">Online</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2 font-mono">
                    <a href={`/sales-days/${d.id}?${carry.toString()}`} className="underline hover:no-underline">
                      {d.businessDate}
                    </a>
                  </td>
                  <td className="px-3 py-2">{storeById.get(d.storeId)?.code ?? d.storeId}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(money(d.totalSales))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(money(d.cashCollected))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(money(d.onlineCollected))}</td>
                  {/* Provenance, kept from v1: a pulled figure and a typed one are not equally
                      trustworthy, and a reader that cannot tell them apart treats them as if
                      they were. */}
                  <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {d.source === 'pos_v1_day_feed' ? 'POS' : 'Typed'}
                  </td>
                  <td className="px-3 py-2">
                    <Badge status={d.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        {toBusinessDate()} today (Asia/Manila)
      </p>
    </Page>
  );
}

function Picker({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string;
  options: { v: string; t: string }[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
      <Select name={name} defaultValue={value}>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.t}
          </option>
        ))}
      </Select>
    </label>
  );
}
