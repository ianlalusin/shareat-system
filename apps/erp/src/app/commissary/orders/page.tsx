import Link from 'next/link';
import { lowStockRepo } from '@shareat/db';
import { requireSession } from '../../../lib/session';
import { createOrderAction } from './actions';
import {
  BRANCH_ORDER_STAGE_LABEL,
  branchOrderStage,
  listStores,
  newOrderPanelData,
  peso,
  today,
  type CommissaryChoice,
} from './lib';
import { withOrgPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';
import { Badge, Button, Field, FlashBanner, FormGrid, Input, LinkRow, RowLink, Select, statusTone } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { COMMISSARY_ORDER_NEW_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Branch orders — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

const LABEL = 'flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400';

/** How many line rows the "New order" form offers. More lines are added on the order itself. */
const NEW_ORDER_ROWS = [1, 2, 3];

export default async function BranchOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/commissary/orders');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Branch orders</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const [orders, choices] = await Promise.all([
    withOrgPrincipal(actor.orgId, (tx) => lowStockRepo.branchOrders(tx, actor.orgId, storeId)),
    newOrderPanelData(actor.orgId, storeId),
  ]);
  const store = stores.find((s) => s.id === storeId)!;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Branch orders</h1>
        {/*
          ⭐ BOTH directions in one list, deliberately. Two screens showing "my orders" from opposite
          ends is how the two sides end up disagreeing about what was sent.
        */}
        <PageDescription className="mt-1">
          Every internal order this store is on — as the commissary filling one, or as the branch
          waiting for it.
        </PageDescription>
      </div>

      <FilterRow>
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

      <FlashBanner flash={sp} />

      {/* ⭐ The "New order" panel — only for a store that IS a branch of some commissary. */}
      {choices.length > 0 ? (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">New order from {store.name}</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            One open order per commissary at a time — draft through in-transit blocks a second, until
            the goods are signed for. Only what the commissary offers can be ordered, at the price the
            branch will be charged; a line that cannot be priced is refused rather than saved at ₱0.
          </p>
          <div className="mt-4 space-y-6">
            {choices.map((c) => (
              <NewOrderForm key={c.id} choice={c} branchStoreId={storeId} />
            ))}
          </div>
        </section>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {store.name} is not linked to a commissary as a branch, so it places no orders here. Links,
          offerings and the item map live under{' '}
          <Link href="/commissary/catalogue" className="underline underline-offset-4">
            Commissary catalogue
          </Link>
          .
        </p>
      )}

      {orders.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No internal orders yet. A branch below its reorder threshold gets one drafted for it
          automatically — see <Link href="/inventory/low-stock" className="underline underline-offset-4">low stock</Link>.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">From → to</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 text-right font-medium">Lines</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Thread</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const stage = branchOrderStage(o);
                return (
                  <LinkRow key={o.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2 tabular-nums">
                      <RowLink href={`/commissary/orders/${o.id}`}>
                        {o.orderDate}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2">
                      {o.commissaryName} → {o.branchName ?? '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(stage)} label={BRANCH_ORDER_STAGE_LABEL[stage]} />
                      {o.pendingCount > 0 && (
                        <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning-ink">
                          {o.pendingCount} awaiting the branch
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{o.lineCount}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(o.totalAmount)}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {o.messageCount === 0 ? '—' : `${o.messageCount} message${o.messageCount === 1 ? '' : 's'}`}
                    </td>
                  </LinkRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function NewOrderForm({ choice, branchStoreId }: { choice: CommissaryChoice; branchStoreId: string }) {
  if (choice.openOrderId) {
    return (
      <div className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
        <span className="font-medium">{choice.name}</span> — an order is already open (
        {BRANCH_ORDER_STAGE_LABEL[choice.openOrderStage!].toLowerCase()}).{' '}
        <Link href={`/commissary/orders/${choice.openOrderId}`} className="underline underline-offset-4">
          Open it
        </Link>
        .
      </div>
    );
  }
  if (choice.catalogue.length === 0) {
    return (
      <div className="rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800">
        <span className="font-medium">{choice.name}</span> offers nothing yet — add offerings under{' '}
        <Link href={`/commissary/catalogue?commissary=${choice.id}`} className="underline underline-offset-4">
          Commissary catalogue
        </Link>
        .
      </div>
    );
  }
  return (
    <CheckedForm rules={COMMISSARY_ORDER_NEW_RULES} action={createOrderAction} className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <input type="hidden" name="branchStoreId" value={branchStoreId} />
      <input type="hidden" name="commissaryStoreId" value={choice.id} />
      <span className="block text-sm font-medium">From {choice.name}</span>
      <FormGrid>
        <Field label="Order date" className={`${LABEL} min-w-0`} rule={COMMISSARY_ORDER_NEW_RULES.orderDate}>
          <Input {...nativeAttrs(COMMISSARY_ORDER_NEW_RULES.orderDate)} type="date" defaultValue={today()} className="w-full" />
        </Field>
        <label className={`${LABEL} min-w-0 [@container_(min-width:29rem)]:col-span-2`}>
          Notes (optional)
          <Input name="notes" className="w-full" />
        </label>
      </FormGrid>
      <div className="space-y-2">
        {NEW_ORDER_ROWS.map((n) => (
          <div key={n} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_7rem_9rem] sm:items-end">
            <label className={`${LABEL} col-span-2 sm:col-span-1`}>
              Item{n === 1 ? '' : ` ${n} (optional)`}
              <Select name="itemId" required={n === 1} defaultValue="">
                <option value="">— pick —</option>
                {choice.catalogue.map((l) => (
                  <option key={l.commissaryItemId} value={l.commissaryItemId}>
                    {l.name} ({l.baseUnit})
                    {l.priced ? ` — ₱${l.price}` : ' — no price, state one'}
                    {l.blocker ? ` — ⚠ ${l.blocker}` : ''}
                  </option>
                ))}
              </Select>
            </label>
            <label className={LABEL}>
              Quantity
              <Input name="quantity" inputMode="decimal" placeholder="0.000" className="tabular-nums" />
            </label>
            <label className={LABEL}>
              Rate ₱ (blank = default)
              <Input name="rate" inputMode="decimal" placeholder="default" className="tabular-nums" />
            </label>
          </div>
        ))}
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          ⚠ marks an item that can be drafted but not yet <strong>submitted</strong> — map it under
          Commissary catalogue first. Whatever rate is used is captured onto the line.
        </p>
      </div>
      <Button type="submit" variant="primary">
        Save draft
      </Button>
    </CheckedForm>
  );
}
