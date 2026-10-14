import { notFound } from 'next/navigation';
import { can } from '@shareat/auth';
import { isZero, money } from '@shareat/core/money';
import { salesDaysRepo } from '@shareat/db';
import { listStores, listChannels, listStoreMoneyAccounts, getStoreLink, withOrgPrincipal, type ChannelOption } from '../../lib';
import { requireSession } from '../../../../lib/session';
import { editSalesDayAction } from '../../actions';
import { SalesDayForm, type SalesDayDefaults } from '../../SalesDayForm';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { FlashBanner } from '@/components/ui';

export const metadata = { title: 'Edit sales day — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

const NOT_EDITABLE = 'text-sm text-neutral-600 dark:text-neutral-400';

/**
 * T-369 S3 (DEF-479) — fix an unverified sales day. The SAME form as `/sales-days/new`, prefilled from
 * the day, its channels and its tenders. The store and the date are not inputs: the date is what the
 * create-block and the unique index key on (R1). Saving never changes the status (R4).
 */
export default async function EditSalesDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/sales-days/${id}/edit`);
  const orgId = actor.orgId;

  const day = await withOrgPrincipal(orgId, (tx) => salesDaysRepo.getById(tx, orgId, id));
  if (!day) notFound();

  const unverified = day.status === 'open' || day.status === 'submitted';

  // T-375 S3 (R13): a feed day, or any day of a store linked to POS, is imported, never edited by hand.
  const link = await getStoreLink(orgId, day.storeId);
  const storeName = (await listStores(orgId)).find((s) => s.id === day.storeId)?.name ?? 'This store';

  // Only offered where it can be used: an open day is the submitter's, a submitted one the verifier's
  // (the domain applies exactly this split). The domain re-checks on save.
  const canEdit = unverified
    ? await withOrgPrincipal(orgId, (tx) =>
        can(tx, actor, day.status === 'submitted' ? 'verify_sales_day' : 'submit_sales_day', { storeId: day.storeId }),
      )
    : false;

  const carry = new URLSearchParams();
  carry.set('store', sp.store ?? day.storeId);

  const back = (
    <a
      href={`/sales-days/${day.id}?${carry.toString()}`}
      className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}
    >
      ← Back to this day
    </a>
  );

  // T-375 S3 (R13): the linked-store refusal shares this block (and its one PageDescription) with the status refusals.
  const takesFromPos = link !== null || day.source === 'pos_v1_day_feed';
  if (takesFromPos || !unverified || !canEdit) {
    return (
      <Page density="table">
        <div>
          {back}
          <h1 className="mt-1 text-2xl font-semibold">Edit sales day</h1>
          <PageDescription>{day.businessDate}</PageDescription>
        </div>
        <p className={NOT_EDITABLE}>
          {takesFromPos
            ? `${storeName} takes its sales from POS. Import the day instead.`
            : unverified
              ? "You can't edit this day."
              : `Only an unverified sales day can be edited — this one is ${day.status}.`}
        </p>
      </Page>
    );
  }

  const [stores, activeChannels, ownChannels, tenders, wallets] = await Promise.all([
    listStores(orgId),
    listChannels(orgId, day.storeId),
    withOrgPrincipal(orgId, (tx) => salesDaysRepo.getChannelsForDay(tx, day.id)),
    withOrgPrincipal(orgId, (tx) => salesDaysRepo.getTendersForDay(tx, day.id)),
    listStoreMoneyAccounts(orgId, day.storeId, { includeRetired: true }),
  ]);
  const activeWallets = wallets.filter((w) => w.isActive);
  const retiredTenders = tenders
    .map((t) => ({ t, w: wallets.find((x) => x.id === t.moneyAccountId) }))
    .filter((x) => x.w && !x.w.isActive)
    .map((x) => ({ name: x.w!.name, amount: x.t.amount }));

  // The active channels, plus any the day already names that have since been retired: editing an old
  // day must keep working (`writeChannels` validates against the unfiltered list for that reason).
  const channels: ChannelOption[] = [
    ...activeChannels.filter((c) => c.isActive),
    ...ownChannels
      .filter((c) => !activeChannels.some((a) => a.id === c.channelId))
      .map((c) => ({
        id: c.channelId,
        name: c.channelName,
        isRemittedDaily: c.isRemittedDaily,
        receivableAccountCode: c.receivableAccountCode,
        isActive: false,
      })),
  ];

  // Zero optional figures stay blank, as on a fresh form; the three revenue figures always show.
  const nonZero = (v: string) => (isZero(money(v)) ? undefined : v);
  const defaults: SalesDayDefaults = {
    figures: {
      totalSales: day.totalSales,
      unliSales: day.unliSales,
      alaCarteSales: day.alaCarteSales,
      ...Object.fromEntries(
        (['seniorDiscount', 'pwdDiscount', 'otherDiscount', 'comps', 'serviceCharge', 'otherCharges', 'cashCollected', 'onlineCollected', 'creditSales'] as const)
          .map((k) => [k, nonZero(day[k])])
          .filter((e): e is [string, string] => e[1] !== undefined),
      ),
    },
    channels: Object.fromEntries(ownChannels.map((c) => [c.channelId, { amount: c.amount, noSales: c.noSales }])),
    tenders: Object.fromEntries(tenders.map((t) => [t.moneyAccountId, t.amount])),
  };

  const store = stores.find((s) => s.id === day.storeId);

  return (
    <Page density="table">
      <div>
        {back}
        <h1 className="mt-1 text-2xl font-semibold">Edit sales day — {day.businessDate}</h1>
        <PageDescription>
          Fix the figures, channels or wallets. <strong>The date and the store stay as they are</strong>,
          and so does the status — a submitted day stays submitted, and the verifier sees what you
          saved here.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <form action={editSalesDayAction} className="space-y-6 text-sm">
        <input type="hidden" name="storeId" value={day.storeId} />
        <input type="hidden" name="salesDayId" value={day.id} />
        <SalesDayForm
          storeLabel={store ? `${store.name} (${store.code})` : day.storeId}
          businessDate={day.businessDate}
          dateEditable={false}
          channels={channels}
          wallets={activeWallets}
          defaults={defaults}
          retiredTenders={retiredTenders}
          submitLabel="Save"
        />
      </form>
    </Page>
  );
}
