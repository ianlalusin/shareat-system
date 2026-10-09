import Link from 'next/link';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { buildPlanAction, finalizeSectionAction, requestMapFromPullAction, voidPullAction } from './actions';
import { findLivePull, listOperatingLocationsForStore, listSalesDaysForStore, listStores, pullView, type PullLineView } from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Daily POS usage pull — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  day?: string;
  pull?: string;
  error?: string;
  ok?: string;
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN_SM =
  'rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

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
        {finalizedAt && <span className="text-xs text-emerald-700 dark:text-emerald-400">Finalized {formatBusinessDateTime(finalizedAt)}</span>}
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
                    {/* T-388 R12: posted / held (the live sentence, red) / not posted (old data in a stamped section) / pending */}
                    {l.usageRecordId || section === 'orphan' || (!l.hold && !finalizedAt) ? (
                      <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                        {l.usageRecordId ? 'posted' : section === 'orphan' ? 'unmapped' : 'pending'}
                      </td>
                    ) : l.hold && !finalizedAt ? (
                      <td className="px-3 py-2 text-red-800 dark:text-red-300">{l.hold}</td>
                    ) : (
                      <td className="px-3 py-2 text-neutral-500">not posted</td>
                    )}
                  </tr>
                ))}
                {blocked.map((l) => (
                  <tr key={l.lineKey} className="border-b border-neutral-100 bg-red-50 last:border-0 dark:border-neutral-900 dark:bg-red-950">
                    {!finalizedAt && <td className="px-2 py-2"></td>}
                    <td className="px-3 py-2">
                      {l.posItemName} <span className="text-neutral-500">({l.posItemKey})</span>
                    </td>
                    {section !== 'orphan' && <td className="px-3 py-2">{l.itemName ?? '—'}</td>}
                    {showQuantity && <td className="px-3 py-2 text-right tabular-nums">—</td>}
                    {section !== 'orphan' && <td className="px-3 py-2">—</td>}
                    <td className="px-3 py-2 text-red-800 dark:text-red-300">{l.blocked?.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!finalizedAt && !viewOnly && confirmable.length > 0 && (
            <button type="submit" className={BTN_SM}>
              Finalize {title.toLowerCase()}
            </button>
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
            <input name="note" placeholder="note (optional)" className={`${INPUT} flex-1`} />
            <button type="submit" className={BTN_SM}>
              Flag as unmappable
            </button>
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
            A day&apos;s POS sales, turned into inventory consumption — physical quantity (sold +
            comped − voided), never the billable one.
          </PageDescription>
        </div>
        <Link href={`/inventory/pos-map?store=${storeId}`} className="text-sm underline underline-offset-4">
          POS item mapping →
        </Link>
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

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className={INPUT}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Sales day</span>
          <select name="day" defaultValue={salesDayId} className={INPUT}>
            {salesDays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.businessDate} ({d.viewOnly ? 'voided — view only' : d.status})
              </option>
            ))}
          </select>
        </label>
      </FilterRow>

      {!salesDayId ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          This store has no sales days yet — record one first.
        </p>
      ) : locations.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          This store has no active operating room yet — a pull needs one to consume from.
        </p>
      ) : viewOnly ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          This sales day was voided. Its pull is shown for reference only — nothing more can be built or finalized against it.
        </p>
      ) : (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">{pull ? 'Refresh plan' : 'Build plan'}</h2>
          <form action={buildPlanAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="salesDayId" value={salesDayId} />
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Operating location</span>
              <select name="locationId" className={INPUT}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={BTN_SM}>
              {pull ? 'Refresh' : 'Build plan'}
            </button>
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
                <button type="submit" className={BTN_SM}>
                  Finish this pull — nothing left to post
                </button>
              </form>
            </section>
          )}
          {pull.status !== 'void' && (
            <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
              <h2 className="text-sm font-medium">Void this pull</h2>
              <p className="mt-1 text-xs text-neutral-500">
                Puts back the stock this pull used and reverses its cost, so the day can be pulled again. All of it or none.
              </p>
              <form action={voidPullAction} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="salesDayId" value={pull.salesDayId} />
                <input type="hidden" name="pullId" value={pull.id} />
                <label className="grow text-sm">
                  <span className="block text-neutral-600 dark:text-neutral-400">Why is it being voided?</span>
                  <input name="reason" required className={`${INPUT} w-full`} />
                </label>
                <button type="submit" className={BTN_SM}>
                  Void this pull
                </button>
              </form>
            </section>
          )}
        </>
      )}
    </Page>
  );
}
