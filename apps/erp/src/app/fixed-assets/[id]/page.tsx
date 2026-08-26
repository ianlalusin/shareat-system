import { notFound } from 'next/navigation';
import { ASSET_CATEGORIES } from '@shareat/db';
import { formatMoney, money, subtract } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { buildSchedule } from '@shareat/domain';
import { requireSession } from '../../../lib/session';
import { disposeAssetAction, updateTermsAction } from '../actions';
import { CATEGORY_LABEL, INTERVAL_LABEL, getAsset, listStores } from '../lib';
import { StatusBadge } from '../page';

export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

export default async function AssetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/fixed-assets/${id}`);

  const found = await getAsset(actor.orgId, id);
  if (!found) notFound();
  const { asset, accumulated, periods } = found;

  const stores = await listStores(actor.orgId);
  const store = stores.find((s) => s.id === asset.storeId);
  const carry = new URLSearchParams();
  if (sp.store) carry.set('store', sp.store);

  const cost = money(asset.cost ?? '0');
  const bookValue = subtract(cost, money(accumulated));
  const isActive = asset.status === 'active';

  // The full schedule, so the screen can show what is still owed rather than only what has been
  // charged. Pure — no database, and it is the SAME function the posting uses, so what is shown
  // here and what will be posted cannot disagree.
  const schedule =
    asset.acquiredOn && asset.cost
      ? buildSchedule({
          acquiredOn: asset.acquiredOn,
          cost,
          salvageValue: money(asset.salvageValue ?? '0'),
          usefulLifeMonths: asset.usefulLifeMonths,
          interval: asset.interval,
        })
      : [];
  const postedSet = new Set(periods);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <a href={`/fixed-assets?${carry.toString()}`} className="text-sm underline hover:no-underline">
            ← Fixed assets
          </a>
          <h1 className="mt-1 flex flex-wrap items-center gap-3 text-2xl font-semibold">
            {asset.name}
            <StatusBadge status={asset.status} />
            {asset.needsReview && (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Needs review
              </span>
            )}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {CATEGORY_LABEL[asset.category] ?? asset.category} · {store?.name ?? '—'} · acquired{' '}
            {asset.acquiredOn ?? '—'}
          </p>
        </div>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok === 'terms' && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Terms updated, and the review flag is cleared.
        </div>
      )}
      {sp.ok === 'disposed' && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Disposed. The remaining book value was written off to 7400.
        </div>
      )}

      {asset.needsReview && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-medium">These terms are a default, not a decision.</strong> This
          asset was capitalised automatically from an expense, so its life and salvage were applied
          from policy without anyone looking at the thing itself. Editing them below confirms them
          and clears this flag.
        </div>
      )}

      {/* ⭐ Three figures, and only ONE of them is stored. */}
      <section className="grid gap-4 sm:grid-cols-3">
        <Figure label="Cost" value={formatMoney(cost)} note="Stored on the asset" />
        <Figure
          label="Accumulated depreciation"
          value={formatMoney(money(accumulated))}
          note="⭐ Derived — summed from the ledger, never stored"
        />
        <Figure
          label="Book value"
          value={formatMoney(bookValue)}
          note="⭐ Derived — cost less accumulated"
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Depreciation terms</h2>
          {isActive ? (
            <form action={updateTermsAction} className="space-y-4">
              <input type="hidden" name="assetId" value={asset.id} />
              <input type="hidden" name="filterStore" value={sp.store ?? ''} />
              <Field label="Name">
                <input name="name" required defaultValue={asset.name} maxLength={200} className={INPUT} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Category">
                  <select name="category" defaultValue={asset.category} className={INPUT}>
                    {ASSET_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABEL[c] ?? c}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Useful life (months)">
                  <input
                    type="number"
                    name="usefulLifeMonths"
                    min={1}
                    step={1}
                    required
                    defaultValue={asset.usefulLifeMonths}
                    className={INPUT}
                  />
                </Field>
                <Field label="Interval">
                  <select name="interval" defaultValue={asset.interval} className={INPUT}>
                    {(['monthly', 'quarterly', 'semiannual', 'annually'] as const).map((i) => (
                      <option key={i} value={i}>
                        {INTERVAL_LABEL[i]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Salvage value">
                  <input
                    name="salvageValue"
                    inputMode="decimal"
                    defaultValue={asset.salvageValue ?? ''}
                    className={INPUT}
                  />
                </Field>
              </div>
              <Field label="Notes">
                <textarea name="notes" rows={2} defaultValue={asset.notes ?? ''} className={INPUT} />
              </Field>
              <button
                type="submit"
                className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Save terms
              </button>
              {/* ⚠️ Changing a life does NOT rewrite what has already posted. Past periods are
                  history; the remaining ones re-derive from the new terms. */}
              <p className="text-xs text-neutral-400 dark:text-neutral-600">
                Changing the life or interval affects periods not yet posted. Entries already
                posted are history and are not rewritten.
              </p>
            </form>
          ) : (
            <dl className="space-y-2 text-sm">
              <Row k="Life" v={`${asset.usefulLifeMonths} months`} />
              <Row k="Interval" v={INTERVAL_LABEL[asset.interval] ?? asset.interval} />
              <Row k="Salvage" v={formatMoney(money(asset.salvageValue ?? '0'))} />
              <Row k="Disposed on" v={asset.disposedOn ?? '—'} />
              <Row k="Reason" v={asset.disposalReason ?? '—'} />
              {asset.notes && <Row k="Notes" v={asset.notes} />}
            </dl>
          )}
        </section>

        <section className="space-y-4">
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="mb-3 font-medium">Schedule</h2>
            {schedule.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                No schedule — this asset has no cost or acquisition date yet.
              </p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-white dark:bg-neutral-950">
                    <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
                      <th className="px-2 py-1.5 font-medium">Period</th>
                      <th className="px-2 py-1.5 text-right font-medium">Charge</th>
                      <th className="px-2 py-1.5 font-medium">Posted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.map((p) => (
                      <tr
                        key={p.period}
                        className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                      >
                        <td className="px-2 py-1.5 font-mono text-xs">{p.period}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">
                          {formatMoney(p.amount)}
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {postedSet.has(p.period) ? (
                            <span className="text-emerald-700 dark:text-emerald-400">Posted</span>
                          ) : (
                            <span className="text-neutral-400 dark:text-neutral-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {isActive && (
            <section className="space-y-3 rounded-lg border border-red-200 p-4 dark:border-red-900">
              <h2 className="font-medium text-red-800 dark:text-red-300">Dispose / write off</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Clears the accumulated depreciation, removes the cost, and writes the remaining{' '}
                <strong>{formatMoney(bookValue)}</strong> off to loss on disposal (7400). This is a
                write-off at zero proceeds — there is no sale-with-proceeds flow.
              </p>
              <form action={disposeAssetAction} className="space-y-3">
                <input type="hidden" name="assetId" value={asset.id} />
                <input type="hidden" name="filterStore" value={sp.store ?? ''} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Disposed on">
                    <input
                      type="date"
                      name="disposedOn"
                      required
                      max={toBusinessDate()}
                      min={asset.acquiredOn ?? undefined}
                      defaultValue={toBusinessDate()}
                      className={INPUT}
                    />
                  </Field>
                  <Field label="Reason" hint="Required — a write-off with no reason is unauditable">
                    <input name="reason" required placeholder="Compressor failed" className={INPUT} />
                  </Field>
                </div>
                <button
                  type="submit"
                  className="rounded bg-red-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-800"
                >
                  Dispose this asset
                </button>
              </form>
            </section>
          )}
        </section>
      </div>
    </main>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    </label>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-neutral-400 dark:text-neutral-600">{note}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-500 dark:text-neutral-400">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
