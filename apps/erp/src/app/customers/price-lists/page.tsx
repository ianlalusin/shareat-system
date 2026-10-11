import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { createPriceListAction } from '../actions';
import { listLists } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Input } from '@/components/ui';

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

      <FlashBanner flash={sp} />

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
            <Input name="name" required placeholder="Wholesale — meat" className="w-full" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Description
            </span>
            <Input name="description" className="w-full" />
          </label>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form>
      </section>
    </Page>
  );
}
