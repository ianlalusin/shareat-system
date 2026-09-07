import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';
import { lowStockRepo, schema } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores } from '../../inventory/lib';
import { deferDiscrepancyAction, resolveDiscrepancyAction } from './actions';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';

export const metadata = { title: 'Transit shortfalls — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  all?: string;
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  deferred: 'Deferred',
  resolved: 'Resolved',
};

export default async function DiscrepanciesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/commissary/discrepancies');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;
  const includeResolved = sp.all === '1';

  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <h1 className="text-2xl font-semibold">Transit shortfalls</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </main>
    );
  }

  const { rows, people } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const [list, persons] = await Promise.all([
      lowStockRepo.discrepancyList(tx, actor.orgId, storeId, includeResolved),
      tx
        .select({ id: schema.persons.id, name: schema.persons.displayName })
        .from(schema.persons)
        .where(eq(schema.persons.orgId, actor.orgId))
        .orderBy(asc(schema.persons.displayName)),
    ]);
    return { rows: list, people: persons };
  });

  const blocking = rows.filter((r) => r.status !== 'resolved').length;
  // ⚠️ **The BUSINESS date, not `toISOString()`.** Manila is UTC+8, so at 2am local a UTC
  // slice offers YESTERDAY — and a manager deferring "to today" would get a date already past,
  // which blocks again immediately and burns their one allowed deferral. Caught on this
  // screen's first run at 01:50 Manila.
  const today = toBusinessDate();

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">Transit shortfalls</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Goods that left this store and did not arrive. They sit in <strong>1340</strong> at cost —
        a real asset — until somebody says what happened to them.
      </p>

      {sp.error && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Dispatching store</span>
          <select
            name="store"
            defaultValue={storeId}
            className="mt-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="all" value="1" defaultChecked={includeResolved} />
          Include resolved
        </label>
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Show
        </button>
      </form>

      {/*
        ⭐ v1's reason, kept because it is exactly right: *forces resolution before revenue can be
        understated further.* A commissary whose dispatched goods are unaccounted for has a wrong
        cost of sales, and every day opened on top of that makes it worse and harder to unpick.
      */}
      {blocking > 0 && (
        <div className="mt-6 rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950">
          <strong>
            ⚠️ {blocking} unresolved shortfall{blocking === 1 ? '' : 's'} — this store cannot open a
            new sales day
          </strong>
          <p className="mt-1 text-neutral-700 dark:text-neutral-300">
            Deciding what happened lifts the block. ⛔ Choosing <em>Audit only</em> does not — it
            records that somebody looked and chose to wait, which is a decision to wait, not a
            resolution.
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-600 dark:text-neutral-400">
          Nothing outstanding. A shortfall appears here on its own when a branch signs for less than
          this store dispatched — there is no “raise a discrepancy” button, deliberately.
        </p>
      ) : (
        <div className="mt-8 space-y-4">
          {rows.map((row) => (
            <article
              key={row.id}
              className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-medium">
                  {row.quantity} {row.unit} of {row.itemName}
                  <span className="ml-2 text-sm font-normal text-neutral-500">
                    ₱{row.value} at cost
                  </span>
                </h2>
                <span className="text-xs text-neutral-500">
                  {STATUS_LABEL[row.status] ?? row.status}
                  {row.disposition ? ` · ${row.disposition}` : ''}
                  {row.deferredTo ? ` until ${row.deferredTo}` : ''}
                </span>
              </div>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                To {row.branchName ?? 'a branch'} · order {row.orderDate} ·{' '}
                <Link href={`/commissary/orders/${row.orderId}`} className="underline underline-offset-4">
                  view order
                </Link>
              </p>
              {row.note && <p className="mt-1 text-sm italic text-neutral-600">“{row.note}”</p>}

              {row.status === 'resolved' ? (
                <p className="mt-3 text-sm text-neutral-500">
                  ⛔ Resolved as <strong>{row.disposition}</strong>. Correcting this is a reversal
                  plus a new resolution, never an edit.
                </p>
              ) : (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <form action={resolveDiscrepancyAction} className="space-y-2 text-sm">
                    <input type="hidden" name="id" value={row.id} />
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="resolvedOn" value={today} />
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        name="disposition"
                        defaultValue="loss"
                        className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                      >
                        <option value="loss">Loss — Dr 5300</option>
                        <option value="charge">Charge a person — Dr 1230</option>
                        <option value="audit">Audit only — posts nothing</option>
                        <option value="late_receipt">Late receipt — the rest turned up</option>
                      </select>
                      <select
                        name="chargePersonId"
                        defaultValue=""
                        className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                      >
                        <option value="">(person, for a charge)</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      name="note"
                      placeholder="What happened?"
                      className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    <button
                      type="submit"
                      className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    >
                      Decide
                    </button>
                  </form>

                  <form action={deferDiscrepancyAction} className="space-y-2 text-sm">
                    <input type="hidden" name="id" value={row.id} />
                    <input type="hidden" name="storeId" value={storeId} />
                    <label className="block">
                      <span className="text-neutral-600 dark:text-neutral-400">
                        Or decide later — <strong>once</strong>
                      </span>
                      <input
                        type="date"
                        name="deferredTo"
                        defaultValue={today}
                        className="mt-1 block rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
                      />
                    </label>
                    {/* ⚠️ v1's rule, and the whole reason defer is safe to offer: a dispute cannot
                        be pushed down the road indefinitely. The database refuses the second one. */}
                    <p className="text-xs text-neutral-500">
                      A second deferral is refused. On the date, it blocks again by itself.
                    </p>
                    <button
                      type="submit"
                      className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    >
                      Defer
                    </button>
                  </form>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
