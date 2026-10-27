import Link from 'next/link';
import { requirePageAccess } from '../../../../lib/page-access';
import { peso } from '../../../../lib/format';
import { inboundList } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, FlashBanner, LinkRow, RowLink } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Shipments to receive — Shareat System' };
export const dynamic = 'force-dynamic';

export default async function InboundShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string; warning?: string; void?: string }>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/inventory/deliveries/inbound');
  if (refusal) return refusal;
  const showVoid = sp.void === '1';
  const shipments = await inboundList(actor, showVoid);

  return (
    <Page density="table" className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Shipments to receive</h1>
          <PageDescription className="mt-1">
            Goods another company in your group has sent you. Count what arrived, line by line, and receive it: your stock goes up and the
            amount you owe the sender is recorded in your own books.
          </PageDescription>
        </div>
        <Link href="/inventory/deliveries" className="inline-flex min-h-6 items-center text-sm underline underline-offset-4">
          ← Deliveries
        </Link>
      </div>

      <FlashBanner flash={sp} />

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {showVoid ? (
          <Link href="/inventory/deliveries/inbound" className="inline-flex min-h-6 items-center underline underline-offset-4">
            Hide cancelled shipments
          </Link>
        ) : (
          <Link href="/inventory/deliveries/inbound?void=1" className="inline-flex min-h-6 items-center underline underline-offset-4">
            Show cancelled shipments
          </Link>
        )}
      </p>

      {shipments.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing has been sent to you yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Shipped</th>
                <th className="px-3 py-2 text-right font-medium">Items</th>
                <th className="px-3 py-2 text-right font-medium">Billed</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => (
                <LinkRow key={s.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2">
                    <RowLink href={`/inventory/deliveries/inbound/${s.id}`}>{s.shippedOn}</RowLink>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.lines.length}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(s.billedTotal)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{s.receivedTotal !== null ? peso(s.receivedTotal) : '—'}</td>
                  <td className="px-3 py-2">
                    <Badge status={s.status} />
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
