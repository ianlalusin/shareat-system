import { getPosDayReconciliation, fetchPosSalesLive } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { PosReconciliationCard } from '@/components/reports/PosReconciliationCard';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'POS Reconciliation — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  date?: string;
}

/**
 * The POS-day ↔ ledger reconciliation — T-210. A per-store, per-day comparison, unlike every
 * other report here (which default to "all stores") — POS's `api/external/sales` is keyed by
 * one store and one date, so "all stores" has no meaning on this screen.
 */
export default async function PosReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const scope = await reportScope('/reports/pos-reconciliation', 'view_financial_reports', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  // ⚠️ Unlike every other report, this screen has no "all stores" reading — fall back to the
  // first store this person may see when none is explicitly chosen (an org-wide viewer's
  // `scope.storeId` is undefined; a store-scoped viewer's is already their one store).
  const storeId = scope.storeId ?? storeRows[0]?.id;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;
  const businessDate = sp.date ?? toBusinessDate();

  const result = storeId
    ? await runReport(orgId, (tx) =>
        getPosDayReconciliation(tx, fetchPosSalesLive, { orgId, storeId, businessDate }),
      )
    : null;

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">POS Reconciliation</h1>
        <PageDescription>
          POS&apos;s live day-level sales figure beside Shareat System&apos;s own sales-day
          record, so the reconciliation is rendered rather than left to goodwill.
        </PageDescription>
      </div>

      <form
        method="GET"
        action="/reports/pos-reconciliation"
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId ?? ''} className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950">
            {storeRows.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Date</span>
          <input type="date" name="date" defaultValue={businessDate} className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950" />
        </label>
        <button type="submit" className="rounded bg-neutral-900 px-4 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
          Apply
        </button>
      </form>

      {storeId && result ? (
        <>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            <span className="font-medium text-neutral-800 dark:text-neutral-200">{scope.orgName} ({scope.orgCode})</span>
            {' · '}
            {currentStore ? `${currentStore.name} (${currentStore.code})` : storeId}
            {' · '}
            {businessDate}
          </p>
          <PosReconciliationCard pos={result.pos} ledger={result.ledger} matches={result.matches} delta={result.delta} />
        </>
      ) : (
        <p className="text-sm text-neutral-500">No store available to report on.</p>
      )}
    </Page>
  );
}
