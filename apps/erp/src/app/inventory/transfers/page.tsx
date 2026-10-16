import Link from 'next/link';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { itemsRepo, schema } from '@shareat/db';
import { listStores } from '../lib';
import {
  createTransferAction,
  dispatchTransferAction,
  receiveTransferAction,
  voidTransferAction,
} from './actions';
import { NewTransferForm } from './NewTransferForm';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Button, ConfirmDestructive, FlashBanner, Input, Select } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Stock transfers — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
}

export default async function TransfersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/transfers');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Stock transfers</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { locations, items, open } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const locs = await tx
      .select({ id: schema.stockLocations.id, name: schema.stockLocations.name, code: schema.stockLocations.code })
      .from(schema.stockLocations)
      .where(and(eq(schema.stockLocations.storeId, storeId), eq(schema.stockLocations.status, 'active')))
      .orderBy(asc(schema.stockLocations.name));

    // T-383 S2b: a retired item with stock at THIS store stays movable until it runs out, labelled as such.
    const its = (await itemsRepo.listUsableItems(tx, actor.orgId, storeId)).map((i) => ({
      id: i.id,
      code: i.code,
      name: i.status === 'inactive' ? `${i.name} (retired)` : i.name,
      baseUnit: i.baseUnit,
    }));

    const openTransfers = await tx
      .select({
        id: schema.stockTransfers.id,
        status: schema.stockTransfers.status,
        mode: schema.stockTransfers.mode,
        fromLocationId: schema.stockTransfers.fromLocationId,
        toLocationId: schema.stockTransfers.toLocationId,
        dispatchedAt: schema.stockTransfers.dispatchedAt,
      })
      .from(schema.stockTransfers)
      .where(and(eq(schema.stockTransfers.storeId, storeId), inArray(schema.stockTransfers.status, ['draft', 'in_transit'])))
      .orderBy(desc(schema.stockTransfers.createdAt));

    const linesByTransfer = new Map<string, { itemId: string; quantity: string }[]>();
    if (openTransfers.length) {
      const lines = await tx
        .select({ transferId: schema.stockTransferLines.transferId, itemId: schema.stockTransferLines.itemId, quantity: schema.stockTransferLines.quantity })
        .from(schema.stockTransferLines)
        .where(inArray(schema.stockTransferLines.transferId, openTransfers.map((t) => t.id)));
      for (const l of lines) {
        const list = linesByTransfer.get(l.transferId) ?? [];
        list.push({ itemId: l.itemId, quantity: l.quantity });
        linesByTransfer.set(l.transferId, list);
      }
    }

    return {
      locations: locs,
      items: its,
      open: openTransfers.map((t) => ({ ...t, lines: linesByTransfer.get(t.id) ?? [] })),
    };
  });

  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const itemName = new Map(items.map((i) => [i.id, `${i.name} (${i.baseUnit})`]));

  return (
    <Page density="table" className="">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Stock transfers</h1>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>
      <PageDescription className="mt-1">
        Room to room, within one store. ⭐ Posts no journal entry and consumes no FIFO layer — a
        transfer moves quantity only.
      </PageDescription>
      <FlashBanner flash={sp} />

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

      {locations.length < 2 ? (
        <p className="mt-8 text-sm text-warning-ink">
          This store needs at least two active rooms before a transfer means anything.
        </p>
      ) : (
        <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">New transfer</h2>
          <NewTransferForm
            action={createTransferAction}
            storeId={storeId}
            locations={locations.map((l) => ({ id: l.id, label: l.name }))}
            items={items}
          />
        </section>
      )}

      <h2 className="mt-10 text-lg font-medium">In flight</h2>
      {open.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Nothing draft or dispatched right now.</p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Route</th>
              <th className="py-2 pr-4 font-medium">Lines</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {open.map((t) => (
              <tr key={t.id} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-2 pr-4">
                  {locName.get(t.fromLocationId) ?? '?'} → {locName.get(t.toLocationId) ?? '?'}
                </td>
                <td className="py-2 pr-4 text-neutral-600 dark:text-neutral-400">
                  {t.lines.map((l, i) => (
                    <div key={i}>
                      {itemName.get(l.itemId) ?? l.itemId} <span className="tabular-nums">{l.quantity}</span>
                    </div>
                  ))}
                </td>
                <td className="py-2 pr-4">
                  <Badge status={t.status} />
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-2">
                    {t.status === 'draft' && (
                      <form action={dispatchTransferAction}>
                        <input type="hidden" name="transferId" value={t.id} />
                        <Button type="submit" variant="secondary">
                          Dispatch
                        </Button>
                      </form>
                    )}
                    {t.status === 'in_transit' && (
                      <form action={receiveTransferAction}>
                        <input type="hidden" name="transferId" value={t.id} />
                        <Button type="submit" variant="secondary">
                          Receive
                        </Button>
                      </form>
                    )}
                    <form action={voidTransferAction} className="flex items-center gap-1">
                      <input type="hidden" name="transferId" value={t.id} />
                      <Input name="reason" placeholder="void reason" required className="w-28" />
                      <ConfirmDestructive
                        tier="admin-pin"
                        label="Void transfer"
                        consequence="Reverses this stock transfer. An administrator must approve with their own PIN."
                      />
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
