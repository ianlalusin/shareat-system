import Link from 'next/link';
import { WASTAGE_REASONS, WASTAGE_REASON_LABEL, wastageReasonLabel } from '@shareat/domain';
import { addDays, toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { saveUsageDraftAction } from './actions';
import { listStores, usageQueueData, usageScreenData } from './lib';
import { NewUsageForm } from './NewUsageForm';
import { ACTION_LINK } from '@/components/action-link';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Banner, FlashBanner, Input, LinkRow, RowLink, Select } from '@/components/ui';

export const metadata = { title: 'Usage & wastage — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  date?: string;
  error?: string;
  ok?: string;
}

const KIND_LABEL: Record<string, string> = { usage: 'Usage', wastage: 'Wastage', adjustment: 'Adjustment', opening: 'Opening' };

/** A stored `numeric` for display: no trailing zeros ('10.000' -> '10', '10.500' -> '10.5'). */
function plainQty(q: string): string {
  return q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q;
}

/** '0.1000' -> '10%', '0.0250' -> '2.5%'. Exact (decimal string arithmetic, no floats). */
function pctOf(tolerance: string): string {
  const [whole = '0', frac = ''] = tolerance.split('.');
  const padded = frac.padEnd(4, '0');
  const pct = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
  const rest = padded.slice(2).replace(/0+$/, '');
  return `${pct}${rest ? `.${rest}` : ''}%`;
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/usage');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { locations, departments, items, records } = await usageScreenData(actor.orgId, storeId);
  // The band table is for one business date: the one asked for, else yesterday (the day a manager is expected to have posted).
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : addDays(toBusinessDate(), -1);
  const queue = await usageQueueData(actor.orgId, actor, storeId, date);

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
          <PageDescription className="mt-1">
            A floor worker records what was consumed or spoiled; a manager posts it. ⭐ Posting is
            the only step that moves stock and hits the books.
          </PageDescription>
        </div>
        <Link href={`/inventory?store=${storeId}`} className="text-sm underline underline-offset-4">
          ← Stock on hand
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
          <span className="block text-neutral-600 dark:text-neutral-400">Check date</span>
          <Input type="date" name="date" defaultValue={date} />
        </label>
      </FilterRow>

      {/* T-401 S6: the check. Per item the POS plan covers on that day: what the plan expects, what staff recorded, inside or outside the band. */}
      <section>
        <h2 className="text-lg font-medium">Usage check for {date}</h2>
        {queue.variances.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Nothing to check for this date: no POS plan covers an item that day.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Expected</th>
                  <th className="px-3 py-2 text-right font-medium">Recorded</th>
                  <th className="px-3 py-2 text-right font-medium">Used in cooking</th>
                  <th className="px-3 py-2 font-medium">Check</th>
                </tr>
              </thead>
              <tbody>
                {queue.variances.map((v) => (
                  <tr key={v.itemId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">{v.itemName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{plainQty(v.expected)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{plainQty(v.actual)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{v.cooked && plainQty(v.cooked) !== '0' ? plainQty(v.cooked) : ''}</td>
                    <td className={`px-3 py-2 ${v.withinBand ? 'text-success' : 'text-danger'}`}>
                      {v.withinBand ? `Within ${pctOf(v.tolerance)}` : `Outside ${pctOf(v.tolerance)}`}
                      {!v.withinBand && plainQty(v.actual) === '0' ? ' (nothing recorded yet)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* T-419: display only. Cooking from a recipe took these out of stock when it was posted; they are not recorded or posted from here. */}
      <section>
        <h2 className="text-lg font-medium">Used in cooking on {date}</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Taken from stock when the cooking was posted. Drafts have not taken anything yet. Shown for the full picture; not posted again from here.
        </p>
        {queue.cooked.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No cooking from a recipe was recorded for this date.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Quantity</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.cooked.map((c, i) => (
                  <LinkRow key={`${c.recordId}-${c.itemId}-${i}`} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">{c.itemName}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${c.isDraft ? 'text-neutral-500 dark:text-neutral-500' : ''}`}>
                      {plainQty(c.quantity)} {c.unit}
                    </td>
                    <td className="px-3 py-2">
                      <RowLink href={`/inventory/production/${c.recordId}`}>
                        Recipe: {c.recipeName}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2">
                      {c.isDraft ? <span className="text-xs text-amber-700 dark:text-amber-400">Draft — not posted yet</span> : 'Posted'}
                    </td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium">Drafts waiting for a manager</h2>
        {queue.drafts.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No usage drafts are waiting.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Room</th>
                  <th className="px-3 py-2 font-medium">Written by</th>
                  <th className="px-3 py-2 font-medium">Lines</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.drafts.map((d) => (
                  <LinkRow key={d.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <RowLink href={`/inventory/usage/${d.id}`}>
                        {d.usedOn}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2">{d.locationName}</td>
                    <td className="px-3 py-2">{d.createdByName}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {d.lines.map((l) => `${l.itemName} ${plainQty(l.quantity)} ${l.unit}`).join('; ')}
                    </td>
                    <td className="px-3 py-2">
                      <Badge status={d.status} />
                      {d.pullVoided && (
                        <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">Pull voided - check this draft against what was really used.</span>
                      )}
                    </td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {locations.length === 0 ? (
        <Banner tone="warning">
          This store has no active operating room yet — a usage can only be recorded from one. Add
          one under{' '}
          <Link href={`/inventory/locations?store=${storeId}`} className="text-sm underline underline-offset-4">
            Locations
          </Link>
          .
        </Banner>
      ) : (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">New record</h2>
          <NewUsageForm
            action={saveUsageDraftAction}
            storeId={storeId}
            locations={locations}
            departments={departments}
            items={items}
            reasons={WASTAGE_REASONS.map((value) => ({ value, label: WASTAGE_REASON_LABEL[value] }))}
            today={toBusinessDate()}
          />
        </section>
      )}

      <section>
        <h2 className="text-lg font-medium">Records</h2>
        {records.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Nothing recorded yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Room</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2 text-right font-medium">Lines</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <LinkRow key={r.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <RowLink href={`/inventory/usage/${r.id}`}>
                        {r.usedOn}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="px-3 py-2">{r.locationName}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {r.reasonCode ? wastageReasonLabel(r.reasonCode) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.lineCount}</td>
                    <td className="px-3 py-2">
                      <Badge status={r.status} />
                    </td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
}
