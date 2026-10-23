import { getTrialBalance } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { toBusinessDate } from '@shareat/core/datetime';
import { EmptyState } from '@/components/reports/EmptyState';
import { ReportBasis } from '@/components/reports/ReportBasis';
import { TieIndicator } from '@/components/reports/TieIndicator';
import { TrialBalanceTable } from '@/components/reports/TrialBalanceTable';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Button, Field, FormGrid, Input, Select } from '@/components/ui';

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
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">Trial Balance</h1>
        <PageDescription>
          Every figure below is computed live from journal_lines — nothing here is a stored
          total.
        </PageDescription>
      </div>

      {/* T-448: one wrapping row of content-sized fields, Apply on the controls' baseline. Same GET form
          and field names as the shared ReportFilters (which the other reports still use). */}
      <form
        method="GET"
        action="/reports/trial-balance"
        className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <FormGrid layout="fields" className="[&.erp-form-fields]:items-end">
          <Field label="Organization" width="name">
            <Select name="org" defaultValue={orgId} className="w-full">
              <option value={orgId}>{`${scope.orgName} (${scope.orgCode})`}</option>
            </Select>
          </Field>
          <Field label="Store" width="code">
            <Select name="store" defaultValue={storeId ?? ''} className="w-full">
              <option value="">All stores</option>
              {storeRows.map((s) => (
                <option key={s.id} value={s.id}>
                  {`${s.name} (${s.code})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" width="date">
            <Input type="date" name="from" defaultValue={fromDate} className="w-full" />
          </Field>
          <Field label="To" width="date">
            <Input type="date" name="to" defaultValue={toDate} className="w-full" />
          </Field>
          {/* A <select> with explicit values, not a checkbox: an unchecked checkbox submits nothing,
              which cannot be told apart from "the form was not submitted". */}
          <Field
            label="Year-close entry"
            width="code"
            hint="Defaults to included — a trial balance is a balance-sheet-as-of view (ADR-006)."
          >
            <Select name="yearClose" defaultValue={includeYearClose ? 'include' : 'exclude'} className="w-full">
              <option value="include">Included</option>
              <option value="exclude">Excluded</option>
            </Select>
          </Field>
          <div style={{ flex: 'none' }}>
            <Button type="submit" variant="primary">
              Apply
            </Button>
          </div>
        </FormGrid>
      </form>

      <div className="flex items-center justify-between gap-4">
        <ReportBasis
          orgLabel={`${scope.orgName} (${scope.orgCode})`}
          storeLabel={currentStore ? `${currentStore.name} (${currentStore.code})` : 'All stores'}
          fromDate={fromDate}
          toDate={toDate}
          includeYearClose={includeYearClose}
        />
        <CsvExportLink
          href={`/reports/trial-balance/export?${new URLSearchParams({ ...(storeId ? { store: storeId } : {}), from: fromDate, to: toDate, yearClose: includeYearClose ? 'include' : 'exclude' }).toString()}`}
        />
      </div>

      <TieIndicator ties={result.ties} totalDebit={result.totalDebit} totalCredit={result.totalCredit} />

      {result.lines.length === 0 ? (
        <EmptyState message={`No entries for ${fromDate} to ${toDate}.`} />
      ) : (
        <TrialBalanceTable
          lines={result.lines}
          totalDebit={result.totalDebit}
          totalCredit={result.totalCredit}
          storeId={storeId}
          fromDate={fromDate}
          toDate={toDate}
          includeYearClose={includeYearClose}
        />
      )}
    </Page>
  );
}
