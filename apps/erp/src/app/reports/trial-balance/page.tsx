import { asc, eq } from 'drizzle-orm';
import { getDb, schema } from '@shareat/db';
import { getTrialBalance } from '@shareat/domain';
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
  org?: string;
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
  const db = getDb();

  // Reading `organizations`/`stores` directly here, rather than through a dedicated
  // repo file, is a deliberate, small exception to bible §4.3 — this task's Scope names
  // no orgs/stores repo, and these two SELECTs exist only to populate the filter form's
  // pickers (bible §4.1 / organizations.ts: "nothing here or downstream may assume
  // there is exactly one organization" — so a picker, not a hardcoded first-row read, is
  // the correct minimum). See the task report.
  const orgs = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name, code: schema.organizations.code })
    .from(schema.organizations)
    .where(eq(schema.organizations.isActive, true))
    .orderBy(asc(schema.organizations.name));

  if (orgs.length === 0) {
    return (
      <main className="mx-auto max-w-5xl space-y-6 p-8">
        <h1 className="text-2xl font-semibold">Trial Balance</h1>
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
  // Trial balance defaults to INCLUDING the year-close entry — ADR-006's
  // balance-sheet-as-of semantics (packages/domain/src/reports/trial-balance.ts's own
  // top comment explains why this differs from the income statement's default).
  const includeYearClose = sp.yearClose === 'exclude' ? false : sp.yearClose === 'include' ? true : true;

  const result = await getTrialBalance(db, { orgId, storeId, fromDate, toDate, includeYearClose });

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
        orgs={orgs.map((o) => ({ id: o.id, label: `${o.name} (${o.code})` }))}
        currentOrgId={orgId}
        stores={storeRows.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
        currentStoreId={storeId}
        fromDate={fromDate}
        toDate={toDate}
        includeYearClose={includeYearClose}
        yearCloseHelp="Defaults to included — a trial balance is a balance-sheet-as-of view (ADR-006)."
      />

      <ReportBasis
        orgLabel={`${currentOrg.name} (${currentOrg.code})`}
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
