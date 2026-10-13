import Link from 'next/link';
import { dualRunOverview } from '@shareat/domain';
import { reportScope, runReport } from '../lib';
import { EmptyState } from '@/components/reports/EmptyState';
import { Page } from '@/components/shell/Page';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Select } from '@/components/ui';
import { FAMILY_LABEL, VerdictBadge } from './ui';

export const metadata = { title: 'Dual run — Shareat System' };
export const dynamic = 'force-dynamic';

const FAMILIES = ['policy', 'timing', 'encoder', 'defect', 'scope', 'open'] as const;

interface SearchParams {
  store?: string;
}

/**
 * T-392 S5 - one row per store-week (the current compare report), newest week first. Reading needs
 * `view_financial_reports`; recording a disposition is on the week page and is for administrators only.
 */
export default async function DualRunOverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const scope = await reportScope('/reports/dual-run', 'view_financial_reports', sp.store);
  const storeIds = scope.storeId ? [scope.storeId] : scope.stores.map((s) => s.id);
  const rows = await runReport(scope.actor.orgId, (tx) => dualRunOverview(tx, scope.actor, { storeIds }));

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">Dual run</h1>
        <p className="mt-1 text-sm text-muted">
          The old system against the new one, one row per store and week. Open a week to see each line, its difference and why.
        </p>
      </div>

      <FlashBanner flash={sp} />

      <form method="GET" action="/reports/dual-run" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">Store</span>
          <Select name="store" defaultValue={scope.storeId ?? ''}>
            {scope.coversWholeOrg ? <option value="">All stores</option> : null}
            {scope.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="primary">
          Apply
        </Button>
        {scope.coversWholeOrg ? (
          <Link href="/reports/dual-run/pack" className="inline-flex min-h-11 items-center text-sm underline font-medium">
            Go / no-go pack
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState message="No compare report yet for this selection." />
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => {
            const differing = FAMILIES.filter((f) => (r.families[f] ?? 0) > 0);
            return (
              <li key={r.reportId} className="rounded-lg border border-surface-border bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <Link href={`/reports/dual-run/${encodeURIComponent(r.storeCode)}/${r.weekStart}`} className="inline-flex min-h-11 items-center text-sm font-semibold underline">
                      {r.storeName} · week of {r.weekStart}
                    </Link>
                    <p className="text-xs text-muted">
                      to {r.through} · {r.comparedDays} compared day{r.comparedDays === 1 ? '' : 's'}
                      {r.versionCount > 1 ? ` · ${r.versionCount} versions` : ''}
                    </p>
                  </div>
                  <VerdictBadge verdict={r.verdict} />
                </div>
                <p className="mt-2 text-xs text-muted">
                  Lines that differ: {differing.length === 0 ? 'none' : differing.map((f) => `${FAMILY_LABEL[f]} ${r.families[f]}`).join(' · ')}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
