import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../lib/session';
import { deleteUsageDraftAction, postUsageAction, voidUsageAction } from '../actions';
import { usageRecordDetail } from '../lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Usage record — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';
const BTN_DANGER =
  'rounded-md border border-red-300 px-4 py-2.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950';

const KIND_LABEL: Record<string, string> = { usage: 'Usage', wastage: 'Wastage', adjustment: 'Adjustment', opening: 'Opening' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', posted: 'Posted', void: 'Void' };

function when(d: Date | null): string {
  return d ? new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '—';
}

export default async function UsageRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/inventory/usage/${id}`);
  const detail = await usageRecordDetail(actor.orgId, id);
  if (!detail) notFound();
  const { record, locationName, lines } = detail;

  const canPost = record.status === 'draft';
  const canDeleteDraft = record.status === 'draft';
  const canVoid = record.status === 'posted';

  return (
    <Page density="table">
      <div>
        <Link href={`/inventory/usage?store=${record.storeId}`} className="text-sm underline underline-offset-4">
          ← Usage &amp; wastage
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {KIND_LABEL[record.kind] ?? record.kind} — {locationName}
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {record.usedOn} · <strong>{STATUS_LABEL[record.status] ?? record.status}</strong>
          {record.reasonCode && <> · {record.reasonCode.replace(/_/g, ' ')}</>}
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

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full min-w-[480px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 text-right font-medium">Quantity</th>
              <th className="px-3 py-2 text-right font-medium">On hand in {locationName}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                <td className="px-3 py-2">
                  <Link href={`/items/${l.itemId}`} className="underline underline-offset-4">
                    {l.itemName}
                  </Link>
                  <span className="ml-2 font-mono text-xs text-neutral-500">{l.itemCode}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {l.quantity} {l.baseUnit}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                  {l.onHand} {l.baseUnit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canPost && (
        <form
          action={postUsageAction}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input type="hidden" name="recordId" value={record.id} />
          <div className="grow">
            <h2 className="font-medium">Post</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Manager or admin only. This relieves the FIFO layers at their real cost and posts the
              entry — nothing has moved until this.
            </p>
          </div>
          <button type="submit" className={BTN}>
            Post
          </button>
        </form>
      )}

      {canDeleteDraft && (
        <form action={deleteUsageDraftAction} className="flex items-center gap-3">
          <input type="hidden" name="recordId" value={record.id} />
          <input type="hidden" name="storeId" value={record.storeId} />
          <button type="submit" className={BTN_DANGER}>
            Delete draft
          </button>
        </form>
      )}

      {(record.status === 'posted' || record.status === 'void') && (
        <dl className="grid gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-2 dark:text-neutral-400">
          <dt className="text-neutral-400">Posted</dt>
          <dd>{when(record.postedAt)}</dd>
          {record.status === 'void' && (
            <>
              <dt className="text-neutral-400">Voided</dt>
              <dd>
                {when(record.voidedAt)} — {record.voidReason}
              </dd>
            </>
          )}
        </dl>
      )}

      {canVoid && (
        <form action={voidUsageAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="recordId" value={record.id} />
          <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            Void — say why
            <input name="reason" required placeholder="reason" className={`${INPUT} w-64`} />
          </label>
          <button type="submit" className={BTN_DANGER}>
            Void
          </button>
          <span className="max-w-xs text-xs text-neutral-500 dark:text-neutral-400">
            Stock, the FIFO layers and the original journal entry are all reversed together.
          </span>
        </form>
      )}

      <Link href={`/inventory?store=${record.storeId}`} className="inline-block text-sm underline underline-offset-4">
        View stock on hand →
      </Link>
    </Page>
  );
}
