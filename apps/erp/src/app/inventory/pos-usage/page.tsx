import Link from 'next/link';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { buildPlanAction, finalizeSectionAction, requestMapFromPullAction, voidPullAction } from './actions';
import { findLivePull, listOperatingLocationsForStore, listSalesDaysForStore, listStores, pullView, type PullLineView } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, FlashBanner, Input, Select } from '@/components/ui';

export const metadata = { title: 'Daily POS usage pull — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  day?: string;
  pull?: string;
  error?: string;
  ok?: string;
}

function SectionTable({
  title,
  lines,
  finalizedAt,
  storeId,
  salesDayId,
  pullId,
  section,
  showQuantity,
  viewOnly,
}: {
  title: string;
  lines: PullLineView[];
  finalizedAt: Date | null;
  storeId: string;
  salesDayId: string;
  pullId: string;
  section: 'direct' | 'recipe' | 'orphan';
  showQuantity: boolean;
  viewOnly?: boolean;
}) {
  const confirmable = lines.filter((l) => !l.blocked);
  const blocked = lines.filter((l) => l.blocked);

  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">
          {title} ({lines.length})
        </h2>
        {finalizedAt && <span className="text-xs text-success">Finalized {formatBusinessDateTime(finalizedAt)}</span>}
      </div>

      {lines.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Nothing here today.</p>
      ) : (
        <form action={finalizeSectionAction} className="mt-3 space-y-2">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="salesDayId" value={salesDayId} />
          <input type="hidden" name="pullId" value={pullId} />
          <input type="hidden" name="section" value={section} />

          <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  {!finalizedAt && <th className="px-2 py-2"></th>}
                  <th className="px-3 py-2 font-medium">POS item</th>
                  {section !== 'orphan' && <th className="px-3 py-2 font-medium">Stock item</th>}
                  {showQuantity && <th className="px-3 py-2 text-right font-medium">Qty</th>}
                  {section !== 'orphan' && <th className="px-3 py-2 font-medium">Room</th>}
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {confirmable.map((l) => (
                  <tr key={l.lineKey} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    {!finalizedAt && (
                      <td className="px-2 py-2">
                        {!l.usageRecordId && <input type="checkbox" name="confirmedKeys" value={l.lineKey} defaultChecked />}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      {l.posItemName} <span className="text-neutral-500">({l.posItemKey})</span>
                    </td>
                    {section !== 'orphan' && <td className="px-3 py-2">{l.itemName ?? '—'}</td>}
                    {showQuantity && <td className="px-3 py-2 text-right tabular-nums">{l.quantity ?? '—'}</td>}
                    {section !== 'orphan' && <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{l.locationName ?? '—'}</td>}
                    {/* T-401 S6: in the day's usage draft / posted / unmapped / pending */}
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {l.usageRecordId ? (l.recordStatus === 'draft' ? 'in usage draft' : 'posted') : section === 'orphan' ? 'unmapped' : finalizedAt ? 'not drafted' : 'pending'}
                    </td>
                  </tr>
                ))}
                {blocked.map((l) => (
                  <tr key={l.lineKey} className="border-b border-neutral-100 bg-danger-surface last:border-0 dark:border-neutral-900">
                    {!finalizedAt && <td className="px-2 py-2"></td>}
                    <td className="px-3 py-2">
                      {l.posItemName} <span className="text-neutral-500">({l.posItemKey})</span>
                    </td>
                    {section !== 'orphan' && <td className="px-3 py-2">{l.itemName ?? '—'}</td>}
                    {showQuantity && <td className="px-3 py-2 text-right tabular-nums">—</td>}
                    {section !== 'orphan' && <td className="px-3 py-2">—</td>}
                    <td className="px-3 py-2 text-danger">{l.blocked?.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!finalizedAt && !viewOnly && confirmable.length > 0 && (
            <Button type="submit" variant="secondary">
              Finalize {title.toLowerCase()}
            </Button>
          )}
        </form>
      )}

      {section === 'orphan' &&
        !viewOnly &&
        confirmable.map((l) => (
          <form key={`req-${l.lineKey}`} action={requestMapFromPullAction} className="mt-2 flex items-center gap-2 text-xs">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="salesDayId" value={salesDayId} />
            <input type="hidden" name="pullId" value={pullId} />
            <input type="hidden" name="posItemKey" value={l.posItemKey} />
            <input type="hidden" name="posItemName" value={l.posItemName} />
            <span>{l.posItemName}:</span>
            <Input name="note" placeholder="note (optional)" className="flex-1" />
            <Button type="submit" variant="secondary">
              Flag as unmappable
            </Button>
          </form>
        ))}
    </section>
  );
}

export default async function PosUsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/pos-usage');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Daily POS usage pull</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const [salesDays, locations] = await Promise.all([
    listSalesDaysForStore(actor.orgId, storeId),
    listOperatingLocationsForStore(actor.orgId, storeId),
  ]);
  const salesDayId = sp.day && salesDays.some((d) => d.id === sp.day) ? sp.day : salesDays[0]?.id;
  const viewOnly = salesDays.find((d) => d.id === salesDayId)?.viewOnly === true;

  let pullId = sp.pull ?? null;
  if (!pullId && salesDayId) {
    const live = await findLivePull(actor.orgId, storeId, salesDayId);
    pullId = live?.id ?? null;
  }
  const pull = pullId ? await pullView(actor.orgId, pullId) : null;

  // T-377 S2 (R5): one button when every unstamped section is empty on this page's own view of the pull.
  const unstamped = pull
    ? [
        { lines: pull.direct, at: pull.directFinalizedAt },
        { lines: pull.recipe, at: pull.recipeFinalizedAt },
        { lines: pull.orphan, at: pull.orphanFinalizedAt },
      ].filter((x) => !x.at)
    : [];
  const canFinish =
    pull !== null && pull.status === 'planned' && !viewOnly && unstamped.length > 0 && unstamped.every((x) => x.lines.length === 0);

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Daily POS usage pull</h1>
          <PageDescription className="mt-1">
            A day&apos;s POS sales, turned into the quantities the kitchen should have used — physical quantity (sold +
            comped − voided), never the billable one. This pull is a check: finalizing it makes a usage draft at those expected
            quantities, staff correct it to what was really used, and a manager posts it. Nothing moves until it is posted
            (or it posts itself at 14:00 the next day).
          </PageDescription>
        </div>
        <Link href={`/inventory/pos-map?store=${storeId}`} className="text-sm underline underline-offset-4">
          POS item mapping →
        </Link>
      </div>

      <FlashBanner flash={sp} />

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Sales day</span>
          <Select name="day" defaultValue={salesDayId}>
            {salesDays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.businessDate} ({d.viewOnly ? 'voided — view only' : d.status})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      {!salesDayId ? (
        <Banner tone="warning">
          This store has no sales days yet — record one first.
        </Banner>
      ) : locations.length === 0 ? (
        <Banner tone="warning">
          This store has no active operating room yet — a pull needs one to consume from.
        </Banner>
      ) : viewOnly ? (
        <Banner tone="warning">
          This sales day was voided. Its pull is shown for reference only — nothing more can be built or finalized against it.
        </Banner>
      ) : (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">{pull ? 'Refresh plan' : 'Build plan'}</h2>
          <form action={buildPlanAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="salesDayId" value={salesDayId} />
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Operating location</span>
              <Select name="locationId">
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit" variant="primary">
              {pull ? 'Refresh' : 'Build plan'}
            </Button>
          </form>
          {pull && (
            <p className="mt-2 text-xs text-neutral-500">
              {pull.soldItemsFeed
                ? `Built ${formatBusinessDateTime(pull.snapshotTakenAt)} from POS's sold items fetched ${formatBusinessDateTime(pull.soldItemsFeed.fetchedAt)} (${pull.soldItemsFeed.purpose === 'recheck' ? 'at a later check' : 'at import'}). A plan older than an hour is refused at finalize.`
                : "Built before usage read POS's stored sold items — build the plan again before finalizing."}
            </p>
          )}
        </section>
      )}

      {pull && (
        <>
          <SectionTable
            title="Direct"
            lines={pull.direct}
            finalizedAt={pull.directFinalizedAt}
            storeId={storeId}
            salesDayId={pull.salesDayId}
            pullId={pull.id}
            section="direct"
            showQuantity
            viewOnly={viewOnly}
          />
          <SectionTable
            title="Recipe"
            lines={pull.recipe}
            finalizedAt={pull.recipeFinalizedAt}
            storeId={storeId}
            salesDayId={pull.salesDayId}
            pullId={pull.id}
            section="recipe"
            showQuantity
            viewOnly={viewOnly}
          />
          <SectionTable
            title="Orphan (unmapped)"
            lines={pull.orphan}
            finalizedAt={pull.orphanFinalizedAt}
            storeId={storeId}
            salesDayId={pull.salesDayId}
            pullId={pull.id}
            section="orphan"
            showQuantity={false}
            viewOnly={viewOnly}
          />
          {canFinish && (
            <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
              <form action={finalizeSectionAction} className="space-y-2">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="salesDayId" value={pull.salesDayId} />
                <input type="hidden" name="pullId" value={pull.id} />
                <input type="hidden" name="finish" value="1" />
                <Button type="submit" variant="secondary">
                  Finish this pull — nothing left to post
                </Button>
              </form>
            </section>
          )}
          {pull.status !== 'void' && (
            <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
              <h2 className="text-sm font-medium">Void this pull</h2>
              <p className="mt-1 text-xs text-neutral-500">
                Removes the usage draft this pull made, and reverses any usage a manager already posted from it, so the day can be pulled again. All of it or none.
              </p>
              <form action={voidPullAction} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="salesDayId" value={pull.salesDayId} />
                <input type="hidden" name="pullId" value={pull.id} />
                <label className="grow text-sm">
                  <span className="block text-neutral-600 dark:text-neutral-400">Why is it being voided?</span>
                  <Input name="reason" required className="w-full" />
                </label>
                <Button type="submit" variant="danger">
                  Void this pull
                </Button>
              </form>
            </section>
          )}
        </>
      )}
    </Page>
  );
}
