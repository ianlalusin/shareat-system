import { formatMoney, money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { ASSET_CATEGORIES } from '@shareat/db';
import { requireSession } from '../../lib/session';
import { runDepreciationAction } from './actions';
import {
  CATEGORY_LABEL,
  INTERVAL_LABEL,
  currentPeriod,
  listRegister,
  listStores,
  readPolicyForDisplay,
} from './lib';

export const metadata = { title: 'Fixed assets — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  status?: string;
  review?: string;
  error?: string;
  ran?: string;
  failed?: string;
}

export default async function FixedAssetsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // ⭐ The org comes from the SESSION, not the URL — the same rule every screen built after
  // T-138 follows, and the one the two reports pages still do not (DEF-064).
  const { actor } = await requireSession('/fixed-assets');
  const stores = await listStores(actor.orgId);

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : undefined;
  const status =
    sp.status === 'active' || sp.status === 'disposed' || sp.status === 'pending_valuation'
      ? sp.status
      : undefined;
  const needsReviewOnly = sp.review === '1';

  const rows = await listRegister(actor.orgId, { storeId, status, needsReviewOnly });
  const policy = await readPolicyForDisplay(actor.orgId);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  const carry = new URLSearchParams();
  if (storeId) carry.set('store', storeId);

  const reviewCount = rows.filter((r) => r.needsReview).length;
  const totalCost = rows.reduce((a, r) => a + Number(r.cost ?? 0), 0);
  const totalAccumulated = rows.reduce((a, r) => a + Number(r.accumulated), 0);
  const totalBook = rows.reduce((a, r) => a + Number(r.bookValue), 0);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Fixed assets</h1>
          <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
            The register. <strong>Accumulated depreciation and book value are computed from the
            ledger on every view</strong> — they are not stored anywhere, so they cannot drift from
            the entries that produced them (docs/tasks/124-fixed-assets-and-depreciation.md §3).
          </p>
        </div>
        <a
          href={`/fixed-assets/new?${carry.toString()}`}
          className="shrink-0 rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Add asset
        </a>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {/* ⚠️ A run that failed must not LOOK like a run that worked. The first version of this
          banner was always green, and the message "1 failed: ... no fiscal period covers
          2026-06-30" was rendered in success colours — which is the precise shade of reporting
          that let v1's two dead months go unnoticed. */}
      {sp.ran &&
        (Number(sp.failed ?? '0') > 0 ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
            <strong className="font-medium">Depreciation run finished with failures.</strong>{' '}
            {sp.ran}
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            Depreciation run: {sp.ran}
          </div>
        ))}

      {reviewCount > 0 && !needsReviewOnly && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-medium">
            {reviewCount} asset{reviewCount === 1 ? '' : 's'} still carry default terms nobody has
            confirmed.
          </strong>{' '}
          They were capitalised automatically from an expense, so their life and salvage are a
          guess.{' '}
          <a
            href={`/fixed-assets?${new URLSearchParams({ ...Object.fromEntries(carry), review: '1' }).toString()}`}
            className="underline hover:no-underline"
          >
            Review them
          </a>
        </div>
      )}

      {/* ⭐ The run. Safe to press twice — every period is idempotent on (asset, period), so a
          second press posts nothing and a missed month is caught up by pressing it again. That is
          the whole DEF-044 answer, and the button says so because a user who believes it is safe
          is a user who runs it. */}
      <form
        action={runDepreciationAction}
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <input type="hidden" name="filterStore" value={storeId ?? ''} />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Run depreciation through
          </span>
          <input
            type="month"
            name="through"
            defaultValue={currentPeriod()}
            className="rounded border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>
        <button
          type="submit"
          className="rounded bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Run
        </button>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Safe to run more than once — periods already posted are skipped, and a month that was
          missed is caught up by running it again.
        </p>
      </form>

      <form
        method="GET"
        action="/fixed-assets"
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <Picker
          name="store"
          label="Store"
          value={storeId ?? ''}
          options={[
            { v: '', t: 'All stores' },
            ...stores.map((s) => ({ v: s.id, t: `${s.name} (${s.code})` })),
          ]}
        />
        <Picker
          name="status"
          label="Status"
          value={status ?? ''}
          options={[
            { v: '', t: 'All' },
            { v: 'active', t: 'Active' },
            { v: 'disposed', t: 'Disposed' },
            { v: 'pending_valuation', t: 'Pending valuation' },
          ]}
        />
        <Picker
          name="review"
          label="Review"
          value={needsReviewOnly ? '1' : ''}
          options={[
            { v: '', t: 'All' },
            { v: '1', t: 'Needs review' },
          ]}
        />
        <button
          type="submit"
          className="rounded bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Apply
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          No assets match this filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Acquired</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Accumulated</th>
                <th className="px-3 py-2 text-right font-medium">Book value</th>
                <th className="px-3 py-2 font-medium">Life</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-3 py-2">
                    <a
                      href={`/fixed-assets/${r.id}?${carry.toString()}`}
                      className="underline hover:no-underline"
                    >
                      {r.name}
                    </a>
                    {r.needsReview && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        Needs review
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{CATEGORY_LABEL[r.category] ?? r.category}</td>
                  <td className="px-3 py-2">{storeById.get(r.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.acquiredOn ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.cost ? formatMoney(money(r.cost)) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                    {formatMoney(money(r.accumulated))}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatMoney(money(r.bookValue))}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {r.usefulLifeMonths} mo · {INTERVAL_LABEL[r.interval] ?? r.interval}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-200 bg-neutral-50 font-medium dark:border-neutral-800 dark:bg-neutral-900">
                <td className="px-3 py-2" colSpan={4}>
                  {rows.length} asset{rows.length === 1 ? '' : 's'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(money(totalCost.toFixed(2)))}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(money(totalAccumulated.toFixed(2)))}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatMoney(money(totalBook.toFixed(2)))}
                </td>
                <td className="px-3 py-2" colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        {toBusinessDate()} today (Asia/Manila). Capitalisation threshold{' '}
        {policy ? formatMoney(money(policy.capitalizationThreshold)) : '₱5,000.00 (default — no policy set)'}.
        Categories: {ASSET_CATEGORIES.length}.
      </p>
    </main>
  );
}

function Picker({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string;
  options: { v: string; t: string }[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className="rounded border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.t}
          </option>
        ))}
      </select>
    </label>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'disposed'
        ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
  const label =
    status === 'pending_valuation' ? 'Pending valuation' : status[0]!.toUpperCase() + status.slice(1);
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}
