import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session';
import { getItem, itemPrices, peso, sellabilityByStore, soldAsLabel } from '../lib';
import { whoSells } from '../../ap/lib';
import { clearStoreSellabilityAction, setStoreSellabilityAction, updateItemFlagsAction } from '../actions';
import { itemKindLabel } from '@shareat/db';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Item — Shareat System' };
export const dynamic = 'force-dynamic';

/** ₱ per base unit, to 2dp for reading. The stored figure keeps 4 — a per-gram price needs them. */
function per(value: string): string {
  return peso(Number(value).toFixed(2));
}

const SELECT =
  'rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900';
const BTN_QUIET =
  'rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';

/** Renders a tri-state override as its select value. `null` is "follow the org", never "no". */
function triValue(v: boolean | null | undefined): string {
  return v === true ? 'yes' : v === false ? 'no' : '';
}

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/items/${id}`);
  const item = await getItem(actor.orgId, id);
  if (!item) notFound();

  const [{ history, movement, bySupplier }, sellers, byStore] = await Promise.all([
    itemPrices(actor.orgId, id),
    whoSells(actor.orgId, id),
    sellabilityByStore(actor.orgId, id),
  ]);
  const peak = movement.reduce((m, r) => Math.max(m, Number(r.maxPrice)), 0);

  const FLAGS = [
    { key: 'isPurchasable', label: 'Bought from suppliers', org: item.isPurchasable },
    { key: 'sellableRetail', label: 'Sold à la carte', org: item.sellableRetail },
    { key: 'sellableWholesale', label: 'Sold wholesale', org: item.sellableWholesale },
  ] as const;

  return (
    <Page density="table">
      <div>
        <a href="/items" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Items
        </a>
        <h1 className="mt-1 text-2xl font-semibold">{item.name}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          <span className="font-mono text-xs">{item.code}</span> · {itemKindLabel(item.kind)} ·
          priced per {item.baseUnit} · {soldAsLabel(item)}
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

      {/*
        ⭐ DEF-130 / T-149. Three independent facts, and TWO layers: the organisation's answer,
        then the store that differs. Bulgogi sauce is one item — one identity, one price history —
        but Lipa MAKES it and sells it wholesale while another branch buys it in. The override
        table holds only the exceptions, so a store that agrees with the org has no row at all.
      */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">What it may be bought and sold as</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            The organisation&rsquo;s answer first. A wholesale order is refused for an item the{' '}
            <strong>selling store</strong> does not sell wholesale, and a supplier invoice is refused
            for one the store makes rather than buys — so an item nobody has flagged can be
            neither sold nor bought.
          </p>
        </div>

        <form action={updateItemFlagsAction} className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <input type="hidden" name="itemId" value={item.id} />
          {FLAGS.map((f) => (
            <label key={f.key} className="flex items-center gap-2">
              <input type="checkbox" name={f.key} defaultChecked={f.org} className="h-4 w-4" />
              {f.label}
            </label>
          ))}
          <button type="submit" className={BTN}>
            Save organisation default
          </button>
        </form>

        {byStore.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Where a store differs</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              ⚠️ &ldquo;Follow the organisation&rdquo; is not the same as &ldquo;no&rdquo; — it keeps
              tracking the default above when that changes; a store that says &ldquo;no&rdquo;
              freezes its own answer.
            </p>
            <ul className="space-y-2">
              {byStore.map((s) => (
                <li
                  key={s.storeId}
                  className="flex flex-wrap items-end gap-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
                >
                  {/*
                    ⚠️ Save and Clear are TWO forms, side by side, not one form with a
                    `formAction` button. A click that lands before React hydrates submits the
                    form natively, and a native submit ignores a server-action `formAction` —
                    "Clear" then SAVED the override instead. Two plain forms behave the same
                    with or without JS.
                  */}
                  <form action={setStoreSellabilityAction} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="itemId" value={item.id} />
                    <input type="hidden" name="storeId" value={s.storeId} />
                    <div className="min-w-[8rem]">
                      <div className="font-medium">{s.storeName}</div>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {s.override ? 'has its own answer' : 'follows the organisation'}
                        {' · here: '}
                        {soldAsLabel(s.resolved)}
                      </div>
                    </div>
                    {FLAGS.map((f) => (
                      <label key={f.key} className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                        {f.label}
                        <select name={f.key} defaultValue={triValue(s.override?.[f.key])} className={SELECT}>
                          <option value="">Follow the organisation ({f.org ? 'yes' : 'no'})</option>
                          <option value="yes">Yes, here</option>
                          <option value="no">No, here</option>
                        </select>
                      </label>
                    ))}
                    <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                      Why
                      <input
                        name="note"
                        defaultValue={s.override?.note ?? ''}
                        placeholder="made in-house here"
                        className={`${SELECT} w-40`}
                      />
                    </label>
                    <button type="submit" className={BTN}>
                      Save
                    </button>
                  </form>
                  {s.override && (
                    <form action={clearStoreSellabilityAction}>
                      <input type="hidden" name="itemId" value={item.id} />
                      <input type="hidden" name="storeId" value={s.storeId} />
                      <button type="submit" className={BTN_QUIET}>
                        Clear
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {sellers.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Who sells this</h2>
          {sellers.length === 1 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              ⚠️ Only one supplier &mdash; a single point of supply for this item.
            </p>
          )}
          <ul className="flex flex-wrap gap-2 text-sm">
            {sellers.map((s) => (
              <li
                key={s.supplierId}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
              >
                <a href={`/ap/suppliers/${s.supplierId}`} className="underline hover:no-underline">
                  {s.supplierName}
                </a>
                <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                  {s.source === 'observed'
                    ? `billed ${s.timesBilled}× since ${s.firstSeenOn}`
                    : 'declared — never billed'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.length === 0 ? (
        <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          No prices yet. Record a supplier invoice with this item on a line, and its history starts
          here — nothing is typed in twice.
        </p>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-medium">Price by month</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              The average is <strong>weighted</strong> — total spent ÷ total {item.baseUnit} — never
              an average of averages. Buying 100{item.baseUnit} cheap and 1{item.baseUnit} dear is
              not a mid-price month.
            </p>
            <div className="space-y-1">
              {movement.map((m) => (
                <div key={m.month} className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 font-mono text-xs">{m.month}</span>
                  <div className="h-5 flex-1 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-900">
                    <div
                      className="h-full rounded bg-neutral-800 dark:bg-neutral-200"
                      style={{ width: peak > 0 ? `${(Number(m.avgPrice) / peak) * 100}%` : '0%' }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right font-mono tabular-nums">
                    {per(m.avgPrice)}
                  </span>
                  <span className="w-32 shrink-0 text-right text-xs text-neutral-500 dark:text-neutral-400">
                    {per(m.minPrice)}–{per(m.maxPrice)} ({m.observations})
                  </span>
                </div>
              ))}
            </div>
          </section>

          {bySupplier.length > 1 && (
            <section className="space-y-2">
              <h2 className="font-medium">By supplier — cheapest first</h2>
              <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                      <th className="px-3 py-2 font-medium">Supplier</th>
                      <th className="px-3 py-2 text-right font-medium">Average</th>
                      <th className="px-3 py-2 text-right font-medium">Last</th>
                      <th className="px-3 py-2 text-right font-medium">Times bought</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bySupplier.map((s) => (
                      <tr key={s.supplierId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                        <td className="px-3 py-2">{s.supplierName}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{per(s.avgPrice)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">
                          {per(s.lastPrice)}
                          <span className="ml-2 text-xs text-neutral-500">{s.lastDate}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{s.observations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <h2 className="font-medium">Every price paid</h2>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Supplier</th>
                    <th className="px-3 py-2 font-medium">Billed as</th>
                    <th className="px-3 py-2 text-right font-medium">Per {item.baseUnit}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.invoiceId + h.invoiceDate} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                      <td className="px-3 py-2">{h.invoiceDate}</td>
                      <td className="px-3 py-2">{h.supplierName}</td>
                      <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">
                        {h.quantity} {h.purchaseUnit} @ {per(h.unitPrice)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{per(h.basePrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </Page>
  );
}
