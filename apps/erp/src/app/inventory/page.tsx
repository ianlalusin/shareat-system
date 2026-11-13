import Link from 'next/link';
import { listStores, stockSummary } from './lib';
import { requireSession } from '../../lib/session';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { Card, EmptyState, NumTd, Select, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Stock on hand — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  // ⭐ The org comes from the SESSION, never the URL — T-138, and `no-client-supplied-actor`
  // fails the build if that ever stops being true.
  const { actor } = await requireSession('/inventory');
  const stores = await listStores(actor.orgId);

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Stock on hand</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const summary = await stockSummary(actor.orgId, storeId);
  const drift = (Number(summary.accountValue) - Number(summary.layerValue)).toFixed(2);
  const ties = drift === '0.00' || drift === '-0.00';

  return (
    <Page density="table" className="">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Stock on hand</h1>
          <PageDescription className="mt-1">
            On-hand is a query over every movement ever recorded — there is no balance column to drift.
          </PageDescription>
        </div>
        {/* The four doors stock actually passes through, plus the two exceptions and the alert. */}
        <nav aria-label="Inventory sections" className="flex max-w-full flex-wrap gap-2 pb-1 text-sm md:flex-nowrap md:overflow-x-auto">
          {[
            { href: `/inventory/locations?store=${storeId}`, label: 'Rooms' },
            { href: `/inventory/deliveries?store=${storeId}`, label: 'Deliveries' },
            { href: `/inventory/usage?store=${storeId}`, label: 'Usage & wastage' },
            { href: `/inventory/counts?store=${storeId}`, label: 'Counts' },
            { href: '/inventory/transfers', label: 'Transfers' },
            { href: '/inventory/returns', label: 'Returns' },
            { href: '/inventory/low-stock', label: 'Low stock' },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex min-h-9 shrink-0 items-center rounded-full border border-surface-border bg-surface px-3 text-sm text-ink hover:bg-canvas"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      <FilterRow className="mt-6">
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId} className="mt-1">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      {/*
        ⭐ **Bible invariant 6's inventory arm, on a screen.** It asks that the control accounts
        equal the subledger "continuously, not at year end" — and until this page, nowhere in the
        product showed it. It lived only inside test assertions.
      */}
      <Card className={`mt-6 ${ties ? '' : 'border-warning bg-warning-soft'}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {ties ? 'Inventory ties to the ledger' : 'Inventory does not tie to the ledger'}
          </h2>
          <span className="text-xs text-muted">
            {ties ? 'Every peso of stock has a ledger entry.' : 'Investigate the difference before closing.'}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">FIFO layers</dt>
            <dd className="mt-1 font-display text-2xl font-extrabold tabular-nums">₱{summary.layerValue}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">On the books</dt>
            <dd className="mt-1 font-display text-2xl font-extrabold tabular-nums">₱{summary.accountValue}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Difference</dt>
            <dd className={`mt-1 font-display text-2xl font-extrabold tabular-nums ${ties ? '' : 'text-warning-ink'}`}>₱{drift}</dd>
          </div>
          <div>
            {/* Goods on a truck are in no FIFO layer: a layer is a thing on a shelf. */}
            <dt className="text-xs text-muted">In transit (branch orders)</dt>
            <dd className="mt-1 font-display text-2xl font-extrabold tabular-nums">₱{summary.inTransitValue}</dd>
          </div>
        </dl>
      </Card>

      {summary.rows.length === 0 ? (
        <EmptyState
          illustration="truck"
          title="No stock on hand yet"
          body="Stock arrives through a delivery or a commissary receipt. Once it does, every movement is visible here."
          action={
            <Link
              href={`/inventory/deliveries?store=${storeId}`}
              className="mt-2 inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover"
            >
              Record a delivery
            </Link>
          }
        />
      ) : (
        <Table card={{ title: 'Item', subtitle: 'Where', keys: ['On hand', 'Value'] }}>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th>Where</Th>
              <Th numeric>On hand</Th>
              <Th numeric>Value</Th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => (
              <tr key={row.itemId} className="align-top">
                <Td>
                  <span className="font-medium">{row.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted">{row.code}</span>
                </Td>
                <Td className="text-muted">
                  {row.byLocation.map((l) => (
                    <div key={l.locationName}>
                      {l.locationName} <span className="tabular-nums">{l.quantity}</span>
                    </div>
                  ))}
                </Td>
                <NumTd>
                  {row.quantity} {row.baseUnit}
                </NumTd>
                <NumTd>
                  {/* A balance with no open layer is a real state: stock exists that no receipt valued. */}
                  {row.value === null ? (
                    <span className="text-warning-ink">no layer</span>
                  ) : (
                    `₱${row.value}`
                  )}
                </NumTd>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
