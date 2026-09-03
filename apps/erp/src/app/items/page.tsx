import { requireSession } from '../../lib/session';
import {
  approveItemRequestAction,
  createItemAction,
  mergeItemsAction,
  rejectItemRequestAction,
  requestItemAction,
} from './actions';
import { listItems, pendingRequests, duplicateCandidates, soldAsLabel } from './lib';

export const metadata = { title: 'Items — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900';
const KINDS = ['raw_material', 'supply', 'retail', 'meat_slab', 'meat_sliced'];
const UNITS = ['pcs', 'kg', 'g', 'ltr', 'ml', 'roll'];

export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; warning?: string }>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/items');
  const [items, requests, dupes] = await Promise.all([
    listItems(actor.orgId),
    pendingRequests(actor.orgId),
    duplicateCandidates(actor.orgId),
  ]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Items</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          One identity per thing the business buys, for the whole organisation. ⭐ Only a
          <strong> super-admin</strong> can add one — everyone else requests it, because a duplicate
          is not a row you delete later, it is a price history split in two.
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
      {sp.warning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          ⚠️ {sp.warning}
        </div>
      )}

      {dupes.length > 0 && (
        <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <h2 className="font-medium text-amber-900 dark:text-amber-200">
            {dupes.length === 1 ? 'One pair looks' : `${dupes.length} pairs look`} like the same item
          </h2>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Spelling-similarity check. ⚠️ It is a prompt, not a verdict — &ldquo;Coke 1.5&rdquo; and
            &ldquo;Coke 15&rdquo; look alike and are different products. Merging is permanent:
            every invoice line, price and supplier link moves to the item you keep.
          </p>
          <ul className="space-y-2">
            {dupes.map((d) => (
              <li
                key={`${d.aId}-${d.bId}`}
                className="rounded border border-amber-300 bg-white p-3 text-sm dark:border-amber-800 dark:bg-neutral-950"
              >
                <div className="mb-2">
                  <a href={`/items/${d.aId}`} className="underline hover:no-underline">{d.aName}</a>
                  <span className="text-neutral-500"> ({d.aUnit})</span>
                  <span className="mx-2 text-neutral-400">vs</span>
                  <a href={`/items/${d.bId}`} className="underline hover:no-underline">{d.bName}</a>
                  <span className="text-neutral-500"> ({d.bUnit})</span>
                  <span className="ml-2 text-xs text-neutral-500">
                    {Math.round(d.similarity * 100)}% alike
                  </span>
                </div>
                {d.unitsDiffer ? (
                  <p className="text-xs text-red-700 dark:text-red-400">
                    ⛔ Measured differently ({d.aUnit} vs {d.bUnit}). Merging is refused until one
                    of them is corrected — combining them would make every past price incomparable.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <form action={mergeItemsAction} className="flex items-center gap-2">
                      <input type="hidden" name="winnerId" value={d.aId} />
                      <input type="hidden" name="loserId" value={d.bId} />
                      <button type="submit" className="rounded border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
                        Keep &ldquo;{d.aName}&rdquo;
                      </button>
                    </form>
                    <form action={mergeItemsAction} className="flex items-center gap-2">
                      <input type="hidden" name="winnerId" value={d.bId} />
                      <input type="hidden" name="loserId" value={d.aId} />
                      <button type="submit" className="rounded border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
                        Keep &ldquo;{d.bName}&rdquo;
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {requests.length > 0 && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">
            {requests.length === 1 ? 'One item is' : `${requests.length} items are`} waiting for a
            super-admin
          </h2>
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id} className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="font-medium">
                  {r.name} <span className="font-mono text-xs text-neutral-500">{r.code}</span>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {r.kind.replace(/_/g, ' ')} · measured in {r.baseUnit}
                  {r.reason ? ` · ${r.reason}` : ''}
                </div>
                {r.similarWarning && (
                  <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                    ⚠️ {r.similarWarning}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <form action={approveItemRequestAction} className="flex items-end gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <button type="submit" className={BTN}>Approve</button>
                  </form>
                  <form action={rejectItemRequestAction} className="flex items-end gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <input name="note" required placeholder="Why not?" className={INPUT} />
                    <button type="submit" className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
                      Reject
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        {items.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Code</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Priced per</th>
                  {/* ⭐ DEF-130. The org's default — a store may differ; see the item's page. */}
                  <th className="px-3 py-2 font-medium">Sold as</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <a href={`/items/${i.id}`} className="underline hover:no-underline">{i.name}</a>
                      {i.status !== 'active' && (
                        <span className="ml-2 text-xs text-neutral-500">({i.status})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{i.code}</td>
                    <td className="px-3 py-2">{i.kind.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2">{i.baseUnit}</td>
                    <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">{soldAsLabel(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No items yet. Their price history builds itself from the invoices you record.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Request a new item</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          A super-admin approves it, and then every store can use it. ⚠️ &ldquo;Measured in&rdquo;
          is the unit every price is compared in, so pick the one you actually measure by. A box is
          not a unit of measure — it belongs on the invoice line with its conversion.
        </p>
        <form action={requestItemAction} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Name</span>
              <input name="name" required placeholder="Pork belly" className={INPUT} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Code</span>
              <input name="code" required placeholder="PORK-BELLY" className={INPUT} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Kind</span>
              <select name="kind" required defaultValue="raw_material" className={INPUT}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Measured in</span>
              <select name="baseUnit" required defaultValue="kg" className={INPUT}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              Why do we need it? <span className="italic">(optional — helps whoever approves)</span>
            </span>
            <input name="reason" className={INPUT} />
          </label>
          {/*
            ⭐ DEF-130. T-149's three independent facts. Until 2026-09-03 the form never asked, both
            "sold" columns default to false, and every item made here was sold to nobody — which
            `createTradeOrder` then refused, correctly, on its own gate.
          */}
          <fieldset className="space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <legend className="px-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              What it may be bought and sold as
            </legend>
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="isPurchasable" defaultChecked className="h-4 w-4" />
                Bought from suppliers
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="sellableRetail" className="h-4 w-4" />
                Sold à la carte (retail)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="sellableWholesale" className="h-4 w-4" />
                Sold wholesale / to franchisees
              </label>
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Three independent facts — Milkis is all three, a bento box is retail-only and made
              here, charcoal is bought and sold to nobody. ⚠️ Applied when a super-admin{' '}
              <strong>adds directly</strong>; a request carries only name, kind and unit, so set
              these on the item&rsquo;s page once it is approved. A store that differs from the
              organisation says so there too.
            </p>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={BTN}>Request item</button>
            <button
              type="submit"
              formAction={createItemAction}
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Add directly (super-admin)
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
