import { getTrialBalance } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { ReportBasis } from '@/components/reports/ReportBasis';
import { ReportFilters } from '@/components/reports/ReportFilters';
import { TieIndicator } from '@/components/reports/TieIndicator';
import { TrialBalanceTable } from '@/components/reports/TrialBalanceTable';

export const metadata = { title: 'Trial Balance — Shareat System' };

// Server component — always dynamically rendered (it reads searchParams and the
// database on every request), matching Next's own "reading searchParams opts a page
// into dynamic rendering" behaviour. Nothing here is cached; every figure is a live
// query (bible §4.2 rule 7 — this whole task exists to prove that).
export const dynamic = 'force-dynamic';

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

interface SearchParams {
  // ⛔ No `org` — DEF-064. The organisation comes from the session, never the URL.
  store?: string;
  from?: string;
  to?: string;
  yearClose?: string;
}

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  // ⛔ DEF-064. The org comes from the SESSION and is never read from the URL, and the store
  // list is what this person is actually scoped to. `sp.org` is deliberately ignored.
  const scope = await reportScope('/reports/trial-balance', 'view_trial_balance', sp.store);
  const orgId = scope.actor.orgId;
  const storeRows = scope.stores;
  const storeId = scope.storeId;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const today = toBusinessDate();
  const fromDate = sp.from ?? firstOfMonth(today);
  const toDate = sp.to ?? today;
  // Trial balance defaults to INCLUDING the year-close entry — ADR-006's
  // balance-sheet-as-of semantics (packages/domain/src/reports/trial-balance.ts's own
  // top comment explains why this differs from the income statement's default).
  const includeYearClose = sp.yearClose === 'exclude' ? false : sp.yearClose === 'include' ? true : true;

  // Under the RLS principal, so the database refuses a cross-org read even if this code is
  // wrong — the backstop the reports never had.
  const result = await runReport(orgId, (tx) =>
    getTrialBalance(tx, { orgId, storeId, fromDate, toDate, includeYearClose }),
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Trial Balance</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Every figure below is computed live from journal_lines — nothing here is a stored
          total.
        </p>
      </div>

      <ReportFilters
        basePath="/reports/trial-balance"
        orgs={[{ id: orgId, label: `${scope.orgName} (${scope.orgCode})` }]}
        currentOrgId={orgId}
        stores={storeRows.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={storeId}
        fromDate={fromDate}
        toDate={toDate}
        includeYearClose={includeYearClose}
        yearCloseHelp="Defaults to included — a trial balance is a balance-sheet-as-of view (ADR-006)."
      />

      <ReportBasis
        orgLabel={`${scope.orgName} (${scope.orgCode})`}
        storeLabel={currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
        fromDate={fromDate}
        toDate={toDate}
        includeYearClose={includeYearClose}
      />

      <TieIndicator ties={result.ties} totalDebit={result.totalDebit} totalCredit={result.totalCredit} />

      {result.lines.length === 0 ? (
        <EmptyState message={`No entries for ${fromDate} to ${toDate}.`} />
      ) : (
        <TrialBalanceTable lines={result.lines} totalDebit={result.totalDebit} totalCredit={result.totalCredit} />
      )}
    </main>
  );
}
