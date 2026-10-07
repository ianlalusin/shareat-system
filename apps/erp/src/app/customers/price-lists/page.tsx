import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { createPriceListAction } from '../actions';
import { listLists } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Price lists — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function PriceListsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/customers/price-lists');
  const lists = await listLists(actor.orgId);

  return (
    <Page density="table">
      <div>
        <Link href="/customers" className="text-sm underline underline-offset-2">
          ← Customers
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Price lists</h1>
        <PageDescription>
          What the business charges, per item. A customer names one, and an order line takes its
          rate. ⛔ <strong>No volume breaks or dated promotions</strong> — one rate per item per
          list is what the business does today, and a pricing-rule engine is generality nothing has
          asked for yet.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok}
        </div>
      )}

      {lists.length > 0 ? (
        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 dark:divide-neutral-900 dark:border-neutral-800">
          {lists.map((l) => (
            <li key={l.id} className="px-4 py-3">
              <Link
                href={`/customers/price-lists/${l.id}`}
                className="underline underline-offset-2"
              >
                {l.name}
              </Link>
              {l.description && (
                <div className="text-xs text-neutral-500 dark:text-neutral-500">
                  {l.description}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No price lists yet.</p>
      )}

      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">New price list</h2>
        <form action={createPriceListAction} className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Name</span>
            <input name="name" required placeholder="Wholesale — meat" className={INPUT} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Description
            </span>
            <input name="description" className={INPUT} />
          </label>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Create
          </button>
        </form>
      </section>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
