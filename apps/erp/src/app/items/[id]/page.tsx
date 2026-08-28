import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session';
import { getItem, itemPrices, peso } from '../lib';

export const metadata = { title: 'Item — Shareat System' };
export const dynamic = 'force-dynamic';

/** ₱ per base unit, to 2dp for reading. The stored figure keeps 4 — a per-gram price needs them. */
function per(value: string): string {
  return peso(Number(value).toFixed(2));
}

export default async function ItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireSession(`/items/${id}`);
  const item = await getItem(actor.orgId, id);
  if (!item) notFound();

  const { history, movement, bySupplier } = await itemPrices(actor.orgId, id);
  const peak = movement.reduce((m, r) => Math.max(m, Number(r.maxPrice)), 0);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div>
        <a href="/items" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Items
        </a>
        <h1 className="mt-1 text-2xl font-semibold">{item.name}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          <span className="font-mono text-xs">{item.code}</span> · {item.kind.replace(/_/g, ' ')} ·
          priced per {item.baseUnit}
        </p>
      </div>

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
    </main>
  );
}
