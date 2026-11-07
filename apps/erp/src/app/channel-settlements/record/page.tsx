import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { Page } from '@/components/shell/Page';
import { previewSettlementAction } from '../actions';
import { SettlementForm } from '../SettlementForm';
import { listActiveLoans, listChannels, listWaitingDays } from '../lib';

export const metadata = { title: 'Record a settlement — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-544 - recording a settlement is a page of its own, not a modal on the overview. It loads exactly what the overview used to hand
 * `SettlementForm`; the form, its actions and its rules are unchanged. A post error still lands on the overview with its banner.
 */
export default async function RecordSettlementPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; day?: string }>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/channel-settlements/record');
  const [channels, waiting, loans] = await Promise.all([
    listChannels(actor.orgId),
    listWaitingDays(actor.orgId),
    listActiveLoans(actor.orgId),
  ]);

  return (
    <Page
      density="table"
      title="Record a settlement"
      description="One payout, one channel, one verified day. A payout covering several days is one settlement per day sharing a reference, so each day's receivable stays checkable on its own."
      actions={
        <Link
          href="/channel-settlements"
          className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
        >
          &larr; Channel settlements
        </Link>
      }
    >
      <SettlementForm
        previewAction={previewSettlementAction}
        channels={channels
          .filter((c) => c.isActive)
          .map((c) => ({
            id: c.id,
            name: c.name,
            storeId: c.storeId,
            storeName: c.storeName,
            outstanding: c.outstanding,
            destinationAccountName: c.destinationAccountName,
            destinationMoneyAccountId: c.destinationMoneyAccountId,
          }))}
        days={waiting.map((d) => ({
          salesDayId: d.salesDayId,
          channelId: d.channelId,
          businessDate: d.businessDate,
          reportedAmount: d.reportedAmount,
          ageDays: d.ageDays,
        }))}
        loans={loans}
        today={toBusinessDate()}
        preselectChannelId={sp.channel}
        preselectSalesDayId={sp.day}
      />
    </Page>
  );
}
