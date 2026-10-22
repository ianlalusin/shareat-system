import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { createPriceListAction } from '../actions';
import { listLists } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, CardGrid, Field, FlashBanner, FormGrid, FormModal, Input } from '@/components/ui';

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
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
        {/* T-448: the add form opens from the header instead of sitting under the list. */}
        <FormModal trigger="+ New price list" title="New price list" size="sm">
          <form action={createPriceListAction} className="space-y-3">
            <FormGrid layout="fields">
              <Field width="name" label="Name">
                <Input name="name" required placeholder="Wholesale — meat" className="w-full" />
              </Field>
              <Field width="long" label="Description" hint="Optional.">
                <Input name="description" className="w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </form>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      {lists.length > 0 ? (
        <CardGrid min="sm">
          {lists.map((l) => (
            <div key={l.id} className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-800">
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
            </div>
          ))}
        </CardGrid>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No price lists yet.</p>
      )}
    </Page>
  );
}
