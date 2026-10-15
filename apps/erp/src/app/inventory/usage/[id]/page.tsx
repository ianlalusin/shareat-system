import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../lib/session';
import { deleteUsageDraftAction, postUsageAction, voidUsageAction } from '../actions';
import { usageRecordDetail } from '../lib';
import { wastageReasonLabel } from '@shareat/domain';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';
import { withFlash } from '@/lib/flash';
import { Button, ConfirmDestructive, FlashBanner, Input, LinkRow, RowLink, statusLabel } from '@/components/ui';

export const metadata = { title: 'Usage record — Shareat System' };
export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = { usage: 'Usage', wastage: 'Wastage', adjustment: 'Adjustment', opening: 'Opening' };

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
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/inventory/usage/${id}`);
  const detail = await usageRecordDetail(actor.orgId, id);
  if (!detail) notFound();
  const { record, locationName, lines, fromLivePull } = detail;

  const canPost = record.status === 'draft';
  const canDeleteDraft = record.status === 'draft';
  const canVoid = record.status === 'posted' && !fromLivePull;

  return (
    <Page density="table">
      <div>
        <Link href={`/inventory/usage?store=${record.storeId}`} className="text-sm underline underline-offset-4">
          ← Usage &amp; wastage
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {KIND_LABEL[record.kind] ?? record.kind} — {locationName}
        </h1>
        <PageDescription className="mt-1">
          {record.usedOn} · <strong>{statusLabel(record.status)}</strong>
          {record.reasonCode && <> · {wastageReasonLabel(record.reasonCode)}</>}
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

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
              <LinkRow key={l.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                <td className="px-3 py-2">
                  <RowLink href={`/items/${l.itemId}`}>
                    {l.itemName}
                  </RowLink>
                  <span className="ml-2 font-mono text-xs text-neutral-500">{l.itemCode}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {l.quantity} {l.baseUnit}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                  {l.onHand} {l.baseUnit}
                </td>
              </LinkRow>
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
          <Button type="submit" variant="primary">
            Post
          </Button>
        </form>
      )}

      {canDeleteDraft && (
        <form action={deleteUsageDraftAction} className="flex items-center gap-3">
          <input type="hidden" name="recordId" value={record.id} />
          <input type="hidden" name="storeId" value={record.storeId} />
          <ConfirmDestructive
            tier="admin-pin"
            label="Delete usage draft"
            consequence="Deletes this draft for good. An administrator must approve with their own PIN."
          />
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

      {record.status === 'posted' && fromLivePull && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          This usage came from a POS pull, so it is voided with the pull.{' '}
          <Link href={`/inventory/pos-usage?store=${record.storeId}`} className={ACTION_LINK}>
            Void it under Inventory › POS usage →
          </Link>
        </p>
      )}

      {canVoid && (
        <form action={voidUsageAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="recordId" value={record.id} />
          <label className="flex min-w-0 grow flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            Void — say why
            <Input name="reason" required placeholder="reason" className="w-full" />
          </label>
          <ConfirmDestructive
            tier="admin-pin"
            label="Void usage"
            consequence="Reverses this usage record and restores the stock. An administrator must approve with their own PIN."
          />
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
