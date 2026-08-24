import { asc, eq } from 'drizzle-orm';
import { getDb, schema } from '@shareat/db';
import { getIncomeStatement } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { IncomeStatementTable } from '@/components/reports/IncomeStatementTable';
import { ReportBasis } from '@/components/reports/ReportBasis';
import { ReportFilters } from '@/components/reports/ReportFilters';

export const metadata = { title: 'Income Statement — Shareat System' };

// See apps/erp/src/app/reports/trial-balance/page.tsx for why this is force-dynamic.
export const dynamic = 'force-dynamic';

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

interface SearchParams {
  org?: string;
  store?: string;
  from?: string;
  to?: string;
  yearClose?: string;
}

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const db = getDb();

  // See trial-balance/page.tsx's identical comment — reading organizations/stores
  // directly here is a small, deliberate exception to bible §4.3 for the filter form's
  // pickers only; no report figure is computed from these two SELECTs.
  const orgs = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name, code: schema.organizations.code })
    .from(schema.organizations)
    .where(eq(schema.organizations.isActive, true))
    .orderBy(asc(schema.organizations.name));

  if (orgs.length === 0) {
    return (
      <main className="mx-auto max-w-4xl space-y-6 p-8">
        <h1 className="text-2xl font-semibold">Income Statement</h1>
        <EmptyState message="No organization exists in this database yet. Nothing to report." />
      </main>
    );
  }

  const orgId = sp.org && orgs.some((o) => o.id === sp.org) ? sp.org : orgs[0]!.id;
  const currentOrg = orgs.find((o) => o.id === orgId)!;

  const storeRows = await db
    .select({ id: schema.stores.id, name: schema.stores.name, code: schema.stores.code })
    .from(schema.stores)
    .where(eq(schema.stores.orgId, orgId))
    .orderBy(asc(schema.stores.name));

  const storeId = sp.store && storeRows.some((s) => s.id === sp.store) ? sp.store : undefined;
  const currentStore = storeId ? storeRows.find((s) => s.id === storeId) : undefined;

  const today = toBusinessDate();
  const fromDate = sp.from ?? firstOfMonth(today);
  const toDate = sp.to ?? today;
  // Income statement defaults to EXCLUDING the year-close entry — ADR-006: "a date-range
  // P&L must be able to exclude it" (packages/domain/src/reports/income-statement.ts's
  // own top comment). Opposite default from the trial balance, deliberately.
  const includeYearClose = sp.yearClose === 'include' ? true : sp.yearClose === 'exclude' ? false : false;

  const result = await getIncomeStatement(db, { orgId, storeId, fromDate, toDate, includeYearClose });

  const hasAnyActivity =
    result.revenueLines.length > 0 ||
    result.costOfSalesLines.length > 0 ||
    result.operatingExpenseLines.length > 0 ||
    result.otherIncomeExpenseLines.length > 0;

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Income Statement</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          A GROUP BY query over journal_lines — a new revenue or expense account appears
          here automatically, with no code change.
        </p>
      </div>

      <ReportFilters
        basePath="/reports/income-statement"
        orgs={orgs.map((o) => ({ id: o.id, label: `${o.name} (${o.code})` }))}
        currentOrgId={orgId}
        stores={storeRows.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={storeId}
        fromDate={fromDate}
        toDate={toDate}
        includeYearClose={includeYearClose}
        yearCloseHelp="Defaults to excluded — a date-range P&L excludes the year-close entry (ADR-006)."
      />

      <ReportBasis
        orgLabel={`${currentOrg.name} (${currentOrg.code})`}
        storeLabel={currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
        fromDate={fromDate}
        toDate={toDate}
        includeYearClose={includeYearClose}
      />

      {hasAnyActivity ? (
        <IncomeStatementTable
          revenueLines={result.revenueLines}
          revenue={result.revenue}
          costOfSalesLines={result.costOfSalesLines}
          costOfSales={result.costOfSales}
          grossProfit={result.grossProfit}
          operatingExpenseLines={result.operatingExpenseLines}
          operatingExpenses={result.operatingExpenses}
          operatingIncome={result.operatingIncome}
          otherIncomeExpenseLines={result.otherIncomeExpenseLines}
          otherIncomeExpense={result.otherIncomeExpense}
          netIncome={result.netIncome}
        />
      ) : (
        <EmptyState message={`No entries for ${fromDate} to ${toDate}.`} />
      )}
    </main>
  );
}
