import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../lib/session';
import { PriceRateForm } from './PriceRateForm';
import { getListDetail, peso, type PriceListItemView } from '../../lib';
import { listItems } from '../../../items/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { FlashBanner, FormModal } from '@/components/ui';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'Price list — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function PriceListPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/customers/price-lists/${id}`);

  const [list, allItems] = await Promise.all([
    getListDetail(actor.orgId, id),
    // T-502 S1: a service (rent, power...) is never sold, so it never gets a rate.
    listItems(actor.orgId, false, undefined, true),
  ]);
  if (!list) notFound();

  return (
    <Page view="detail" sectioned density="table">
      <div>
        <Link href="/customers/price-lists" className={NAV_LINK}>
          ← Price lists
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{list.name}</h1>
        {list.description && (
          <PageDescription>{list.description}</PageDescription>
        )}
      </div>

      <FlashBanner flash={sp} />

      {list.items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">Today</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((i) => (
                <tr
                  key={i.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{i.itemCode}</span>
                    {i.itemName && (
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {i.itemName}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{i.unit ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{ruleOf(i)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {i.today !== null ? (
                      peso(i.today)
                    ) : (
                      <span className="font-sans text-xs text-neutral-500 dark:text-neutral-400">No delivery yet</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Nothing priced yet. A customer on this list has no rate for any item until one is added,
          and an unpriced item is refused rather than treated as free.
        </p>
      )}

      <div className="flex justify-end">
        <FormModal
          trigger="+ Set rate"
          title="Set a rate"
          size="md"
          description={
            <>
              Setting a rate for an item that already has one <strong>replaces</strong> it. A list keeps
              one price per item, not a history. A price that follows the delivery cost is worked out
              when an order is made, and the order keeps that number.
            </>
          }
        >
          <PriceRateForm listId={list.id} items={allItems.map((it) => ({ id: it.id, name: it.name, code: it.code, baseUnit: it.baseUnit }))} />
        </FormModal>
      </div>
    </Page>
  );
}

/** The rule in the words the rate form uses: "₱100.00", "Cost + 7%", "Cost + ₱50.00". */
function ruleOf(i: PriceListItemView): string {
  if (i.pricingMode === 'fixed') return peso(i.rate ?? '0');
  if (i.pricingMode === 'fixed_markup') return `Cost + ${peso(i.markupAmount ?? '0')}`;
  return `Cost + ${Number(i.markupPercent ?? '0')}%`;
}
