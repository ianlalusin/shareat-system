import { formatMoney, money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { ASSET_CATEGORIES } from '@shareat/db';
import { requirePageAccess } from '../../lib/page-access';
import { SchedulerStatus } from '../../components/scheduler-status';
import { runDepreciationAction } from './actions';
import {
  CATEGORY_LABEL,
  INTERVAL_LABEL,
  currentPeriod,
  listRegister,
  listStores,
  readPolicyForDisplay,
} from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Banner, Button, FlashBanner, LinkRow, RowLink, Select, Input } from '@/components/ui';

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
  const sp = await withFlash(searchParams);

  // ⭐ The org comes from the SESSION, not the URL — the same rule every screen built after
  // T-138 follows, and the one the two reports pages still do not (DEF-064).
  const { actor, refusal } = await requirePageAccess('/fixed-assets');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
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
  // T-346 S2 (DEF-427), §3.6 — held assets sit on the books at cost, depreciating nothing, so
  // their cost is worth calling out as its own group rather than blending into the grand total.
  const heldRows = rows.filter((r) => r.status === 'active' && r.inServiceOn === null);
  const heldCost = heldRows.reduce((a, r) => a + Number(r.cost ?? 0), 0);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Fixed assets</h1>
          <PageDescription>
            The register. <strong>Accumulated depreciation and book value are computed from the
            ledger on every view</strong> — they are not stored anywhere, so they cannot drift from
            the entries that produced them (docs/tasks/124-fixed-assets-and-depreciation.md §3).
          </PageDescription>
        </div>
        <a
          href={`/fixed-assets/new?${carry.toString()}`}
          className="inline-flex min-h-11 shrink-0 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
        >
          Add asset
        </a>
      </div>

      <FlashBanner flash={sp} />
      {/* ⚠️ A run that failed must not LOOK like a run that worked. The first version of this
          banner was always green, and the message "1 failed: ... no fiscal period covers
          2026-06-30" was rendered in success colours — which is the precise shade of reporting
          that let v1's two dead months go unnoticed. */}
      {sp.ran &&
        (Number(sp.failed ?? '0') > 0 ? (
          <Banner tone="warning">
            <strong className="font-medium">Depreciation run finished with failures.</strong>{' '}
            {sp.ran}
          </Banner>
        ) : (
          <Banner tone="success">Depreciation run: {sp.ran}</Banner>
        ))}

      {/* ⭐ Is anybody keeping these books? Reads scheduler_runs, not the ledger — a run that
          posts nothing looks exactly like a run that never happened. This is the surface that
          would have caught DEF-044 on day one (T-140). */}
      <SchedulerStatus orgId={actor.orgId} job="depreciation" label="Depreciation" />

      {reviewCount > 0 && !needsReviewOnly && (
        <Banner tone="warning">
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
        </Banner>
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
          <Input type="month" name="through" defaultValue={currentPeriod()} />
        </label>
        <Button type="submit" variant="secondary">
          Run
        </Button>
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
        <Button type="submit" variant="primary">
          Apply
        </Button>
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
                <LinkRow
                  key={r.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-3 py-2">
                    <RowLink href={`/fixed-assets/${r.id}?${carry.toString()}`}>
                      {r.name}
                    </RowLink>
                    {r.needsReview && <Badge tone="warning" label="Needs review" className="ml-2" />}
                    {r.status === 'active' && r.inServiceOn === null && (
                      <Badge tone="warning" label="Not yet in service" className="ml-2" />
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
                    <Badge status={r.status} />
                  </td>
                </LinkRow>
              ))}
            </tbody>
            <tfoot>
              {heldRows.length > 0 && (
                <tr className="border-t border-neutral-200 bg-warning-soft text-warning-ink dark:border-neutral-800">
                  <td className="px-3 py-2" colSpan={4}>
                    Not yet in service — {heldRows.length} asset{heldRows.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(money(heldCost.toFixed(2)))}
                  </td>
                  <td className="px-3 py-2" colSpan={4} />
                </tr>
              )}
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
    </Page>
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
      <Select name={name} defaultValue={value}>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.t}
          </option>
        ))}
      </Select>
    </label>
  );
}
