'use client';

/**
 * The "New trade order" form — DEF-138. One document for a wholesale sale and an internal
 * transfer alike (ADR-008 §8); the customer picked here decides which, and the form says so.
 *
 * ⭐ The rate is OPTIONAL on purpose. Left blank, `createTradeOrder` takes the customer's
 * price-list rate (a sale) or the branch price (a transfer) and CAPTURES it onto the line. The
 * placeholder shows that default so the person sees the agreed price before it is captured — and
 * sees "no default" before the server refuses the line.
 */
import { useState } from 'react';
import type { CustomerOption, ItemOption, StoreOption } from './lib';

interface LineDraft {
  key: number;
  itemId: string;
  quantity: string;
  rate: string;
}

const TREATMENT_HINT: Record<string, string> = {
  internal: 'One of our own stores — an internal transfer. No revenue, no receivable; stock moves at cost and the branch price is the default rate.',
  external: 'An outside buyer — a real sale. Dispatch raises the receivable and books wholesale revenue; the price list is the default rate.',
  inter_entity: 'Another company — not yet supported: their side of the trade cannot be posted from here (T-133 §4).',
};

export function NewOrderForm({
  action,
  stores,
  storeId,
  customers,
  items,
  quotes,
  branchPrices,
  today,
}: {
  action: (fd: FormData) => void | Promise<void>;
  stores: readonly StoreOption[];
  /** The store the register is showing — the default SELLING store. */
  storeId: string;
  customers: readonly CustomerOption[];
  items: readonly ItemOption[];
  quotes: Record<string, Record<string, string>>;
  branchPrices: Record<string, string>;
  today: string;
}) {
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [sellingStoreId, setSellingStoreId] = useState(storeId);
  const [lines, setLines] = useState<LineDraft[]>([{ key: 1, itemId: items[0]?.id ?? '', quantity: '', rate: '' }]);
  const [nextKey, setNextKey] = useState(2);

  const customer = customers.find((c) => c.id === customerId);
  const treatment = customer?.treatment ?? 'external';
  const unsupported = treatment === 'inter_entity';
  const itemById = new Map(items.map((i) => [i.id, i]));

  function defaultRate(itemId: string): string | null {
    if (!itemId) return null;
    if (treatment === 'internal') return branchPrices[itemId] ?? null;
    return quotes[customerId]?.[itemId] ?? null;
  }

  function update(key: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { key: nextKey, itemId: items[0]?.id ?? '', quantity: '', rate: '' }]);
    setNextKey((k) => k + 1);
  }
  function removeLine(key: number) {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((l) => l.key !== key)));
  }

  const label = 'flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400';
  const field =
    'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

  if (customers.length === 0 || items.length === 0) {
    return (
      <p className="mt-3 text-sm text-amber-700 dark:text-amber-500">
        {customers.length === 0
          ? 'No active customers yet — record one under Trade › Customers first.'
          : 'No active items yet — add one under Inventory › Items first.'}
      </p>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={label}>
          Selling store
          <select
            name="storeId"
            required
            value={sellingStoreId}
            onChange={(e) => setSellingStoreId(e.target.value)}
            className={field}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Customer
          <select
            name="customerId"
            required
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className={field}
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.treatment === 'internal' ? ' — our own store' : c.treatment === 'inter_entity' ? ' — another company' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Order date
          <input name="orderDate" type="date" required defaultValue={today} className={field} />
        </label>
        <label className={label}>
          Reference (optional)
          <input name="referenceNo" placeholder="DR-0001" className={field} />
        </label>
      </div>

      <p
        className={`text-xs ${
          treatment === 'internal'
            ? 'text-sky-700 dark:text-sky-400'
            : unsupported
              ? 'text-red-700 dark:text-red-400'
              : 'text-neutral-600 dark:text-neutral-400'
        }`}
      >
        {TREATMENT_HINT[treatment]}
        {treatment === 'internal' && customer?.counterpartyStoreId === sellingStoreId && (
          <span className="ml-1 text-red-700 dark:text-red-400">⛔ That is the selling store itself — a store cannot transfer to itself.</span>
        )}
      </p>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Lines</h3>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            + Add line
          </button>
        </div>
        {lines.map((l) => {
          const item = itemById.get(l.itemId);
          const dflt = defaultRate(l.itemId);
          return (
            <div
              key={l.key}
              className="grid grid-cols-2 gap-2 rounded-md border border-neutral-200 p-2 sm:grid-cols-[1fr_7rem_9rem_auto] sm:items-end dark:border-neutral-800"
            >
              <label className={`${label} col-span-2 sm:col-span-1`}>
                Item
                <select
                  name="itemId"
                  required
                  value={l.itemId}
                  onChange={(e) => update(l.key, { itemId: e.target.value })}
                  className={field}
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.baseUnit})
                    </option>
                  ))}
                </select>
              </label>
              <label className={label}>
                Quantity{item ? ` (${item.baseUnit})` : ''}
                <input
                  name="quantity"
                  required
                  inputMode="decimal"
                  placeholder="0.000"
                  value={l.quantity}
                  onChange={(e) => update(l.key, { quantity: e.target.value })}
                  className={`${field} tabular-nums`}
                />
              </label>
              <label className={label}>
                Rate ₱ (blank = default)
                <input
                  name="rate"
                  inputMode="decimal"
                  placeholder={dflt ? `₱${dflt}` : 'no default — state one'}
                  value={l.rate}
                  onChange={(e) => update(l.key, { rate: e.target.value })}
                  className={`${field} tabular-nums ${dflt || l.rate ? '' : 'border-amber-400 dark:border-amber-600'}`}
                />
              </label>
              <button
                type="button"
                onClick={() => removeLine(l.key)}
                disabled={lines.length === 1}
                aria-label="Remove line"
                className="rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Remove
              </button>
            </div>
          );
        })}
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          ⚠️ Whatever rate is used is <strong>captured</strong> onto the line — a later price-list
          edit never reaches back. An amber rate box means nothing can price that line by default.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className={label}>
          Delivery fee ₱ (optional)
          <input name="deliveryFee" inputMode="decimal" placeholder="0.00" className={`${field} tabular-nums`} />
        </label>
        <label className={label}>
          Other fees ₱ (optional)
          <input name="otherFees" inputMode="decimal" placeholder="0.00" className={`${field} tabular-nums`} />
        </label>
        <label className={label}>
          Notes (optional)
          <input name="notes" className={field} />
        </label>
      </div>

      <button
        type="submit"
        disabled={unsupported}
        className="rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      >
        Save draft order
      </button>
    </form>
  );
}
