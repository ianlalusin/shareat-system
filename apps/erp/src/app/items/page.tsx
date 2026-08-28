import { requireSession } from '../../lib/session';
import { createItemAction } from './actions';
import { listItems } from './lib';

export const metadata = { title: 'Items — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950';

const KINDS = ['raw_material', 'supply', 'retail', 'meat_slab', 'meat_sliced'];
const UNITS = ['pcs', 'kg', 'g', 'ltr', 'ml', 'roll'];

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/items');
  const items = await listItems(actor.orgId);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Items</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          One identity per thing the business buys, for the whole organisation — not one per store.
          That is what makes &ldquo;what have we paid per kilo, month by month, across every
          branch&rdquo; a question with a single answer.
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

      <section className="space-y-3">
        {items.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Code</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Priced per</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <a href={`/items/${i.id}`} className="underline hover:no-underline">
                        {i.name}
                      </a>
                      {i.status !== 'active' && (
                        <span className="ml-2 text-xs text-neutral-500">(inactive)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{i.code}</td>
                    <td className="px-3 py-2">{i.kind.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2">{i.baseUnit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No items yet. Add the things you buy, and their price history builds itself from the
            invoices you record.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Add an item</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          ⚠️ &ldquo;Measured in&rdquo; is the unit every price is compared in, so pick the one you
          actually measure by. A box is not a unit of measure — it is a quantity of something, and
          it belongs on the invoice line with its conversion instead.
        </p>
        <form action={createItemAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name</span>
              <input name="name" required placeholder="Pork belly" className={INPUT} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Code</span>
              <input name="code" required placeholder="PORK-BELLY" className={INPUT} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Kind</span>
              <select name="kind" required defaultValue="raw_material" className={INPUT}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Measured in
              </span>
              <select name="baseUnit" required defaultValue="kg" className={INPUT}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Add item
          </button>
        </form>
      </section>
    </main>
  );
}
