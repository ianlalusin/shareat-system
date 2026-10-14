import { can } from '@shareat/auth';
import { getPosDayReconciliation } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { recheckPosDayAction } from '../../sales-days/actions';
import { toBusinessDate } from '@shareat/core/datetime';
import { PosReconciliationCard } from '@/components/reports/PosReconciliationCard';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, Input, Select } from '@/components/ui';

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
  const sp = await withFlash(searchParams);

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
        getPosDayReconciliation(tx, { orgId, storeId, businessDate }),
      )
    : null;
  // The button is offered to someone who may use it (the domain re-checks on submit), and only for a POS-sourced day.
  const canRecheck =
    storeId && result?.salesDayId && result.ledger.exists && result.ledger.source === 'pos_v1_day_feed'
      ? await runReport(orgId, (tx) => can(tx, scope.actor, 'verify_sales_day', { storeId }))
      : false;

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">POS Reconciliation</h1>
        <PageDescription>
          What POS said about the day, from the feeds this system stored, beside Shareat System&apos;s own
          sales-day record. Nothing here calls POS: the check button below stores a fresh reading.
        </PageDescription>
      </div>

      {/* DEF-604: a refused recheck comes back to this page; its sentence arrives in the flash. */}
      {sp.error && (
        <Banner tone="error">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </Banner>
      )}

      <form
        method="GET"
        action="/reports/pos-reconciliation"
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId ?? ''}>
            {storeRows.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Date</span>
          <Input type="date" name="date" defaultValue={businessDate} />
        </label>
        <Button type="submit" variant="primary">
          Apply
        </Button>
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
          <PosReconciliationCard postedBasis={result.postedBasis} latest={result.latest} ledger={result.ledger} matches={result.matches} delta={result.delta} />
          {canRecheck && result.salesDayId && (
            <form action={recheckPosDayAction} className="text-sm">
              <input type="hidden" name="salesDayId" value={result.salesDayId} />
              <input type="hidden" name="returnTo" value={`/reports/pos-reconciliation?store=${storeId}&date=${businessDate}`} />
              <Button type="submit" variant="secondary">
                Check POS again
              </Button>
            </form>
          )}
        </>
      ) : (
        <p className="text-sm text-neutral-500">No store available to report on.</p>
      )}
    </Page>
  );
}
