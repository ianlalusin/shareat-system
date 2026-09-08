import { reportsRepo } from '@shareat/db';
import { add, money } from '@shareat/core/money';
import { reportScope, runReport } from '../lib';
import { EmptyState } from '@/components/reports/EmptyState';
import { JournalLinesTable, type JournalLineRow } from '@/components/reports/JournalLinesTable';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Journal Lines — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

interface SearchParams {
  account?: string;
  code?: string;
  name?: string;
  store?: string;
  from?: string;
  to?: string;
  yearClose?: string;
}

/**
 * The drill-down — T-209c. Reached only from an account row on another report (trial balance,
 * income statement, balance sheet) via `AccountDrillLink`, which carries the account's code/name
 * and the linking report's own filter, so this screen needs no second account lookup and its
 * total never disagrees with the line that linked here. Gated by `view_trial_balance` — the
 * strictest existing report capability — because it exposes raw ledger detail for ANY account,
 * regardless of which report's audience linked into it.
 */
export default async function JournalLinesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  if (!sp.account || !sp.from || !sp.to) {
    return (
      <Page density="wide">
        <h1 className="text-2xl font-semibold">Journal Lines</h1>
        <EmptyState message="Reached from an account row on another report — no account or date range was given." />
      </Page>
    );
  }

  const scope = await reportScope('/reports/journal-lines', 'view_trial_balance', sp.store);
  const orgId = scope.actor.orgId;
  const storeId = scope.storeId;
  const currentStore = storeId ? scope.stores.find((s) => s.id === storeId) : undefined;
  const includeYearClose = sp.yearClose === 'exclude' ? false : true;

  const rows = await runReport(orgId, (tx) =>
    reportsRepo.getAccountEntries(tx, {
      orgId,
      storeId,
      accountId: sp.account!,
      fromDate: sp.from!,
      toDate: sp.to!,
      includeYearClose,
    }),
  );

  const lines: JournalLineRow[] = rows.map((r) => ({
    entryId: r.entryId,
    entryDate: r.entryDate,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    status: r.status,
    memo: r.memo,
    lineMemo: r.lineMemo,
    debit: money(r.debit),
    credit: money(r.credit),
  }));

  const totalDebit = add(...lines.map((l) => l.debit));
  const totalCredit = add(...lines.map((l) => l.credit));

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">
          Journal Lines{sp.code ? ` — ${sp.code}` : ''} {sp.name ?? ''}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Every line posted to this account for the range below — the drill-down behind a report
          line.
        </p>
      </div>

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        <span className="font-medium text-neutral-800 dark:text-neutral-200">{scope.orgName} ({scope.orgCode})</span>
        {' · '}
        {currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
        {' · '}
        {sp.from} to {sp.to}
        {' · '}
        year-close entry {includeYearClose ? 'included' : 'excluded'}
      </p>

      {lines.length > 0 ? (
        <JournalLinesTable rows={lines} totalDebit={totalDebit} totalCredit={totalCredit} />
      ) : (
        <EmptyState message={`No entries on this account for ${sp.from} to ${sp.to}.`} />
      )}
    </Page>
  );
}
