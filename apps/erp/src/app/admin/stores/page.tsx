import Link from 'next/link';
import { requirePageAccess } from '../../../lib/page-access';
import { listStoresForAdmin } from './lib';
import { createStoreAction } from './actions';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Stores — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-222 — opening and closing a branch.
 *
 * ⭐ **Until this shipped, nothing in the codebase created a store.** `scripts/dev-seed.ts` opens
 * with the tell: *"Migrations create 93 accounts and (via whatever put them there) an org and its
 * stores."* The four dev stores were inserted by hand.
 *
 * ⚠️ Store creation is a handful of lifetime uses — **7 stores across the whole business, ever** —
 * each with high consequence and a long tail. So this is not a slick high-throughput flow: it is a
 * careful one that cannot leave a store half-made, and the effort goes into making the remaining
 * gaps legible rather than into the form.
 */
export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/admin/stores');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const stores = await listStoresForAdmin(actor.orgId);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Stores</h1>
        <PageDescription>
          Opening a branch creates its default room and grants every admin access, in one
          transaction — so a half-made store cannot exist. What is left is the business half.
        </PageDescription>
      </div>

      {sp.ok && (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok}
        </p>
      )}
      {sp.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </p>
      )}

      <section className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="p-3">Code</th>
              <th className="p-3">Name</th>
              <th className="p-3">Cadence</th>
              <th className="p-3 text-right">Rooms</th>
              <th className="p-3">Status</th>
              <th className="p-3">Opening</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="p-3 font-medium">
                  <Link href={`/admin/stores/${s.id}`} className="underline underline-offset-2">
                    {s.code}
                  </Link>
                </td>
                <td className="p-3">{s.name}</td>
                <td className="p-3">
                  {s.remittanceCadence}
                  {s.unremittedCeiling ? ` · ceiling ${s.unremittedCeiling}` : ''}
                </td>
                <td className="p-3 text-right tabular-nums">{s.roomCount}</td>
                <td className="p-3">
                  {s.isActive ? (
                    <span className="text-emerald-700 dark:text-emerald-400">Active</span>
                  ) : (
                    <span className="text-neutral-500">Inactive</span>
                  )}
                </td>
                {/* T-346 S1 (DEF-428) — Amendment R3.3: three states via the shared `isPreOpening`
                    (R1 item 11 originally specified two; superseded). */}
                <td className="p-3">
                  {s.openingDate === null ? (
                    <span className="text-neutral-500">Not yet open</span>
                  ) : s.preOpening ? (
                    <span className="text-amber-600">Opens {s.openingDate}</span>
                  ) : (
                    <span className="text-emerald-700 dark:text-emerald-400">Opened {s.openingDate}</span>
                  )}
                </td>
              </tr>
            ))}
            {stores.length === 0 && (
              <tr>
                <td className="p-4 text-neutral-500" colSpan={6}>
                  No stores yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Open a branch</h2>
        <form action={createStoreAction} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Code</span>
            <input name="code" required maxLength={16}
              className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
            <span className="mt-1 block text-xs text-neutral-500">
              The stable handle. Not editable afterwards.
            </span>
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Name</span>
            <input name="name" required
              className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Stock model</span>
            <select name="stockModel"
              className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="single_room">single_room</option>
              <option value="multi_room">multi_room</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Remittance cadence</span>
            <select name="remittanceCadence"
              className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900">
              <option value="daily">daily</option>
              <option value="every_2_days">every_2_days</option>
              <option value="weekly">weekly</option>
              <option value="monthly">monthly</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Opening date</span>
            <input type="date" name="openingDate"
              className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
            <span className="mt-1 block text-xs text-neutral-500">
              Leave blank if it has not opened. The first day this store trades.
            </span>
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="block text-neutral-600 dark:text-neutral-400">
              Unremitted ceiling (required unless the cadence is daily)
            </span>
            <input name="unremittedCeiling" inputMode="decimal" placeholder="e.g. 20000.00"
              className="mt-1 w-full rounded border border-neutral-300 p-2 dark:border-neutral-700 dark:bg-neutral-900" />
            {/* ⚠️ The form does not enforce this pairing — the database does. Disabling a button
                client-side would be help, not enforcement (bible §2 rule 7). */}
            <span className="mt-1 block text-xs text-neutral-500">
              A store that pools cash must name the ceiling that bounds it. The database refuses the
              unsafe combination; this field is where you satisfy it.
            </span>
          </label>
          <div className="sm:col-span-2">
            <button type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
              Open branch
            </button>
          </div>
        </form>
      </section>
    </Page>
  );
}
